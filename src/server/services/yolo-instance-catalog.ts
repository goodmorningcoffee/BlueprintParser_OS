// [2026-10-21/22 owner asks] LIVE SageMaker processing-job quotas + on-demand prices for the YOLO
// instance allowlist (src/lib/yolo-instances.ts), for the root-only Admin › AI Models picker.
//
//   Quotas: Service Quotas ListServiceQuotas (applied) over ListAWSDefaultServiceQuotas (defaults),
//           service "sagemaker", names "<type> for processing job usage".
//   Prices: Price List GetProducts (us-east-1 endpoint), AmazonSageMaker, component Processing,
//           this region, on-demand $/h.
// Both are read-only and need the web task role's servicequotas:List* / pricing:GetProducts grants
// (infrastructure/terraform/iam.tf). The SDK clients for those services are not dependencies, so the
// two JSON-1.1 calls are SigV4-signed here with the SageMaker client's own credential chain.
//
// NEVER THROWS and is never on the YOLO run path: any AWS failure degrades to the code table
// (priceStatus "approximate", quotaStatus "unavailable"). Results are cached in memory for an hour
// (a failure for five minutes, so a missing IAM grant does not cost a round trip per page view).

import { SageMakerClient } from "@aws-sdk/client-sagemaker";
import { SignatureV4 } from "@smithy/signature-v4";
import { logger } from "@/lib/logger";
import { YOLO_INSTANCE_OPTIONS, instanceTypeFromQuotaName } from "@/lib/yolo-instances";
import type { YoloCatalogOption, YoloInstanceCatalog } from "@/lib/yolo-cost";

/** When the code table's prices were last checked by hand. */
export const YOLO_PRICE_TABLE_AS_OF = "2026-10-21";
const CACHE_MS = 60 * 60_000;
const FAILURE_CACHE_MS = 5 * 60_000;
const CALL_TIMEOUT_MS = 6_000;
const MAX_PAGES = 60;

export type { YoloCatalogOption, YoloInstanceCatalog } from "@/lib/yolo-cost";

/** One signed AWS JSON-1.1 call. Injectable for tests. */
export type AwsJsonCall = (req: {
  service: string;
  region: string;
  hostname: string;
  target: string;
  body: Record<string, unknown>;
}) => Promise<unknown>;

let credentialSource: SageMakerClient | null = null;
function credentials(): SageMakerClient["config"] {
  credentialSource ??= new SageMakerClient({
    region: process.env.AWS_REGION || "us-east-1",
    ...(process.env.AWS_ACCESS_KEY_ID && {
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      },
    }),
  });
  return credentialSource.config;
}

export const awsJsonCall: AwsJsonCall = async ({ service, region, hostname, target, body }) => {
  const config = credentials();
  const signer = new SignatureV4({ service, region, credentials: config.credentials, sha256: config.sha256 });
  const payload = JSON.stringify(body);
  const signed = await signer.sign({
    method: "POST",
    protocol: "https:",
    hostname,
    path: "/",
    query: {},
    headers: { host: hostname, "content-type": "application/x-amz-json-1.1", "x-amz-target": target },
    body: payload,
  });
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(signed.headers)) if (k.toLowerCase() !== "host") headers[k] = String(v);
  const res = await fetch(`https://${hostname}/`, {
    method: "POST",
    headers,
    body: payload,
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${target} HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as unknown;
};

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** All pages. `truncated` = MAX_PAGES was hit with a NextToken still pending (the list is partial). */
async function paginate(
  call: AwsJsonCall,
  req: Parameters<AwsJsonCall>[0],
  listKey: string,
): Promise<{ items: unknown[]; truncated: boolean }> {
  const items: unknown[] = [];
  let token: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = asRecord(await call({ ...req, body: { ...req.body, ...(token ? { NextToken: token } : {}) } }));
    const list = res[listKey];
    if (Array.isArray(list)) items.push(...list);
    token = typeof res.NextToken === "string" && res.NextToken ? res.NextToken : undefined;
    if (!token) return { items, truncated: false };
  }
  return { items, truncated: true };
}

/** A quota listing must be complete: a type it did not reach would read as quota 0 and be hidden. */
async function completeQuotaListing(call: AwsJsonCall, req: Parameters<AwsJsonCall>[0]): Promise<unknown[]> {
  const { items, truncated } = await paginate(call, req, "Quotas");
  if (truncated) throw new Error(`${req.target}: more than ${MAX_PAGES} pages; quota listing incomplete`);
  return items;
}

/** Applied values over AWS defaults → { type: quota }. Throws when EITHER listing fails or is
 *  truncated: a missing applied value would show an approved type as the default (usually 0), and a
 *  missing default would show an untouched type as 0 — both hide a type the account can run. */
export async function fetchProcessingQuotas(call: AwsJsonCall, region: string): Promise<Map<string, number>> {
  const req = (target: string) => ({
    service: "servicequotas",
    region,
    hostname: `servicequotas.${region}.amazonaws.com`,
    target,
    body: { ServiceCode: "sagemaker", MaxResults: 100 },
  });
  const [defaults, applied] = await Promise.all([
    completeQuotaListing(call, req("ServiceQuotasV20190624.ListAWSDefaultServiceQuotas")),
    completeQuotaListing(call, req("ServiceQuotasV20190624.ListServiceQuotas")),
  ]);
  const quotas = new Map<string, number>();
  for (const listing of [defaults, applied]) {
    for (const q of listing) {
      const r = asRecord(q);
      const type = instanceTypeFromQuotaName(r.QuotaName);
      if (type && typeof r.Value === "number" && Number.isFinite(r.Value)) quotas.set(type, r.Value);
    }
  }
  return quotas;
}

