// Validate and adjudicate the four retained final perf-v2 legs. The collection order is fixed as
// pre1 -> post1 -> post2 -> pre2; only the fully warmed reverse pair (post2 vs pre2) is gated.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const ARTIFACT_SCHEMA_VERSION = "bp-viewer-perf-v2.0.0";
const PROTOCOL_VERSION = "p2.3-populated-profiler-median3-reverse1";
const VERDICT_SCHEMA_VERSION = "bp-viewer-perf-v2-verdict-2";
const INSTRUMENTATION_SCHEMA_VERSION = "bp-perf-v2-instrumentation-manifest-1";
const BASELINE_SOURCE_SHA = "26a9de754f4422e1a6d353b2b4a3f2e6307b3f14";
const SHA1_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TIMING_KEYS = [
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
];
const PROFILER_SCENARIOS = ["nav20", "zoom10", "polygon20", "drag60", "bucket4000"];
const GATED_PROFILER_SCENARIOS = ["zoom10", "polygon20", "drag60", "bucket4000"];
const PROFILER_TARGETS = ["AnnotationOverlay", "DrawingPreviewLayer", "PDFPage"];
const PROFILER_FIELDS = ["commits", "mounts", "updates", "actualDurationMs"];
const HARNESS_HASH_FIELDS = [
  ["specSha256", "e2e/viewer-perf-v2.spec.ts"],
  ["configSha256", "playwright.perf-v2.config.ts"],
  ["patcherSha256", "scripts/apply-perf-v2-instrumentation.mjs"],
  ["comparatorSha256", "scripts/compare-viewer-perf-v2.mjs"],
  ["probeSha256", "e2e/perf-v2/PerfRenderProbe.tsx"],
  ["globalSetupSha256", "e2e/global-setup.ts"],
  ["cdnStubSha256", "e2e/cdn-stub.mjs"],
  ["packageLockSha256", "package-lock.json"],
];
const EXPECTED_OVERLAY_STATUS = [
  " M src/components/viewer/AnnotationOverlay.tsx",
  " M src/components/viewer/DrawingPreviewLayer.tsx",
  " M src/components/viewer/PDFPage.tsx",
  "?? .perf-v2-instrumentation.json",
  "?? src/components/viewer/PerfRenderProbe.tsx",
];
const EXPECTED_THRESHOLD_CONTRACT = {
  candidateVsBaselineTimingMaxRatioExclusive: 1.6,
  candidateBucket4000MaxMsExclusive: 400,
  candidateProfilerCommitsMustNotExceedBaseline: true,
  deterministicDrawEndUnitFloor: {
    AnnotationOverlay: 0,
    DrawingPreviewLayer: 1,
    PDFPage: 0,
  },
};
const EXPECTED_FIXTURE = {
  pdfVersion: "synthetic-100pg-seed-b1ce-target60mb",
  pdfPages: 100,
  pdfBytes: 65_682_593,
  pdfSha256: "f0e6599185554a3035f2487b1385b632578e411eeb42f8db05d5d981e1e0c2d8",
  generatorSha256: "cfb5faf5e05c43cbe2fb21ea58dafe86e4950496d46c4e53c0c3aeda41616577",
  yoloTags: 120,
  yoloInstances: 3600,
  denseAnnotations: 6848,
  takeoffItems: 128,
  bucketRaster: {
    sourceWidth: 4000,
    sourceHeight: 2667,
    processedWidth: 4000,
    processedHeight: 2667,
    roomAreaFraction: 0.36,
  },
  underlays: "absent (404); bucket uses deterministic 4000x2667 black-wall/white-room raster",
};

function parseArguments(argv) {
  const allowed = new Set(["pre1", "post1", "post2", "pre2", "candidate-sha", "out"]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error("arguments must be --name value pairs");
    }
    const name = flag.slice(2);
    if (!allowed.has(name)) throw new Error(`unknown argument: ${flag}`);
    if (Object.hasOwn(values, name)) throw new Error(`duplicate argument: ${flag}`);
    values[name] = value;
  }
  const missing = [...allowed].filter((name) => !values[name]);
  if (missing.length > 0) {
    throw new Error(
      "usage: node scripts/compare-viewer-perf-v2.mjs " +
      "--pre1 pre1.json --post1 post1.json --post2 post2.json --pre2 pre2.json " +
      "--candidate-sha SHA --out verdict.json" +
      ` (missing: ${missing.join(", ")})`,
    );
  }
  if (!SHA1_PATTERN.test(values["candidate-sha"])) {
    throw new Error("--candidate-sha must be the exact lowercase 40-character commit SHA");
  }
  if (values["candidate-sha"] === BASELINE_SOURCE_SHA) {
    throw new Error("--candidate-sha must be distinct from the fixed baseline SHA");
  }
  return values;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepEqual(left, right) {
  return isDeepStrictEqual(left, right);
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return +(sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2).toFixed(1);
}

