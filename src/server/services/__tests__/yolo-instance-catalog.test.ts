// @vitest-environment node
// [2026-10-21/22 owner] LIVE quotas + prices for the YOLO picker: Service Quotas (applied over AWS
// defaults, paginated) + Price List (Processing, on-demand $/h). Every AWS failure degrades to the
// code table — the catalog never throws — and results are cached (1 h; a failure 5 min).
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildYoloInstanceCatalog,
  getYoloInstanceCatalog,
  parseProcessingPrices,
  resetYoloInstanceCatalogCache,
  type AwsJsonCall,
} from "@/server/services/yolo-instance-catalog";
import { YOLO_INSTANCE_OPTIONS } from "@/lib/yolo-instances";

const product = (instanceName: string, component: string, usd: string, unit = "Hrs") =>
  JSON.stringify({
    product: { attributes: { instanceName, component, usagetype: `USE1-${component}:${instanceName}` } },
    terms: { OnDemand: { t: { priceDimensions: { d: { unit, pricePerUnit: { USD: usd } } } } } },
  });

function fakeAws(over: Partial<Record<string, (body: Record<string, unknown>) => unknown>> = {}) {
  const calls: Array<{ target: string; body: Record<string, unknown>; hostname: string; service: string }> = [];
  const call: AwsJsonCall = async (req) => {
    calls.push(req);
    const handler = over[req.target];
    if (handler) return handler(req.body);
    if (req.target.endsWith("ListAWSDefaultServiceQuotas")) {
      return req.body.NextToken
        ? { Quotas: [{ QuotaName: "ml.g6.xlarge for processing job usage", Value: 0 }] }
        : {
            Quotas: [
              { QuotaName: "ml.g4dn.xlarge for processing job usage", Value: 0 },
              { QuotaName: "ml.g5.xlarge for training job usage", Value: 8 },
            ],
            NextToken: "p2",
          };
    }
    if (req.target.endsWith("ListServiceQuotas")) {
      return { Quotas: [{ QuotaName: "ml.g4dn.xlarge for processing job usage", Value: 2 }, { QuotaName: "ml.g6.xlarge for processing job usage", Value: 1 }] };
    }
    if (req.target.endsWith("GetProducts")) {
      return { PriceList: [product("ml.g4dn.xlarge", "Processing", "0.7364"), product("ml.g6.xlarge", "Processing", "1.0058")] };
    }
    throw new Error(`unexpected ${req.target}`);
  };
  return { call, calls };
}

beforeEach(() => {
  resetYoloInstanceCatalogCache();
  process.env.AWS_REGION = "us-east-1";
});

