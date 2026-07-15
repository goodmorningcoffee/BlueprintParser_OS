// [refactor jul13 P2.3 final] Populated, source-exact viewer performance + Profiler A/B protocol.
//
// This file runs from one common harness checkout while playwright.perf-v2.config.ts starts Next
// in an exact detached app worktree. scripts/apply-perf-v2-instrumentation.mjs applies the same
// measurement-only Profiler sentinels to both app SHAs. The comparator pins pre=9edc329 (the exact
// direct parent) and post=85522ad (the private-gateway candidate). Required order is
// pre→post→post→pre; every invocation is a warmed median-of-three and writes its own immutable
// SHA/leg-labelled artifact.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { cpus, platform, release } from "node:os";
import { resolve } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";

const SCHEMA_VERSION = "bp-viewer-perf-v2.2.0";
const PROTOCOL_VERSION =
  "p2.4-direct-parent-symmetric-missing-underlays-profiler-median3-reverse1";
const RUNS = Number(process.env.PERF_RUNS || 3);
const SMOKE = process.env.PERF_SMOKE === "1";
const SOURCE_SHA = process.env.PERF_APP_SHA || "";
const ROLE = process.env.PERF_ROLE || "";
const LEG = process.env.PERF_LEG || "";
const HARNESS_SHA = process.env.PERF_HARNESS_SHA || "";
const OUTPUT_PATH = process.env.PERF_OUTPUT_PATH || "";
const APP_ROOT_INPUT = process.env.PERF_APP_ROOT || "";
const APP_ROOT = resolve(APP_ROOT_INPUT || process.cwd());
const world = JSON.parse(readFileSync("e2e/.state/world.json", "utf8")) as {
  publicId: string;
  dataUrl: string;
  email: string;
  password: string;
  pages: number;
};

const TARGETS = [
  "AnnotationOverlay",
  "DrawingPreviewLayer",
  "PDFPage",
] as const;
type Target = (typeof TARGETS)[number];
type ProfilerEntry = {
  commits: number;
  mounts: number;
  updates: number;
  actualDurationMs: number;
};
type ProfilerSnapshot = Record<Target, ProfilerEntry>;
type PageWindowObservation = {
  url: string;
  from: number;
  to: number;
};
type RasterWitness = {
  width: number;
  height: number;
  cssWidth: number;
  cssHeight: number;
  opacity: string;
  paintedPixelSamples: number;
};
type MissingUnderlayFamily =
  | "legacy-thumbnail-proxy"
  | "direct-cdn-page-underlay"
  | "private-gateway-page-underlay"
  | "private-gateway-thumbnail";
type MissingUnderlayRequest = {
  family: MissingUnderlayFamily;
  method: string;
  url: string;
  pathname: string;
  status: 404;
};
type InstrumentationManifest = {
  schemaVersion: string;
  sourceSha: string;
  scriptVersion: string;
  overlayProtocolSha256: string;
  probeSha256: string;
  targets: Array<{
    file: string;
    beforeSha256: string;
    afterSha256: string;
  }>;
};

const PERF_AREA_ITEM = {
  id: 910001,
  name: "PERF AREA 20",
  shape: "polygon",
  color: "#22c55e",
  size: 24,
  notes: null,
  sortOrder: 0,
  groupId: null,
};

const BUCKET_RASTER_FIXTURE = {
  fixtureKind: "white-room-with-structural-column",
  outerRoomBounds: [0.2, 0.2, 0.8, 0.8],
  structuralColumnBounds: [0.62, 0.42, 0.68, 0.58],
  seed: [0.5, 0.5],
  dilationPx: 3,
  roomAreaFraction: 0.3504,
} as const;

const BUCKET_PREVIEW_WITNESS = {
  filledPoints: [
    [0.58, 0.5],
    [0.72, 0.5],
    [0.65, 0.36],
    [0.65, 0.64],
  ],
  holePoint: [0.65, 0.5],
} as const;

const PERF_TAKEOFF_ITEMS = [
  PERF_AREA_ITEM,
  ...Array.from({ length: 127 }, (_, index) => ({
    id: 910002 + index,
    name: `PERF QTO ${String(index + 2).padStart(3, "0")}`,
    shape: index % 4 < 2 ? "polygon" : index % 4 === 2 ? "count" : "linear",
    color: ["#ef4444", "#3b82f6", "#eab308", "#a855f7"][index % 4],
    size: 24,
    notes: null,
    sortOrder: index + 1,
    groupId: null,
  })),
];

const PERF_DRAG_TARGET = {
  id: -910001,
  pageNumber: 1,
  name: "PERF-DRAG-TARGET",
  bbox: [0.4, 0.4, 0.48, 0.48],
  note: null,
  source: "user",
  data: null,
};

const PERF_PAGE_ONE_ANNOTATIONS = [
  PERF_DRAG_TARGET,
  ...Array.from({ length: 511 }, (_, index) => {
    const column = index % 16;
    const row = Math.floor(index / 16);
    const x = 0.015 + column * 0.06;
    const y = 0.015 + row * 0.03;
    return {
      id: -910100 - index,
      pageNumber: 1,
      name: `PERF-DENSE-${String(index + 1).padStart(3, "0")}`,
      bbox: [x, y, Math.min(x + 0.024, 0.99), Math.min(y + 0.016, 0.99)],
      note: null,
      source: "user",
      data: null,
    };
  }),
];

const PERF_OTHER_PAGE_ANNOTATIONS = Array.from(
  { length: 99 * 64 },
  (_, index) => {
    const pageNumber = 2 + Math.floor(index / 64);
    const pageIndex = index % 64;
    const column = pageIndex % 8;
    const row = Math.floor(pageIndex / 8);
    const x = 0.04 + column * 0.115;
    const y = 0.05 + row * 0.105;
    return {
      id: -920000 - index,
      pageNumber,
      name: `PERF-P${String(pageNumber).padStart(3, "0")}-${String(pageIndex + 1).padStart(2, "0")}`,
      bbox: [x, y, Math.min(x + 0.045, 0.99), Math.min(y + 0.035, 0.99)],
      note: null,
      source: "user",
      data: null,
    };
  },
);