const args = parseArguments(process.argv.slice(2));
const candidateSourceSha = args["candidate-sha"];
const legDefinitions = [
  { key: "pre1", role: "baseline", sourceSha: BASELINE_SOURCE_SHA },
  { key: "post1", role: "candidate", sourceSha: candidateSourceSha },
  { key: "post2", role: "candidate", sourceSha: candidateSourceSha },
  { key: "pre2", role: "baseline", sourceSha: BASELINE_SOURCE_SHA },
];
const legs = legDefinitions.map((definition) => {
  const path = resolve(args[definition.key]);
  const bytes = readFileSync(path);
  return {
    ...definition,
    path,
    artifactSha256: sha256(bytes),
    artifact: JSON.parse(bytes.toString("utf8")),
  };
});
const byKey = Object.fromEntries(legs.map((leg) => [leg.key, leg]));
const checks = [];

function check(name, pass, details) {
  checks.push({ name, pass: pass === true, details });
}

function exact(name, actual, expected) {
  check(name, deepEqual(actual, expected), { actual, expected });
}

function finite(name, value, { integer = false, minimum = 0, exclusiveMinimum = false } = {}) {
  const pass = typeof value === "number" && Number.isFinite(value) &&
    (!integer || Number.isInteger(value)) &&
    (exclusiveMinimum ? value > minimum : value >= minimum);
  check(name, pass, { actual: value, integer, minimum, exclusiveMinimum });
  return pass;
}

function nonemptyString(name, value) {
  const pass = typeof value === "string" && value.trim() !== "";
  check(name, pass, { actual: value });
  return pass;
}

function array(name, value) {
  const pass = Array.isArray(value);
  check(name, pass, { actualType: value === null ? "null" : typeof value });
  return pass;
}

function validateProfiler(label, profiler) {
  check(`${label} is object`, isObject(profiler), { actualType: typeof profiler });
  if (!isObject(profiler)) return;
  for (const scenario of PROFILER_SCENARIOS) {
    const scenarioValue = profiler[scenario];
    check(`${label}.${scenario} is object`, isObject(scenarioValue), {
      actualType: typeof scenarioValue,
    });
    if (!isObject(scenarioValue)) continue;
    for (const target of PROFILER_TARGETS) {
      const entry = scenarioValue[target];
      check(`${label}.${scenario}.${target} is object`, isObject(entry), {
        actualType: typeof entry,
      });
      if (!isObject(entry)) continue;
      for (const field of PROFILER_FIELDS) {
        finite(`${label}.${scenario}.${target}.${field}`, entry[field], {
          integer: field !== "actualDurationMs",
        });
      }
    }
  }
}

function validateBucketRaster(label, raster) {
  check(`${label} is object`, isObject(raster), { actualType: typeof raster });
  if (!isObject(raster)) return;
  for (const key of ["sourceWidth", "sourceHeight", "processedWidth", "processedHeight"]) {
    finite(`${label}.${key}`, raster[key], { integer: true, minimum: 0, exclusiveMinimum: true });
  }
  finite(`${label}.roomAreaFraction`, raster.roomAreaFraction);
}

function validatePageWindow(label, pageWindow) {
  check(`${label} is object`, isObject(pageWindow), { actualType: typeof pageWindow });
  if (!isObject(pageWindow)) return;
  nonemptyString(`${label}.url`, pageWindow.url);
  finite(`${label}.from`, pageWindow.from, { integer: true, minimum: 0, exclusiveMinimum: true });
  finite(`${label}.to`, pageWindow.to, { integer: true, minimum: 0, exclusiveMinimum: true });
  check(`${label} covers page 21`, pageWindow.from <= 21 && pageWindow.to >= 21,
    { from: pageWindow.from, to: pageWindow.to });
}