describe("getYoloInstanceCatalog", () => {
  it("merges applied quotas over defaults (all pages) and live Processing prices onto the allowlist", async () => {
    const { call, calls } = fakeAws();
    const c = await getYoloInstanceCatalog({ call });
    expect(c.quotaStatus).toBe("live");
    const byType = new Map(c.options.map((o) => [o.type, o]));
    expect(byType.get("ml.g4dn.xlarge")).toMatchObject({ quota: 2, usdPerHour: 0.7364, priceSource: "live" });
    expect(byType.get("ml.g6.xlarge")).toMatchObject({ quota: 1, usdPerHour: 1.0058, priceSource: "live" });
    expect(byType.get("ml.g5.xlarge")).toMatchObject({ quota: 0, priceSource: "table" }); // training quota ignored
    expect(c.priceStatus).toBe("partial");
    expect(c.options.map((o) => o.type)).toEqual(YOLO_INSTANCE_OPTIONS.map((o) => o.type));
    const pricing = calls.find((x) => x.target.endsWith("GetProducts"));
    expect(pricing).toMatchObject({ service: "pricing", hostname: "api.pricing.us-east-1.amazonaws.com" });
    expect(pricing?.body.Filters).toContainEqual({ Type: "TERM_MATCH", Field: "regionCode", Value: "us-east-1" });
    expect(calls.filter((x) => x.target.endsWith("ListAWSDefaultServiceQuotas"))).toHaveLength(2); // paginated
  });

  it("never throws: quotas AND prices failing → the code table, quota unknown, prices approximate", async () => {
    const boom = () => {
      throw new Error("AccessDeniedException");
    };
    const { call } = fakeAws({
      "ServiceQuotasV20190624.ListServiceQuotas": boom,
      "ServiceQuotasV20190624.ListAWSDefaultServiceQuotas": boom,
      "AWSPriceListService.GetProducts": boom,
    });
    const c = await getYoloInstanceCatalog({ call });
    expect(c.quotaStatus).toBe("unavailable");
    expect(c.priceStatus).toBe("approximate");
    expect(c.options.every((o) => o.quota === null && o.priceSource === "table")).toBe(true);
  });

  it.each(["ListServiceQuotas", "ListAWSDefaultServiceQuotas"])(
    "%s failing alone → quotas unavailable (a half-merged map would hide approved types as 0)",
    async (name) => {
      resetYoloInstanceCatalogCache();
      const { call } = fakeAws({
        [`ServiceQuotasV20190624.${name}`]: () => {
          throw new Error("throttled");
        },
      });
      const c = await getYoloInstanceCatalog({ call });
      expect(c.quotaStatus).toBe("unavailable");
      expect(c.options.every((o) => o.quota === null)).toBe(true);
      expect(c.priceStatus).toBe("partial"); // prices unaffected
    },
  );

  it("a quota listing that never ends (page cap hit) → unavailable, not quota 0", async () => {
    const { call } = fakeAws({
      "ServiceQuotasV20190624.ListServiceQuotas": () => ({ Quotas: [], NextToken: "again" }),
    });
    const c = await getYoloInstanceCatalog({ call });
    expect(c.quotaStatus).toBe("unavailable");
    expect(c.options.every((o) => o.quota === null)).toBe(true);
  });

  it("caches for an hour; ?refresh re-reads; a failure is cached only five minutes", async () => {
    let t = Date.parse("2026-10-22T00:00:00Z");
    const now = () => new Date(t);
    const ok = fakeAws();
    await getYoloInstanceCatalog({ call: ok.call, now });
    const first = ok.calls.length;
    t += 59 * 60_000;
    await getYoloInstanceCatalog({ call: ok.call, now });
    expect(ok.calls.length).toBe(first);
    await getYoloInstanceCatalog({ call: ok.call, now, refresh: true });
    expect(ok.calls.length).toBe(first * 2);

    resetYoloInstanceCatalogCache();
    const failing = vi.fn(async () => {
      throw new Error("down");
    });
    await getYoloInstanceCatalog({ call: failing, now });
    const n = failing.mock.calls.length;
    t += 4 * 60_000;
    await getYoloInstanceCatalog({ call: failing, now });
    expect(failing.mock.calls.length).toBe(n);
    t += 2 * 60_000;
    await getYoloInstanceCatalog({ call: failing, now });
    expect(failing.mock.calls.length).toBeGreaterThan(n);
  });
});

describe("parseProcessingPrices", () => {
  it("keeps Processing on-demand hourly prices only, cheapest per type, tolerating junk", () => {
    const prices = parseProcessingPrices([
      product("ml.g5.xlarge", "Processing", "1.41"),
      product("ml.g5.xlarge", "Processing", "1.50"),
      product("ml.g5.xlarge", "Training", "0.10"),
      product("ml.g6.xlarge", "Processing", "0", "Hrs"),
      product("ml.g6e.xlarge", "Processing", "2.33", "GB-Mo"),
      "{not json",
      42,
    ]);
    expect([...prices]).toEqual([["ml.g5.xlarge", 1.41]]);
  });

  it("buildYoloInstanceCatalog: every type priced live → priceStatus live", () => {
    const all = new Map(YOLO_INSTANCE_OPTIONS.map((o) => [o.type, 1]));
    const c = buildYoloInstanceCatalog("us-east-1", all, all, new Date(0));
    expect(c.priceStatus).toBe("live");
    expect(c.options.every((o) => o.quota === 1)).toBe(true);
  });
});
