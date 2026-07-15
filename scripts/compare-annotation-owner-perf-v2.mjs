// Validate and adjudicate the immutable P2.2.6 annotation-owner direct-parent A/B cohort.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

const BASELINE_SHA = "e8752e9fe298b56c7cf20ba6e2e1005e32a57845";
const CANDIDATE_SHA = "12fcab503d6b7cfcbdf5726f466629abd16e45a9";
const SCHEMA = "bp-annotation-owner-perf-v2.1.0";
const PROTOCOL = "p2.2.6-annotation-owner-direct-parent-delete-witness-median3-abba1";
const VERDICT_SCHEMA = "bp-annotation-owner-perf-v2-verdict-1";
const MANIFEST_SCHEMA = "bp-annotation-owner-perf-v2-instrumentation-manifest-1";
const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TIMING_KEYS = [
  "coldOpenWarmMs", "nav20Ms", "navRafP95Ms", "zoom10Ms", "zoomRafP95Ms",
  "polygon20Ms", "polygonRafP95Ms", "drag60Ms", "dragRafP95Ms",
  "bucket4000Ms", "bucketRafP95Ms", "annotationDeleteMs", "annotationDeleteRafP95Ms",
];
const PROFILER_SCENARIOS = [
  "nav20", "zoom10", "polygon20", "drag60", "bucket4000", "annotationDelete",
];
const GATED_PROFILER_SCENARIOS = [
  "zoom10", "polygon20", "drag60", "bucket4000", "annotationDelete",
];
const TARGETS = ["AnnotationOverlay", "DrawingPreviewLayer", "PDFPage"];
const PROFILER_FIELDS = ["commits", "mounts", "updates", "actualDurationMs"];
const HARNESS_PATHS = {
  baseSpecSha256: "e2e/viewer-perf-v2.spec.ts",
  configSha256: "playwright.annotation-owner-perf-v2.config.ts",
  patcherSha256: "scripts/apply-annotation-owner-perf-v2-instrumentation.mjs",
  comparatorSha256: "scripts/compare-annotation-owner-perf-v2.mjs",
  probeSha256: "e2e/perf-v2/AnnotationOwnerPerfRenderProbe.tsx",
  globalSetupSha256: "e2e/global-setup.ts",
  cdnStubSha256: "e2e/cdn-stub.mjs",
  fixturePreflightSha256: "e2e/ensure-synthetic-pdf.mjs",
  startDevServerSha256: "e2e/start-dev-server.mjs",
  packageLockSha256: "package-lock.json",
};
const EXPECTED_THRESHOLD_CONTRACT = {
  candidateVsBaselineTimingMaxRatioExclusive: 1.6,
  candidateBucket4000MaxMsExclusive: 400,
  profilerCommitGateScenarios: GATED_PROFILER_SCENARIOS,
  candidateProfilerCommitsMustNotExceedBaselineForGatedScenarios: true,
  annotationDeleteWitness: {
    targetId: 990001, requestsPerSample: 1, status: 200, beforeCount: 512, afterCount: 511,
  },
  deterministicDrawEndUnitFloor: {
    AnnotationOverlay: 0, DrawingPreviewLayer: 1, PDFPage: 0,
  },
};
const EXPECTED_STATUS = [
  " M src/components/viewer/AnnotationOverlay.tsx",
  " M src/components/viewer/DrawingPreviewLayer.tsx",
  " M src/components/viewer/PDFPage.tsx",
  "?? .annotation-owner-perf-v2-instrumentation.json",
  "?? e2e/annotation-owner-perf-v2.spec.ts",
  "?? src/components/viewer/AnnotationOwnerPerfRenderProbe.tsx",
].sort();
const LEG_DEFINITIONS = [
  { key: "pre1", role: "baseline", sourceSha: BASELINE_SHA },
  { key: "post1", role: "candidate", sourceSha: CANDIDATE_SHA },
  { key: "post2", role: "candidate", sourceSha: CANDIDATE_SHA },
  { key: "pre2", role: "baseline", sourceSha: BASELINE_SHA },
];

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error("arguments must be --name value pairs");
    const key = flag.slice(2);
    if (!["pre1", "post1", "post2", "pre2", "out"].includes(key) || values[key]) {
      throw new Error(`unknown or duplicate argument: ${flag}`);
    }
    values[key] = value;
  }
  const missing = ["pre1", "post1", "post2", "pre2", "out"].filter((key) => !values[key]);
  if (missing.length) throw new Error(`missing arguments: ${missing.join(", ")}`);
  return values;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return +(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2).toFixed(3);
}
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const args = parseArgs(process.argv.slice(2));
const checks = [];
function check(name, pass, details = undefined) {
  checks.push({ name, pass: pass === true, details });
}
function exact(name, actual, expected) {
  check(name, isDeepStrictEqual(actual, expected), { actual, expected });
}
function finite(name, value, { positive = false, integer = false } = {}) {
  check(name, typeof value === "number" && Number.isFinite(value) &&
    (!positive || value > 0) && (!integer || Number.isInteger(value)),
  { actual: value, positive, integer });
}