function validateNavOutcome(label, outcome) {
  check(`${label} is object`, isObject(outcome), { actualType: typeof outcome });
  if (!isObject(outcome)) return;
  exact(`${label}.targetPage`, outcome.targetPage, 21);
  exact(`${label}.activePage`, outcome.activePage, 21);
  nonemptyString(`${label}.activeClass`, outcome.activeClass);
  validatePageWindow(`${label}.pageWindow`, outcome.pageWindow);
  const raster = outcome.raster;
  check(`${label}.raster is object`, isObject(raster), { actualType: typeof raster });
  if (isObject(raster)) {
    for (const field of ["width", "height", "paintedPixelSamples"]) {
      finite(`${label}.raster.${field}`, raster[field], {
        integer: true,
        minimum: 0,
        exclusiveMinimum: true,
      });
    }
    for (const field of ["cssWidth", "cssHeight"]) {
      finite(`${label}.raster.${field}`, raster[field], {
        minimum: 0,
        exclusiveMinimum: true,
      });
    }
    check(`${label}.raster.opacity is visible`, typeof raster.opacity === "string" &&
      raster.opacity !== "" && raster.opacity !== "0", raster.opacity);
  }
  finite(`${label}.pdfPageCommits`, outcome.pdfPageCommits,
    { integer: true, minimum: 0, exclusiveMinimum: true });
}

function validateZoomOutcome(label, outcome) {
  check(`${label} is object`, isObject(outcome), { actualType: typeof outcome });
  if (!isObject(outcome)) return;
  for (const field of ["beforePercent", "afterPercent", "deltaPercent"]) {
    finite(`${label}.${field}`, outcome[field], { minimum: 0, exclusiveMinimum: true });
  }
  check(`${label} records a coherent positive scale change`,
    Number.isFinite(outcome.beforePercent) && Number.isFinite(outcome.afterPercent) &&
      Number.isFinite(outcome.deltaPercent) && outcome.afterPercent > outcome.beforePercent &&
      outcome.afterPercent - outcome.beforePercent === outcome.deltaPercent,
    outcome);
  finite(`${label}.pdfPageCommits`, outcome.pdfPageCommits,
    { integer: true, minimum: 0, exclusiveMinimum: true });
}

