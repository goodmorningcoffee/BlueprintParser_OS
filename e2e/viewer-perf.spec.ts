// [refactor jun12 P0.4] Viewer performance baseline + golden open path.
// [refactor jun16 P0-review] median-of-3 + a soft regression gate.
//
// THE point of this file (owner mandate): the PDF viewer's performance is
// sacred and nobody fully remembers how it was achieved — so every phase that
// touches src/components/viewer or the hot stores re-runs this spec and
// compares against perf/private-gateway-baseline.json. Numbers are DEV-MODE and machine-local:
// only phase-over-phase deltas mean anything, never absolutes.
//
// Single runs are NOISY on this box (a G6 run once spiked zoom 2-4x then
// returned to baseline = machine noise, not a regression). So each metric is
// now the MEDIAN of N=3 measurement passes (PERF_RUNS env override). A soft
// regression gate fails the run if any comparable median exceeds baseline * factor
// (PERF_REGRESSION_FACTOR, default 1.6 — gross-regression guard, generous on
// purpose so noise doesn't flake CI/owner runs). The checked-in current-protocol reference declares
// two median-of-3 captures with authoritative upstream-byte accounting and fails closed when its
// protocol does not match. It is a same-harness future-regression reference, not source-exact
// before/after attribution; the direct-parent comparison belongs to viewer-perf-v2. The historical
// perf/baseline.json remains provenance for the old direct-CDN/empty-workload harness only.
//
// Measures (100-page / ~62MB synthetic fixture over the Range+CORS cdn-stub):
//   coldOpenWarmMs — reload-to-first-mounted-canvas after a warmup visit.
//                    Painted raster readiness is proven immediately afterward,
//                    outside this historical timing window.
//   nav20Ms        — wall time to scroll+click through 20 sidebar thumbnails,
//                    double-rAF settled per step (page-swap responsiveness).
//                    Pre-scroll per step is REQUIRED: the sidebar is
//                    virtualized (~20 buttons in DOM) and sidebar clicks
//                    suppress its auto-scroll (sidebarClickRef), so far
//                    targets never mount on their own. Protocol is part of
//                    the metric — keep it identical across phases.
//   zoom10Ms       — wall time for 10 wheel-zoom steps over the canvas
//   rafP95NavMs / rafP95ZoomMs — frame-gap p95 during those phases (jank)
import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";

const world = JSON.parse(readFileSync("e2e/.state/world.json", "utf8")) as {
  publicId: string;
  projectDbId: number;
  demoPublicId: string;
  demoProjectDbId: number;
  email: string;
  password: string;
  dataUrl: string;
  demoDataUrl: string;
  outsiderEmail: string;
  outsiderPassword: string;
  outsiderCompanyId: number;
  outsiderUserId: number;
  pages: number;
};

const FIXTURE_PATH = "test/fixtures/synthetic-100pg.pdf";
const FIXTURE_BUCKET = "e2e-dummy-bucket";
const FIXTURE_PROJECT_PATHS = [world.dataUrl, world.demoDataUrl] as const;
const ALLOWED_STUB_PDF_PATHS = [
  ...FIXTURE_PROJECT_PATHS.map((path) => `/${path}/original.pdf`),
  ...FIXTURE_PROJECT_PATHS.map(
    (path) => `/${FIXTURE_BUCKET}/${path}/original.pdf`,
  ),
];
const EXPECTED_UPSTREAM_PDF_PATH = `/${FIXTURE_BUCKET}/${world.dataUrl}/original.pdf`;
const FIXTURE_BYTES = statSync(FIXTURE_PATH).size;
const FIXTURE_SHA256 = createHash("sha256")
  .update(readFileSync(FIXTURE_PATH))
  .digest("hex");
const PDF_PROBE_HEADER = "x-blueprintparser-pdf-range-probe";
const PDF_PROBE_VALUE = "1";
const S3_PDF_PROBE_RANGE = "bytes=0-0";
const INTENTIONAL_ABORT_RANGE = "bytes=0-33554431";
const INTENTIONAL_ABORT_MAX_SOURCE_BYTES = 1024 * 1024;
const TRANSPORT_SETTLE_TIMEOUT_MS = 30_000;
const GATING_RUNS = 3;
const GATING_REGRESSION_FACTOR = 1.6;
const PERF_PROTOCOL_VERSION =
  "private-gateway-populated-v4-lifecycle-abort-authz";
const TRANSPORT_ORACLE_VERSION =
  "private-gateway-transport-oracle-v4-lifecycle-abort-authz";
const CURRENT_BASELINE_PATH = "perf/private-gateway-baseline.json";
const TIMING_KEYS = [
  "coldOpenWarmMs",
  "nav20Ms",
  "zoom10Ms",
  "rafP95NavMs",
  "rafP95ZoomMs",
] as const;

// [refactor jul11 P2.2⑨] The old perf world had no tags, so the final server-collection
// migration's canvas subscription gate was vacuous. Intercept only the viewer metadata response
// and inject a deterministic, realistic project-wide graph: 120 mappings × 30 scored instances
// spread across all 100 pages. Keeping this in the spec (rather than DB seed state) lets exact
// detached pre/post commits run against the identical payload and leaves other E2E cases untouched.
const PERF_YOLO_TAGS = Array.from({ length: 120 }, (_, tagIndex) => ({
  id: `perf-tag-${tagIndex}`,
  name: `D-${String(tagIndex + 1).padStart(3, "0")}`,
  tagText: `D-${String(tagIndex + 1).padStart(3, "0")}`,
  yoloClass:
    tagIndex % 3 === 0
      ? "door_single"
      : tagIndex % 3 === 1
        ? "window"
        : "fixture",
  yoloModel: "perf-fixture-model",
  source: tagIndex % 5 === 0 ? "keynote" : "schedule",
  scope: tagIndex % 5 === 0 ? "page" : "project",
  ...(tagIndex % 5 === 0 ? { pageNumber: (tagIndex % world.pages) + 1 } : {}),
  instances: Array.from({ length: 30 }, (_, instanceIndex) => {
    const pageNumber = ((tagIndex * 7 + instanceIndex * 11) % world.pages) + 1;
    const x = ((tagIndex * 13 + instanceIndex * 3) % 80) / 100;
    const y = ((tagIndex * 5 + instanceIndex * 17) % 80) / 100;
    return {
      pageNumber,
      annotationId: -1,
      bbox: [x, y, Math.min(x + 0.04, 0.99), Math.min(y + 0.03, 0.99)],
      confidence: 0.9 + (instanceIndex % 10) / 100,
      confidenceTier: "high",
    };
  }),
}));

async function settleFrames(page: import("@playwright/test").Page, n = 2) {
  await page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        let left = count;
        const tick = () =>
          --left <= 0 ? resolve() : requestAnimationFrame(tick);
        requestAnimationFrame(tick);
      }),
    n,
  );
}

function startFrameSampler(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const w = window as unknown as { __gaps: number[]; __stop: boolean };
    w.__gaps = [];
    w.__stop = false;
    let last = performance.now();
    const loop = (t: number) => {
      w.__gaps.push(t - last);
      last = t;
      if (!w.__stop) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
}
async function stopFrameSampler(
  page: import("@playwright/test").Page,
): Promise<number[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __gaps: number[]; __stop: boolean };
    w.__stop = true;
    return w.__gaps;
  });
}
const p95 = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length
    ? +s[Math.min(s.length - 1, Math.floor(s.length * 0.95))].toFixed(1)
    : 0;
};
// median of the per-run samples — the noise damper. Odd N picks the middle;
// even N averages the two middles (keeps it sane for PERF_RUNS overrides).
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return 0;
  const mid = Math.floor(s.length / 2);
  return +(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2).toFixed(1);
};