const PERF_DENSE_ANNOTATIONS = [
  ...PERF_PAGE_ONE_ANNOTATIONS,
  ...PERF_OTHER_PAGE_ANNOTATIONS,
];
const PERF_ANNOTATION_IDS = new Set(
  PERF_DENSE_ANNOTATIONS.map((annotation) => annotation.id),
);

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

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function gitText(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function validateInstrumentedWorktree(): {
  sourceCommitSha: string;
  headSha: string;
  gitStatus: string[];
  instrumentation: InstrumentationManifest;
} {
  const sourceCommitSha = gitText(APP_ROOT, [
    "rev-parse",
    `${SOURCE_SHA}^{commit}`,
  ]);
  const headSha = gitText(APP_ROOT, ["rev-parse", "HEAD"]);
  expect(
    headSha,
    "detached app worktree HEAD must be the requested source commit",
  ).toBe(sourceCommitSha);
  expect(
    gitText(APP_ROOT, ["rev-parse", "--abbrev-ref", "HEAD"]),
    "perf app must be a detached worktree",
  ).toBe("HEAD");
  expect(
    realpathSync(APP_ROOT),
    "perf app must not be the common harness checkout",
  ).not.toBe(realpathSync(process.cwd()));

  const manifestPath = resolve(APP_ROOT, ".perf-v2-instrumentation.json");
  const instrumentation = JSON.parse(
    readFileSync(manifestPath, "utf8"),
  ) as InstrumentationManifest;
  expect(instrumentation.schemaVersion).toBe(
    "bp-perf-v2-instrumentation-manifest-1",
  );
  expect(
    gitText(APP_ROOT, ["rev-parse", `${instrumentation.sourceSha}^{commit}`]),
  ).toBe(sourceCommitSha);
  expect(instrumentation.overlayProtocolSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(instrumentation.probeSha256).toBe(
    sha256File("e2e/perf-v2/PerfRenderProbe.tsx"),
  );

  const expectedTargets = [
    "src/components/viewer/AnnotationOverlay.tsx",
    "src/components/viewer/DrawingPreviewLayer.tsx",
    "src/components/viewer/PDFPage.tsx",
  ];
  expect(instrumentation.targets.map((target) => target.file).sort()).toEqual(
    expectedTargets,
  );
  for (const target of instrumentation.targets) {
    expect(
      sha256File(resolve(APP_ROOT, target.file)),
      `${target.file} overlay after-hash`,
    ).toBe(target.afterSha256);
    const sourceBytes = execFileSync(
      "git",
      ["show", `${sourceCommitSha}:${target.file}`],
      {
        cwd: APP_ROOT,
      },
    );
    expect(
      sha256Bytes(sourceBytes),
      `${target.file} exact source before-hash`,
    ).toBe(target.beforeSha256);
  }
  expect(
    sha256File(resolve(APP_ROOT, "src/components/viewer/PerfRenderProbe.tsx")),
    "copied probe must match the common harness probe",
  ).toBe(instrumentation.probeSha256);

  const gitStatus = execFileSync(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { cwd: APP_ROOT, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean)
    .sort();
  const expectedStatus = [
    ...expectedTargets.map((file) => ` M ${file}`),
    "?? .perf-v2-instrumentation.json",
    "?? src/components/viewer/PerfRenderProbe.tsx",
  ].sort();
  expect(
    gitStatus,
    "app worktree may differ from source only by the declared profiler overlay",
  ).toEqual(expectedStatus);

  return { sourceCommitSha, headSha, gitStatus, instrumentation };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return +(
    sorted.length % 2
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2
  ).toFixed(1);
}

function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length
    ? +sorted[
        Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))
      ].toFixed(1)
    : 0;
}