/** Parse Price List products → { type: on-demand USD/h } for SageMaker Processing in one region. */
export function parseProcessingPrices(priceList: readonly unknown[]): Map<string, number> {
  const prices = new Map<string, number>();
  for (const entry of priceList) {
    let item: unknown = entry;
    if (typeof entry === "string") {
      try {
        item = JSON.parse(entry);
      } catch {
        continue;
      }
    }
    const attrs = asRecord(asRecord(asRecord(item).product).attributes);
    const usage = typeof attrs.usagetype === "string" ? attrs.usagetype : "";
    const component = typeof attrs.component === "string" ? attrs.component : "";
    if (component && component.toLowerCase() !== "processing") continue;
    if (!component && !/(^|-)Processing:/u.test(usage)) continue;
    const type =
      (typeof attrs.instanceName === "string" && attrs.instanceName) || /:(ml\.[a-z0-9-]+\.[a-z0-9]+)$/u.exec(usage)?.[1];
    if (!type || !/^ml\./u.test(type)) continue;
    const onDemand = asRecord(asRecord(asRecord(item).terms).OnDemand);
    for (const term of Object.values(onDemand)) {
      for (const dim of Object.values(asRecord(asRecord(term).priceDimensions))) {
        const d = asRecord(dim);
        const usd = Number(asRecord(d.pricePerUnit).USD);
        if (/^h(ou)?rs?$/iu.test(String(d.unit ?? "")) && Number.isFinite(usd) && usd > 0) {
          const prev = prices.get(type);
          if (prev === undefined || usd < prev) prices.set(type, usd);
        }
      }
    }
  }
  return prices;
}

export async function fetchProcessingPrices(call: AwsJsonCall, region: string): Promise<Map<string, number>> {
  // A truncated price list is fine: types it did not reach keep the code-table price ("partial").
  const { items: products } = await paginate(
    call,
    {
      service: "pricing",
      region: "us-east-1",
      hostname: "api.pricing.us-east-1.amazonaws.com",
      target: "AWSPriceListService.GetProducts",
      body: {
        ServiceCode: "AmazonSageMaker",
        FormatVersion: "aws_v1",
        MaxResults: 100,
        Filters: [
          { Type: "TERM_MATCH", Field: "regionCode", Value: region },
          { Type: "TERM_MATCH", Field: "component", Value: "Processing" },
        ],
      },
    },
    "PriceList",
  );
  return parseProcessingPrices(products);
}

/** Merge live quotas/prices onto the code allowlist. null = that source failed. */
export function buildYoloInstanceCatalog(
  region: string,
  quotas: Map<string, number> | null,
  prices: Map<string, number> | null,
  now: Date,
): YoloInstanceCatalog {
  let live = 0;
  const options = YOLO_INSTANCE_OPTIONS.map((o): YoloCatalogOption => {
    const price = prices?.get(o.type);
    if (price !== undefined) live += 1;
    return {
      ...o,
      usdPerHour: price ?? o.usdPerHour,
      priceSource: price !== undefined ? "live" : "table",
      quota: quotas ? (quotas.get(o.type) ?? 0) : null,
    };
  });
  return {
    region,
    checkedAt: now.toISOString(),
    quotaStatus: quotas ? "live" : "unavailable",
    priceStatus: live === options.length ? "live" : live > 0 ? "partial" : "approximate",
    priceTableAsOf: YOLO_PRICE_TABLE_AS_OF,
    options,
  };
}

let cache: { value: YoloInstanceCatalog; expiresAt: number } | null = null;
let inFlight: Promise<YoloInstanceCatalog> | null = null;

/** Test hook. */
export function resetYoloInstanceCatalogCache(): void {
  cache = null;
  inFlight = null;
}

/** The annotated allowlist, live where AWS answers. Never throws. */
export async function getYoloInstanceCatalog(
  opts: { call?: AwsJsonCall; now?: () => Date; refresh?: boolean } = {},
): Promise<YoloInstanceCatalog> {
  const now = opts.now ?? (() => new Date());
  if (!opts.refresh && cache && cache.expiresAt > now().getTime()) return cache.value;
  if (inFlight) return inFlight;
  const call = opts.call ?? awsJsonCall;
  const region = process.env.AWS_REGION || "us-east-1";
  inFlight = (async () => {
    const [quotas, prices] = await Promise.all([
      fetchProcessingQuotas(call, region).catch((err: unknown) => {
        logger.warn("[yolo] SageMaker processing quotas unavailable; picker shows the full allowlist", { error: String(err).slice(0, 300) });
        return null;
      }),
      fetchProcessingPrices(call, region).catch((err: unknown) => {
        logger.warn("[yolo] SageMaker Price List unavailable; using the approximate code table", { error: String(err).slice(0, 300) });
        return null;
      }),
    ]);
    const usablePrices = prices && prices.size > 0 ? prices : null;
    const value = buildYoloInstanceCatalog(region, quotas, usablePrices, now());
    const ok = quotas !== null && usablePrices !== null;
    cache = { value, expiresAt: now().getTime() + (ok ? CACHE_MS : FAILURE_CACHE_MS) };
    return value;
  })()
    .catch((err: unknown) => {
      logger.error("[yolo] instance catalog build failed; using the code table", { error: String(err).slice(0, 300) });
      return buildYoloInstanceCatalog(region, null, null, now());
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}