function validateArtifact(leg) {
  const { artifact, key, role, sourceSha } = leg;
  const label = key;
  check(`${label} top level is object`, isObject(artifact), { actualType: typeof artifact });
  if (!isObject(artifact)) return;

  exact(`${label} schemaVersion`, artifact.schemaVersion, ARTIFACT_SCHEMA_VERSION);
  exact(`${label} protocolVersion`, artifact.protocolVersion, PROTOCOL_VERSION);
  exact(`${label} role`, artifact.role, role);
  exact(`${label} leg label`, artifact.leg, key);
  exact(`${label} sourceSha`, artifact.sourceSha, sourceSha);
  exact(`${label} sourceCommitSha`, artifact.sourceCommitSha, sourceSha);
  check(`${label} sourceSha is exact SHA`, SHA1_PATTERN.test(artifact.sourceSha), artifact.sourceSha);
  check(`${label} sourceCommitSha is exact SHA`, SHA1_PATTERN.test(artifact.sourceCommitSha),
    artifact.sourceCommitSha);
  check(`${label} harnessSha is exact SHA`, SHA1_PATTERN.test(artifact.harnessSha), artifact.harnessSha);
  nonemptyString(`${label} mode`, artifact.mode);
  exact(`${label} runs`, artifact.runs, 3);
  exact(`${label} smoke`, artifact.smoke, false);
  exact(`${label} thresholdContract`, artifact.thresholdContract, EXPECTED_THRESHOLD_CONTRACT);
  check(`${label} date is ISO timestamp`, typeof artifact.date === "string" &&
    Number.isFinite(Date.parse(artifact.date)), artifact.date);

  check(`${label} fixture is object`, isObject(artifact.fixture), { actualType: typeof artifact.fixture });
  if (isObject(artifact.fixture)) {
    exact(`${label} fixture protocol`, artifact.fixture, EXPECTED_FIXTURE);
    for (const field of [
      "pdfPages", "pdfBytes", "yoloTags", "yoloInstances", "denseAnnotations", "takeoffItems",
    ]) finite(`${label} fixture.${field}`, artifact.fixture[field], {
      integer: true,
      minimum: 0,
      exclusiveMinimum: true,
    });
    validateBucketRaster(`${label} fixture.bucketRaster`, artifact.fixture.bucketRaster);
  }

  check(`${label} harness is object`, isObject(artifact.harness), { actualType: typeof artifact.harness });
  if (isObject(artifact.harness)) {
    for (const [field] of HARNESS_HASH_FIELDS) {
      check(`${label} harness.${field} is SHA-256`, SHA256_PATTERN.test(artifact.harness[field]),
        artifact.harness[field]);
    }
    const instrumentation = artifact.harness.instrumentation;
    check(`${label} instrumentation is object`, isObject(instrumentation), {
      actualType: typeof instrumentation,
    });
    if (isObject(instrumentation)) {
      exact(`${label} instrumentation.schemaVersion`, instrumentation.schemaVersion,
        INSTRUMENTATION_SCHEMA_VERSION);
      exact(`${label} instrumentation.scriptVersion`, instrumentation.scriptVersion,
        "bp-perf-v2-overlay-1");
      exact(`${label} instrumentation.sourceSha`, instrumentation.sourceSha, sourceSha);
      check(`${label} instrumentation.overlayProtocolSha256 is SHA-256`,
        SHA256_PATTERN.test(instrumentation.overlayProtocolSha256),
        instrumentation.overlayProtocolSha256);
      check(`${label} instrumentation.probeSha256 is SHA-256`,
        SHA256_PATTERN.test(instrumentation.probeSha256), instrumentation.probeSha256);
      exact(`${label} instrumentation probe matches harness probe`,
        instrumentation.probeSha256, artifact.harness.probeSha256);
      check(`${label} instrumentation.targets is length 3`,
        Array.isArray(instrumentation.targets) && instrumentation.targets.length === 3,
        instrumentation.targets);
      if (Array.isArray(instrumentation.targets)) {
        const expectedFiles = [
          "src/components/viewer/PDFPage.tsx",
          "src/components/viewer/AnnotationOverlay.tsx",
          "src/components/viewer/DrawingPreviewLayer.tsx",
        ];
        instrumentation.targets.forEach((target, index) => {
          exact(`${label} instrumentation.targets[${index}].file`, target?.file, expectedFiles[index]);
          check(`${label} instrumentation.targets[${index}].beforeSha256 is SHA-256`,
            SHA256_PATTERN.test(target?.beforeSha256), target?.beforeSha256);
          check(`${label} instrumentation.targets[${index}].afterSha256 is SHA-256`,
            SHA256_PATTERN.test(target?.afterSha256), target?.afterSha256);
          check(`${label} instrumentation.targets[${index}] changed`,
            SHA256_PATTERN.test(target?.beforeSha256) &&
              SHA256_PATTERN.test(target?.afterSha256) &&
              target.beforeSha256 !== target.afterSha256,
            { before: target?.beforeSha256, after: target?.afterSha256 });
        });
      }
    }
    const exactAppWorktree = artifact.harness.exactAppWorktree;
    check(`${label} exactAppWorktree is object`, isObject(exactAppWorktree), {
      actualType: typeof exactAppWorktree,
    });
    if (isObject(exactAppWorktree)) {
      check(`${label} exactAppWorktree.root is a distinct absolute path`,
        typeof exactAppWorktree.root === "string" &&
          resolve(exactAppWorktree.root) === exactAppWorktree.root &&
          resolve(exactAppWorktree.root) !== scriptRoot,
        exactAppWorktree.root);
      exact(`${label} exactAppWorktree.headSha`, exactAppWorktree.headSha, sourceSha);
      exact(`${label} exactAppWorktree.sourceCommitSha`, exactAppWorktree.sourceCommitSha, sourceSha);
      exact(`${label} exactAppWorktree.gitStatus`, exactAppWorktree.gitStatus,
        EXPECTED_OVERLAY_STATUS);
    }
  }

  const environment = artifact.environment;
  check(`${label} environment is object`, isObject(environment), { actualType: typeof environment });
  if (isObject(environment)) {
    for (const field of ["node", "playwright", "chromium", "os", "cpu", "postgres"])
      nonemptyString(`${label} environment.${field}`, environment[field]);
    check(`${label} environment.viewport is object`, isObject(environment.viewport),
      environment.viewport);
    if (isObject(environment.viewport)) {
      finite(`${label} environment.viewport.width`, environment.viewport.width,
        { integer: true, minimum: 0, exclusiveMinimum: true });
      finite(`${label} environment.viewport.height`, environment.viewport.height,
        { integer: true, minimum: 0, exclusiveMinimum: true });
    }
    finite(`${label} environment.devicePixelRatio`, environment.devicePixelRatio,
      { minimum: 0, exclusiveMinimum: true });
  }

  const medians = artifact.medians;
  check(`${label} medians is object`, isObject(medians), { actualType: typeof medians });
  if (isObject(medians)) {
    for (const timingKey of TIMING_KEYS) {
      finite(`${label} medians.${timingKey}`, medians[timingKey], {
        minimum: 0,
        exclusiveMinimum: true,
      });
    }
    validateProfiler(`${label} medians.profiler`, medians.profiler);
  }

  check(`${label} samples length equals runs`,
    Array.isArray(artifact.samples) && artifact.samples.length === artifact.runs,
    { sampleCount: Array.isArray(artifact.samples) ? artifact.samples.length : null, runs: artifact.runs });
  if (Array.isArray(artifact.samples)) {
    artifact.samples.forEach((sample, index) => {
      const sampleLabel = `${label} samples[${index}]`;
      check(`${sampleLabel} is object`, isObject(sample), { actualType: typeof sample });
      if (!isObject(sample)) return;
      for (const timingKey of TIMING_KEYS) {
        finite(`${sampleLabel}.${timingKey}`, sample[timingKey], {
          minimum: 0,
          exclusiveMinimum: true,
        });
      }
      validateProfiler(`${sampleLabel}.profiler`, sample.profiler);
      validateBucketRaster(`${sampleLabel}.bucketRaster`, sample.bucketRaster);
      exact(`${sampleLabel}.bucketRaster protocol`, sample.bucketRaster, EXPECTED_FIXTURE.bucketRaster);
      validateNavOutcome(`${sampleLabel}.navOutcome`, sample.navOutcome);
      validateZoomOutcome(`${sampleLabel}.zoomOutcome`, sample.zoomOutcome);
    });
    if (artifact.samples.length === artifact.runs && isObject(medians)) {
      for (const timingKey of TIMING_KEYS) {
        const values = artifact.samples.map((sample) => sample?.[timingKey]);
        if (values.every((value) => typeof value === "number" && Number.isFinite(value))) {
          exact(`${label} recomputed median ${timingKey}`, medians[timingKey], median(values));
        }
      }
      for (const scenario of PROFILER_SCENARIOS) {
        for (const target of PROFILER_TARGETS) {
          for (const field of PROFILER_FIELDS) {
            const values = artifact.samples.map((sample) =>
              sample?.profiler?.[scenario]?.[target]?.[field]);
            if (values.every((value) => typeof value === "number" && Number.isFinite(value))) {
              exact(`${label} recomputed Profiler median ${scenario}.${target}.${field}`,
                medians?.profiler?.[scenario]?.[target]?.[field], median(values));
            }
          }
        }
      }
    }
  }

  const integrity = artifact.integrity;
  check(`${label} integrity is object`, isObject(integrity), { actualType: typeof integrity });
  if (isObject(integrity)) {
    for (const field of [
      "pageErrors", "requestFailures", "abortedRequestFailures", "unexpectedRequestFailures",
      "pagePngResponses", "http429", "polygonPostVertexCounts", "servedShas", "navFinalPages",
      "navFinalPageWindows", "navRasterPaintedPixelSamples", "navPdfPageCommits",
      "zoomScaleChanges", "zoomPdfPageCommits",
    ]) array(`${label} integrity.${field}`, integrity[field]);
    for (const field of [
      "pagePng404s", "annotationPosts", "bucketServerFallbacks", "cachedProjectResponses",
      "cachedPageWindowKeys", "cachedTextractKeys",
    ]) finite(`${label} integrity.${field}`, integrity[field], { integer: true });

    check(`${label} request failures are completely classified as aborted`,
      Array.isArray(integrity.requestFailures) && Array.isArray(integrity.abortedRequestFailures) &&
        deepEqual(integrity.requestFailures, integrity.abortedRequestFailures), {
        requestFailures: integrity.requestFailures,
        abortedRequestFailures: integrity.abortedRequestFailures,
      });
    check(`${label} page PNG CDN witness is non-vacuous and all 404`,
      Array.isArray(integrity.pagePngResponses) && integrity.pagePngResponses.length > 0 &&
        integrity.pagePngResponses.every((response) => isObject(response) &&
          typeof response.url === "string" &&
          /^https:\/\/localhost:9876\/.*\/pages\/page_\d{4}\.png$/.test(response.url) &&
          response.status === 404) &&
        integrity.pagePng404s === integrity.pagePngResponses.length, {
        pagePngResponses: integrity.pagePngResponses,
        pagePng404s: integrity.pagePng404s,
      });
    check(`${label} nav witness arrays have one entry per run`, [
      integrity.navFinalPages,
      integrity.navFinalPageWindows,
      integrity.navRasterPaintedPixelSamples,
      integrity.navPdfPageCommits,
      integrity.zoomScaleChanges,
      integrity.zoomPdfPageCommits,
    ].every((values) => Array.isArray(values) && values.length === artifact.runs), {
      runs: artifact.runs,
      lengths: Object.fromEntries([
        "navFinalPages", "navFinalPageWindows", "navRasterPaintedPixelSamples",
        "navPdfPageCommits", "zoomScaleChanges", "zoomPdfPageCommits",
      ].map((field) => [field, Array.isArray(integrity[field]) ? integrity[field].length : null])),
    });
    if (Array.isArray(integrity.navFinalPages)) {
      check(`${label} nav final pages are exactly page 21`,
        integrity.navFinalPages.every((page) => page === 21), integrity.navFinalPages);
    }
    if (Array.isArray(integrity.navFinalPageWindows)) {
      integrity.navFinalPageWindows.forEach((pageWindow, index) =>
        validatePageWindow(`${label} integrity.navFinalPageWindows[${index}]`, pageWindow));
    }
    for (const field of [
      "navRasterPaintedPixelSamples", "navPdfPageCommits", "zoomPdfPageCommits",
    ]) {
      if (Array.isArray(integrity[field])) {
        integrity[field].forEach((value, index) => finite(
          `${label} integrity.${field}[${index}]`, value,
          { integer: true, minimum: 0, exclusiveMinimum: true },
        ));
      }
    }
    if (Array.isArray(integrity.zoomScaleChanges)) {
      integrity.zoomScaleChanges.forEach((change, index) =>
        validateZoomOutcome(`${label} integrity.zoomScaleChanges[${index}]`, {
          ...change,
          pdfPageCommits: integrity.zoomPdfPageCommits?.[index],
        }));
    }
    if (Array.isArray(artifact.samples)) {
      exact(`${label} integrity.navFinalPages matches samples`, integrity.navFinalPages,
        artifact.samples.map((sample) => sample?.navOutcome?.activePage));
      exact(`${label} integrity.navFinalPageWindows matches samples`, integrity.navFinalPageWindows,
        artifact.samples.map((sample) => sample?.navOutcome?.pageWindow));
      exact(`${label} integrity.navRasterPaintedPixelSamples matches samples`,
        integrity.navRasterPaintedPixelSamples,
        artifact.samples.map((sample) => sample?.navOutcome?.raster?.paintedPixelSamples));
      exact(`${label} integrity.navPdfPageCommits matches samples`, integrity.navPdfPageCommits,
        artifact.samples.map((sample) => sample?.navOutcome?.pdfPageCommits));
      exact(`${label} integrity.zoomScaleChanges matches samples`, integrity.zoomScaleChanges,
        artifact.samples.map((sample) => ({
          beforePercent: sample?.zoomOutcome?.beforePercent,
          afterPercent: sample?.zoomOutcome?.afterPercent,
          deltaPercent: sample?.zoomOutcome?.deltaPercent,
        })));
      exact(`${label} integrity.zoomPdfPageCommits matches samples`, integrity.zoomPdfPageCommits,
        artifact.samples.map((sample) => sample?.zoomOutcome?.pdfPageCommits));
    }
  }
}