// The sidebar's scroll container has no test id (P0 = no viewer edits), so
// walk up from any mounted thumbnail to the first scrollable ancestor.
function setSidebarScroll(page: import("@playwright/test").Page, top: number) {
  return page.evaluate((t) => {
    let el = document.querySelector("[data-page-num]")?.parentElement ?? null;
    while (el && el.scrollHeight <= el.clientHeight) el = el.parentElement;
    if (!el) throw new Error("sidebar scroll container not found");
    el.scrollTop = t;
    return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  }, top);
}

async function waitForPaintedPdfCanvas(
  page: import("@playwright/test").Page,
  pageNumber: number,
) {
  const activeButton = page.locator(`[data-page-num="${pageNumber}"]`);
  await expect(activeButton, `page ${pageNumber} sidebar witness`).toBeAttached(
    {
      timeout: 120_000,
    },
  );
  await expect
    .poll(
      () =>
        activeButton.evaluate(
          (node) =>
            node.className.includes("bg-[var(--accent)]/20") &&
            node.className.includes("border-[var(--accent)]/40"),
        ),
      { timeout: 120_000, message: `page ${pageNumber} is active` },
    )
    .toBe(true);

  const canvas = page.locator('canvas[data-page-canvas="true"]').first();
  await canvas.waitFor({ state: "attached", timeout: 120_000 });
  await expect
    .poll(
      () =>
        canvas.evaluate((node) => {
          const element = node as HTMLCanvasElement;
          const context = element.getContext("2d");
          if (!context || element.width <= 0 || element.height <= 0) return 0;
          let painted = 0;
          for (const fraction of [0.15, 0.35, 0.5, 0.65, 0.85]) {
            const x = Math.min(
              element.width - 1,
              Math.floor(element.width * fraction),
            );
            const y = Math.min(
              element.height - 1,
              Math.floor(element.height * fraction),
            );
            if (context.getImageData(x, y, 1, 1).data[3] > 0) painted += 1;
          }
          return painted;
        }),
      { timeout: 120_000, message: `page ${pageNumber} canvas is painted` },
    )
    .toBeGreaterThan(0);
  return canvas;
}

async function login(
  page: import("@playwright/test").Page,
  email: string,
  password: string,
) {
  await page.goto("/login");
  await page.getByPlaceholder("Email").first().fill(email);
  await page.getByPlaceholder("Password").first().fill(password);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForURL("**/home**", { timeout: 60_000 });
}

type PrivateAssetSurface = {
  status: number;
  statusText: string;
  body: string;
  headers: Record<string, string | null>;
};

async function fetchPrivateAssetSurface(
  page: import("@playwright/test").Page,
  range: string | null,
): Promise<PrivateAssetSurface> {
  return page.evaluate(
    async ({ path, requestedRange }) => {
      const response = await fetch(path, {
        cache: "no-store",
        credentials: "include",
        ...(requestedRange
          ? { headers: { Range: requestedRange } }
          : undefined),
      });
      const names = [
        "cache-control",
        "content-length",
        "content-type",
        "vary",
        "x-content-type-options",
      ];
      return {
        status: response.status,
        statusText: response.statusText,
        body: await response.text(),
        headers: Object.fromEntries(
          names.map((name) => [name, response.headers.get(name)]),
        ),
      };
    },
    {
      path: `/api/project-assets/${world.publicId}/original.pdf`,
      requestedRange: range,
    },
  );
}

async function expectNoFixtureReads(
  page: import("@playwright/test").Page,
  label: string,
) {
  const { stats, settle } = await waitForS3TransportIdle(page);
  expect(
    settle.elapsedMs,
    `${label}: measured stub settle`,
  ).toBeGreaterThanOrEqual(0);
  expect(
    stats.completedRequests,
    `${label}: zero completed fixture reads`,
  ).toEqual([]);
  expect(stats.activeRequests, `${label}: zero active fixture reads`).toEqual(
    [],
  );
  expect(stats.activeStreamCount, `${label}: zero active fixture streams`).toBe(
    0,
  );
}

async function assertDeniedAssetReads(
  page: import("@playwright/test").Page,
  status: 401 | 404,
  principal: string,
) {
  await resetS3TransportStats(page);
  const full = await fetchPrivateAssetSurface(page, null);
  const ranged = await fetchPrivateAssetSurface(page, "bytes=1048576-2097151");
  expect(full.status, `${principal}: full GET status`).toBe(status);
  expect(ranged.status, `${principal}: Range GET status`).toBe(status);
  expect(
    ranged,
    `${principal}: full and Range denials are indistinguishable`,
  ).toEqual(full);
  expect(full.headers["cache-control"], `${principal}: private no-store`).toBe(
    "private, no-store",
  );
  const vary = (full.headers.vary ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase());
  expect(vary, `${principal}: identity/range vary`).toEqual(
    expect.arrayContaining([
      "cookie",
      "authorization",
      "range",
      "x-blueprintparser-pdf-range-probe",
    ]),
  );
  await expectNoFixtureReads(page, principal);
}

async function assertStubRangeContract(page: import("@playwright/test").Page) {
  await resetS3TransportStats(page);
  const allowedUrl = `https://localhost:9876${EXPECTED_UPSTREAM_PDF_PATH}`;
  const disallowedUrl =
    "https://localhost:9876/e2e-dummy-bucket/not-a-seeded-project/original.pdf";
  const result = await page.evaluate(
    async ({ allowed, disallowed, bytes }) => {
      const suffix = await fetch(allowed, {
        cache: "no-store",
        headers: { Range: "bytes=-257" },
      });
      const suffixBytes = (await suffix.arrayBuffer()).byteLength;
      const oversizedSuffix = await fetch(allowed, {
        method: "HEAD",
        cache: "no-store",
        headers: { Range: `bytes=-${bytes + 1}` },
      });
      const zeroSuffix = await fetch(allowed, {
        cache: "no-store",
        headers: { Range: "bytes=-0" },
      });
      const disallowedResponse = await fetch(disallowed, {
        cache: "no-store",
        headers: { Range: "bytes=0-0" },
      });
      return {
        suffix: {
          status: suffix.status,
          bytes: suffixBytes,
          contentRange: suffix.headers.get("content-range"),
        },
        oversizedSuffix: {
          status: oversizedSuffix.status,
          contentLength: oversizedSuffix.headers.get("content-length"),
          contentRange: oversizedSuffix.headers.get("content-range"),
        },
        zeroSuffixStatus: zeroSuffix.status,
        disallowed: {
          status: disallowedResponse.status,
          body: await disallowedResponse.text(),
        },
      };
    },
    { allowed: allowedUrl, disallowed: disallowedUrl, bytes: FIXTURE_BYTES },
  );
  expect(result.suffix).toEqual({
    status: 206,
    bytes: 257,
    contentRange: `bytes ${FIXTURE_BYTES - 257}-${FIXTURE_BYTES - 1}/${FIXTURE_BYTES}`,
  });
  expect(result.oversizedSuffix).toEqual({
    status: 206,
    contentLength: String(FIXTURE_BYTES),
    contentRange: `bytes 0-${FIXTURE_BYTES - 1}/${FIXTURE_BYTES}`,
  });
  expect(result.zeroSuffixStatus).toBe(416);
  expect(result.disallowed).toEqual({ status: 404, body: "not found" });

  const { stats } = await waitForS3TransportIdle(page);
  expect(stats.completedRequests).toHaveLength(3);
  expect(
    stats.completedRequests.every(
      (request) => request.pathname === EXPECTED_UPSTREAM_PDF_PATH,
    ),
    "only the exact allowed fixture path is accounted",
  ).toBe(true);
  await resetS3TransportStats(page);
}