async function settleFrames(page: Page, count = 2): Promise<void> {
  await page.evaluate(
    (frameCount) =>
      new Promise<void>((resolveFrame) => {
        let remaining = frameCount;
        const tick = () => {
          remaining -= 1;
          if (remaining <= 0) resolveFrame();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    count,
  );
}

async function startFrameSampler(page: Page): Promise<void> {
  await page.evaluate(() => {
    type FrameSampler = {
      generation: number;
      gaps: number[];
      rafId: number | null;
      running: boolean;
    };
    const runtime = window as unknown as {
      __bpPerfFrameSampler?: FrameSampler;
    };
    const previous = runtime.__bpPerfFrameSampler;
    if (previous?.rafId !== null && previous?.rafId !== undefined) {
      cancelAnimationFrame(previous.rafId);
    }
    const sampler: FrameSampler = {
      generation: (previous?.generation ?? 0) + 1,
      gaps: [],
      rafId: null,
      running: true,
    };
    runtime.__bpPerfFrameSampler = sampler;
    let last = performance.now();
    const loop = (time: number) => {
      if (runtime.__bpPerfFrameSampler !== sampler || !sampler.running) return;
      sampler.gaps.push(time - last);
      last = time;
      sampler.rafId = requestAnimationFrame(loop);
    };
    sampler.rafId = requestAnimationFrame(loop);
  });
}

async function stopFrameSampler(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const runtime = window as unknown as {
      __bpPerfFrameSampler?: {
        gaps: number[];
        rafId: number | null;
        running: boolean;
      };
    };
    const sampler = runtime.__bpPerfFrameSampler;
    if (!sampler) throw new Error("frame sampler missing");
    sampler.running = false;
    if (sampler.rafId !== null) cancelAnimationFrame(sampler.rafId);
    sampler.rafId = null;
    return [...sampler.gaps];
  });
}

async function resetProfiler(page: Page, label: string): Promise<void> {
  await page.evaluate(
    ({ nextLabel, sourceSha }) => {
      const sink = (
        window as unknown as {
          __BP_PERF_V2_STATE__?: {
            label: string;
            counts: Record<string, ProfilerEntry>;
            servedShas: string[];
          };
        }
      ).__BP_PERF_V2_STATE__;
      if (!sink) throw new Error("perf-v2 Profiler sink missing");
      for (const target of [
        "AnnotationOverlay",
        "DrawingPreviewLayer",
        "PDFPage",
      ]) {
        if (!sink.counts[target]?.commits)
          throw new Error(`${target} Profiler probe never mounted`);
      }
      if (sink.servedShas.length !== 1 || sink.servedShas[0] !== sourceSha) {
        throw new Error(
          `served SHA mismatch: ${JSON.stringify(sink.servedShas)} vs ${sourceSha}`,
        );
      }
      sink.label = nextLabel;
      sink.counts = {};
    },
    { nextLabel: label, sourceSha: SOURCE_SHA },
  );
}

async function profilerSnapshot(page: Page): Promise<ProfilerSnapshot> {
  const raw = await page.evaluate(() => {
    const sink = (
      window as unknown as {
        __BP_PERF_V2_STATE__?: { counts: Record<string, ProfilerEntry> };
      }
    ).__BP_PERF_V2_STATE__;
    if (!sink) throw new Error("perf-v2 Profiler sink missing");
    return sink.counts;
  });
  return Object.fromEntries(
    TARGETS.map((target) => [
      target,
      raw[target] ?? {
        commits: 0,
        mounts: 0,
        updates: 0,
        actualDurationMs: 0,
      },
    ]),
  ) as ProfilerSnapshot;
}

async function waitForPageCanvas(page: Page): Promise<Locator> {
  const canvas = page.locator('canvas[data-page-canvas="true"]');
  await canvas.waitFor({ state: "attached", timeout: 120_000 });
  await expect
    .poll(
      () =>
        canvas.evaluate((node) => {
          const element = node as HTMLCanvasElement;
          return (
            element.width > 0 &&
            element.height > 0 &&
            getComputedStyle(element).opacity !== "0"
          );
        }),
      { timeout: 120_000, message: "rendered page canvas" },
    )
    .toBe(true);
  return canvas;
}

async function rasterWitness(canvas: Locator): Promise<RasterWitness> {
  return canvas.evaluate((node) => {
    const element = node as HTMLCanvasElement;
    const context = element.getContext("2d");
    if (!context) throw new Error("page canvas 2d context missing");
    let paintedPixelSamples = 0;
    for (const xFraction of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      for (const yFraction of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        const x = Math.min(
          element.width - 1,
          Math.max(0, Math.floor(element.width * xFraction)),
        );
        const y = Math.min(
          element.height - 1,
          Math.max(0, Math.floor(element.height * yFraction)),
        );
        if (context.getImageData(x, y, 1, 1).data[3] > 0)
          paintedPixelSamples += 1;
      }
    }
    const rect = element.getBoundingClientRect();
    return {
      width: element.width,
      height: element.height,
      cssWidth: +rect.width.toFixed(1),
      cssHeight: +rect.height.toFixed(1),
      opacity: getComputedStyle(element).opacity,
      paintedPixelSamples,
    };
  });
}

async function readZoomPercent(page: Page): Promise<number> {
  return page.evaluate(() => {
    const buttons = [...document.querySelectorAll("button")];
    const minus = buttons.find((button) => button.textContent?.trim() === "-");
    const plus = buttons.find((button) => button.textContent?.trim() === "+");
    const indicator = minus?.parentElement?.nextElementSibling;
    if (
      !indicator ||
      !plus ||
      indicator.nextElementSibling?.contains(plus) !== true
    ) {
      throw new Error("zoom percentage indicator topology missing");
    }
    const match = /^(\d+)%$/.exec(indicator.textContent?.trim() ?? "");
    if (!match)
      throw new Error(`invalid zoom percentage: ${indicator.textContent}`);
    return Number(match[1]);
  });
}

async function reloadReady(page: Page): Promise<number> {
  const started = performance.now();
  await page.reload();
  await waitForPageCanvas(page);
  return Math.round(performance.now() - started);
}

async function annotationCanvas(page: Page): Promise<Locator> {
  const canvas = page.locator('canvas[data-perf-surface="annotation-overlay"]');
  await expect(canvas).toHaveCount(1);
  await expect
    .poll(() => canvas.evaluate((node) => getComputedStyle(node).pointerEvents))
    .not.toBe("none");
  return canvas;
}

async function setSidebarScroll(
  page: Page,
  top: number,
): Promise<{ scrollHeight: number }> {
  return page.evaluate((nextTop) => {
    let element =
      document.querySelector("[data-page-num]")?.parentElement ?? null;
    while (element && element.scrollHeight <= element.clientHeight)
      element = element.parentElement;
    if (!element) throw new Error("sidebar scroll container not found");
    element.scrollTop = nextTop;
    return { scrollHeight: element.scrollHeight };
  }, top);
}

async function openQtoArea(page: Page, selectItem: boolean): Promise<void> {
  await page.getByRole("button", { name: "QTO", exact: true }).click();
  await expect(
    page.getByText("Quantity Takeoff", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Area", exact: true }).click();
  await expect(
    page.getByText(PERF_AREA_ITEM.name, { exact: true }).first(),
  ).toBeVisible();
  if (selectItem) {
    await page.getByText(PERF_AREA_ITEM.name, { exact: true }).first().click();
    await expect(
      page.getByRole("button", { name: "Stop", exact: true }),
    ).toBeVisible();
  }
  await settleFrames(page, 10);
}

async function measureNav20(page: Page, pageWindows: PageWindowObservation[]) {
  const { scrollHeight } = await setSidebarScroll(
    page,
    Number.MAX_SAFE_INTEGER,
  );
  await setSidebarScroll(page, 0);
  await settleFrames(page, 2);
  const itemHeight = scrollHeight / world.pages;
  await resetProfiler(page, "nav20");
  await startFrameSampler(page);
  const started = performance.now();
  for (let pageNumber = 2; pageNumber <= 21; pageNumber += 1) {
    await setSidebarScroll(page, (pageNumber - 1) * itemHeight);
    await settleFrames(page, 2);
    await page.locator(`[data-page-num="${pageNumber}"]`).click();
    await settleFrames(page, 2);
  }
  const elapsedMs = Math.round(performance.now() - started);
  const gaps = await stopFrameSampler(page);

  // The wall-clock target ends above. Prove the final navigation outcome and let its deferred
  // raster/chunk work settle before zoom begins, without charging that wait to nav20.
  const finalPage = 21;
  const finalButton = page.locator(`[data-page-num="${finalPage}"]`);
  await expect(finalButton).toBeAttached({ timeout: 30_000 });
  await expect
    .poll(
      () =>
        finalButton.evaluate(
          (node) =>
            node.className.includes("bg-[var(--accent)]/20") &&
            node.className.includes("border-[var(--accent)]/40"),
        ),
      {
        timeout: 30_000,
        message: "page 21 is the active sidebar page",
      },
    )
    .toBe(true);
  await expect
    .poll(
      () =>
        pageWindows.some(
          (window) => window.from <= finalPage && window.to >= finalPage,
        ),
      {
        timeout: 30_000,
        message: "fulfilled page window covers final nav page 21",
      },
    )
    .toBe(true);
  const finalPageWindow = [...pageWindows]
    .reverse()
    .find((window) => window.from <= finalPage && window.to >= finalPage)!;
  const canvas = await waitForPageCanvas(page);
  await settleFrames(page, 10);
  const raster = await rasterWitness(canvas);
  expect(raster.width).toBeGreaterThan(0);
  expect(raster.height).toBeGreaterThan(0);
  expect(raster.paintedPixelSamples).toBeGreaterThan(0);
  expect(raster.opacity).not.toBe("0");
  const profiler = await profilerSnapshot(page);
  expect(profiler.PDFPage.commits).toBeGreaterThan(0);
  return {
    elapsedMs,
    rafP95Ms: p95(gaps),
    profiler,
    outcome: {
      targetPage: finalPage,
      activePage: Number(await finalButton.getAttribute("data-page-num")),
      activeClass: await finalButton.getAttribute("class"),
      pageWindow: finalPageWindow,
      raster,
      pdfPageCommits: profiler.PDFPage.commits,
    },
  };
}

async function measureZoom10(page: Page) {
  const canvas = page.locator('canvas[data-page-canvas="true"]');
  const box = await canvas.boundingBox();
  if (!box) throw new Error("page canvas has no box for zoom");
  const beforePercent = await readZoomPercent(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await resetProfiler(page, "zoom10");
  await startFrameSampler(page);
  const started = performance.now();
  for (let index = 0; index < 10; index += 1) {
    await page.mouse.wheel(0, -120);
    await settleFrames(page, 2);
  }
  const elapsedMs = Math.round(performance.now() - started);
  const gaps = await stopFrameSampler(page);
  const afterPercent = await readZoomPercent(page);
  expect(afterPercent).toBeGreaterThan(beforePercent);
  const profiler = await profilerSnapshot(page);
  expect(profiler.PDFPage.commits).toBeGreaterThan(0);
  return {
    elapsedMs,
    rafP95Ms: p95(gaps),
    profiler,
    outcome: {
      beforePercent,
      afterPercent,
      deltaPercent: afterPercent - beforePercent,
      pdfPageCommits: profiler.PDFPage.commits,
    },
  };
}

async function installBucketRaster(
  pageCanvas: Locator,
  width: number,
  height: number,
) {
  return pageCanvas.evaluate(
    (node, { dimensions, fixture }) => {
      const canvas = node as HTMLCanvasElement;
      const cssWidth = canvas.style.width;
      const cssHeight = canvas.style.height;
      canvas.width = dimensions.width;
      canvas.height = dimensions.height;
      canvas.style.width = cssWidth;
      canvas.style.height = cssHeight;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("2d context missing for bucket fixture");
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.fillStyle = "#000";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#fff";
      const [roomMinX, roomMinY, roomMaxX, roomMaxY] = fixture.outerRoomBounds;
      context.fillRect(
        canvas.width * roomMinX,
        canvas.height * roomMinY,
        canvas.width * (roomMaxX - roomMinX),
        canvas.height * (roomMaxY - roomMinY),
      );
      context.fillStyle = "#000";
      const [columnMinX, columnMinY, columnMaxX, columnMaxY] =
        fixture.structuralColumnBounds;
      context.fillRect(
        canvas.width * columnMinX,
        canvas.height * columnMinY,
        canvas.width * (columnMaxX - columnMinX),
        canvas.height * (columnMaxY - columnMinY),
      );
      const ratio = Math.min(4000 / canvas.width, 4000 / canvas.height, 1);
      return {
        sourceWidth: canvas.width,
        sourceHeight: canvas.height,
        processedWidth: Math.round(canvas.width * ratio),
        processedHeight: Math.round(canvas.height * ratio),
        ...fixture,
      };
    },
    { dimensions: { width, height }, fixture: BUCKET_RASTER_FIXTURE },
  );
}

async function measureBucket4000(page: Page) {
  await reloadReady(page);
  await settleFrames(page, 10);
  await openQtoArea(page, false);
  await page.getByRole("button", { name: "Bucket Fill", exact: true }).click();
  const resolution = page.locator(
    '[title^="Max pixel dimension"] input[type="range"]',
  );
  const dilation = page.locator(
    '[title^="Gap-closing radius"] input[type="range"]',
  );
  const pageCanvas = page.locator('canvas[data-page-canvas="true"]');
  const overlay = await annotationCanvas(page);
  const box = await overlay.boundingBox();
  if (!box) throw new Error("overlay has no box for bucket fill");
  await dilation.fill(String(BUCKET_RASTER_FIXTURE.dilationPx));
  await expect(dilation).toHaveValue(String(BUCKET_RASTER_FIXTURE.dilationPx));

  // Compile/start the exact singleton worker outside the timed 4000px sample. Dev-Turbopack's
  // first worker-chunk request is build-system latency, not the warmed client algorithm target.
  await resolution.fill("1000");
  await installBucketRaster(pageCanvas, 1000, 667);
  await page.mouse.click(
    box.x + box.width * BUCKET_RASTER_FIXTURE.seed[0],
    box.y + box.height * BUCKET_RASTER_FIXTURE.seed[1],
  );
  await expect
    .poll(() => overlay.evaluate((node) => getComputedStyle(node).cursor), {
      timeout: 15_000,
    })
    .toBe("wait");
  await expect
    .poll(() => overlay.evaluate((node) => getComputedStyle(node).cursor), {
      timeout: 15_000,
    })
    .not.toBe("wait");
  await page.keyboard.press("Escape");
  await settleFrames(page, 4);

  await resolution.fill("4000");
  await expect(resolution).toHaveValue("4000");
  await settleFrames(page, 4);
  const raster = await installBucketRaster(pageCanvas, 4000, 2667);
  expect(Math.max(raster.processedWidth, raster.processedHeight)).toBe(4000);
  await resetProfiler(page, "bucket4000");
  await startFrameSampler(page);
  await overlay.evaluate((node) => {
    const runtime = window as unknown as {
      __BP_BUCKET_V2_DONE__?: Promise<{ elapsedMs: number; sawWait: boolean }>;
    };
    runtime.__BP_BUCKET_V2_DONE__ = new Promise(
      (resolveBucket, rejectBucket) => {
        let start = 0;
        let sawWait = false;
        let finished = false;
        node.addEventListener(
          "mousedown",
          () => {
            start = performance.now();
          },
          { capture: true, once: true },
        );
        const timeout = window.setTimeout(() => {
          if (!finished)
            rejectBucket(new Error("bucket4000 did not settle within 15s"));
        }, 15_000);
        const tick = () => {
          if (start > 0) {
            const cursor = getComputedStyle(node).cursor;
            if (cursor === "wait") sawWait = true;
            if (sawWait && cursor !== "wait") {
              finished = true;
              clearTimeout(timeout);
              resolveBucket({
                elapsedMs: +(performance.now() - start).toFixed(1),
                sawWait,
              });
              return;
            }
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      },
    );
  });
  await page.mouse.click(
    box.x + box.width * BUCKET_RASTER_FIXTURE.seed[0],
    box.y + box.height * BUCKET_RASTER_FIXTURE.seed[1],
  );
  const settlement = await page.evaluate(() => {
    const promise = (
      window as unknown as {
        __BP_BUCKET_V2_DONE__?: Promise<{
          elapsedMs: number;
          sawWait: boolean;
        }>;
      }
    ).__BP_BUCKET_V2_DONE__;
    if (!promise) throw new Error("bucket4000 watcher missing");
    return promise;
  });
  const gaps = await stopFrameSampler(page);
  const profiler = await profilerSnapshot(page);
  expect(settlement.sawWait).toBe(true);
  await settleFrames(page, 4);
  const outcome = await overlay.evaluate((node, witness) => {
    const preview = node.nextElementSibling;
    if (
      !(preview instanceof HTMLCanvasElement) ||
      getComputedStyle(preview).zIndex !== "15"
    ) {
      throw new Error("DrawingPreviewLayer canvas topology missing");
    }
    const context = preview.getContext("2d");
    if (!context) throw new Error("DrawingPreviewLayer 2d context missing");
    const alphaAt = ([x, y]: readonly [number, number]) =>
      context.getImageData(
        Math.max(0, Math.min(preview.width - 1, Math.floor(x * preview.width))),
        Math.max(
          0,
          Math.min(preview.height - 1, Math.floor(y * preview.height)),
        ),
        1,
        1,
      ).data[3];
    const filledSampleAlphas = witness.filledPoints.map((point) =>
      alphaAt(point),
    );
    return {
      previewCanvasWidth: preview.width,
      previewCanvasHeight: preview.height,
      previewCanvasZIndex: getComputedStyle(preview).zIndex,
      filledSampleAlphas,
      filledSampleCount: filledSampleAlphas.filter((alpha) => alpha > 0).length,
      holeCenterAlpha: alphaAt(witness.holePoint),
    };
  }, BUCKET_PREVIEW_WITNESS);
  expect(outcome.filledSampleCount).toBe(
    BUCKET_PREVIEW_WITNESS.filledPoints.length,
  );
  expect(outcome.holeCenterAlpha).toBe(0);
  await page.keyboard.press("Enter");
  await expect(
    page.getByText("Assign to Area Item", { exact: true }),
  ).toBeVisible({ timeout: 10_000 });
  return {
    elapsedMs: settlement.elapsedMs,
    rafP95Ms: p95(gaps),
    profiler,
    raster,
    outcome,
    workerWarmup: "1000px deterministic room-with-column outside timed sample",
    previewAcceptedByEnter: true,
  };
}

async function measurePolygon20(page: Page) {
  await reloadReady(page);
  await settleFrames(page, 10);
  await openQtoArea(page, true);
  const overlay = await annotationCanvas(page);
  const box = await overlay.boundingBox();
  if (!box) throw new Error("overlay has no box for polygon");
  const centerX = box.x + box.width * 0.5;
  const centerY = box.y + box.height * 0.5;
  const radiusX = box.width * 0.22;
  const radiusY = box.height * 0.22;
  await resetProfiler(page, "polygon20");
  await startFrameSampler(page);
  const started = performance.now();
  for (let index = 0; index < 20; index += 1) {
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / 20;
    await page.mouse.move(
      centerX + Math.cos(angle) * radiusX,
      centerY + Math.sin(angle) * radiusY,
    );
    await page.mouse.down();
    await page.mouse.up();
    await settleFrames(page, 1);
  }
  await page.keyboard.press("Enter");
  await settleFrames(page, 3);
  const elapsedMs = Math.round(performance.now() - started);
  const gaps = await stopFrameSampler(page);
  const profiler = await profilerSnapshot(page);
  await expect(page.getByText(/^1p 1pg$/)).toBeVisible({ timeout: 10_000 });
  expect(profiler.DrawingPreviewLayer.commits).toBeGreaterThanOrEqual(20);
  return {
    elapsedMs,
    rafP95Ms: p95(gaps),
    profiler,
    vertices: 20,
    optimisticPolygonVisible: true,
  };
}

async function measureDrag60(page: Page) {
  await reloadReady(page);
  await settleFrames(page, 10);
  await page.getByRole("button", { name: /Pointer\s*Select/ }).click();
  await settleFrames(page, 4);
  const overlay = await annotationCanvas(page);
  const box = await overlay.boundingBox();
  if (!box) throw new Error("overlay has no box for annotation drag");
  const startX = box.x + box.width * 0.44;
  const startY = box.y + box.height * 0.44;
  await page.mouse.move(startX, startY);
  await overlay.evaluate((node) => {
    const runtime = window as unknown as { __BP_DRAG60_MOVES__?: number };
    runtime.__BP_DRAG60_MOVES__ = 0;
    node.addEventListener("mousemove", () => {
      runtime.__BP_DRAG60_MOVES__ = (runtime.__BP_DRAG60_MOVES__ ?? 0) + 1;
    });
  });
  await resetProfiler(page, "drag60");
  await startFrameSampler(page);
  const started = performance.now();
  await page.mouse.down();
  for (let step = 1; step <= 60; step += 1) {
    await page.mouse.move(startX + step * 1.8, startY + step * 1.1);
    await settleFrames(page, 1);
  }
  await page.mouse.up();
  await settleFrames(page, 3);
  const elapsedMs = Math.round(performance.now() - started);
  const gaps = await stopFrameSampler(page);
  const profiler = await profilerSnapshot(page);
  const observedMouseMoves = await page.evaluate(
    () =>
      (window as unknown as { __BP_DRAG60_MOVES__?: number })
        .__BP_DRAG60_MOVES__ ?? 0,
  );
  expect(observedMouseMoves).toBeGreaterThanOrEqual(60);
  expect(profiler.AnnotationOverlay.commits).toBeGreaterThanOrEqual(30);
  return {
    elapsedMs,
    rafP95Ms: p95(gaps),
    profiler,
    pointerSteps: 60,
    observedMouseMoves,
    denseAnnotations: PERF_DENSE_ANNOTATIONS.length,
    targetWasReactive: profiler.AnnotationOverlay.commits >= 30,
  };
}

type PerfSample = {
  coldOpenWarmMs: number;
  nav20Ms: number;
  navRafP95Ms: number;
  zoom10Ms: number;
  zoomRafP95Ms: number;
  polygon20Ms: number;
  polygonRafP95Ms: number;
  drag60Ms: number;
  dragRafP95Ms: number;
  bucket4000Ms: number;
  bucketRafP95Ms: number;
  profiler: Record<
    "nav20" | "zoom10" | "polygon20" | "drag60" | "bucket4000",
    ProfilerSnapshot
  >;
  bucketRaster: Awaited<ReturnType<typeof measureBucket4000>>["raster"];
  bucketOutcome: Awaited<ReturnType<typeof measureBucket4000>>["outcome"];
  navOutcome: Awaited<ReturnType<typeof measureNav20>>["outcome"];
  zoomOutcome: Awaited<ReturnType<typeof measureZoom10>>["outcome"];
};

async function measureOnce(
  page: Page,
  pageWindows: PageWindowObservation[],
): Promise<PerfSample> {
  const coldOpenWarmMs = await reloadReady(page);
  await settleFrames(page, 10);
  const nav = await measureNav20(page, pageWindows);
  const zoom = await measureZoom10(page);
  const bucket = await measureBucket4000(page);
  const polygon = await measurePolygon20(page);
  const drag = await measureDrag60(page);
  return {
    coldOpenWarmMs,
    nav20Ms: nav.elapsedMs,
    navRafP95Ms: nav.rafP95Ms,
    zoom10Ms: zoom.elapsedMs,
    zoomRafP95Ms: zoom.rafP95Ms,
    polygon20Ms: polygon.elapsedMs,
    polygonRafP95Ms: polygon.rafP95Ms,
    drag60Ms: drag.elapsedMs,
    dragRafP95Ms: drag.rafP95Ms,
    bucket4000Ms: bucket.elapsedMs,
    bucketRafP95Ms: bucket.rafP95Ms,
    profiler: {
      nav20: nav.profiler,
      zoom10: zoom.profiler,
      polygon20: polygon.profiler,
      drag60: drag.profiler,
      bucket4000: bucket.profiler,
    },
    bucketRaster: bucket.raster,
    bucketOutcome: bucket.outcome,
    navOutcome: nav.outcome,
    zoomOutcome: zoom.outcome,
  };
}

function validatePopulatedSamples(samples: PerfSample[]): void {
  expect(samples).toHaveLength(RUNS);
  const timingKeys = [
    "coldOpenWarmMs",
    "nav20Ms",
    "navRafP95Ms",
    "zoom10Ms",
    "zoomRafP95Ms",
    "polygon20Ms",
    "polygonRafP95Ms",
    "drag60Ms",
    "dragRafP95Ms",
    "bucket4000Ms",
    "bucketRafP95Ms",
  ] as const;
  for (const sample of samples) {
    for (const key of timingKeys) {
      expect(Number.isFinite(sample[key]), `${key} must be finite`).toBe(true);
      expect(sample[key], `${key} must be populated`).toBeGreaterThan(0);
    }
    for (const scenario of [
      "nav20",
      "zoom10",
      "polygon20",
      "drag60",
      "bucket4000",
    ] as const) {
      for (const target of TARGETS) {
        const entry = sample.profiler[scenario][target];
        expect(
          Number.isInteger(entry.commits),
          `${scenario}.${target}.commits integer`,
        ).toBe(true);
        expect(
          entry.commits,
          `${scenario}.${target}.commits nonnegative`,
        ).toBeGreaterThanOrEqual(0);
        expect(
          Number.isFinite(entry.actualDurationMs),
          `${scenario}.${target}.actualDurationMs finite`,
        ).toBe(true);
      }
    }
    expect(sample.navOutcome.activePage).toBe(21);
    expect(sample.navOutcome.targetPage).toBe(21);
    expect(sample.navOutcome.pageWindow.from).toBeLessThanOrEqual(21);
    expect(sample.navOutcome.pageWindow.to).toBeGreaterThanOrEqual(21);
    expect(sample.navOutcome.raster.paintedPixelSamples).toBeGreaterThan(0);
    expect(sample.navOutcome.pdfPageCommits).toBeGreaterThan(0);
    expect(sample.zoomOutcome.deltaPercent).toBeGreaterThan(0);
    expect(sample.zoomOutcome.pdfPageCommits).toBeGreaterThan(0);
    expect(sample.bucketOutcome.previewCanvasWidth).toBeGreaterThan(0);
    expect(sample.bucketOutcome.previewCanvasHeight).toBeGreaterThan(0);
    expect(sample.bucketOutcome.previewCanvasZIndex).toBe("15");
    expect(sample.bucketOutcome.filledSampleAlphas).toHaveLength(
      BUCKET_PREVIEW_WITNESS.filledPoints.length,
    );
    expect(
      sample.bucketOutcome.filledSampleAlphas.every((alpha) => alpha > 0),
    ).toBe(true);
    expect(sample.bucketOutcome.filledSampleCount).toBe(
      BUCKET_PREVIEW_WITNESS.filledPoints.length,
    );
    expect(sample.bucketOutcome.holeCenterAlpha).toBe(0);
  }
}

function profilerMedians(samples: PerfSample[]) {
  return Object.fromEntries(
    (["nav20", "zoom10", "polygon20", "drag60", "bucket4000"] as const).map(
      (scenario) => [
        scenario,
        Object.fromEntries(
          TARGETS.map((target) => [
            target,
            {
              commits: median(
                samples.map(
                  (sample) => sample.profiler[scenario][target].commits,
                ),
              ),
              mounts: median(
                samples.map(
                  (sample) => sample.profiler[scenario][target].mounts,
                ),
              ),
              updates: median(
                samples.map(
                  (sample) => sample.profiler[scenario][target].updates,
                ),
              ),
              actualDurationMs: median(
                samples.map(
                  (sample) =>
                    sample.profiler[scenario][target].actualDurationMs,
                ),
              ),
            },
          ]),
        ),
      ],
    ),
  );
}

test("viewer perf-v2 populated source-exact protocol", async ({
  browser,
  page,
}) => {
  test.setTimeout(Math.max(600_000, RUNS * 300_000));
  for (const [name, value] of Object.entries({
    PERF_APP_SHA: SOURCE_SHA,
    PERF_APP_ROOT: APP_ROOT_INPUT,
    PERF_ROLE: ROLE,
    PERF_LEG: LEG,
    PERF_HARNESS_SHA: HARNESS_SHA,
    PERF_OUTPUT_PATH: OUTPUT_PATH,
  }))
    expect(value, `${name} is required`).not.toBe("");
  expect(["baseline", "candidate"]).toContain(ROLE);
  expect(RUNS).toBe(SMOKE ? 1 : 3);
  expect(
    existsSync(OUTPUT_PATH),
    "perf output path must be new/immutable",
  ).toBe(false);
  const worktree = validateInstrumentedWorktree();

  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  const http429: string[] = [];
  const missingUnderlayRequests: MissingUnderlayRequest[] = [];
  const pdfTransportRequests: Array<{
    boundary: "direct-cdn" | "same-origin-private-gateway";
    method: string;
    pathname: string;
    range: string | null;
  }> = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("request", (request) => {
    const url = new URL(request.url());
    const directPath = `/${world.dataUrl}/original.pdf`;
    const gatewayPath = `/api/project-assets/${world.publicId}/original.pdf`;
    if (
      url.protocol === "https:" &&
      url.hostname === "localhost" &&
      url.port === "9876" &&
      url.pathname === directPath
    ) {
      pdfTransportRequests.push({
        boundary: "direct-cdn",
        method: request.method(),
        pathname: url.pathname,
        range: request.headers().range ?? null,
      });
    } else if (url.pathname === gatewayPath) {
      pdfTransportRequests.push({
        boundary: "same-origin-private-gateway",
        method: request.method(),
        pathname: url.pathname,
        range: request.headers().range ?? null,
      });
    }
  });
  page.on("requestfailed", (request) => {
    requestFailures.push(
      `${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`,
    );
  });
  page.on("response", (response) => {
    if (response.status() === 429) http429.push(response.url());
  });

  await page.addInitScript(() => {
    type Entry = {
      commits: number;
      mounts: number;
      updates: number;
      actualDurationMs: number;
    };
    const state = {
      label: "boot",
      counts: {} as Record<string, Entry>,
      servedShas: [] as string[],
    };
    (
      window as unknown as { __BP_PERF_V2_STATE__: typeof state }
    ).__BP_PERF_V2_STATE__ = state;
    (
      window as unknown as {
        __BP_PERF_V2_PROFILER__: {
          record: (
            id: string,
            phase: string,
            actualDuration: number,
            baseDuration: number,
            startTime: number,
            commitTime: number,
            servedSha: string,
          ) => void;
        };
      }
    ).__BP_PERF_V2_PROFILER__ = {
      record(
        id,
        phase,
        actualDuration,
        _baseDuration,
        _startTime,
        _commitTime,
        servedSha,
      ) {
        if (!state.servedShas.includes(servedSha))
          state.servedShas.push(servedSha);
        const entry = state.counts[id] ?? {
          commits: 0,
          mounts: 0,
          updates: 0,
          actualDurationMs: 0,
        };
        entry.commits += 1;
        if (phase === "mount") entry.mounts += 1;
        else entry.updates += 1;
        entry.actualDurationMs = +(
          entry.actualDurationMs + actualDuration
        ).toFixed(3);
        state.counts[id] = entry;
      },
    };
  });

  let cachedProjectBody: Record<string, unknown> | null = null;
  await page.route(`**/api/projects/${world.publicId}`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    if (!cachedProjectBody) {
      const response = await route.fetch();
      expect(response.ok(), "perf-v2 project bootstrap").toBe(true);
      const body = (await response.json()) as Record<string, unknown> & {
        projectIntelligence?: Record<string, unknown>;
      };
      cachedProjectBody = {
        ...body,
        takeoffItems: PERF_TAKEOFF_ITEMS,
        takeoffGroups: [],
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

  type CachedPageWindow = Record<string, unknown> & {
    from: number;
    to: number;
    annotations: Array<{ id: number }>;
  };
  const cachedPageWindows = new Map<string, CachedPageWindow>();
  const pageWindowObservations: PageWindowObservation[] = [];
  await page.route(
    `**/api/projects/${world.publicId}/pages?*`,
    async (route) => {
      const key = route.request().url();
      if (!cachedPageWindows.has(key)) {
        const response = await route.fetch();
        expect(response.ok(), `perf-v2 page window ${key}`).toBe(true);
        const body = (await response.json()) as Record<string, unknown> & {
          from: number;
          to: number;
          annotations?: Array<{ id: number }>;
        };
        cachedPageWindows.set(key, {
          ...body,
          annotations: [
            ...(body.annotations ?? []).filter(
              (annotation) => !PERF_ANNOTATION_IDS.has(annotation.id),
            ),
            ...PERF_DENSE_ANNOTATIONS.filter(
              (annotation) =>
                annotation.pageNumber >= body.from &&
                annotation.pageNumber <= body.to,
            ),
          ],
        });
      }
      const body = cachedPageWindows.get(key)!;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: body,
      });
      pageWindowObservations.push({ url: key, from: body.from, to: body.to });
    },
  );

  let cachedGroups: unknown;
  await page.route("**/api/annotation-groups?*", async (route) => {
    if (cachedGroups === undefined) {
      const response = await route.fetch();
      expect(response.ok(), "perf-v2 annotation groups").toBe(true);
      cachedGroups = await response.json();
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: cachedGroups,
    });
  });

  const cachedTextract = new Map<
    string,
    {
      status: number;
      headers: Record<string, string>;
      body: Buffer;
    }
  >();
  await page.route("**/api/pages/textract?*", async (route) => {
    const key = route.request().url();
    if (!cachedTextract.has(key)) {
      const response = await route.fetch();
      cachedTextract.set(key, {
        status: response.status(),
        headers: response.headers(),
        body: await response.body(),
      });
    }
    const cached = cachedTextract.get(key)!;
    await route.fulfill({
      status: cached.status,
      headers: cached.headers,
      body: cached.body,
    });
  });

  // The direct parent and candidate spell their known-missing image requests
  // differently. Intercept every source-compatible family at the same browser
  // boundary so neither leg pays server/CDN admission work. Record the exact
  // family and require both role-specific families below; a route that stops
  // being exercised therefore fails closed instead of silently changing work.
  const classifyMissingUnderlay = (
    requestUrl: string,
  ): MissingUnderlayFamily | null => {
    const url = new URL(requestUrl);
    if (
      url.pathname.match(
        new RegExp(
          `^/api/projects/${world.publicId}/thumbnail/[1-9][0-9]*$`,
          "u",
        ),
      )
    ) {
      return "legacy-thumbnail-proxy";
    }
    if (
      url.protocol === "https:" &&
      url.hostname === "localhost" &&
      url.port === "9876" &&
      url.pathname.match(
        new RegExp(`^/${world.dataUrl}/pages/page_[0-9]{4}\\.png$`, "u"),
      )
    ) {
      return "direct-cdn-page-underlay";
    }
    const gatewayMatch = new RegExp(
      `^/api/project-assets/${world.publicId}/(pages|thumbnails)/page_[0-9]{4}\\.png$`,
      "u",
    ).exec(url.pathname);
    if (gatewayMatch?.[1] === "pages") {
      return "private-gateway-page-underlay";
    }
    if (gatewayMatch?.[1] === "thumbnails") {
      return "private-gateway-thumbnail";
    }
    return null;
  };
  const fulfillMissingUnderlay = async (
    route: import("@playwright/test").Route,
  ) => {
    const request = route.request();
    const url = new URL(request.url());
    const family = classifyMissingUnderlay(request.url());
    expect(
      family,
      `classified missing underlay ${request.url()}`,
    ).not.toBeNull();
    expect(request.method(), `${family} request method`).toBe("GET");
    missingUnderlayRequests.push({
      family: family!,
      method: request.method(),
      url: request.url(),
      pathname: url.pathname,
      status: 404,
    });
    await route.fulfill({
      status: 404,
      contentType: "text/plain",
      body: "not found",
    });
  };
  for (const matcher of [
    /\/api\/projects\/[^/]+\/thumbnail\/[1-9][0-9]*(?:\?.*)?$/u,
    /^https:\/\/localhost:9876\/[^?#]+\/pages\/page_[0-9]{4}\.png(?:\?.*)?$/u,
    /\/api\/project-assets\/[^/]+\/(?:pages|thumbnails)\/page_[0-9]{4}\.png(?:\?.*)?$/u,
  ]) {
    await page.route(matcher, fulfillMissingUnderlay);
  }

  let annotationPosts = 0;
  const annotationPostBodies: Array<Record<string, unknown>> = [];
  await page.route("**/api/annotations", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    annotationPosts += 1;
    const body = JSON.parse(route.request().postData() || "{}") as Record<
      string,
      unknown
    >;
    annotationPostBodies.push(body);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: { id: 920000 + annotationPosts, ...body },
    });
  });

  let bucketServerFallbacks = 0;
  await page.route("**/api/bucket-fill", async (route) => {
    bucketServerFallbacks += 1;
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      json: { error: "perf-v2 forbids server fallback" },
    });
  });

  await page.goto("/login");
  await page.getByPlaceholder("Email").first().fill(world.email);
  await page.getByPlaceholder("Password").first().fill(world.password);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForURL("**/home**", { timeout: 60_000 });
  await page.goto(`/project/${world.publicId}`);
  await waitForPageCanvas(page);
  await settleFrames(page, 10);
  await expect(page.locator('[data-page-num="1"]')).toBeAttached();
  await expect(page.locator('[data-page-num="100"]')).not.toBeAttached();
  expect(await page.locator("[data-page-num]").count()).toBeLessThan(30);

  const samples: PerfSample[] = [];
  for (let run = 0; run < RUNS; run += 1) {
    samples.push(await measureOnce(page, pageWindowObservations));
  }
  validatePopulatedSamples(samples);

  expect(annotationPosts).toBeGreaterThanOrEqual(RUNS);
  expect(annotationPostBodies).toHaveLength(RUNS);
  for (const body of annotationPostBodies) {
    const data = body.data as
      { vertices?: unknown[]; takeoffItemId?: number } | undefined;
    expect(data?.vertices).toHaveLength(20);
    expect(data?.takeoffItemId).toBe(PERF_AREA_ITEM.id);
  }
  expect(bucketServerFallbacks).toBe(0);
  expect(pageErrors).toEqual([]);
  const abortedRequestFailures = requestFailures.filter(
    (failure) =>
      failure.includes("ERR_ABORTED") || failure.includes("NS_BINDING_ABORTED"),
  );
  const unexpectedRequestFailures = requestFailures.filter(
    (failure) =>
      !failure.includes("ERR_ABORTED") &&
      !failure.includes("NS_BINDING_ABORTED"),
  );
  expect(unexpectedRequestFailures).toEqual([]);
  const expectedMissingUnderlayFamilies: MissingUnderlayFamily[] =
    ROLE === "baseline"
      ? ["direct-cdn-page-underlay", "legacy-thumbnail-proxy"]
      : ["private-gateway-page-underlay", "private-gateway-thumbnail"];
  expect(
    [
      ...new Set(missingUnderlayRequests.map((request) => request.family)),
    ].sort(),
    "both role-specific missing-underlay request families must be exercised",
  ).toEqual([...expectedMissingUnderlayFamilies].sort());
  expect(
    missingUnderlayRequests.every(
      (request) => request.method === "GET" && request.status === 404,
    ),
    "every intercepted missing underlay must receive the symmetric deterministic 404",
  ).toBe(true);
  expect(http429).toEqual([]);
  const expectedTransportBoundary =
    ROLE === "baseline" ? "direct-cdn" : "same-origin-private-gateway";
  expect(
    pdfTransportRequests.length,
    "source-exact A/B must exercise a PDF transport",
  ).toBeGreaterThan(0);
  expect(
    [...new Set(pdfTransportRequests.map((request) => request.boundary))],
    "source-exact A/B browser boundary",
  ).toEqual([expectedTransportBoundary]);
  expect(
    pdfTransportRequests.every((request) => request.method === "GET"),
    "source-exact A/B PDF requests are GETs",
  ).toBe(true);
  expect(
    pdfTransportRequests.some((request) => request.range !== null),
    "source-exact A/B PDF transport includes ranges",
  ).toBe(true);
  const servedShas = await page.evaluate(
    () =>
      (
        window as unknown as {
          __BP_PERF_V2_STATE__?: { servedShas: string[] };
        }
      ).__BP_PERF_V2_STATE__?.servedShas ?? [],
  );
  expect(servedShas).toEqual([SOURCE_SHA]);

  const instrumentation = worktree.instrumentation;

  const fixturePath = "test/fixtures/synthetic-100pg.pdf";
  const packageLockPath = "package-lock.json";
  const specPath = "e2e/viewer-perf-v2.spec.ts";
  const configPath = "playwright.perf-v2.config.ts";
  const patcherPath = "scripts/apply-perf-v2-instrumentation.mjs";
  const comparatorPath = "scripts/compare-viewer-perf-v2.mjs";
  const probePath = "e2e/perf-v2/PerfRenderProbe.tsx";
  const generatorPath = "scripts/make-synthetic-pdf.mjs";
  const globalSetupPath = "e2e/global-setup.ts";
  const cdnStubPath = "e2e/cdn-stub.mjs";
  const fixturePreflightPath = "e2e/ensure-synthetic-pdf.mjs";
  const startDevServerPath = "e2e/start-dev-server.mjs";
  const result = {
    schemaVersion: SCHEMA_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    date: new Date().toISOString(),
    role: ROLE,
    leg: LEG,
    sourceSha: SOURCE_SHA,
    sourceCommitSha: worktree.sourceCommitSha,
    harnessSha: HARNESS_SHA,
    mode: `dev-turbopack · median-of-${RUNS} · viewport1600x1000 · dpr2`,
    runs: RUNS,
    smoke: SMOKE,
    transportBoundary: {
      browserBoundary: expectedTransportBoundary,
      sourceExact: true,
      securityEvidence: false,
      rationale:
        "timing A/B intentionally accepts historical direct-CDN baseline versus same-origin candidate; authorization and upstream cancellation are proven by the dedicated private-gateway oracle",
      missingUnderlayTreatment:
        "all source-compatible legacy/current page and thumbnail request families are intercepted at the browser boundary with the same deterministic 404",
      pdfRequestCount: pdfTransportRequests.length,
      pdfRequestPaths: [
        ...new Set(pdfTransportRequests.map((request) => request.pathname)),
      ],
      pdfRangeRequestCount: pdfTransportRequests.filter(
        (request) => request.range !== null,
      ).length,
    },
    thresholdContract: {
      candidateVsBaselineTimingMaxRatioExclusive: 1.6,
      candidateBucket4000MaxMsExclusive: 400,
      profilerCommitGateScenarios: [
        "zoom10",
        "polygon20",
        "drag60",
        "bucket4000",
      ],
      candidateProfilerCommitsMustNotExceedBaselineForGatedScenarios: true,
      deterministicDrawEndUnitFloor: {
        AnnotationOverlay: 0,
        DrawingPreviewLayer: 1,
        PDFPage: 0,
      },
    },
    fixture: {
      pdfVersion: "synthetic-100pg-seed-b1ce-target60mb",
      pdfPages: world.pages,
      pdfBytes: statSync(fixturePath).size,
      pdfSha256: sha256File(fixturePath),
      generatorSha256: sha256File(generatorPath),
      yoloTags: PERF_YOLO_TAGS.length,
      yoloInstances: PERF_YOLO_TAGS.reduce(
        (total, tag) => total + tag.instances.length,
        0,
      ),
      denseAnnotations: PERF_DENSE_ANNOTATIONS.length,
      takeoffItems: PERF_TAKEOFF_ITEMS.length,
      bucketRaster: samples[0].bucketRaster,
      bucketPreviewWitness: BUCKET_PREVIEW_WITNESS,
      underlays:
        "absent; legacy/current page and thumbnail families receive symmetric browser-intercepted 404s; bucket uses deterministic 4000x2667 black-wall/white-room-with-column raster",
    },
    harness: {
      specSha256: sha256File(specPath),
      configSha256: sha256File(configPath),
      patcherSha256: sha256File(patcherPath),
      comparatorSha256: sha256File(comparatorPath),
      probeSha256: sha256File(probePath),
      globalSetupSha256: sha256File(globalSetupPath),
      cdnStubSha256: sha256File(cdnStubPath),
      fixturePreflightSha256: sha256File(fixturePreflightPath),
      startDevServerSha256: sha256File(startDevServerPath),
      packageLockSha256: sha256File(packageLockPath),
      instrumentation,
      exactAppWorktree: {
        root: realpathSync(APP_ROOT),
        headSha: worktree.headSha,
        sourceCommitSha: worktree.sourceCommitSha,
        gitStatus: worktree.gitStatus,
      },
    },
    environment: {
      node: process.version,
      playwright: JSON.parse(
        readFileSync("node_modules/@playwright/test/package.json", "utf8"),
      ).version,
      chromium: browser.version(),
      os: `${platform()} ${release()}`,
      cpu: cpus()[0]?.model ?? "unknown",
      viewport: page.viewportSize(),
      devicePixelRatio: await page.evaluate(() => window.devicePixelRatio),
      postgres: "17 localhost:5433/bp_test",
    },
    medians: {
      coldOpenWarmMs: median(samples.map((sample) => sample.coldOpenWarmMs)),
      nav20Ms: median(samples.map((sample) => sample.nav20Ms)),
      navRafP95Ms: median(samples.map((sample) => sample.navRafP95Ms)),
      zoom10Ms: median(samples.map((sample) => sample.zoom10Ms)),
      zoomRafP95Ms: median(samples.map((sample) => sample.zoomRafP95Ms)),
      polygon20Ms: median(samples.map((sample) => sample.polygon20Ms)),
      polygonRafP95Ms: median(samples.map((sample) => sample.polygonRafP95Ms)),
      drag60Ms: median(samples.map((sample) => sample.drag60Ms)),
      dragRafP95Ms: median(samples.map((sample) => sample.dragRafP95Ms)),
      bucket4000Ms: median(samples.map((sample) => sample.bucket4000Ms)),
      bucketRafP95Ms: median(samples.map((sample) => sample.bucketRafP95Ms)),
      profiler: profilerMedians(samples),
    },
    samples,
    integrity: {
      pageErrors,
      requestFailures,
      abortedRequestFailures,
      unexpectedRequestFailures,
      missingUnderlayRequests,
      missingUnderlay404s: missingUnderlayRequests.filter(
        (request) => request.status === 404,
      ).length,
      http429,
      annotationPosts,
      polygonPostVertexCounts: annotationPostBodies.map(
        (body) =>
          ((body.data as { vertices?: unknown[] } | undefined)?.vertices ?? [])
            .length,
      ),
      bucketServerFallbacks,
      cachedProjectResponses: cachedProjectBody ? 1 : 0,
      cachedPageWindowKeys: cachedPageWindows.size,
      cachedTextractKeys: cachedTextract.size,
      servedShas,
      navFinalPages: samples.map((sample) => sample.navOutcome.activePage),
      navFinalPageWindows: samples.map(
        (sample) => sample.navOutcome.pageWindow,
      ),
      navRasterPaintedPixelSamples: samples.map(
        (sample) => sample.navOutcome.raster.paintedPixelSamples,
      ),
      navPdfPageCommits: samples.map(
        (sample) => sample.navOutcome.pdfPageCommits,
      ),
      zoomScaleChanges: samples.map((sample) => ({
        beforePercent: sample.zoomOutcome.beforePercent,
        afterPercent: sample.zoomOutcome.afterPercent,
        deltaPercent: sample.zoomOutcome.deltaPercent,
      })),
      zoomPdfPageCommits: samples.map(
        (sample) => sample.zoomOutcome.pdfPageCommits,
      ),
      bucketPreviewOutcomes: samples.map((sample) => sample.bucketOutcome),
    },
  };
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(result, null, 2)}\n`, {
    flag: "wx",
  });
  console.log(`[perf-v2] wrote ${OUTPUT_PATH}`, result.medians);

  if (ROLE === "candidate") {
    expect
      .soft(result.medians.bucket4000Ms, "candidate bucket4000 absolute target")
      .toBeLessThan(400);
  }
});