const legs = LEG_DEFINITIONS.map((definition) => {
  const path = resolve(args[definition.key]);
  const bytes = readFileSync(path);
  return { ...definition, path, artifactSha256: sha256(bytes), artifact: JSON.parse(bytes) };
});

exact("candidate is exact child of baseline",
  execFileSync("git", ["rev-parse", `${CANDIDATE_SHA}^`], { encoding: "utf8" }).trim(), BASELINE_SHA);

for (const leg of legs) {
  const { key, role, sourceSha, artifact } = leg;
  const prefix = key;
  exact(`${prefix}.schemaVersion`, artifact.schemaVersion, SCHEMA);
  exact(`${prefix}.protocolVersion`, artifact.protocolVersion, PROTOCOL);
  exact(`${prefix}.role`, artifact.role, role);
  exact(`${prefix}.leg`, artifact.leg, key);
  exact(`${prefix}.sourceSha`, artifact.sourceSha, sourceSha);
  exact(`${prefix}.sourceCommitSha`, artifact.sourceCommitSha, sourceSha);
  check(`${prefix}.harnessSha`, SHA1.test(artifact.harnessSha), artifact.harnessSha);
  exact(`${prefix}.runs`, artifact.runs, 3);
  exact(`${prefix}.smoke`, artifact.smoke, false);
  check(`${prefix}.date`, Number.isFinite(Date.parse(artifact.date)), artifact.date);
  exact(`${prefix}.thresholdContract`, artifact.thresholdContract, EXPECTED_THRESHOLD_CONTRACT);
  exact(`${prefix}.fixture dense annotation count`, artifact.fixture?.denseAnnotations, 6848);
  exact(`${prefix}.fixture takeoff item count`, artifact.fixture?.takeoffItems, 128);
  exact(`${prefix}.fixture yolo tags`, artifact.fixture?.yoloTags, 120);
  exact(`${prefix}.fixture yolo instances`, artifact.fixture?.yoloInstances, 3600);
  check(`${prefix}.fixture pdf hash`, SHA256.test(artifact.fixture?.pdfSha256), artifact.fixture?.pdfSha256);

  const harness = artifact.harness;
  check(`${prefix}.harness object`, isObject(harness));
  if (isObject(harness)) {
    for (const [field, path] of Object.entries(HARNESS_PATHS)) {
      exact(`${prefix}.harness.${field}`, harness[field], sha256(readFileSync(path)));
    }
    check(`${prefix}.harness.generatedSpecSha256`, SHA256.test(harness.generatedSpecSha256),
      harness.generatedSpecSha256);
    const instrumentation = harness.instrumentation;
    exact(`${prefix}.manifest schema`, instrumentation?.schemaVersion, MANIFEST_SCHEMA);
    exact(`${prefix}.manifest source`, instrumentation?.sourceSha, sourceSha);
    exact(`${prefix}.manifest baseline`, instrumentation?.baselineSha, BASELINE_SHA);
    exact(`${prefix}.manifest candidate`, instrumentation?.candidateSha, CANDIDATE_SHA);
    exact(`${prefix}.manifest direct parent`, instrumentation?.directParentVerified, true);
    exact(`${prefix}.manifest probe hash`, instrumentation?.probeSha256, harness.probeSha256);
    exact(`${prefix}.manifest base spec hash`, instrumentation?.baseSpecSha256, harness.baseSpecSha256);
    exact(`${prefix}.manifest generated spec hash`, instrumentation?.generatedSpecSha256,
      harness.generatedSpecSha256);
    check(`${prefix}.manifest protocol hash`, SHA256.test(instrumentation?.overlayProtocolSha256),
      instrumentation?.overlayProtocolSha256);
    exact(`${prefix}.worktree HEAD`, harness.exactAppWorktree?.headSha, sourceSha);
    exact(`${prefix}.worktree source`, harness.exactAppWorktree?.sourceCommitSha, sourceSha);
    exact(`${prefix}.worktree status`, [...(harness.exactAppWorktree?.gitStatus ?? [])].sort(),
      EXPECTED_STATUS);
    check(`${prefix}.source lock hash`, SHA256.test(harness.exactAppWorktree?.sourcePackageLockSha256),
      harness.exactAppWorktree?.sourcePackageLockSha256);
    exact(`${prefix}.generated spec on disk`, sha256(readFileSync(resolve(
      harness.exactAppWorktree.root, "e2e/annotation-owner-perf-v2.spec.ts"))),
    harness.generatedSpecSha256);
    for (const target of instrumentation?.targets ?? []) {
      const sourceBytes = execFileSync("git", ["show", `${sourceSha}:${target.file}`]);
      exact(`${prefix}.${target.file} before hash`, target.beforeSha256, sha256(sourceBytes));
      exact(`${prefix}.${target.file} after hash`, target.afterSha256,
        sha256(readFileSync(resolve(harness.exactAppWorktree.root, target.file))));
    }
  }

  exact(`${prefix}.node major`, /^v20\./.test(artifact.environment?.node), true);
  exact(`${prefix}.postgres`, artifact.environment?.postgres, "17 localhost:5433/bp_test");
  exact(`${prefix}.single Playwright module`, artifact.environment?.playwrightModule,
    realpathSync("node_modules/@playwright/test"));
  exact(`${prefix}.viewport`, artifact.environment?.viewport, { width: 1600, height: 1000 });
  exact(`${prefix}.devicePixelRatio`, artifact.environment?.devicePixelRatio, 2);
  check(`${prefix}.samples length`, Array.isArray(artifact.samples) && artifact.samples.length === 3,
    artifact.samples?.length);

  for (const [sampleIndex, sample] of (artifact.samples ?? []).entries()) {
    const samplePrefix = `${prefix}.samples[${sampleIndex}]`;
    for (const timing of TIMING_KEYS) finite(`${samplePrefix}.${timing}`, sample[timing], { positive: true });
    for (const scenario of PROFILER_SCENARIOS) {
      for (const target of TARGETS) {
        for (const field of PROFILER_FIELDS) {
          finite(`${samplePrefix}.profiler.${scenario}.${target}.${field}`,
            sample.profiler?.[scenario]?.[target]?.[field], { integer: field !== "actualDurationMs" });
        }
      }
    }
    exact(`${samplePrefix}.drag pointer steps`, sample.dragOutcome?.pointerSteps, 60);
    check(`${samplePrefix}.drag observed moves`, sample.dragOutcome?.observedMouseMoves >= 60,
      sample.dragOutcome?.observedMouseMoves);
    exact(`${samplePrefix}.drag dense annotations`, sample.dragOutcome?.denseAnnotations, 6848);
    exact(`${samplePrefix}.drag reactive`, sample.dragOutcome?.targetWasReactive, true);
    exact(`${samplePrefix}.polygon vertices`, sample.polygonOutcome?.vertices, 20);
    exact(`${samplePrefix}.polygon optimistic outcome`, sample.polygonOutcome?.optimisticPolygonVisible, true);
    exact(`${samplePrefix}.delete target`, sample.annotationDeleteOutcome?.targetId, 990001);
    exact(`${samplePrefix}.delete before count`, sample.annotationDeleteOutcome?.beforeCount, 512);
    exact(`${samplePrefix}.delete after count`, sample.annotationDeleteOutcome?.afterCount, 511);
    exact(`${samplePrefix}.delete selected before`, sample.annotationDeleteOutcome?.selectedIdBefore, 990001);
    exact(`${samplePrefix}.delete selected after`, sample.annotationDeleteOutcome?.selectedIdAfter, null);
    exact(`${samplePrefix}.delete replay suppressed`, sample.annotationDeleteOutcome?.replayDeleteSuppressed, true);
    exact(`${samplePrefix}.delete method`, sample.annotationDeleteOutcome?.transport?.method, "DELETE");
    exact(`${samplePrefix}.delete status`, sample.annotationDeleteOutcome?.transport?.status, 200);
    exact(`${samplePrefix}.delete path`, new URL(sample.annotationDeleteOutcome?.transport?.url).pathname,
      "/api/annotations/990001");
    check(`${samplePrefix}.delete transport timing`,
      sample.annotationDeleteOutcome?.transport?.fulfilledAtEpochMs >=
      sample.annotationDeleteOutcome?.transport?.requestedAtEpochMs,
    sample.annotationDeleteOutcome?.transport);
  }

  for (const timing of TIMING_KEYS) {
    exact(`${prefix}.median.${timing}`, artifact.medians?.[timing],
      median(artifact.samples.map((sample) => sample[timing])));
  }
  exact(`${prefix}.polygon POST count`, artifact.integrity?.annotationPosts, 3);
  exact(`${prefix}.polygon POST vertices`, artifact.integrity?.polygonPostVertexCounts, [20, 20, 20]);
  exact(`${prefix}.polygon outcomes count`, artifact.integrity?.polygonOutcomes?.length, 3);
  exact(`${prefix}.polygon POST methods`, artifact.integrity?.annotationPostTransports?.map((x) => x.method),
    ["POST", "POST", "POST"]);
  exact(`${prefix}.polygon POST statuses`, artifact.integrity?.annotationPostTransports?.map((x) => x.status),
    [200, 200, 200]);
  exact(`${prefix}.DELETE count`, artifact.integrity?.annotationDeletes, 3);
  exact(`${prefix}.DELETE transport count`, artifact.integrity?.annotationDeleteTransports?.length, 3);
  exact(`${prefix}.bucket server fallbacks`, artifact.integrity?.bucketServerFallbacks, 0);
  exact(`${prefix}.unexpected request failures`, artifact.integrity?.unexpectedRequestFailures, []);
  exact(`${prefix}.page errors`, artifact.integrity?.pageErrors, []);
  exact(`${prefix}.http429`, artifact.integrity?.http429, []);
  exact(`${prefix}.served SHA`, artifact.integrity?.servedShas, [sourceSha]);
}