async function assertIntentionalRangeAbort(
  page: import("@playwright/test").Page,
) {
  await resetS3TransportStats(page);
  const gatewayPath = `/api/project-assets/${world.publicId}/original.pdf`;
  const browser = await page.evaluate(
    async ({ path, range }) => {
      const controller = new AbortController();
      const response = await fetch(path, {
        cache: "no-store",
        credentials: "include",
        headers: { Range: range },
        signal: controller.signal,
      });
      if (!response.body) throw new Error("abort witness response has no body");
      const reader = response.body.getReader();
      const first = await reader.read();
      controller.abort("intentional private-gateway transport witness");
      let secondRead: string;
      try {
        const next = await reader.read();
        secondRead = next.done ? "done" : `bytes:${next.value.byteLength}`;
      } catch (error) {
        secondRead = error instanceof Error ? error.name : String(error);
      }
      let teardown: string;
      try {
        await reader.cancel("intentional witness teardown");
        teardown = "cancelled";
      } catch (error) {
        // An AbortError means the signal already performed the same teardown.
        teardown = error instanceof Error ? error.name : String(error);
      }
      return {
        status: response.status,
        contentRange: response.headers.get("content-range"),
        firstBytes: first.done ? 0 : first.value.byteLength,
        secondRead,
        teardown,
      };
    },
    { path: gatewayPath, range: INTENTIONAL_ABORT_RANGE },
  );
  expect(browser.status, "intentional abort response status").toBe(206);
  expect(browser.contentRange, "intentional abort response range").toBe(
    `bytes 0-33554431/${FIXTURE_BYTES}`,
  );
  expect(
    browser.firstBytes,
    "intentional abort reads one browser chunk",
  ).toBeGreaterThan(0);
  expect(
    browser.firstBytes <= INTENTIONAL_ABORT_MAX_SOURCE_BYTES,
    "intentional abort browser bytes stay bounded",
  ).toBe(true);
  expect(
    ["AbortError", "cancelled"],
    "intentional abort teardown result",
  ).toContain(browser.teardown);
  expect(browser.secondRead, "intentional abort stops the next read").toBe(
    "AbortError",
  );

  const { stats, settle } = await waitForS3TransportIdle(page);
  expect(
    settle.elapsedMs,
    "intentional abort source settle",
  ).toBeLessThanOrEqual(TRANSPORT_SETTLE_TIMEOUT_MS);
  expect(stats.completedRequests).toHaveLength(1);
  const [request] = stats.completedRequests;
  expect(request.pathname, "intentional abort fixture path").toBe(
    EXPECTED_UPSTREAM_PDF_PATH,
  );
  expect(request.range, "intentional abort fixture range").toBe(
    INTENTIONAL_ABORT_RANGE,
  );
  expect(request.outcome, "intentional abort response closes").toBe("close");
  expect(request.sourceDestroyedOnResponseClose).toBe(true);
  expect(request.sourceClosed, "intentional abort source closes").toBe(true);
  expect(request.sourceDestroyed, "intentional abort source tears down").toBe(
    true,
  );
  expect(request.sourceEnded, "intentional abort does not drain source").toBe(
    false,
  );
  expect(request.throttleCreated).toBe(true);
  expect(request.throttleClosed, "intentional abort throttle tears down").toBe(
    true,
  );
  expect(
    request.sourceBytes,
    "intentional abort reads source bytes",
  ).toBeGreaterThan(0);
  expect(
    request.sourceBytes <= INTENTIONAL_ABORT_MAX_SOURCE_BYTES,
    "intentional abort source bytes stay bounded",
  ).toBe(true);
  expect(
    request.sourceBytes < (request.expectedBodyBytes ?? 0),
    "intentional abort cannot drain its advertised range",
  ).toBe(true);
  expect(stats.activeCount).toBe(0);
  expect(stats.activeStreamCount).toBe(0);
  await resetS3TransportStats(page);
}

interface PerfSample {
  coldOpenWarmMs: number;
  nav20Ms: number;
  zoom10Ms: number;
  rafP95NavMs: number;
  rafP95ZoomMs: number;
  pdfTransport: {
    browserRequests: number;
    browserFullGets: number;
    browserRangeRequests: number;
    browserOrdinaryRangeRequests: number;
    browserProbeRequests: number;
    browserMeasuredResponseBytes: number;
    browserUnmeasuredRequests: number;
    upstreamRequests: number;
    upstreamFullGets: number;
    upstreamRangeRequests: number;
    upstreamOrdinaryRangeRequests: number;
    upstreamProbeRequests: number;
    upstreamProbeBytes: number;
    upstreamFullGetBytes: number;
    upstreamResponseBytes: number;
    outstandingAtZoomStart: number;
    settle: {
      beforeReloadMs: number;
      beforeZoomMs: number;
      afterZoomMs: number;
      upstreamAfterZoomMs: number;
    };
  };
}

type PerfPhase = "setup" | "cold" | "nav" | "zoom" | "idle";
type PdfTransportObservation = {
  phase: PerfPhase;
  range: string | null;
  pathname: string;
  pdfProbe: boolean;
  startedAt: number;
  finishedAt?: number;
  status?: number;
  advertisedBytes?: number;
  responseBytes?: number;
};
type PdfTransportTelemetry = {
  phase: PerfPhase;
  observations: PdfTransportObservation[];
  active: Map<import("@playwright/test").Request, PdfTransportObservation>;
};

type UpstreamTransportRequest = {
  id: number;
  method: string;
  pathname: string;
  range: string | null;
  servedRange: string | null;
  expectedBodyBytes: number | null;
  bodyBytes: number;
  status: number | null;
  outcome: string | null;
  sourceBytes: number;
  sourceCreated: boolean;
  sourceEnded: boolean;
  sourceClosed: boolean;
  sourceDestroyed: boolean;
  sourceDestroyedOnResponseClose: boolean;
  sourceError: string | null;
  throttleCreated: boolean;
  throttleClosed: boolean;
};
type UpstreamTransportStats = {
  schemaVersion: 2;
  fixture: {
    bytes: number;
    bucket: string;
    projectPaths: string[];
    allowedPdfPaths: string[];
    intentionalAbortRange: string;
    sourceChunkBytes: number;
    abortChunkDelayMs: number;
  };
  activeCount: number;
  activeStreamCount: number;
  activeRequests: UpstreamTransportRequest[];
  completedRequests: UpstreamTransportRequest[];
};
type TransportSettleWitness = {
  elapsedMs: number;
  polls: number;
  initialActive: number;
};