for (const leg of legs) validateArtifact(leg);

check("four distinct retained artifact paths", new Set(legs.map((leg) => leg.path)).size === 4,
  legs.map((leg) => leg.path));
const collectionTimestamps = legs.map((leg) => Date.parse(leg.artifact.date));
check("retained artifact timestamps follow pre1 -> post1 -> post2 -> pre2",
  collectionTimestamps.every(Number.isFinite) && collectionTimestamps.every((timestamp, index) =>
    index === 0 || timestamp > collectionTimestamps[index - 1]),
  Object.fromEntries(legs.map((leg, index) => [leg.key, leg.artifact.date])));
check("verdict output does not overwrite a retained artifact",
  !legs.some((leg) => leg.path === resolve(args.out)), resolve(args.out));

function equalAcross(name, getter) {
  const values = Object.fromEntries(legs.map((leg) => [leg.key, getter(leg.artifact)]));
  const [first, ...rest] = Object.values(values);
  check(name, rest.every((value) => deepEqual(value, first)), values);
}

equalAcross("all legs exact schemaVersion", (artifact) => artifact.schemaVersion);
equalAcross("all legs exact protocolVersion", (artifact) => artifact.protocolVersion);
equalAcross("all legs runs", (artifact) => artifact.runs);
equalAcross("all legs smoke flag", (artifact) => artifact.smoke);
equalAcross("all legs threshold contract", (artifact) => artifact.thresholdContract);
equalAcross("all legs mode", (artifact) => artifact.mode);
equalAcross("all legs nonempty actual harnessSha", (artifact) => artifact.harnessSha);
equalAcross("all legs fixture inputs", (artifact) => artifact.fixture);
equalAcross("all legs environment", (artifact) => artifact.environment);
for (const [field] of HARNESS_HASH_FIELDS) {
  equalAcross(`all legs harness.${field}`, (artifact) => artifact.harness?.[field]);
}
for (const field of ["schemaVersion", "scriptVersion", "overlayProtocolSha256", "probeSha256"]) {
  equalAcross(`all legs instrumentation.${field}`,
    (artifact) => artifact.harness?.instrumentation?.[field]);
}
exact("baseline instrumentation stable across pre1/pre2",
  byKey.pre1.artifact.harness?.instrumentation,
  byKey.pre2.artifact.harness?.instrumentation);