const byKey = Object.fromEntries(legs.map((leg) => [leg.key, leg.artifact]));
const dates = LEG_DEFINITIONS.map(({ key }) => Date.parse(byKey[key].date));
check("collection order is pre1 -> post1 -> post2 -> pre2",
  dates.every((date, index) => index === 0 || date > dates[index - 1]), dates);
exact("one immutable harness SHA across all legs",
  [...new Set(legs.map((leg) => leg.artifact.harnessSha))].length, 1);
exact("one generated derivative across all legs",
  [...new Set(legs.map((leg) => leg.artifact.harness.generatedSpecSha256))].length, 1);
exact("one overlay protocol across all legs",
  [...new Set(legs.map((leg) => leg.artifact.harness.instrumentation.overlayProtocolSha256))].length, 1);
exact("same source package lock across exact parent and child",
  [...new Set(legs.map((leg) => leg.artifact.harness.exactAppWorktree.sourcePackageLockSha256))].length,
  1);
exact("same Playwright version", [...new Set(legs.map((leg) => leg.artifact.environment.playwright))].length, 1);
exact("same Chromium version", [...new Set(legs.map((leg) => leg.artifact.environment.chromium))].length, 1);
exact("same OS", [...new Set(legs.map((leg) => leg.artifact.environment.os))].length, 1);
exact("same CPU", [...new Set(legs.map((leg) => leg.artifact.environment.cpu))].length, 1);
for (const key of ["post1", "post2", "pre2"]) {
  exact(`${key}.fixture equals pre1 fixture`, byKey[key].fixture, byKey.pre1.fixture);
}