const S3_TRANSPORT_STATS_URL = "https://localhost:9876/__bp_e2e_s3_transport";

async function fetchS3TransportStats(
  page: import("@playwright/test").Page,
): Promise<UpstreamTransportStats> {
  const response = await page.evaluate(async (url) => {
    const result = await fetch(url, { cache: "no-store" });
    return { status: result.status, body: await result.text() };
  }, S3_TRANSPORT_STATS_URL);
  expect(response.status, "S3 fixture stats status").toBe(200);
  const body = JSON.parse(response.body) as Partial<UpstreamTransportStats>;
  expect(body.schemaVersion, "S3 fixture stats schema").toBe(2);
  expect(body.fixture, "S3 fixture contract").toEqual({
    bytes: FIXTURE_BYTES,
    bucket: FIXTURE_BUCKET,
    projectPaths: FIXTURE_PROJECT_PATHS,
    allowedPdfPaths: ALLOWED_STUB_PDF_PATHS,
    intentionalAbortRange: INTENTIONAL_ABORT_RANGE,
    sourceChunkBytes: 64 * 1024,
    abortChunkDelayMs: 20,
  });
  expect(Number.isInteger(body.activeCount), "S3 fixture active count").toBe(
    true,
  );
  expect(
    Number.isInteger(body.activeStreamCount),
    "S3 fixture active stream count",
  ).toBe(true);
  expect(Array.isArray(body.activeRequests), "S3 fixture active rows").toBe(
    true,
  );
  expect(
    Array.isArray(body.completedRequests),
    "S3 fixture completed rows",
  ).toBe(true);
  expect(
    body.activeCount,
    "S3 fixture active count must match its active rows",
  ).toBe(body.activeRequests?.length);
  expect(
    (body.activeStreamCount ?? 0) >= 0,
    "S3 fixture active stream count is non-negative",
  ).toBe(true);
  const ids = new Set<number>();
  for (const request of [
    ...(body.activeRequests ?? []),
    ...(body.completedRequests ?? []),
  ]) {
    expect(["GET", "HEAD"], "S3 fixture request method allowlist").toContain(
      request.method,
    );
    expect(
      ALLOWED_STUB_PDF_PATHS,
      "S3 fixture request pathname allowlist",
    ).toContain(request.pathname);
    expect(
      Number.isSafeInteger(request.bodyBytes) && request.bodyBytes >= 0,
      "S3 fixture request byte count",
    ).toBe(true);
    expect(
      request.range === null || /^bytes=(?:\d+-\d*|-\d+)$/u.test(request.range),
      "S3 fixture request range",
    ).toBe(true);
    for (const [field, value] of [
      ["sourceBytes", request.sourceBytes],
      ["expectedBodyBytes", request.expectedBodyBytes],
    ] as const) {
      expect(
        value === null || (Number.isSafeInteger(value) && value >= 0),
        `S3 fixture ${field}`,
      ).toBe(true);
    }
    expect(Number.isSafeInteger(request.id), "S3 fixture request id").toBe(
      true,
    );
    expect(ids.has(request.id), "S3 fixture request ids must be unique").toBe(
      false,
    );
    ids.add(request.id);
  }
  for (const request of body.completedRequests ?? []) {
    expect([200, 206, 416], "completed S3 fixture response status").toContain(
      request.status,
    );
    expect(
      request.outcome === "finish" || request.outcome === "close",
      "completed S3 fixture response outcome",
    ).toBe(true);
    if (request.sourceCreated) {
      expect(request.sourceClosed, "completed source must close").toBe(true);
      expect(request.sourceDestroyed, "completed source must teardown").toBe(
        true,
      );
      expect(request.sourceError, "completed source error").toBeNull();
      if (request.throttleCreated) {
        expect(request.throttleClosed, "completed throttle must close").toBe(
          true,
        );
      }
    } else {
      expect(request.sourceBytes, "source-free response bytes").toBe(0);
    }

    if (request.status === 416 || request.method === "HEAD") {
      expect(request.sourceCreated, "HEAD/416 must not open the fixture").toBe(
        false,
      );
      expect(request.bodyBytes, "HEAD/416 response body bytes").toBe(0);
      continue;
    }

    expect(request.sourceCreated, "GET success must open the fixture").toBe(
      true,
    );
    expect(request.expectedBodyBytes, "GET expected byte count").not.toBeNull();
    if (request.status === 206) {
      const rangeMatch = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(
        request.servedRange ?? "",
      );
      expect(rangeMatch, "completed 206 Content-Range").not.toBeNull();
      if (rangeMatch) {
        const start = Number(rangeMatch[1]);
        const end = Number(rangeMatch[2]);
        const total = Number(rangeMatch[3]);
        expect(total, "completed 206 fixture total").toBe(FIXTURE_BYTES);
        expect(
          request.expectedBodyBytes,
          "completed 206 uses inclusive Range accounting",
        ).toBe(end - start + 1);
      }
    }
    if (request.outcome === "finish") {
      expect(
        request.bodyBytes,
        "finished response emits its exact inclusive byte count",
      ).toBe(request.expectedBodyBytes);
      expect(
        request.sourceBytes,
        "finished response reads its exact inclusive byte count",
      ).toBe(request.expectedBodyBytes);
      expect(request.sourceEnded, "finished source reaches EOF").toBe(true);
    } else {
      expect(
        request.bodyBytes <= (request.expectedBodyBytes ?? -1),
        "closed response cannot emit beyond its advertised range",
      ).toBe(true);
      expect(
        request.sourceBytes <= (request.expectedBodyBytes ?? -1),
        "closed source cannot read beyond its advertised range",
      ).toBe(true);
    }
  }
  return body as UpstreamTransportStats;
}

async function waitForS3TransportIdle(
  page: import("@playwright/test").Page,
): Promise<{
  stats: UpstreamTransportStats;
  settle: TransportSettleWitness;
}> {
  const started = performance.now();
  const deadline = Date.now() + TRANSPORT_SETTLE_TIMEOUT_MS;
  let stats = await fetchS3TransportStats(page);
  const initialActive = stats.activeCount + stats.activeStreamCount;
  let polls = 1;
  while (
    (stats.activeCount > 0 || stats.activeStreamCount > 0) &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    stats = await fetchS3TransportStats(page);
    polls += 1;
  }
  expect(stats.activeCount, "S3 fixture transport must settle").toBe(0);
  expect(stats.activeStreamCount, "S3 fixture streams must settle").toBe(0);
  const elapsedMs = +(performance.now() - started).toFixed(1);
  expect(
    elapsedMs <= TRANSPORT_SETTLE_TIMEOUT_MS,
    "S3 fixture transport settle is bounded",
  ).toBe(true);
  return { stats, settle: { elapsedMs, polls, initialActive } };
}

async function resetS3TransportStats(
  page: import("@playwright/test").Page,
): Promise<void> {
  await waitForS3TransportIdle(page);
  const response = await page.evaluate(async (url) => {
    const result = await fetch(url, { method: "POST", cache: "no-store" });
    return { status: result.status, body: await result.text() };
  }, S3_TRANSPORT_STATS_URL);
  expect(
    response,
    `S3 fixture stats reset failed: ${response.status} ${response.body}`,
  ).toEqual({ status: 204, body: "" });
}