exact("candidate instrumentation stable across post1/post2",
  byKey.post1.artifact.harness?.instrumentation,
  byKey.post2.artifact.harness?.instrumentation);
exact("baseline exact app worktree stable across pre1/pre2",
  byKey.pre1.artifact.harness?.exactAppWorktree,
  byKey.pre2.artifact.harness?.exactAppWorktree);
exact("candidate exact app worktree stable across post1/post2",
  byKey.post1.artifact.harness?.exactAppWorktree,
  byKey.post2.artifact.harness?.exactAppWorktree);

const harnessSha = byKey.pre1.artifact.harnessSha;
let harnessCommitExists = false;
if (SHA1_PATTERN.test(harnessSha)) {
  try {
    execFileSync("git", ["-C", scriptRoot, "cat-file", "-e", `${harnessSha}^{commit}`], {
      stdio: "ignore",
    });
    harnessCommitExists = true;
  } catch {
    // Reported by the check below.
  }
}
check("harnessSha names an actual local commit", harnessCommitExists, harnessSha);
if (harnessCommitExists) {
  for (const [field, path] of HARNESS_HASH_FIELDS) {
    let committedSha256 = null;
    try {
      committedSha256 = sha256(execFileSync(
        "git",
        ["-C", scriptRoot, "show", `${harnessSha}:${path}`],
        { encoding: "buffer", maxBuffer: 128 * 1024 * 1024 },
      ));
    } catch {
      // A missing blob is a failed identity check.
    }
    check(`harnessSha committed ${path} matches artifact hash`,
      committedSha256 !== null && committedSha256 === byKey.pre1.artifact.harness?.[field], {
        committedSha256,
        artifactSha256: byKey.pre1.artifact.harness?.[field],
      });
  }
}

