// Build the versioned annotation-owner derivative and apply identical measurement-only probes to
// an exact detached direct-parent worktree. No product checkout or committed H2 artifact is edited.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_VERSION = "bp-annotation-owner-perf-v2-overlay-1";
const BASELINE_SHA = "e8752e9fe298b56c7cf20ba6e2e1005e32a57845";
const CANDIDATE_SHA = "12fcab503d6b7cfcbdf5726f466629abd16e45a9";
const scriptPath = fileURLToPath(import.meta.url);
const harnessRoot = resolve(dirname(scriptPath), "..");

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function git(appRoot, ...args) {
  return execFileSync("git", ["-C", appRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function replaceExactly(text, before, after, expectedCount, label) {
  let count = 0;
  let cursor = 0;
  while ((cursor = text.indexOf(before, cursor)) >= 0) {
    count += 1;
    cursor += before.length;
  }
  if (count !== expectedCount) {
    throw new Error(`${label}: expected ${expectedCount} marker(s), found ${count}`);
  }
  return text.split(before).join(after);
}

const appRoot = resolve(argument("app-root") ?? "");
const sourceSha = argument("source-sha");
if (!argument("app-root") || !sourceSha) {
  throw new Error("usage: node scripts/apply-annotation-owner-perf-v2-instrumentation.mjs --app-root PATH --source-sha SHA");
}
if (![BASELINE_SHA, CANDIDATE_SHA].includes(sourceSha)) {
  throw new Error(`source SHA must be the declared direct parent or child; received ${sourceSha}`);
}
if (git(harnessRoot, "rev-parse", `${CANDIDATE_SHA}^`) !== BASELINE_SHA) {
  throw new Error("declared candidate is not an exact direct child of the declared baseline");
}

const canonicalAppRoot = realpathSync(appRoot);
const canonicalHarnessRoot = realpathSync(harnessRoot);
if (realpathSync(git(canonicalAppRoot, "rev-parse", "--show-toplevel")) !== canonicalAppRoot) {
  throw new Error("--app-root must be the detached worktree root");
}
if (canonicalAppRoot === canonicalHarnessRoot) {
  throw new Error("refusing to instrument the owner harness checkout");
}
if (git(canonicalAppRoot, "rev-parse", "HEAD") !== sourceSha) {
  throw new Error("source SHA mismatch between argument and detached worktree HEAD");
}
if (git(canonicalAppRoot, "rev-parse", "--abbrev-ref", "HEAD") !== "HEAD") {
  throw new Error("benchmark app must be detached");
}
const preStatus = git(canonicalAppRoot, "status", "--porcelain=v1", "--untracked-files=all");
if (preStatus !== "") throw new Error(`worktree must be clean before instrumentation:\n${preStatus}`);

const probeTemplatePath = join(harnessRoot, "e2e/perf-v2/AnnotationOwnerPerfRenderProbe.tsx");
const probeSource = readFileSync(probeTemplatePath, "utf8");
const probeTargetPath = join(canonicalAppRoot, "src/components/viewer/AnnotationOwnerPerfRenderProbe.tsx");
const baseSpecPath = join(harnessRoot, "e2e/viewer-perf-v2.spec.ts");
const generatedSpecPath = join(canonicalAppRoot, "e2e/annotation-owner-perf-v2.spec.ts");
const baseSpecSource = readFileSync(baseSpecPath, "utf8");

const transforms = [
  {
    file: "src/components/viewer/PDFPage.tsx",
    importBefore: 'import AnnotationOverlay from "./AnnotationOverlay";',
    importAfter: 'import AnnotationOverlay from "./AnnotationOverlay";\nimport AnnotationOwnerPerfRenderProbe from "./AnnotationOwnerPerfRenderProbe";',
    jsxBefore: "      {/* PNG background — ALWAYS in DOM behind canvas. Shows through when canvas is hidden.",
    jsxAfter: "      <AnnotationOwnerPerfRenderProbe id=\"PDFPage\" />\n      {/* PNG background — ALWAYS in DOM behind canvas. Shows through when canvas is hidden.",
  },
  {
    file: "src/components/viewer/AnnotationOverlay.tsx",
    importBefore: 'import DrawingPreviewLayer from "./DrawingPreviewLayer";',
    importAfter: 'import DrawingPreviewLayer from "./DrawingPreviewLayer";\nimport AnnotationOwnerPerfRenderProbe from "./AnnotationOwnerPerfRenderProbe";',
    jsxBefore: "  return (\n    <>\n      <canvas\n        ref={canvasRef}",
    jsxAfter: "  return (\n    <>\n      <AnnotationOwnerPerfRenderProbe id=\"AnnotationOverlay\" annotationCount={pageAnnotations.length} selectedAnnotationId={selectedId} />\n      <canvas\n        ref={canvasRef}\n        data-perf-surface=\"annotation-overlay\"",
  },
  {
    file: "src/components/viewer/DrawingPreviewLayer.tsx",
    importBefore: 'import BucketFillAssignDialog from "./BucketFillAssignDialog";',
    importAfter: 'import BucketFillAssignDialog from "./BucketFillAssignDialog";\nimport AnnotationOwnerPerfRenderProbe from "./AnnotationOwnerPerfRenderProbe";',
    jsxBefore: "  return (\n    <>\n      <canvas\n        ref={canvasRef}",
    jsxAfter: "  return (\n    <>\n      <AnnotationOwnerPerfRenderProbe id=\"DrawingPreviewLayer\" />\n      <canvas\n        ref={canvasRef}",
  },
];

const preparedTransforms = transforms.map((transform) => {
  const path = join(canonicalAppRoot, transform.file);
  const before = readFileSync(path, "utf8");
  if (before.includes('from "./AnnotationOwnerPerfRenderProbe"')) {
    throw new Error(`${transform.file}: annotation-owner overlay already applied`);
  }
  let after = replaceExactly(before, transform.importBefore, transform.importAfter, 1,
    `${transform.file} import`);
  after = replaceExactly(after, transform.jsxBefore, transform.jsxAfter, 1,
    `${transform.file} JSX`);
  return {
    path,
    after,
    target: { file: transform.file, beforeSha256: sha256(before), afterSha256: sha256(after) },
  };
});

let generatedSpec = baseSpecSource;
const derive = (before, after, count, label) => {
  generatedSpec = replaceExactly(generatedSpec, before, after, count, label);
};

derive('const SCHEMA_VERSION = "bp-viewer-perf-v2.2.0";',
  'const SCHEMA_VERSION = "bp-annotation-owner-perf-v2.1.0";', 1, "artifact schema");
derive('const PROTOCOL_VERSION =\n  "p2.4-direct-parent-symmetric-missing-underlays-profiler-median3-reverse1";',
  'const PROTOCOL_VERSION = "p2.2.6-annotation-owner-direct-parent-delete-witness-median3-abba1";',
  1, "protocol version");
derive('} from "@playwright/test";',
  '} from "../../../blueprintparser_2/node_modules/@playwright/test";',
  1, "single owner Playwright module");
derive('  probeSha256: string;\n  targets:',
  '  probeSha256: string;\n  baseSpecSha256: string;\n  generatedSpecSha256: string;\n  targets:',
  1, "manifest spec hashes type");
derive('const PERF_PAGE_ONE_ANNOTATIONS = [\n  PERF_DRAG_TARGET,\n  ...Array.from({ length: 511 }',
  'const PERF_DELETE_TARGET = {\n  id: 990001,\n  pageNumber: 1,\n  name: "PERF-DELETE-TARGET",\n  bbox: [0.955, 0.965, 0.985, 0.99],\n  note: null,\n  source: "user",\n  data: null,\n};\n\nconst PERF_PAGE_ONE_ANNOTATIONS = [\n  PERF_DRAG_TARGET,\n  PERF_DELETE_TARGET,\n  ...Array.from({ length: 510 }',
  1, "positive delete fixture");
derive('const manifestPath = resolve(APP_ROOT, ".perf-v2-instrumentation.json");',
  'const manifestPath = resolve(APP_ROOT, ".annotation-owner-perf-v2-instrumentation.json");',
  1, "manifest path");
derive('  expect(instrumentation.schemaVersion).toBe(\n    "bp-perf-v2-instrumentation-manifest-1",\n  );',
  '  expect(instrumentation.schemaVersion).toBe(\n    "bp-annotation-owner-perf-v2-instrumentation-manifest-1",\n  );',
  1, "manifest schema");
derive('  expect(instrumentation.probeSha256).toBe(\n    sha256File("e2e/perf-v2/PerfRenderProbe.tsx"),\n  );',
  '  expect(instrumentation.probeSha256).toBe(\n    sha256File("e2e/perf-v2/AnnotationOwnerPerfRenderProbe.tsx"),\n  );\n  expect(instrumentation.baseSpecSha256).toBe(\n    sha256File("e2e/viewer-perf-v2.spec.ts"),\n  );\n  expect(instrumentation.generatedSpecSha256).toBe(\n    sha256File(resolve(APP_ROOT, "e2e/annotation-owner-perf-v2.spec.ts")),\n  );',
  1, "manifest provenance assertions");
derive('    "?? .perf-v2-instrumentation.json",\n    "?? src/components/viewer/PerfRenderProbe.tsx",',
  '    "?? .annotation-owner-perf-v2-instrumentation.json",\n    "?? e2e/annotation-owner-perf-v2.spec.ts",\n    "?? src/components/viewer/AnnotationOwnerPerfRenderProbe.tsx",',
  1, "expected detached status");
derive('    sha256File(resolve(APP_ROOT, "src/components/viewer/PerfRenderProbe.tsx")),\n    "copied probe must match the common harness probe",',
  '    sha256File(\n      resolve(APP_ROOT, "src/components/viewer/AnnotationOwnerPerfRenderProbe.tsx"),\n    ),\n    "copied annotation-owner probe must match the common harness probe",',
  1, "copied probe assertion");

const deleteMeasure = `type DeleteTransportObservation = {
  sequence: number;
  method: string;
  url: string;
  status: number;
  requestedAtEpochMs: number;
  fulfilledAtEpochMs: number;
  requestBody: string | null;
};
type DeleteTransportTracker = { observations: DeleteTransportObservation[] };

async function measureAnnotationDelete(page: Page, tracker: DeleteTransportTracker) {
  await reloadReady(page);
  await settleFrames(page, 10);
  await page.getByRole("button", { name: /Pointer\\s*Select/ }).click();
  await settleFrames(page, 4);
  const overlay = await annotationCanvas(page);
  const witness = page.locator('[data-annotation-owner-witness="true"]');
  await expect(witness).toHaveCount(1);
  await expect(witness).toHaveAttribute("data-annotation-count", "512");
  const box = await overlay.boundingBox();
  if (!box) throw new Error("overlay has no box for annotation delete");
  const targetX = box.x + box.width * ((PERF_DELETE_TARGET.bbox[0] + PERF_DELETE_TARGET.bbox[2]) / 2);
  const targetY = box.y + box.height * ((PERF_DELETE_TARGET.bbox[1] + PERF_DELETE_TARGET.bbox[3]) / 2);
  await page.mouse.click(targetX, targetY);
  await expect(witness).toHaveAttribute("data-selected-annotation-id", String(PERF_DELETE_TARGET.id));
  const beforeCount = Number(await witness.getAttribute("data-annotation-count"));
  const priorTransportCount = tracker.observations.length;
  await resetProfiler(page, "annotationDelete");
  await startFrameSampler(page);
  const started = performance.now();
  await page.keyboard.press("Delete");
  await expect.poll(() => tracker.observations.length, {
    timeout: 10_000,
    message: "one positive-ID annotation DELETE reached transport",
  }).toBe(priorTransportCount + 1);
  await expect(witness).toHaveAttribute("data-annotation-count", "511");
  await expect(witness).toHaveAttribute("data-selected-annotation-id", "");
  await settleFrames(page, 3);
  const elapsedMs = Math.round(performance.now() - started);
  const gaps = await stopFrameSampler(page);
  const profiler = await profilerSnapshot(page);
  const afterCount = Number(await witness.getAttribute("data-annotation-count"));
  const transport = tracker.observations.at(-1)!;
  expect(transport.method).toBe("DELETE");
  expect(transport.status).toBe(200);
  expect(new URL(transport.url).pathname).toBe(\`/api/annotations/\${PERF_DELETE_TARGET.id}\`);
  expect(transport.fulfilledAtEpochMs).toBeGreaterThanOrEqual(transport.requestedAtEpochMs);

  await page.mouse.click(targetX, targetY);
  await page.keyboard.press("Delete");
  await settleFrames(page, 5);
  expect(tracker.observations).toHaveLength(priorTransportCount + 1);
  return {
    elapsedMs,
    rafP95Ms: p95(gaps),
    profiler,
    outcome: {
      targetId: PERF_DELETE_TARGET.id,
      beforeCount,
      afterCount,
      selectedIdBefore: PERF_DELETE_TARGET.id,
      selectedIdAfter: null,
      replayDeleteSuppressed: true,
      transport,
    },
  };
}

`;
derive('type PerfSample = {', deleteMeasure + 'type PerfSample = {', 1, "delete measurement");
derive('  bucketRafP95Ms: number;\n  profiler: Record<\n    "nav20" | "zoom10" | "polygon20" | "drag60" | "bucket4000",\n    ProfilerSnapshot\n  >;',
  '  bucketRafP95Ms: number;\n  annotationDeleteMs: number;\n  annotationDeleteRafP95Ms: number;\n  profiler: Record<\n    "nav20" | "zoom10" | "polygon20" | "drag60" | "bucket4000" | "annotationDelete",\n    ProfilerSnapshot\n  >;',
  1, "delete sample timing type");
derive('  zoomOutcome: Awaited<ReturnType<typeof measureZoom10>>["outcome"];\n};',
  '  zoomOutcome: Awaited<ReturnType<typeof measureZoom10>>["outcome"];\n  polygonOutcome: Awaited<ReturnType<typeof measurePolygon20>>;\n  dragOutcome: Awaited<ReturnType<typeof measureDrag60>>;\n  annotationDeleteOutcome: Awaited<ReturnType<typeof measureAnnotationDelete>>["outcome"];\n};',
  1, "delete outcome type");
derive('  pageWindows: PageWindowObservation[],\n): Promise<PerfSample> {',
  '  pageWindows: PageWindowObservation[],\n  deleteTransport: DeleteTransportTracker,\n): Promise<PerfSample> {',
  1, "measureOnce tracker argument");
derive('  const drag = await measureDrag60(page);\n  return {',
  '  const drag = await measureDrag60(page);\n  const annotationDelete = await measureAnnotationDelete(page, deleteTransport);\n  return {',
  1, "invoke delete scenario");
derive('    bucketRafP95Ms: bucket.rafP95Ms,\n    profiler: {',
  '    bucketRafP95Ms: bucket.rafP95Ms,\n    annotationDeleteMs: annotationDelete.elapsedMs,\n    annotationDeleteRafP95Ms: annotationDelete.rafP95Ms,\n    profiler: {',
  1, "record delete timing");
derive('      bucket4000: bucket.profiler,\n    },',
  '      bucket4000: bucket.profiler,\n      annotationDelete: annotationDelete.profiler,\n    },',
  1, "record delete profiler");
derive('    zoomOutcome: zoom.outcome,\n  };',
  '    zoomOutcome: zoom.outcome,\n    polygonOutcome: polygon,\n    dragOutcome: drag,\n    annotationDeleteOutcome: annotationDelete.outcome,\n  };',
  1, "record delete outcome");
derive('    "bucketRafP95Ms",\n  ] as const;',
  '    "bucketRafP95Ms",\n    "annotationDeleteMs",\n    "annotationDeleteRafP95Ms",\n  ] as const;',
  1, "validate delete timings");
derive('["nav20", "zoom10", "polygon20", "drag60", "bucket4000"] as const',
  '["nav20", "zoom10", "polygon20", "drag60", "bucket4000", "annotationDelete"] as const',
  1, "profiler median scenarios");
derive('    for (const scenario of [\n      "nav20",\n      "zoom10",\n      "polygon20",\n      "drag60",\n      "bucket4000",\n    ] as const) {',
  '    for (const scenario of [\n      "nav20",\n      "zoom10",\n      "polygon20",\n      "drag60",\n      "bucket4000",\n      "annotationDelete",\n    ] as const) {',
  1, "sample profiler scenarios");
derive('    expect(sample.bucketOutcome.holeCenterAlpha).toBe(0);\n  }',
  '    expect(sample.bucketOutcome.holeCenterAlpha).toBe(0);\n    expect(sample.polygonOutcome.vertices).toBe(20);\n    expect(sample.polygonOutcome.optimisticPolygonVisible).toBe(true);\n    expect(sample.dragOutcome.pointerSteps).toBe(60);\n    expect(sample.dragOutcome.observedMouseMoves).toBeGreaterThanOrEqual(60);\n    expect(sample.dragOutcome.denseAnnotations).toBe(6848);\n    expect(sample.dragOutcome.targetWasReactive).toBe(true);\n    expect(sample.annotationDeleteOutcome.targetId).toBe(PERF_DELETE_TARGET.id);\n    expect(sample.annotationDeleteOutcome.beforeCount).toBe(512);\n    expect(sample.annotationDeleteOutcome.afterCount).toBe(511);\n    expect(sample.annotationDeleteOutcome.selectedIdBefore).toBe(PERF_DELETE_TARGET.id);\n    expect(sample.annotationDeleteOutcome.selectedIdAfter).toBeNull();\n    expect(sample.annotationDeleteOutcome.replayDeleteSuppressed).toBe(true);\n    expect(sample.annotationDeleteOutcome.transport.method).toBe("DELETE");\n    expect(sample.annotationDeleteOutcome.transport.status).toBe(200);\n  }',
  1, "validate delete outcome");
derive('test("viewer perf-v2 populated source-exact protocol"',
  'test("annotation-owner direct-parent populated source-exact protocol"', 1, "test name");
derive('  const expectedMissingUnderlayFamilies: MissingUnderlayFamily[] =\n    ROLE === "baseline"\n      ? ["direct-cdn-page-underlay", "legacy-thumbnail-proxy"]\n      : ["private-gateway-page-underlay", "private-gateway-thumbnail"];',
  '  const expectedMissingUnderlayFamilies: MissingUnderlayFamily[] = [\n    "direct-cdn-page-underlay",\n    "legacy-thumbnail-proxy",\n  ];',
  1, "source-compatible missing underlays");
derive('  const expectedTransportBoundary =\n    ROLE === "baseline" ? "direct-cdn" : "same-origin-private-gateway";',
  '  const expectedTransportBoundary = "direct-cdn";',
  1, "source-compatible PDF transport");
derive('timing A/B intentionally accepts historical direct-CDN baseline versus same-origin candidate; authorization and upstream cancellation are proven by the dedicated private-gateway oracle',
  'annotation-owner direct parent and candidate both use the historical direct-CDN browser boundary; transport is held constant and is not security evidence',
  1, "annotation transport rationale");

derive('  const annotationPostBodies: Array<Record<string, unknown>> = [];',
  '  const annotationPostBodies: Array<Record<string, unknown>> = [];\n  const annotationPostTransports: Array<{ method: string; url: string; status: number; requestedAtEpochMs: number; fulfilledAtEpochMs: number }> = [];',
  1, "polygon POST tracker");
derive('    annotationPosts += 1;\n    const body = JSON.parse(route.request().postData() || "{}") as Record<',
  '    annotationPosts += 1;\n    const requestedAtEpochMs = Date.now();\n    const body = JSON.parse(route.request().postData() || "{}") as Record<',
  1, "polygon POST request timing");
derive('      json: { id: 920000 + annotationPosts, ...body },\n    });',
  '      json: { id: 920000 + annotationPosts, ...body },\n    });\n    annotationPostTransports.push({ method: route.request().method(), url: route.request().url(), status: 200, requestedAtEpochMs, fulfilledAtEpochMs: Date.now() });',
  1, "polygon POST transport outcome");
derive('  expect(annotationPostBodies).toHaveLength(RUNS);',
  '  expect(annotationPostBodies).toHaveLength(RUNS);\n  expect(annotationPostTransports).toHaveLength(RUNS);\n  expect(annotationPostTransports.map((entry) => entry.method)).toEqual(Array(RUNS).fill("POST"));\n  expect(annotationPostTransports.map((entry) => entry.status)).toEqual(Array(RUNS).fill(200));',
  1, "polygon POST transport assertions");

const deleteRoute = `  const deleteTransport: DeleteTransportTracker = { observations: [] };
  await page.route(\`**/api/annotations/\${PERF_DELETE_TARGET.id}\`, async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    const requestedAtEpochMs = Date.now();
    const sequence = deleteTransport.observations.length + 1;
    const requestBody = route.request().postData();
    await route.fulfill({ status: 200, contentType: "application/json", json: { success: true } });
    deleteTransport.observations.push({
      sequence,
      method: route.request().method(),
      url: route.request().url(),
      status: 200,
      requestedAtEpochMs,
      fulfilledAtEpochMs: Date.now(),
      requestBody,
    });
  });

`;
derive('  let bucketServerFallbacks = 0;', deleteRoute + '  let bucketServerFallbacks = 0;',
  1, "delete route witness");
derive('samples.push(await measureOnce(page, pageWindowObservations));',
  'samples.push(await measureOnce(page, pageWindowObservations, deleteTransport));',
  1, "pass delete tracker");
derive('  expect(bucketServerFallbacks).toBe(0);',
  '  expect(deleteTransport.observations).toHaveLength(RUNS);\n  expect(deleteTransport.observations.map((entry) => entry.method)).toEqual(Array(RUNS).fill("DELETE"));\n  expect(deleteTransport.observations.map((entry) => entry.status)).toEqual(Array(RUNS).fill(200));\n  expect(bucketServerFallbacks).toBe(0);',
  1, "delete transport total");
derive('  const specPath = "e2e/viewer-perf-v2.spec.ts";\n  const configPath = "playwright.perf-v2.config.ts";\n  const patcherPath = "scripts/apply-perf-v2-instrumentation.mjs";\n  const comparatorPath = "scripts/compare-viewer-perf-v2.mjs";\n  const probePath = "e2e/perf-v2/PerfRenderProbe.tsx";',
  '  const baseSpecPath = "e2e/viewer-perf-v2.spec.ts";\n  const generatedSpecPath = resolve(APP_ROOT, "e2e/annotation-owner-perf-v2.spec.ts");\n  const configPath = "playwright.annotation-owner-perf-v2.config.ts";\n  const patcherPath = "scripts/apply-annotation-owner-perf-v2-instrumentation.mjs";\n  const comparatorPath = "scripts/compare-annotation-owner-perf-v2.mjs";\n  const probePath = "e2e/perf-v2/AnnotationOwnerPerfRenderProbe.tsx";',
  1, "derivative harness paths");
derive('      profilerCommitGateScenarios: [\n        "zoom10",\n        "polygon20",\n        "drag60",\n        "bucket4000",\n      ],\n      candidateProfilerCommitsMustNotExceedBaselineForGatedScenarios: true,\n      deterministicDrawEndUnitFloor:',
  '      profilerCommitGateScenarios: ["zoom10", "polygon20", "drag60", "bucket4000", "annotationDelete"],\n      candidateProfilerCommitsMustNotExceedBaselineForGatedScenarios: true,\n      annotationDeleteWitness: { targetId: 990001, requestsPerSample: 1, status: 200, beforeCount: 512, afterCount: 511 },\n      deterministicDrawEndUnitFloor:',
  1, "threshold contract");
derive('      specSha256: sha256File(specPath),',
  '      baseSpecSha256: sha256File(baseSpecPath),\n      generatedSpecSha256: sha256File(generatedSpecPath),',
  1, "spec provenance hashes");
derive('        sourceCommitSha: worktree.sourceCommitSha,\n        gitStatus: worktree.gitStatus,',
  '        sourceCommitSha: worktree.sourceCommitSha,\n        sourcePackageLockSha256: sha256File(resolve(APP_ROOT, "package-lock.json")),\n        gitStatus: worktree.gitStatus,',
  1, "exact source lock hash");
derive('      postgres: "17 localhost:5433/bp_test",',
  '      postgres: "17 localhost:5433/bp_test",\n      playwrightModule: realpathSync("node_modules/@playwright/test"),',
  1, "single Playwright module provenance");
derive('      bucketRafP95Ms: median(samples.map((sample) => sample.bucketRafP95Ms)),\n      profiler:',
  '      bucketRafP95Ms: median(samples.map((sample) => sample.bucketRafP95Ms)),\n      annotationDeleteMs: median(samples.map((sample) => sample.annotationDeleteMs)),\n      annotationDeleteRafP95Ms: median(samples.map((sample) => sample.annotationDeleteRafP95Ms)),\n      profiler:',
  1, "delete medians");
derive('      annotationPosts,\n      polygonPostVertexCounts:',
  '      annotationPosts,\n      annotationPostTransports,\n      polygonOutcomes: samples.map((sample) => sample.polygonOutcome),\n      dragOutcomes: samples.map((sample) => sample.dragOutcome),\n      annotationDeletes: deleteTransport.observations.length,\n      annotationDeleteTransports: deleteTransport.observations,\n      annotationDeleteOutcomes: samples.map((sample) => sample.annotationDeleteOutcome),\n      polygonPostVertexCounts:',
  1, "delete integrity");
derive('console.log(`[perf-v2] wrote ${OUTPUT_PATH}`, result.medians);',
  'console.log(`[annotation-owner-perf-v2] wrote ${OUTPUT_PATH}`, result.medians);',
  1, "log prefix");

mkdirSync(dirname(probeTargetPath), { recursive: true });
mkdirSync(dirname(generatedSpecPath), { recursive: true });
writeFileSync(probeTargetPath, probeSource);
for (const prepared of preparedTransforms) writeFileSync(prepared.path, prepared.after);
writeFileSync(generatedSpecPath, generatedSpec);

const targets = preparedTransforms.map(({ path, target }) => {
  const actual = sha256(readFileSync(path));
  if (actual !== target.afterSha256) throw new Error(`${target.file}: after-hash verification failed`);
  return { ...target, afterSha256: actual };
});
const probeSha256 = sha256(readFileSync(probeTargetPath));
const baseSpecSha256 = sha256(baseSpecSource);
const generatedSpecSha256 = sha256(readFileSync(generatedSpecPath));
if (probeSha256 !== sha256(probeSource)) throw new Error("copied probe hash mismatch");
if (generatedSpecSha256 !== sha256(generatedSpec)) throw new Error("generated spec hash mismatch");

const overlayProtocolSha256 = sha256([
  SCRIPT_VERSION,
  readFileSync(scriptPath),
  probeSource,
  baseSpecSource,
  generatedSpec,
].join("\n--annotation-owner-protocol-part--\n"));
const manifest = {
  schemaVersion: "bp-annotation-owner-perf-v2-instrumentation-manifest-1",
  scriptVersion: SCRIPT_VERSION,
  sourceSha,
  baselineSha: BASELINE_SHA,
  candidateSha: CANDIDATE_SHA,
  directParentVerified: true,
  overlayProtocolSha256,
  probeSha256,
  baseSpecSha256,
  generatedSpecSha256,
  targets,
};
const manifestPath = join(canonicalAppRoot, ".annotation-owner-perf-v2-instrumentation.json");
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
if (JSON.stringify(JSON.parse(readFileSync(manifestPath, "utf8"))) !== JSON.stringify(manifest)) {
  throw new Error("instrumentation manifest read-back mismatch");
}
console.log(JSON.stringify(manifest, null, 2));