const baselineSamples = [...byKey.pre1.samples, ...byKey.pre2.samples];
const candidateSamples = [...byKey.post1.samples, ...byKey.post2.samples];
const aggregate = {
  baseline: {
    timings: Object.fromEntries(TIMING_KEYS.map((key) => [key, median(baselineSamples.map((sample) => sample[key]))])),
    profilerCommits: {},
  },
  candidate: {
    timings: Object.fromEntries(TIMING_KEYS.map((key) => [key, median(candidateSamples.map((sample) => sample[key]))])),
    profilerCommits: {},
  },
};
for (const scenario of PROFILER_SCENARIOS) {
  aggregate.baseline.profilerCommits[scenario] = {};
  aggregate.candidate.profilerCommits[scenario] = {};
  for (const target of TARGETS) {
    aggregate.baseline.profilerCommits[scenario][target] = median(
      baselineSamples.map((sample) => sample.profiler[scenario][target].commits));
    aggregate.candidate.profilerCommits[scenario][target] = median(
      candidateSamples.map((sample) => sample.profiler[scenario][target].commits));
  }
}

const comparisons = { timingRatios: {}, profilerCommitDeltas: {} };
for (const timing of TIMING_KEYS) {
  const baseline = aggregate.baseline.timings[timing];
  const candidate = aggregate.candidate.timings[timing];
  const ratio = +(candidate / baseline).toFixed(4);
  comparisons.timingRatios[timing] = { baseline, candidate, ratio };
  check(`${timing} candidate/baseline pooled median ratio < 1.6`, ratio < 1.6,
    comparisons.timingRatios[timing]);
}
check("candidate pooled bucket4000 median < 400 ms",
  aggregate.candidate.timings.bucket4000Ms < 400,
  aggregate.candidate.timings.bucket4000Ms);