for (const sourceSha of [BASELINE_SOURCE_SHA, candidateSourceSha]) {
  let exists = false;
  try {
    execFileSync("git", ["-C", scriptRoot, "cat-file", "-e", `${sourceSha}^{commit}`], {
      stdio: "ignore",
    });
    exists = true;
  } catch {
    // Reported below.
  }
  check(`source commit exists ${sourceSha}`, exists, sourceSha);
}

for (const leg of legs) {
  const integrity = leg.artifact.integrity ?? {};
  check(`${leg.key} zero page errors`, Array.isArray(integrity.pageErrors) &&
    integrity.pageErrors.length === 0, integrity.pageErrors);
  check(`${leg.key} zero unexpected request failures`,
    Array.isArray(integrity.unexpectedRequestFailures) &&
      integrity.unexpectedRequestFailures.length === 0,
    integrity.unexpectedRequestFailures);
  check(`${leg.key} zero 429`, Array.isArray(integrity.http429) && integrity.http429.length === 0,
    integrity.http429);
  check(`${leg.key} non-vacuous all-404 localhost CDN witness`,
    Array.isArray(integrity.pagePngResponses) && integrity.pagePngResponses.length > 0 &&
      integrity.pagePng404s === integrity.pagePngResponses.length &&
      integrity.pagePngResponses.every((response) => response?.status === 404), {
      responses: integrity.pagePngResponses?.length,
      pagePng404s: integrity.pagePng404s,
    });
  check(`${leg.key} non-vacuous polygon persistence`,
    Number.isInteger(integrity.annotationPosts) && integrity.annotationPosts >= leg.artifact.runs,
    { posts: integrity.annotationPosts, runs: leg.artifact.runs });
  check(`${leg.key} exact polygon20 POSTs`,
    Array.isArray(integrity.polygonPostVertexCounts) &&
      integrity.polygonPostVertexCounts.length === leg.artifact.runs &&
      integrity.polygonPostVertexCounts.every((count) => count === 20),
    integrity.polygonPostVertexCounts);
  check(`${leg.key} zero bucket server fallback`, integrity.bucketServerFallbacks === 0,
    integrity.bucketServerFallbacks);
  check(`${leg.key} served-SHA handshake`,
    deepEqual(integrity.servedShas, [leg.sourceSha]), integrity.servedShas);
}