async function waitForPdfTransportIdle(
  telemetry: PdfTransportTelemetry,
): Promise<TransportSettleWitness> {
  const started = performance.now();
  const deadline = Date.now() + TRANSPORT_SETTLE_TIMEOUT_MS;
  const initialActive = telemetry.active.size;
  let polls = 0;
  while (telemetry.active.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    polls += 1;
  }
  expect(telemetry.active.size, "PDF transport must settle before zoom").toBe(
    0,
  );
  const elapsedMs = +(performance.now() - started).toFixed(1);
  expect(
    elapsedMs <= TRANSPORT_SETTLE_TIMEOUT_MS,
    "browser PDF transport settle is bounded",
  ).toBe(true);
  return { elapsedMs, polls, initialActive };
}

// One full measurement pass (cold-open via reload → nav → zoom). Called N times
// for the median. performance.now() (monotonic) for the wall-time deltas.
async function measureOnce(
  page: import("@playwright/test").Page,
  telemetry: PdfTransportTelemetry,
): Promise<PerfSample> {
  telemetry.phase = "idle";
  const beforeReload = await waitForPdfTransportIdle(telemetry);
  await resetS3TransportStats(page);
  const transportStart = telemetry.observations.length;
  // ── cold-open (warm route): reload → first canvas ──
  // 120s ceiling (not 60s): a turbopack dev server degraded by a prior spec run
  // can take >60s to re-render. The metric is the measured time, not the ceiling;
  // for clean numbers run this spec in ISOLATION (npm run e2e -- e2e/viewer-perf.spec.ts).
  telemetry.phase = "cold";
  const t0 = performance.now();
  await page.reload();
  await page.waitForSelector("canvas", { timeout: 120_000 });
  const coldOpenWarmMs = Math.round(performance.now() - t0);
  // Preserve the captured timing boundary above, then make the result
  // non-vacuous: page 1 must be active and its PDF raster must contain paint.
  await waitForPaintedPdfCanvas(page, 1);
  await settleFrames(page, 10);

  // derive itemHeight from the virtualized list (spacer height / numPages);
  // headers make it inexact but VIRTUAL_BUFFER absorbs the error
  const { scrollHeight } = await setSidebarScroll(
    page,
    Number.MAX_SAFE_INTEGER,
  );
  await setSidebarScroll(page, 0);
  await settleFrames(page, 2);
  const itemHeight = scrollHeight / world.pages;

  // ── page-nav: scroll+click through 20 thumbnails ──
  telemetry.phase = "nav";
  await startFrameSampler(page);
  const tNav = performance.now();
  for (let n = 2; n <= 21; n++) {
    await setSidebarScroll(page, (n - 1) * itemHeight);
    await settleFrames(page, 2); // scroll → rAF'd setScrollTop → window remount
    await page.locator(`[data-page-num="${n}"]`).click();
    await settleFrames(page, 2);
  }
  const nav20Ms = Math.round(performance.now() - tNav);
  const navGaps = await stopFrameSampler(page);
  // As above, this outcome witness is outside the historical timing window.
  await waitForPaintedPdfCanvas(page, 21);

  // ── wheel-zoom: 10 steps at canvas center ──
  telemetry.phase = "idle";
  const beforeZoom = await waitForPdfTransportIdle(telemetry);
  const outstandingAtZoomStart = telemetry.active.size;
  const canvas = page.locator('canvas[data-page-canvas="true"]').first();
  const box = await canvas.boundingBox();
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  telemetry.phase = "zoom";
  await startFrameSampler(page);
  const tZoom = performance.now();
  for (let i = 0; i < 10; i++) {
    await page.mouse.wheel(0, -120);
    await settleFrames(page, 2);
  }
  const zoom10Ms = Math.round(performance.now() - tZoom);
  const zoomGaps = await stopFrameSampler(page);
  telemetry.phase = "idle";
  const afterZoom = await waitForPdfTransportIdle(telemetry);
  const { stats: upstream, settle: upstreamAfterZoom } =
    await waitForS3TransportIdle(page);

  const transport = telemetry.observations.slice(transportStart);
  const upstreamRequests = upstream.completedRequests;
  expect(
    transport.every(
      (request) =>
        request.pathname ===
        `/api/project-assets/${world.publicId}/original.pdf`,
    ),
    "measured browser PDF requests use only the exact private gateway path",
  ).toBe(true);
  expect(
    transport.every((request) => request.pdfProbe),
    "pdf.js applies the viewer marker header to every gateway PDF request",
  ).toBe(true);
  expect(
    upstreamRequests.every(
      (request) => request.pathname === EXPECTED_UPSTREAM_PDF_PATH,
    ),
    "measured upstream reads use only the exact bucket/project fixture path",
  ).toBe(true);
  expect(
    upstreamRequests.every(
      (request) => request.status === 206 && request.outcome === "finish",
    ),
    "measured upstream ranges complete with inclusive byte accounting",
  ).toBe(true);

  return {
    coldOpenWarmMs,
    nav20Ms,
    zoom10Ms,
    rafP95NavMs: p95(navGaps),
    rafP95ZoomMs: p95(zoomGaps),
    pdfTransport: {
      browserRequests: transport.length,
      browserFullGets: transport.filter((request) => request.range === null)
        .length,
      browserRangeRequests: transport.filter(
        (request) => request.range !== null,
      ).length,
      browserOrdinaryRangeRequests: transport.filter(
        (request) =>
          request.range !== null && request.range !== S3_PDF_PROBE_RANGE,
      ).length,
      browserProbeRequests: transport.filter(
        (request) => request.pdfProbe && request.range === null,
      ).length,
      browserMeasuredResponseBytes: transport.reduce(
        (total, request) => total + (request.responseBytes ?? 0),
        0,
      ),
      browserUnmeasuredRequests: transport.filter(
        (request) => request.responseBytes === undefined,
      ).length,
      upstreamRequests: upstreamRequests.length,
      upstreamFullGets: upstreamRequests.filter(
        (request) => request.range === null,
      ).length,
      upstreamRangeRequests: upstreamRequests.filter(
        (request) => request.range !== null,
      ).length,
      upstreamOrdinaryRangeRequests: upstreamRequests.filter(
        (request) =>
          request.range !== null && request.range !== S3_PDF_PROBE_RANGE,
      ).length,
      upstreamProbeRequests: upstreamRequests.filter(
        (request) => request.range === S3_PDF_PROBE_RANGE,
      ).length,
      upstreamProbeBytes: upstreamRequests
        .filter((request) => request.range === S3_PDF_PROBE_RANGE)
        .reduce((total, request) => total + request.bodyBytes, 0),
      upstreamFullGetBytes: upstreamRequests
        .filter((request) => request.range === null)
        .reduce((total, request) => total + request.bodyBytes, 0),
      upstreamResponseBytes: upstreamRequests.reduce(
        (total, request) => total + request.bodyBytes,
        0,
      ),
      outstandingAtZoomStart,
      settle: {
        beforeReloadMs: beforeReload.elapsedMs,
        beforeZoomMs: beforeZoom.elapsedMs,
        afterZoomMs: afterZoom.elapsedMs,
        upstreamAfterZoomMs: upstreamAfterZoom.elapsedMs,
      },
    },
  };
}