for (const scenario of GATED_PROFILER_SCENARIOS) {
  comparisons.profilerCommitDeltas[scenario] = {};
  for (const target of TARGETS) {
    const baseline = aggregate.baseline.profilerCommits[scenario][target];
    const candidate = aggregate.candidate.profilerCommits[scenario][target];
    const delta = candidate - baseline;
    comparisons.profilerCommitDeltas[scenario][target] = { baseline, candidate, delta };
    check(`${scenario}.${target} candidate pooled commits <= baseline`, candidate <= baseline,
      comparisons.profilerCommitDeltas[scenario][target]);
  }
}

for (const leg of legs) {
  for (const [index, transport] of
    (leg.artifact.integrity.annotationPostTransports ?? []).entries()) {
    exact(`${leg.key}.polygon POST[${index}] path`, new URL(transport.url).pathname,
      "/api/annotations");
    check(`${leg.key}.polygon POST[${index}] timing`,
      transport.fulfilledAtEpochMs >= transport.requestedAtEpochMs, transport);
  }
}

const failedChecks = checks.filter((entry) => !entry.pass);
const verdict = {
  schemaVersion: VERDICT_SCHEMA,
  protocolVersion: PROTOCOL,
  date: new Date().toISOString(),
  baselineSha: BASELINE_SHA,
  candidateSha: CANDIDATE_SHA,
  exactDirectParent: true,
  collectionOrder: LEG_DEFINITIONS.map(({ key }) => key),
  sampleCounts: { baseline: baselineSamples.length, candidate: candidateSamples.length },
  thresholdContract: EXPECTED_THRESHOLD_CONTRACT,
  legs: legs.map(({ key, role, sourceSha, path, artifactSha256 }) => ({
    key, role, sourceSha, path, artifactSha256,
  })),
  aggregate,
  comparisons,
  checkCount: checks.length,
  failedCheckCount: failedChecks.length,
  failedChecks,
  pass: failedChecks.length === 0,
  verdict: failedChecks.length === 0 ? "pass" : "fail",
};
writeFileSync(resolve(args.out), `${JSON.stringify(verdict, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({
  verdict: verdict.verdict,
  checkCount: verdict.checkCount,
  failedCheckCount: verdict.failedCheckCount,
  output: resolve(args.out),
}, null, 2));