function pairDiagnostics(baselineLeg, candidateLeg) {
  const baseline = baselineLeg.artifact;
  const candidate = candidateLeg.artifact;
  const timing = {};
  for (const key of TIMING_KEYS) {
    const pre = baseline.medians?.[key];
    const post = candidate.medians?.[key];
    const valid = typeof pre === "number" && Number.isFinite(pre) && pre > 0 &&
      typeof post === "number" && Number.isFinite(post);
    timing[key] = {
      baseline: pre,
      candidate: post,
      ratio: valid ? +(post / pre).toFixed(4) : null,
      ceilingExclusive: valid ? pre * 1.6 : null,
      pass: valid && post < pre * 1.6,
    };
  }
  const profiler = {};
  for (const scenario of GATED_PROFILER_SCENARIOS) {
    profiler[scenario] = {};
    for (const target of PROFILER_TARGETS) {
      const pre = baseline.medians?.profiler?.[scenario]?.[target]?.commits;
      const post = candidate.medians?.profiler?.[scenario]?.[target]?.commits;
      profiler[scenario][target] = {
        baselineCommits: pre,
        candidateCommits: post,
        pass: Number.isFinite(pre) && Number.isFinite(post) && post <= pre,
      };
    }
  }
  return {
    baselineLeg: baselineLeg.key,
    candidateLeg: candidateLeg.key,
    timing,
    profiler,
    candidateBucket4000: {
      value: candidate.medians?.bucket4000Ms,
      ceilingExclusive: 400,
      pass: Number.isFinite(candidate.medians?.bucket4000Ms) &&
        candidate.medians.bucket4000Ms < 400,
    },
  };
}

const firstForwardPair = pairDiagnostics(byKey.pre1, byKey.post1);
const warmedReversePair = pairDiagnostics(byKey.pre2, byKey.post2);
for (const [key, result] of Object.entries(warmedReversePair.timing)) {
  check(`warmed reverse timing ${key} < baseline×1.6`, result.pass, result);
}
check("warmed reverse candidate bucket4000 <400ms",
  warmedReversePair.candidateBucket4000.pass, warmedReversePair.candidateBucket4000);
for (const [scenario, targets] of Object.entries(warmedReversePair.profiler)) {
  for (const [target, result] of Object.entries(targets)) {
    check(`warmed reverse Profiler ${scenario}.${target} candidate<=baseline`, result.pass, result);
  }
}
check("warmed reverse polygon20 Profiler is non-vacuous",
  byKey.pre2.artifact.medians?.profiler?.polygon20?.DrawingPreviewLayer?.commits >= 20 &&
    byKey.post2.artifact.medians?.profiler?.polygon20?.DrawingPreviewLayer?.commits >= 20, {
    baseline: byKey.pre2.artifact.medians?.profiler?.polygon20?.DrawingPreviewLayer?.commits,
    candidate: byKey.post2.artifact.medians?.profiler?.polygon20?.DrawingPreviewLayer?.commits,
  });
check("warmed reverse drag60 Profiler is non-vacuous",
  byKey.pre2.artifact.medians?.profiler?.drag60?.AnnotationOverlay?.commits >= 30 &&
    byKey.post2.artifact.medians?.profiler?.drag60?.AnnotationOverlay?.commits >= 30, {
    baseline: byKey.pre2.artifact.medians?.profiler?.drag60?.AnnotationOverlay?.commits,
    candidate: byKey.post2.artifact.medians?.profiler?.drag60?.AnnotationOverlay?.commits,
  });

const pass = checks.every((entry) => entry.pass);
const verdict = {
  schemaVersion: VERDICT_SCHEMA_VERSION,
  generatedAt: new Date().toISOString(),
  collectionOrder: legDefinitions.map((leg) => leg.key),
  baselineSourceSha: BASELINE_SOURCE_SHA,
  candidateSourceSha,
  harnessSha,
  retainedLegs: legs.map((leg) => ({
    leg: leg.key,
    role: leg.role,
    path: leg.path,
    artifactSha256: leg.artifactSha256,
    sourceSha: leg.artifact.sourceSha,
    harnessSha: leg.artifact.harnessSha,
    runs: leg.artifact.runs,
    sampleCount: Array.isArray(leg.artifact.samples) ? leg.artifact.samples.length : null,
    medians: leg.artifact.medians,
  })),
  pairDiagnostics: {
    firstForward: firstForwardPair,
    warmedReverse: warmedReversePair,
    gatedPair: "warmedReverse",
  },
  checks,
  pass,
};
writeFileSync(resolve(args.out), `${JSON.stringify(verdict, null, 2)}\n`);
console.log(JSON.stringify({
  pass,
  retainedLegs: verdict.retainedLegs.map(({ leg, sourceSha, artifactSha256 }) => ({
    leg,
    sourceSha,
    artifactSha256,
  })),
  gatedPair: warmedReversePair,
  failedChecks: checks.filter((entry) => !entry.pass).map((entry) => entry.name),
}, null, 2));
if (!pass) process.exitCode = 1;