const diagnosticRaw = process.env.PERF_DIAGNOSTIC;
if (diagnosticRaw !== undefined && !["0", "1"].includes(diagnosticRaw)) {
  throw new Error("PERF_DIAGNOSTIC must be exactly 0 or 1");
}
const DIAGNOSTIC = diagnosticRaw === "1";
const RUNS = Number(process.env.PERF_RUNS ?? GATING_RUNS);
const REGRESSION_FACTOR = Number(
  process.env.PERF_REGRESSION_FACTOR ?? GATING_REGRESSION_FACTOR,
);
if (!Number.isSafeInteger(RUNS) || RUNS < 1) {
  throw new Error("PERF_RUNS must be a positive integer");
}
if (!Number.isFinite(REGRESSION_FACTOR) || REGRESSION_FACTOR < 1) {
  throw new Error("PERF_REGRESSION_FACTOR must be a finite number >= 1");
}
if (
  !DIAGNOSTIC &&
  (RUNS !== GATING_RUNS || REGRESSION_FACTOR !== GATING_REGRESSION_FACTOR)
) {
  throw new Error(
    "gating protocol is fixed at PERF_RUNS=3 and PERF_REGRESSION_FACTOR=1.6; " +
      "set PERF_DIAGNOSTIC=1 for explicit non-gating overrides",
  );
}

test("viewer perf baseline on the synthetic 100-page set", async ({ page }) => {
  // median-of-N is N× the measurement work; the default 180s test timeout is
  // for a single pass. Scale it (warmup compile can be slow when the dev server
  // is loaded from prior specs).
  test.setTimeout(Math.max(180_000, RUNS * 150_000));
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  const pdfTransport: PdfTransportTelemetry = {
    phase: "setup",
    observations: [],
    active: new Map(),
  };
  const isPdfGatewayRequest = (url: string) =>
    new URL(url).pathname ===
    `/api/project-assets/${world.publicId}/original.pdf`;
  page.on("request", (request) => {
    if (!isPdfGatewayRequest(request.url())) return;
    const observation: PdfTransportObservation = {
      phase: pdfTransport.phase,
      range: request.headers().range ?? null,
      pathname: new URL(request.url()).pathname,
      pdfProbe: request.headers()[PDF_PROBE_HEADER] === PDF_PROBE_VALUE,
      startedAt: performance.now(),
    };
    pdfTransport.observations.push(observation);
    pdfTransport.active.set(request, observation);
  });
  page.on("response", (response) => {
    const observation = pdfTransport.active.get(response.request());
    if (!observation) return;
    observation.status = response.status();
    const contentLength = Number(response.headers()["content-length"]);
    if (Number.isFinite(contentLength))
      observation.advertisedBytes = contentLength;
  });
  const finishPdfRequest = (
    request: import("@playwright/test").Request,
    responseBytes?: number,
  ) => {
    const observation = pdfTransport.active.get(request);
    if (!observation) return;
    if (responseBytes !== undefined) observation.responseBytes = responseBytes;
    observation.finishedAt = performance.now();
    pdfTransport.active.delete(request);
  };
  page.on("requestfinished", async (request) => {
    try {
      const sizes = await request.sizes();
      finishPdfRequest(request, sizes.responseBodySize);
    } catch {
      finishPdfRequest(request);
    }
  });
  page.on("requestfailed", async (request) => {
    try {
      const sizes = await request.sizes();
      finishPdfRequest(request, sizes.responseBodySize);
    } catch {
      // Chromium cannot report actual bytes for an aborted request. Leave this explicitly unknown;
      // the S3-shaped fixture's upstream accounting below is the fail-closed transport authority.
      finishPdfRequest(request);
    }
  });

  // Fetch the real bootstrap once, then replay the identical populated payload for each measured
  // reload. Without this cache, the perf loop measures/consumes middleware's shared API budget;
  // once that bucket fills, a later reload renders "Failed to load project" instead of a canvas.
  // The server response is still exercised once, while every timed pass gets the same input.
  let cachedProjectBody: Record<string, unknown> | null = null;
  await page.route(`**/api/projects/${world.publicId}`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    if (!cachedProjectBody) {
      const response = await route.fetch();
      expect(response.ok(), "perf project bootstrap should succeed").toBe(true);
      const body = (await response.json()) as Record<string, unknown> & {
        projectIntelligence?: Record<string, unknown>;
      };
      cachedProjectBody = {
        ...body,
        projectIntelligence: {
          ...(body.projectIntelligence ?? {}),
          yoloTags: PERF_YOLO_TAGS,
        },
      };
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: cachedProjectBody,
    });
  });
  // Page-window reads are repeated across the warmup and three reloads too. Cache each distinct
  // range after its first real response so later passes cannot turn into 429-driven blank pages.
  const cachedPageWindows = new Map<string, unknown>();
  await page.route(
    `**/api/projects/${world.publicId}/pages?*`,
    async (route) => {
      const key = route.request().url();
      if (!cachedPageWindows.has(key)) {
        const response = await route.fetch();
        expect(response.ok(), `perf page window should succeed: ${key}`).toBe(
          true,
        );
        cachedPageWindows.set(key, await response.json());
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: cachedPageWindows.get(key),
      });
    },
  );
  // The populated perf world deliberately has no Textract rows. Production maps that state to the
  // stable payload below, but letting 100+ lazy reads compile/hit Postgres during the measured
  // reloads makes a canvas benchmark mostly measure background API work. Validate the exact request
  // identity, then provide the same null contract at the browser boundary for every page.
  await page.route("**/api/pages/textract?*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pageNumber = Number(url.searchParams.get("pageNumber"));
    expect(request.method(), "perf Textract method").toBe("GET");
    expect(url.searchParams.get("publicId"), "perf Textract project").toBe(
      world.publicId,
    );
    expect(
      Number.isInteger(pageNumber) &&
        pageNumber >= 1 &&
        pageNumber <= world.pages,
      "perf Textract page",
    ).toBe(true);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Cache-Control": "private, max-age=3600" },
      json: { textractData: null },
    });
  });
  // Annotation groups are real bootstrap data, so exercise that route once during the untimed
  // warmup and replay its exact payload for measured reloads (the perf-v2 harness uses the same
  // isolation). This removes per-reload DB variance without inventing viewer state.
  let cachedGroups: unknown;
  await page.route("**/api/annotation-groups?*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    expect(request.method(), "perf annotation-groups method").toBe("GET");
    expect(
      url.searchParams.get("projectId"),
      "perf annotation-groups project",
    ).toBe(world.publicId);
    if (cachedGroups === undefined) {
      const response = await route.fetch();
      expect(response.ok(), "perf annotation groups should succeed").toBe(true);
      cachedGroups = await response.json();
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: cachedGroups,
    });
  });
  // The offline fixture intentionally has no page/thumbnail PNG underlays. Fulfill those known
  // misses at the current browser boundary: this benchmark measures the PDF canvas path, not
  // dozens of expected gateway DB/S3 404 admissions continuing behind nav and zoom.
  await page.route(
    /\/api\/project-assets\/[^/]+\/(?:pages|thumbnails)\/page_\d{4}\.png(?:\?.*)?$/,
    (route) =>
      route.fulfill({
        status: 404,
        contentType: "text/plain",
        body: "not found",
      }),
  );

  // ── transport/authz oracle (untimed) ──
  await page.goto("/login");
  await assertStubRangeContract(page);
  await assertDeniedAssetReads(page, 401, "logged-out principal");

  await login(page, world.outsiderEmail, world.outsiderPassword);
  await assertDeniedAssetReads(page, 404, "second-tenant principal");

  await page.context().clearCookies();
  await page.goto("/login");
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  // ── login (golden path: real owner-tenant credentials form) ──
  await login(page, world.email, world.password);
  await assertIntentionalRangeAbort(page);

  // ── warmup visit: compiles the route, primes pdf.js worker chunk ──
  await page.goto(`/project/${world.publicId}`);
  await waitForPaintedPdfCanvas(page, 1);
  await settleFrames(page, 10);

  // ── golden assertions (once): the sidebar VIRTUALIZES (PageSidebar
  // ITEM_HEIGHT window + buffer) — freeze that: page 1 mounted, page 100 NOT,
  // only a window's worth of buttons in the DOM…
  await expect(page.locator('[data-page-num="1"]')).toBeAttached({
    timeout: 30_000,
  });
  await expect(page.locator('[data-page-num="100"]')).not.toBeAttached();
  expect(await page.locator("[data-page-num]").count()).toBeLessThan(30);
  // …while every page stays REACHABLE by scroll (page 100 mounts at bottom)
  await setSidebarScroll(page, Number.MAX_SAFE_INTEGER);
  await expect(page.locator('[data-page-num="100"]')).toBeAttached({
    timeout: 10_000,
  });
  await setSidebarScroll(page, 0);
  await settleFrames(page, 2);

  // ── median-of-N measurement passes (noise damper) ──
  const samples: PerfSample[] = [];
  for (let i = 0; i < RUNS; i++) {
    samples.push(await measureOnce(page, pdfTransport));
  }

  // no uncaught page errors during the whole run (404'd PNG underlays are
  // fine and expected offline; exceptions are not)
  expect(pageErrors).toEqual([]);

  // [refactor jul14 P2 review] PDF.js issues one browser capability-probe GET before switching to
  // ranges. The marked probe must become exactly one upstream byte-range request, never an S3 full
  // GET whose socket buffers race downstream cancellation. This transport-security/performance
  // invariant is independent of noisy dev-mode wall-clock medians.
  for (const [index, sample] of samples.entries()) {
    const label = `PDF transport sample ${index + 1}`;
    expect(
      sample.pdfTransport.browserFullGets,
      `${label}: browser capability probes`,
    ).toBe(1);
    expect(
      sample.pdfTransport.upstreamFullGets,
      `${label}: upstream full GETs`,
    ).toBe(0);
    expect(
      sample.pdfTransport.upstreamFullGetBytes,
      `${label}: upstream full-GET bytes`,
    ).toBe(0);
    expect(
      sample.pdfTransport.upstreamProbeRequests,
      `${label}: one-byte upstream probes`,
    ).toBe(1);
    expect(
      sample.pdfTransport.upstreamProbeBytes,
      `${label}: upstream probe bytes`,
    ).toBe(1);
    expect(
      sample.pdfTransport.browserProbeRequests,
      `${label}: marked browser probes`,
    ).toBe(1);
    expect(
      sample.pdfTransport.browserOrdinaryRangeRequests,
      `${label}: browser ordinary ranges`,
    ).toBeGreaterThan(0);
    expect(
      sample.pdfTransport.upstreamOrdinaryRangeRequests,
      `${label}: upstream ordinary ranges`,
    ).toBeGreaterThan(0);
    expect(
      sample.pdfTransport.upstreamRangeRequests,
      `${label}: upstream range requests`,
    ).toBeGreaterThan(0);
    expect(
      sample.pdfTransport.upstreamResponseBytes,
      `${label}: upstream total response bytes`,
    ).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(
      sample.pdfTransport.outstandingAtZoomStart,
      `${label}: outstanding at zoom`,
    ).toBe(0);
    for (const [phase, elapsedMs] of Object.entries(
      sample.pdfTransport.settle,
    )) {
      expect(
        elapsedMs,
        `${label}: ${phase} settle measured`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        elapsedMs,
        `${label}: ${phase} settle bounded`,
      ).toBeLessThanOrEqual(TRANSPORT_SETTLE_TIMEOUT_MS);
    }
  }

  const fixtureContract = {
    version: "synthetic-100pg-seed-b1ce-target60mb",
    pages: world.pages,
    bytes: FIXTURE_BYTES,
    sha256: FIXTURE_SHA256,
    bucket: FIXTURE_BUCKET,
    projectPaths: FIXTURE_PROJECT_PATHS,
    allowedStubPdfPaths: ALLOWED_STUB_PDF_PATHS,
    yoloTags: PERF_YOLO_TAGS.length,
    yoloInstances: PERF_YOLO_TAGS.reduce(
      (sum, tag) => sum + tag.instances.length,
      0,
    ),
    underlays: "absent (404) — pure pdf.js canvas path",
  };
  const harnessContract = {
    gatingRuns: GATING_RUNS,
    gatingRegressionFactorExclusive: GATING_REGRESSION_FACTOR,
    diagnosticOptIn: "PERF_DIAGNOSTIC=1",
    diagnosticRunsAreGating: false,
    timingAggregation: "median of three samples",
    captureAggregation: "median of independent capture medians",
    paintedOutcomePages: [1, 21],
    paintedOutcomeWaitsOutsideHistoricalTimingWindows: true,
  };
  const transportContract = {
    oracleVersion: TRANSPORT_ORACLE_VERSION,
    stubSchemaVersion: 2,
    browserBoundary: "same-origin private project-asset gateway",
    expectedUpstreamPdfPath: EXPECTED_UPSTREAM_PDF_PATH,
    probeRange: S3_PDF_PROBE_RANGE,
    ordinaryRangeDefinition: "non-null Range other than bytes=0-0",
    maxUpstreamResponseBytesPerSample: 16 * 1024 * 1024,
    settleTimeoutMs: TRANSPORT_SETTLE_TIMEOUT_MS,
    intentionalAbort: {
      range: INTENTIONAL_ABORT_RANGE,
      maxSourceBytes: INTENTIONAL_ABORT_MAX_SOURCE_BYTES,
      responseOutcome: "close",
      sourceDestroyedOnResponseClose: true,
      activeStreamsAfterSettle: 0,
    },
    deniedReads: {
      loggedOut: 401,
      secondTenant: 404,
      fullAndRangeIndistinguishableWithinPrincipal: true,
      fixtureReadsPerPrincipal: 0,
    },
  };
  const result = {
    date: new Date().toISOString().slice(0, 10),
    protocolVersion: PERF_PROTOCOL_VERSION,
    transportOracleVersion: TRANSPORT_ORACLE_VERSION,
    mode: `dev-turbopack-clean-private-gateway-populated · median-of-${RUNS}${DIAGNOSTIC ? " · diagnostic-non-gating" : " · gating"}`,
    runs: RUNS,
    gating: {
      eligible: !DIAGNOSTIC,
      diagnostic: DIAGNOSTIC,
      requestedRuns: RUNS,
      requestedRegressionFactor: REGRESSION_FACTOR,
      fixedRuns: GATING_RUNS,
      fixedRegressionFactorExclusive: GATING_REGRESSION_FACTOR,
    },
    fixture: fixtureContract,
    harnessContract,
    transportContract,
    navProtocol: "per-step sidebar scroll + thumbnail click (virtualized list)",
    coldOpenWarmMs: median(samples.map((s) => s.coldOpenWarmMs)),
    nav20Ms: median(samples.map((s) => s.nav20Ms)),
    navPerPageMs: +(median(samples.map((s) => s.nav20Ms)) / 20).toFixed(1),
    zoom10Ms: median(samples.map((s) => s.zoom10Ms)),
    rafP95NavMs: median(samples.map((s) => s.rafP95NavMs)),
    rafP95ZoomMs: median(samples.map((s) => s.rafP95ZoomMs)),
    pdfTransport: {
      browserRequests: samples.map(
        (sample) => sample.pdfTransport.browserRequests,
      ),
      browserFullGets: samples.map(
        (sample) => sample.pdfTransport.browserFullGets,
      ),
      browserRangeRequests: samples.map(
        (sample) => sample.pdfTransport.browserRangeRequests,
      ),
      browserOrdinaryRangeRequests: samples.map(
        (sample) => sample.pdfTransport.browserOrdinaryRangeRequests,
      ),
      browserProbeRequests: samples.map(
        (sample) => sample.pdfTransport.browserProbeRequests,
      ),
      browserMeasuredResponseBytes: samples.map(
        (sample) => sample.pdfTransport.browserMeasuredResponseBytes,
      ),
      browserUnmeasuredRequests: samples.map(
        (sample) => sample.pdfTransport.browserUnmeasuredRequests,
      ),
      upstreamRequests: samples.map(
        (sample) => sample.pdfTransport.upstreamRequests,
      ),
      upstreamFullGets: samples.map(
        (sample) => sample.pdfTransport.upstreamFullGets,
      ),
      upstreamRangeRequests: samples.map(
        (sample) => sample.pdfTransport.upstreamRangeRequests,
      ),
      upstreamOrdinaryRangeRequests: samples.map(
        (sample) => sample.pdfTransport.upstreamOrdinaryRangeRequests,
      ),
      upstreamProbeRequests: samples.map(
        (sample) => sample.pdfTransport.upstreamProbeRequests,
      ),
      upstreamProbeBytes: samples.map(
        (sample) => sample.pdfTransport.upstreamProbeBytes,
      ),
      upstreamFullGetBytes: samples.map(
        (sample) => sample.pdfTransport.upstreamFullGetBytes,
      ),
      upstreamResponseBytes: samples.map(
        (sample) => sample.pdfTransport.upstreamResponseBytes,
      ),
      outstandingAtZoomStart: samples.map(
        (sample) => sample.pdfTransport.outstandingAtZoomStart,
      ),
      settle: samples.map((sample) => sample.pdfTransport.settle),
    },
    samples,
  };
  mkdirSync("perf", { recursive: true });
  writeFileSync("perf/latest.json", JSON.stringify(result, null, 2));

  expect(
    existsSync(CURRENT_BASELINE_PATH),
    "current-protocol perf baseline must be checked in",
  ).toBe(true);
  const base = JSON.parse(readFileSync(CURRENT_BASELINE_PATH, "utf8"));
  expect(base.schemaVersion, "perf baseline schema").toBe(2);
  expect(base.protocolVersion, "perf baseline protocol").toBe(
    PERF_PROTOCOL_VERSION,
  );
  expect(base.transportOracleVersion, "perf transport oracle protocol").toBe(
    TRANSPORT_ORACLE_VERSION,
  );
  expect(base.fixture, "perf baseline exact fixture contract").toEqual(
    fixtureContract,
  );
  expect(base.harnessContract, "perf baseline harness contract").toEqual(
    harnessContract,
  );
  expect(base.transportContract, "perf baseline transport contract").toEqual(
    transportContract,
  );
  expect(base.runsPerCapture, "perf baseline capture size").toBe(GATING_RUNS);
  const promoted =
    base.promotionStatus === "promoted-v4-two-independent-captures";
  expect(
    ["pending-v4-recapture", "promoted-v4-two-independent-captures"],
    "perf baseline promotion status",
  ).toContain(base.promotionStatus);
  if (!promoted) {
    expect(
      DIAGNOSTIC,
      "an unpromoted baseline may be exercised only in explicit non-gating diagnostic mode",
    ).toBe(true);
    expect(base.captureCount, "pending v4 capture count").toBe(0);
    expect(base.captures, "pending v4 captures are absent").toEqual([]);
  } else {
    expect(
      Array.isArray(base.captures),
      "perf baseline retained raw captures",
    ).toBe(true);
    expect(base.captureCount, "perf baseline independent captures").toBe(
      base.captures.length,
    );
    expect(base.captureCount).toBeGreaterThanOrEqual(2);
    const captureMedians: Array<Record<(typeof TIMING_KEYS)[number], number>> =
      [];
    for (const [index, capture] of base.captures.entries()) {
      expect(
        capture.processOrdinal,
        `baseline capture ${index + 1} ordinal`,
      ).toBe(index + 1);
      expect(
        capture.samples,
        `baseline capture ${index + 1} has exactly three raw samples`,
      ).toHaveLength(GATING_RUNS);
      for (const [sampleIndex, sample] of capture.samples.entries()) {
        expect(
          Object.keys(sample).sort(),
          `baseline capture ${index + 1} sample ${sampleIndex + 1} exact timing keys`,
        ).toEqual([...TIMING_KEYS].sort());
        for (const key of TIMING_KEYS) {
          expect(
            typeof sample[key],
            `baseline capture ${index + 1} sample ${sampleIndex + 1} ${key}`,
          ).toBe("number");
          expect(sample[key]).toBeGreaterThan(0);
        }
      }
      captureMedians.push(
        Object.fromEntries(
          TIMING_KEYS.map((key) => [
            key,
            median(
              capture.samples.map(
                (sample: Record<(typeof TIMING_KEYS)[number], number>) =>
                  sample[key],
              ),
            ),
          ]),
        ) as Record<(typeof TIMING_KEYS)[number], number>,
      );
    }
    for (const key of TIMING_KEYS) {
      expect(
        base[key],
        `${key} baseline is derived from raw samples through capture medians`,
      ).toBe(median(captureMedians.map((captureMedian) => captureMedian[key])));
    }
    expect(base.navPerPageMs, "baseline nav/page derivation").toBe(
      +(base.nav20Ms / 20).toFixed(1),
    );
  }
  console.log(
    DIAGNOSTIC
      ? "[perf] diagnostic result; timing regression gate intentionally disabled"
      : `[perf] latest vs current baseline (fixed gate factor ${GATING_REGRESSION_FACTOR}x)`,
    { latest: result, baseline: base },
  );
  if (!DIAGNOSTIC) {
    expect(promoted, "gating requires a promoted v4 baseline").toBe(true);
    expect(RUNS, "gating run count").toBe(GATING_RUNS);
    expect(REGRESSION_FACTOR, "gating factor").toBe(GATING_REGRESSION_FACTOR);
    for (const key of TIMING_KEYS) {
      expect
        .soft(
          result[key],
          `${key} regressed: ${result[key]} vs baseline ${base[key]} (>${GATING_REGRESSION_FACTOR}x)`,
        )
        .toBeLessThan(base[key] * GATING_REGRESSION_FACTOR);
    }
  }
});
