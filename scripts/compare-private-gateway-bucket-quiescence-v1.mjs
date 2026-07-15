// Adjudicate the immutable four-leg private-gateway Bucket quiescence cohort.
// Collection order is fixed as pre1 -> post1 -> post2 -> pre2. Only the fully
// warmed reverse pair (post2 vs pre2) is timing-gated; quiescence is gated for
// every candidate sample in both candidate legs.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const ARTIFACT_SCHEMA_VERSION =
  "bp-viewer-perf-v2.3.0-private-gateway-bucket-quiescence";
const PROTOCOL_VERSION = "private-gateway-bucket-quiescence-v1";
const VALIDATION_GATE = "private-gateway-bucket-quiescence-v1";
const VERDICT_SCHEMA_VERSION =
  "bp-private-gateway-bucket-quiescence-v1-verdict-1";
const INSTRUMENTATION_SCHEMA_VERSION = "bp-perf-v2-instrumentation-manifest-1";
const BASELINE_SOURCE_SHA = "d0500f79940e3083d6bd727233d143d9058c80c5";
const CANDIDATE_SOURCE_SHA = "0e990e30631fd840b4146c8a6ab2739a2af2756c";
const RUNS = 3;
const SHA1_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
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
const PROFILER_SCENARIOS = [
  "nav20",
  "zoom10",
  "polygon20",
  "drag60",
  "bucket4000",
];
const PROFILER_TARGETS = [
  "AnnotationOverlay",
  "DrawingPreviewLayer",
  "PDFPage",
];
const PROFILER_FIELDS = ["commits", "mounts", "updates", "actualDurationMs"];
const QUIESCENCE_PHASES = ["warm1000", "timed4000"];
const QUIET_BARRIER_CONTRACT = {
  requiredQuietMs: 100,
  pollIntervalMs: 25,
  stablePolls: 5,
};
const EXPECTED_THRESHOLD_CONTRACT = {
  candidateVsBaselineTimingMaxRatioExclusive: 1.6,
  candidateBucket4000MaxMsExclusive: 400,
  timingGateScenarios: ["bucket4000"],
  profilerCommitGateScenarios: ["bucket4000"],
  candidateProfilerCommitsMustNotExceedBaselineForGatedScenarios: true,
  polygonTimingGated: false,
  polygonRafGated: false,
  deterministicDrawEndUnitFloor: {
    AnnotationOverlay: 0,
    DrawingPreviewLayer: 1,
    PDFPage: 0,
  },
  bucketTransportQuiescence: {
    requiredQuietMs: 100,
    pollIntervalMs: 25,
    stablePolls: 5,
    activeCountsMustBeZero: true,
    generationDeltasMustBeZero: true,
  },
};
const TRANSPORT_RATIONALE =
  "both direct-parent roles use the same-origin private gateway; the bucket quiescence witness proves no browser PDF request or upstream fixture lifecycle overlaps either worker interval";
const MISSING_UNDERLAY_TREATMENT =
  "private-gateway page and thumbnail request families are intercepted at the browser boundary with the same deterministic 404 for both roles";
const HARNESS_HASH_FIELDS = [
  ["specSha256", "e2e/viewer-perf-v2.spec.ts"],
  ["configSha256", "playwright.perf-v2.config.ts"],
  ["patcherSha256", "scripts/apply-perf-v2-instrumentation.mjs"],
  [
    "comparatorSha256",
    "scripts/compare-private-gateway-bucket-quiescence-v1.mjs",
  ],
  ["probeSha256", "e2e/perf-v2/PerfRenderProbe.tsx"],
  ["globalSetupSha256", "e2e/global-setup.ts"],
  ["cdnStubSha256", "e2e/cdn-stub.mjs"],
  ["fixturePreflightSha256", "e2e/ensure-synthetic-pdf.mjs"],
  ["startDevServerSha256", "e2e/start-dev-server.mjs"],
  ["packageLockSha256", "package-lock.json"],
];
const EXPECTED_OVERLAY_STATUS = [
  " M src/components/viewer/AnnotationOverlay.tsx",
  " M src/components/viewer/DrawingPreviewLayer.tsx",
  " M src/components/viewer/PDFPage.tsx",
  "?? .perf-v2-instrumentation.json",
  "?? src/components/viewer/PerfRenderProbe.tsx",
];
const EXPECTED_FIXTURE = {
  pdfVersion: "synthetic-100pg-seed-b1ce-target60mb",
  pdfPages: 100,
  pdfBytes: 65_682_593,
  pdfSha256: "f0e6599185554a3035f2487b1385b632578e411eeb42f8db05d5d981e1e0c2d8",
  generatorSha256:
    "cfb5faf5e05c43cbe2fb21ea58dafe86e4950496d46c4e53c0c3aeda41616577",
  yoloTags: 120,
  yoloInstances: 3600,
  denseAnnotations: 6848,
  takeoffItems: 128,
  bucketRaster: {
    sourceWidth: 4000,
    sourceHeight: 2667,
    processedWidth: 4000,
    processedHeight: 2667,
    fixtureKind: "white-room-with-structural-column",
    outerRoomBounds: [0.2, 0.2, 0.8, 0.8],
    structuralColumnBounds: [0.62, 0.42, 0.68, 0.58],
    seed: [0.5, 0.5],
    dilationPx: 3,
    roomAreaFraction: 0.3504,
  },
  bucketPreviewWitness: {
    filledPoints: [
      [0.58, 0.5],
      [0.72, 0.5],
      [0.65, 0.36],
      [0.65, 0.64],
    ],
    holePoint: [0.65, 0.5],
  },
  underlays:
    "absent; private-gateway page and thumbnail families receive symmetric browser-intercepted 404s; bucket uses deterministic 4000x2667 black-wall/white-room-with-column raster",
};

function parseArguments(argv) {
  const required = new Set([
    "pre1",
    "post1",
    "post2",
    "pre2",
    "candidate-sha",
    "out",
  ]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      !flag?.startsWith("--") ||
      value === undefined ||
      value.startsWith("--")
    ) {
      throw new Error("arguments must be --name value pairs");
    }
    const name = flag.slice(2);
    if (!required.has(name)) throw new Error(`unknown argument: ${flag}`);
    if (Object.hasOwn(values, name)) {
      throw new Error(`duplicate argument: ${flag}`);
    }
    values[name] = value;
  }
  const missing = [...required].filter((name) => !values[name]);
  if (missing.length > 0) {
    throw new Error(
      "usage: node scripts/compare-private-gateway-bucket-quiescence-v1.mjs " +
        "--pre1 pre1.json --post1 post1.json --post2 post2.json --pre2 pre2.json " +
        "--candidate-sha SHA --out verdict.json" +
        ` (missing: ${missing.join(", ")})`,
    );
  }
  if (values["candidate-sha"] !== CANDIDATE_SOURCE_SHA) {
    throw new Error(
      `--candidate-sha must be the fixed private-gateway candidate ${CANDIDATE_SOURCE_SHA}`,
    );
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
  return +(
    sorted.length % 2
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2
  ).toFixed(1);
}

const args = parseArguments(process.argv.slice(2));
const legDefinitions = [
  { key: "pre1", role: "baseline", sourceSha: BASELINE_SOURCE_SHA },
  { key: "post1", role: "candidate", sourceSha: CANDIDATE_SOURCE_SHA },
  { key: "post2", role: "candidate", sourceSha: CANDIDATE_SOURCE_SHA },
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

function exactKeys(name, value, expectedKeys) {
  check(
    `${name} has exact fields`,
    isObject(value) &&
      deepEqual(Object.keys(value).sort(), [...expectedKeys].sort()),
    {
      actual: isObject(value) ? Object.keys(value).sort() : null,
      expected: [...expectedKeys].sort(),
    },
  );
}

function finite(
  name,
  value,
  { integer = false, minimum = 0, exclusiveMinimum = false } = {},
) {
  const pass =
    typeof value === "number" &&
    Number.isFinite(value) &&
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

function equalAcross(name, getter) {
  const values = Object.fromEntries(
    legs.map((leg) => {
      let value;
      try {
        value = getter(leg.artifact);
      } catch {
        value = undefined;
      }
      return [leg.key, value];
    }),
  );
  const [first, ...rest] = Object.values(values);
  check(
    name,
    rest.every((value) => deepEqual(value, first)),
    values,
  );
}

function validateProfiler(label, profiler) {
  check(`${label} is object`, isObject(profiler), {
    actualType: typeof profiler,
  });
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

function validateIntegrity(label, artifact) {
  const integrity = artifact.integrity;
  check(`${label}.integrity is object`, isObject(integrity), {
    actualType: typeof integrity,
  });
  if (isObject(integrity)) {
    for (const field of [
      "pageErrors",
      "requestFailures",
      "abortedRequestFailures",
      "unexpectedRequestFailures",
      "missingUnderlayRequests",
      "http429",
      "polygonPostVertexCounts",
      "servedShas",
      "navFinalPages",
      "navFinalPageWindows",
      "navRasterPaintedPixelSamples",
      "navPdfPageCommits",
      "zoomScaleChanges",
      "zoomPdfPageCommits",
      "bucketPreviewOutcomes",
      "bucketTransportQuiescence",
    ]) {
      array(`${label}.integrity.${field}`, integrity[field]);
    }
    for (const field of [
      "missingUnderlay404s",
      "annotationPosts",
      "bucketServerFallbacks",
      "cachedProjectResponses",
      "cachedPageWindowKeys",
      "cachedTextractKeys",
    ]) {
      finite(`${label}.integrity.${field}`, integrity[field], {
        integer: true,
      });
    }
    check(
      `${label} request failures are completely classified as aborted`,
      Array.isArray(integrity.requestFailures) &&
        Array.isArray(integrity.abortedRequestFailures) &&
        deepEqual(integrity.requestFailures, integrity.abortedRequestFailures),
      {
        requestFailures: integrity.requestFailures,
        abortedRequestFailures: integrity.abortedRequestFailures,
      },
    );
    check(
      `${label} missing underlays are non-vacuous, private-gateway-only, and symmetric`,
      Array.isArray(integrity.missingUnderlayRequests) &&
        integrity.missingUnderlayRequests.length > 0 &&
        integrity.missingUnderlayRequests.every(
          validPrivateMissingUnderlayRequest,
        ) &&
        deepEqual(
          [
            ...new Set(
              integrity.missingUnderlayRequests.map(
                (request) => request.family,
              ),
            ),
          ].sort(),
          ["private-gateway-page-underlay", "private-gateway-thumbnail"],
        ) &&
        integrity.missingUnderlay404s ===
          integrity.missingUnderlayRequests.length,
      {
        requests: integrity.missingUnderlayRequests,
        missingUnderlay404s: integrity.missingUnderlay404s,
      },
    );
    const runWitnessFields = [
      "navFinalPages",
      "navFinalPageWindows",
      "navRasterPaintedPixelSamples",
      "navPdfPageCommits",
      "zoomScaleChanges",
      "zoomPdfPageCommits",
      "bucketPreviewOutcomes",
      "bucketTransportQuiescence",
    ];
    check(
      `${label} integrity run-witness arrays have one entry per run`,
      runWitnessFields.every(
        (field) =>
          Array.isArray(integrity[field]) && integrity[field].length === RUNS,
      ),
      Object.fromEntries(
        runWitnessFields.map((field) => [
          field,
          Array.isArray(integrity[field]) ? integrity[field].length : null,
        ]),
      ),
    );
    if (Array.isArray(integrity.navFinalPageWindows)) {
      integrity.navFinalPageWindows.forEach((pageWindow, index) =>
        validatePageWindow(
          `${label}.integrity.navFinalPageWindows[${index}]`,
          pageWindow,
        ),
      );
    }
    if (Array.isArray(integrity.bucketPreviewOutcomes)) {
      integrity.bucketPreviewOutcomes.forEach((outcome, index) =>
        validateBucketOutcome(
          `${label}.integrity.bucketPreviewOutcomes[${index}]`,
          outcome,
        ),
      );
    }
    if (Array.isArray(integrity.bucketTransportQuiescence)) {
      integrity.bucketTransportQuiescence.forEach((witness, index) =>
        validateBucketTransportQuiescence(
          `${label}.integrity.bucketTransportQuiescence[${index}]`,
          witness,
        ),
      );
    }
    if (Array.isArray(artifact.samples)) {
      exact(
        `${label} integrity.navFinalPages matches samples`,
        integrity.navFinalPages,
        artifact.samples.map((sample) => sample?.navOutcome?.activePage),
      );
      exact(
        `${label} integrity.navFinalPageWindows matches samples`,
        integrity.navFinalPageWindows,
        artifact.samples.map((sample) => sample?.navOutcome?.pageWindow),
      );
      exact(
        `${label} integrity.navRasterPaintedPixelSamples matches samples`,
        integrity.navRasterPaintedPixelSamples,
        artifact.samples.map(
          (sample) => sample?.navOutcome?.raster?.paintedPixelSamples,
        ),
      );
      exact(
        `${label} integrity.navPdfPageCommits matches samples`,
        integrity.navPdfPageCommits,
        artifact.samples.map((sample) => sample?.navOutcome?.pdfPageCommits),
      );
      exact(
        `${label} integrity.zoomScaleChanges matches samples`,
        integrity.zoomScaleChanges,
        artifact.samples.map((sample) => ({
          beforePercent: sample?.zoomOutcome?.beforePercent,
          afterPercent: sample?.zoomOutcome?.afterPercent,
          deltaPercent: sample?.zoomOutcome?.deltaPercent,
        })),
      );
      exact(
        `${label} integrity.zoomPdfPageCommits matches samples`,
        integrity.zoomPdfPageCommits,
        artifact.samples.map((sample) => sample?.zoomOutcome?.pdfPageCommits),
      );
      exact(
        `${label} integrity.bucketPreviewOutcomes matches samples`,
        integrity.bucketPreviewOutcomes,
        artifact.samples.map((sample) => sample?.bucketOutcome),
      );
      exact(
        `${label} integrity.bucketTransportQuiescence matches samples`,
        integrity.bucketTransportQuiescence,
        artifact.samples.map((sample) => sample?.bucketTransportQuiescence),
      );
    }
  }
}

function validateBucketRaster(label, raster) {
  check(`${label} is object`, isObject(raster), { actualType: typeof raster });
  if (!isObject(raster)) return;
  for (const key of [
    "sourceWidth",
    "sourceHeight",
    "processedWidth",
    "processedHeight",
  ]) {
    finite(`${label}.${key}`, raster[key], {
      integer: true,
      minimum: 0,
      exclusiveMinimum: true,
    });
  }
  finite(`${label}.roomAreaFraction`, raster.roomAreaFraction);
}

function validateBucketOutcome(label, outcome) {
  check(`${label} is object`, isObject(outcome), {
    actualType: typeof outcome,
  });
  if (!isObject(outcome)) return;
  finite(`${label}.previewCanvasWidth`, outcome.previewCanvasWidth, {
    integer: true,
    minimum: 0,
    exclusiveMinimum: true,
  });
  finite(`${label}.previewCanvasHeight`, outcome.previewCanvasHeight, {
    integer: true,
    minimum: 0,
    exclusiveMinimum: true,
  });
  exact(`${label}.previewCanvasZIndex`, outcome.previewCanvasZIndex, "15");
  check(
    `${label}.filledSampleAlphas has one entry per witness point`,
    Array.isArray(outcome.filledSampleAlphas) &&
      outcome.filledSampleAlphas.length ===
        EXPECTED_FIXTURE.bucketPreviewWitness.filledPoints.length,
    outcome.filledSampleAlphas,
  );
  if (Array.isArray(outcome.filledSampleAlphas)) {
    outcome.filledSampleAlphas.forEach((alpha, index) =>
      check(
        `${label}.filledSampleAlphas[${index}] is painted`,
        Number.isInteger(alpha) && alpha > 0 && alpha <= 255,
        alpha,
      ),
    );
  }
  exact(
    `${label}.filledSampleCount`,
    outcome.filledSampleCount,
    EXPECTED_FIXTURE.bucketPreviewWitness.filledPoints.length,
  );
  exact(`${label}.holeCenterAlpha`, outcome.holeCenterAlpha, 0);
}

function validatePageWindow(label, pageWindow) {
  check(`${label} is object`, isObject(pageWindow), {
    actualType: typeof pageWindow,
  });
  if (!isObject(pageWindow)) return;
  nonemptyString(`${label}.url`, pageWindow.url);
  finite(`${label}.from`, pageWindow.from, {
    integer: true,
    minimum: 0,
    exclusiveMinimum: true,
  });
  finite(`${label}.to`, pageWindow.to, {
    integer: true,
    minimum: 0,
    exclusiveMinimum: true,
  });
  check(
    `${label} covers page 21`,
    pageWindow.from <= 21 && pageWindow.to >= 21,
    { from: pageWindow.from, to: pageWindow.to },
  );
}

function validateNavOutcome(label, outcome) {
  check(`${label} is object`, isObject(outcome), {
    actualType: typeof outcome,
  });
  if (!isObject(outcome)) return;
  exact(`${label}.targetPage`, outcome.targetPage, 21);
  exact(`${label}.activePage`, outcome.activePage, 21);
  nonemptyString(`${label}.activeClass`, outcome.activeClass);
  validatePageWindow(`${label}.pageWindow`, outcome.pageWindow);
  check(`${label}.raster is object`, isObject(outcome.raster), {
    actualType: typeof outcome.raster,
  });
  if (isObject(outcome.raster)) {
    for (const field of ["width", "height", "paintedPixelSamples"]) {
      finite(`${label}.raster.${field}`, outcome.raster[field], {
        integer: true,
        minimum: 0,
        exclusiveMinimum: true,
      });
    }
    for (const field of ["cssWidth", "cssHeight"]) {
      finite(`${label}.raster.${field}`, outcome.raster[field], {
        minimum: 0,
        exclusiveMinimum: true,
      });
    }
    check(
      `${label}.raster.opacity is visible`,
      typeof outcome.raster.opacity === "string" &&
        outcome.raster.opacity !== "" &&
        outcome.raster.opacity !== "0",
      outcome.raster.opacity,
    );
  }
  finite(`${label}.pdfPageCommits`, outcome.pdfPageCommits, {
    integer: true,
    minimum: 0,
    exclusiveMinimum: true,
  });
}

function validateZoomOutcome(label, outcome) {
  check(`${label} is object`, isObject(outcome), {
    actualType: typeof outcome,
  });
  if (!isObject(outcome)) return;
  for (const field of ["beforePercent", "afterPercent", "deltaPercent"]) {
    finite(`${label}.${field}`, outcome[field], {
      minimum: 0,
      exclusiveMinimum: true,
    });
  }
  check(
    `${label} records a coherent positive scale change`,
    Number.isFinite(outcome.beforePercent) &&
      Number.isFinite(outcome.afterPercent) &&
      Number.isFinite(outcome.deltaPercent) &&
      outcome.afterPercent > outcome.beforePercent &&
      outcome.afterPercent - outcome.beforePercent === outcome.deltaPercent,
    outcome,
  );
  finite(`${label}.pdfPageCommits`, outcome.pdfPageCommits, {
    integer: true,
    minimum: 0,
    exclusiveMinimum: true,
  });
}

function validateObservationWindow(label, window) {
  exactKeys(label, window, ["startedAtEpochMs", "endedAtEpochMs", "elapsedMs"]);
  if (!isObject(window)) return;
  finite(`${label}.startedAtEpochMs`, window.startedAtEpochMs, {
    integer: true,
    minimum: 0,
    exclusiveMinimum: true,
  });
  finite(`${label}.endedAtEpochMs`, window.endedAtEpochMs, {
    integer: true,
    minimum: 0,
    exclusiveMinimum: true,
  });
  finite(`${label}.elapsedMs`, window.elapsedMs, { minimum: 0 });
  check(
    `${label} is ordered and bounded`,
    Number.isFinite(window.startedAtEpochMs) &&
      Number.isFinite(window.endedAtEpochMs) &&
      Number.isFinite(window.elapsedMs) &&
      window.endedAtEpochMs >= window.startedAtEpochMs &&
      window.elapsedMs >= 0 &&
      window.elapsedMs < 30_000,
    window,
  );
}

function validateBrowserSnapshot(label, snapshot) {
  exactKeys(label, snapshot, [
    "observedAtEpochMs",
    "requestGeneration",
    "lifecycleGeneration",
    "activeCount",
  ]);
  if (!isObject(snapshot)) return;
  finite(`${label}.observedAtEpochMs`, snapshot.observedAtEpochMs, {
    integer: true,
    minimum: 0,
    exclusiveMinimum: true,
  });
  for (const field of [
    "requestGeneration",
    "lifecycleGeneration",
    "activeCount",
  ]) {
    finite(`${label}.${field}`, snapshot[field], { integer: true });
  }
}

function validateUpstreamSnapshot(label, snapshot) {
  exactKeys(label, snapshot, [
    "requestGeneration",
    "lifecycleGeneration",
    "activeCount",
    "activeStreamCount",
  ]);
  if (!isObject(snapshot)) return;
  for (const field of [
    "requestGeneration",
    "lifecycleGeneration",
    "activeCount",
    "activeStreamCount",
  ]) {
    finite(`${label}.${field}`, snapshot[field], { integer: true });
  }
}

function validateGenerationDeltas(label, deltas, fields) {
  exactKeys(label, deltas, fields);
  if (!isObject(deltas)) return;
  for (const field of fields) {
    finite(`${label}.${field}`, deltas[field], { integer: true });
  }
}

function validateBracketedObservation(label, observation) {
  exactKeys(label, observation, [
    "observationWindow",
    "coherenceRetries",
    "coherenceStateTransitions",
    "browserBefore",
    "upstream",
    "browserAfter",
    "browserBracketDeltas",
  ]);
  if (!isObject(observation)) return;
  validateObservationWindow(
    `${label}.observationWindow`,
    observation.observationWindow,
  );
  finite(`${label}.coherenceRetries`, observation.coherenceRetries, {
    integer: true,
  });
  finite(
    `${label}.coherenceStateTransitions`,
    observation.coherenceStateTransitions,
    { integer: true },
  );
  check(
    `${label} coherence retry diagnostics are internally bounded`,
    Number.isInteger(observation.coherenceRetries) &&
      Number.isInteger(observation.coherenceStateTransitions) &&
      observation.coherenceStateTransitions >= observation.coherenceRetries &&
      observation.coherenceStateTransitions <= observation.coherenceRetries * 2,
    {
      coherenceRetries: observation.coherenceRetries,
      coherenceStateTransitions: observation.coherenceStateTransitions,
    },
  );
  validateBrowserSnapshot(`${label}.browserBefore`, observation.browserBefore);
  validateUpstreamSnapshot(`${label}.upstream`, observation.upstream);
  validateBrowserSnapshot(`${label}.browserAfter`, observation.browserAfter);
  validateGenerationDeltas(
    `${label}.browserBracketDeltas`,
    observation.browserBracketDeltas,
    ["requestGeneration", "lifecycleGeneration"],
  );
  if (
    isObject(observation.browserBefore) &&
    isObject(observation.browserAfter) &&
    isObject(observation.browserBracketDeltas)
  ) {
    exact(
      `${label} request generation bracket delta is coherent`,
      observation.browserBracketDeltas.requestGeneration,
      observation.browserAfter.requestGeneration -
        observation.browserBefore.requestGeneration,
    );
    exact(
      `${label} lifecycle generation bracket delta is coherent`,
      observation.browserBracketDeltas.lifecycleGeneration,
      observation.browserAfter.lifecycleGeneration -
        observation.browserBefore.lifecycleGeneration,
    );
  }
  if (isObject(observation.browserBracketDeltas)) {
    exact(
      `${label} coherent capture has zero browser request-generation bracket delta`,
      observation.browserBracketDeltas.requestGeneration,
      0,
    );
    exact(
      `${label} coherent capture has zero browser lifecycle-generation bracket delta`,
      observation.browserBracketDeltas.lifecycleGeneration,
      0,
    );
  }
  if (
    isObject(observation.observationWindow) &&
    isObject(observation.browserBefore) &&
    isObject(observation.browserAfter)
  ) {
    check(
      `${label} browser observations are inside their bracket window`,
      observation.observationWindow.startedAtEpochMs <=
        observation.browserBefore.observedAtEpochMs &&
        observation.browserBefore.observedAtEpochMs <=
          observation.browserAfter.observedAtEpochMs &&
        observation.browserAfter.observedAtEpochMs <=
          observation.observationWindow.endedAtEpochMs,
      {
        window: observation.observationWindow,
        browserBefore: observation.browserBefore.observedAtEpochMs,
        browserAfter: observation.browserAfter.observedAtEpochMs,
      },
    );
  }
}

function activeVector(observation) {
  return [
    observation?.browserBefore?.activeCount,
    observation?.upstream?.activeCount,
    observation?.upstream?.activeStreamCount,
    observation?.browserAfter?.activeCount,
  ];
}

function validateQuietBarrier(label, barrier) {
  exactKeys(label, barrier, [
    "requiredQuietMs",
    "pollIntervalMs",
    "initialActive",
    "polls",
    "stablePolls",
    "elapsedMs",
    "stateChangeTransitions",
    "observationWindow",
    "stableObservationWindow",
    "pollObservations",
  ]);
  if (!isObject(barrier)) return;
  exact(
    `${label}.requiredQuietMs`,
    barrier.requiredQuietMs,
    QUIET_BARRIER_CONTRACT.requiredQuietMs,
  );
  exact(
    `${label}.pollIntervalMs`,
    barrier.pollIntervalMs,
    QUIET_BARRIER_CONTRACT.pollIntervalMs,
  );
  finite(`${label}.polls`, barrier.polls, {
    integer: true,
    minimum: QUIET_BARRIER_CONTRACT.stablePolls,
  });
  exact(
    `${label}.stablePolls`,
    barrier.stablePolls,
    QUIET_BARRIER_CONTRACT.stablePolls,
  );
  exactKeys(`${label}.initialActive`, barrier.initialActive, [
    "browserPdfRequests",
    "upstreamRequests",
    "upstreamStreams",
  ]);
  if (isObject(barrier.initialActive)) {
    for (const field of [
      "browserPdfRequests",
      "upstreamRequests",
      "upstreamStreams",
    ]) {
      finite(`${label}.initialActive.${field}`, barrier.initialActive[field], {
        integer: true,
      });
    }
  }
  finite(`${label}.elapsedMs`, barrier.elapsedMs, {
    minimum: QUIET_BARRIER_CONTRACT.requiredQuietMs,
  });
  finite(`${label}.stateChangeTransitions`, barrier.stateChangeTransitions, {
    integer: true,
  });
  validateObservationWindow(
    `${label}.observationWindow`,
    barrier.observationWindow,
  );
  validateObservationWindow(
    `${label}.stableObservationWindow`,
    barrier.stableObservationWindow,
  );
  check(
    `${label}.elapsedMs matches observationWindow.elapsedMs`,
    barrier.elapsedMs === barrier.observationWindow?.elapsedMs,
    {
      elapsedMs: barrier.elapsedMs,
      observationElapsedMs: barrier.observationWindow?.elapsedMs,
    },
  );
  check(
    `${label}.pollObservations length equals total polls and includes the stable tail`,
    Array.isArray(barrier.pollObservations) &&
      barrier.pollObservations.length === barrier.polls &&
      barrier.pollObservations.length >= QUIET_BARRIER_CONTRACT.stablePolls,
    {
      actual: Array.isArray(barrier.pollObservations)
        ? barrier.pollObservations.length
        : null,
      polls: barrier.polls,
      minimum: QUIET_BARRIER_CONTRACT.stablePolls,
    },
  );
  if (Array.isArray(barrier.pollObservations)) {
    barrier.pollObservations.forEach((observation, index) =>
      validateBracketedObservation(
        `${label}.pollObservations[${index}]`,
        observation,
      ),
    );
    if (barrier.pollObservations.length > 0) {
      const first = barrier.pollObservations[0];
      check(
        `${label}.initialActive preserves pre-fetch browser activity and first upstream activity`,
        Number.isInteger(barrier.initialActive?.browserPdfRequests) &&
          barrier.initialActive.browserPdfRequests >= 0 &&
          barrier.initialActive?.upstreamRequests ===
            first?.upstream?.activeCount &&
          barrier.initialActive?.upstreamStreams ===
            first?.upstream?.activeStreamCount,
        {
          initialActive: barrier.initialActive,
          firstObservation: first,
        },
      );
      const stableTail = barrier.pollObservations.slice(
        -QUIET_BARRIER_CONTRACT.stablePolls,
      );
      const stableStates = stableTail.map((observation) => ({
        browserRequestGeneration: observation?.browserAfter?.requestGeneration,
        browserLifecycleGeneration:
          observation?.browserAfter?.lifecycleGeneration,
        browserActiveCount: observation?.browserAfter?.activeCount,
        upstreamRequestGeneration: observation?.upstream?.requestGeneration,
        upstreamLifecycleGeneration: observation?.upstream?.lifecycleGeneration,
        upstreamActiveCount: observation?.upstream?.activeCount,
        upstreamActiveStreamCount: observation?.upstream?.activeStreamCount,
      }));
      check(
        `${label} final five-observation tail is idle and state-stable`,
        stableTail.length === QUIET_BARRIER_CONTRACT.stablePolls &&
          stableTail.every(
            (observation) =>
              observation?.browserBefore?.activeCount === 0 &&
              observation?.browserAfter?.activeCount === 0 &&
              observation?.upstream?.activeCount === 0 &&
              observation?.upstream?.activeStreamCount === 0,
          ) &&
          stableStates.every((state) => deepEqual(state, stableStates[0])),
        { stableTail, stableStates },
      );
      const firstStableWindow = stableTail[0]?.observationWindow;
      const lastStableWindow = stableTail.at(-1)?.observationWindow;
      exact(
        `${label}.stableObservationWindow matches the final stable tail`,
        barrier.stableObservationWindow,
        {
          startedAtEpochMs: firstStableWindow?.startedAtEpochMs,
          endedAtEpochMs: lastStableWindow?.endedAtEpochMs,
          elapsedMs:
            lastStableWindow?.endedAtEpochMs -
            firstStableWindow?.startedAtEpochMs,
        },
      );
      check(
        `${label} final stable tail spans at least the required quiet window`,
        Number.isFinite(barrier.stableObservationWindow?.elapsedMs) &&
          barrier.stableObservationWindow.elapsedMs >=
            QUIET_BARRIER_CONTRACT.requiredQuietMs,
        barrier.stableObservationWindow,
      );
      let recomputedVisibleTransitions = 0;
      let hiddenTransitions = 0;
      for (let index = 1; index < barrier.pollObservations.length; index += 1) {
        const previous = barrier.pollObservations[index - 1];
        const current = barrier.pollObservations[index];
        const state = (observation) => ({
          browserRequestGeneration:
            observation?.browserAfter?.requestGeneration,
          browserLifecycleGeneration:
            observation?.browserAfter?.lifecycleGeneration,
          browserActiveCount: observation?.browserAfter?.activeCount,
          upstreamRequestGeneration: observation?.upstream?.requestGeneration,
          upstreamLifecycleGeneration:
            observation?.upstream?.lifecycleGeneration,
          upstreamActiveCount: observation?.upstream?.activeCount,
          upstreamActiveStreamCount: observation?.upstream?.activeStreamCount,
        });
        hiddenTransitions += current?.coherenceStateTransitions ?? 0;
        if (
          !deepEqual(state(previous), state(current)) &&
          current?.coherenceStateTransitions === 0
        ) {
          recomputedVisibleTransitions += 1;
        }
      }
      hiddenTransitions += first?.coherenceStateTransitions ?? 0;
      const recomputedFloor = hiddenTransitions + recomputedVisibleTransitions;
      const firstVisibleActiveTransition =
        first?.browserBefore?.activeCount !==
        barrier.initialActive?.browserPdfRequests;
      const firstHiddenTransitions = first?.coherenceStateTransitions ?? 0;
      const transitionCountPass =
        firstHiddenTransitions > 0
          ? barrier.stateChangeTransitions === recomputedFloor
          : firstVisibleActiveTransition
            ? barrier.stateChangeTransitions === recomputedFloor + 1
            : barrier.stateChangeTransitions === recomputedFloor ||
              barrier.stateChangeTransitions === recomputedFloor + 1;
      check(
        `${label}.stateChangeTransitions covers all retained hidden and visible transitions`,
        transitionCountPass,
        {
          actual: barrier.stateChangeTransitions,
          recomputedFloor,
          firstVisibleActiveTransition,
          note: "an unpersisted initial browser generation can contribute at most one additional transition",
        },
      );
    }
  }
}

function validateQuiescencePhase(label, phase) {
  exactKeys(label, phase, [
    "quietBarrier",
    "before",
    "after",
    "intervalDeltas",
  ]);
  if (!isObject(phase)) return;
  validateQuietBarrier(`${label}.quietBarrier`, phase.quietBarrier);
  validateBracketedObservation(`${label}.before`, phase.before);
  validateBracketedObservation(`${label}.after`, phase.after);
  validateGenerationDeltas(`${label}.intervalDeltas`, phase.intervalDeltas, [
    "browserRequestGeneration",
    "browserLifecycleGeneration",
    "upstreamRequestGeneration",
    "upstreamLifecycleGeneration",
  ]);
  exact(
    `${label}.before is the final quiet-barrier poll`,
    phase.before,
    Array.isArray(phase.quietBarrier?.pollObservations)
      ? phase.quietBarrier.pollObservations.at(-1)
      : undefined,
  );
  check(
    `${label} before/after observation windows are ordered`,
    Number.isFinite(phase.before?.observationWindow?.endedAtEpochMs) &&
      Number.isFinite(phase.after?.observationWindow?.startedAtEpochMs) &&
      phase.after.observationWindow.startedAtEpochMs >=
        phase.before.observationWindow.endedAtEpochMs,
    {
      before: phase.before?.observationWindow,
      after: phase.after?.observationWindow,
    },
  );
  if (
    isObject(phase.before) &&
    isObject(phase.after) &&
    isObject(phase.intervalDeltas)
  ) {
    exact(
      `${label} browser request interval delta is coherent`,
      phase.intervalDeltas.browserRequestGeneration,
      phase.after.browserBefore?.requestGeneration -
        phase.before.browserAfter?.requestGeneration,
    );
    exact(
      `${label} browser lifecycle interval delta is coherent`,
      phase.intervalDeltas.browserLifecycleGeneration,
      phase.after.browserBefore?.lifecycleGeneration -
        phase.before.browserAfter?.lifecycleGeneration,
    );
    exact(
      `${label} upstream request interval delta is coherent`,
      phase.intervalDeltas.upstreamRequestGeneration,
      phase.after.upstream?.requestGeneration -
        phase.before.upstream?.requestGeneration,
    );
    exact(
      `${label} upstream lifecycle interval delta is coherent`,
      phase.intervalDeltas.upstreamLifecycleGeneration,
      phase.after.upstream?.lifecycleGeneration -
        phase.before.upstream?.lifecycleGeneration,
    );
  }
}

function validateBucketTransportQuiescence(label, witness) {
  exactKeys(label, witness, QUIESCENCE_PHASES);
  if (!isObject(witness)) return;
  for (const phaseName of QUIESCENCE_PHASES) {
    validateQuiescencePhase(`${label}.${phaseName}`, witness[phaseName]);
  }
}

function candidatePhaseQuiescenceValues(phase) {
  const pollObservations = Array.isArray(phase?.quietBarrier?.pollObservations)
    ? phase.quietBarrier.pollObservations
    : [];
  const beforeAfter = [phase?.before, phase?.after];
  return {
    quietBarrierInitialActive: phase?.quietBarrier?.initialActive,
    quietBarrierStateChangeTransitions:
      phase?.quietBarrier?.stateChangeTransitions,
    quietBarrierPolls: phase?.quietBarrier?.polls,
    quietBarrierStablePolls: phase?.quietBarrier?.stablePolls,
    pollActiveCounts: pollObservations.map((observation) =>
      activeVector(observation),
    ),
    pollCoherenceDiagnostics: pollObservations.map((observation) => ({
      coherenceRetries: observation?.coherenceRetries,
      coherenceStateTransitions: observation?.coherenceStateTransitions,
    })),
    beforeAfterActiveCounts: beforeAfter.map((observation) =>
      activeVector(observation),
    ),
    browserBracketDeltas: [...pollObservations, ...beforeAfter].map(
      (observation) => observation?.browserBracketDeltas,
    ),
    intervalDeltas: phase?.intervalDeltas,
  };
}

function gateCandidateQuiescence(label, phase) {
  const values = candidatePhaseQuiescenceValues(phase);
  check(
    `${label} starts with zero browser/upstream active requests and streams`,
    isObject(values.quietBarrierInitialActive) &&
      values.quietBarrierInitialActive.browserPdfRequests === 0 &&
      values.quietBarrierInitialActive.upstreamRequests === 0 &&
      values.quietBarrierInitialActive.upstreamStreams === 0,
    values.quietBarrierInitialActive,
  );
  check(
    `${label} observes exactly five stable polls without a drain prefix`,
    values.quietBarrierPolls === QUIET_BARRIER_CONTRACT.stablePolls &&
      values.quietBarrierStablePolls === QUIET_BARRIER_CONTRACT.stablePolls &&
      values.pollActiveCounts.length === QUIET_BARRIER_CONTRACT.stablePolls,
    {
      polls: values.quietBarrierPolls,
      stablePolls: values.quietBarrierStablePolls,
      pollObservations: values.pollActiveCounts.length,
    },
  );
  exact(
    `${label} zero quiet-barrier state-change transitions`,
    values.quietBarrierStateChangeTransitions,
    0,
  );
  check(
    `${label} every quiet-barrier observation has zero browser/upstream activity`,
    values.pollActiveCounts.length === QUIET_BARRIER_CONTRACT.stablePolls &&
      values.pollActiveCounts.every(
        (counts) => counts.length === 4 && counts.every((count) => count === 0),
      ),
    values.pollActiveCounts,
  );
  check(
    `${label} every quiet-barrier observation has zero coherence retries and transitions`,
    values.pollCoherenceDiagnostics.length ===
      QUIET_BARRIER_CONTRACT.stablePolls &&
      values.pollCoherenceDiagnostics.every(
        (diagnostic) =>
          diagnostic.coherenceRetries === 0 &&
          diagnostic.coherenceStateTransitions === 0,
      ),
    values.pollCoherenceDiagnostics,
  );
  check(
    `${label} zero before/after browser and upstream active counts and streams`,
    values.beforeAfterActiveCounts.length === 2 &&
      values.beforeAfterActiveCounts.every(
        (counts) => counts.length === 4 && counts.every((count) => count === 0),
      ),
    values.beforeAfterActiveCounts,
  );
  check(
    `${label} zero browser request/lifecycle bracket deltas`,
    Number.isInteger(values.quietBarrierPolls) &&
      values.browserBracketDeltas.length === values.quietBarrierPolls + 2 &&
      values.browserBracketDeltas.every(
        (deltas) =>
          deltas?.requestGeneration === 0 && deltas?.lifecycleGeneration === 0,
      ),
    values.browserBracketDeltas,
  );
  check(
    `${label} zero browser/upstream request/lifecycle interval deltas`,
    isObject(values.intervalDeltas) &&
      Object.values(values.intervalDeltas).length === 4 &&
      Object.values(values.intervalDeltas).every((delta) => delta === 0),
    values.intervalDeltas,
  );
}

function validPrivateMissingUnderlayRequest(request) {
  if (
    !isObject(request) ||
    request.method !== "GET" ||
    request.status !== 404 ||
    typeof request.url !== "string" ||
    typeof request.pathname !== "string"
  ) {
    return false;
  }
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  if (
    url.pathname !== request.pathname ||
    url.protocol !== "http:" ||
    url.hostname !== "localhost" ||
    url.port !== "3100"
  ) {
    return false;
  }
  if (request.family === "private-gateway-page-underlay") {
    return /^\/api\/project-assets\/[0-9a-f-]{36}\/pages\/page_[0-9]{4}\.png$/u.test(
      url.pathname,
    );
  }
  if (request.family === "private-gateway-thumbnail") {
    return /^\/api\/project-assets\/[0-9a-f-]{36}\/thumbnails\/page_[0-9]{4}\.png$/u.test(
      url.pathname,
    );
  }
  return false;
}

function validateTransportBoundary(label, boundary) {
  check(`${label} is object`, isObject(boundary), {
    actualType: typeof boundary,
  });
  if (!isObject(boundary)) return;
  exact(
    `${label}.browserBoundary`,
    boundary.browserBoundary,
    "same-origin-private-gateway",
  );
  exact(`${label}.sourceExact`, boundary.sourceExact, true);
  exact(`${label}.securityEvidence`, boundary.securityEvidence, false);
  exact(`${label}.rationale`, boundary.rationale, TRANSPORT_RATIONALE);
  exact(
    `${label}.missingUnderlayTreatment`,
    boundary.missingUnderlayTreatment,
    MISSING_UNDERLAY_TREATMENT,
  );
  finite(`${label}.pdfRequestCount`, boundary.pdfRequestCount, {
    integer: true,
    minimum: 0,
    exclusiveMinimum: true,
  });
  finite(`${label}.pdfRangeRequestCount`, boundary.pdfRangeRequestCount, {
    integer: true,
    minimum: 0,
    exclusiveMinimum: true,
  });
  check(
    `${label} range request count fits total`,
    Number.isInteger(boundary.pdfRequestCount) &&
      Number.isInteger(boundary.pdfRangeRequestCount) &&
      boundary.pdfRangeRequestCount > 0 &&
      boundary.pdfRangeRequestCount <= boundary.pdfRequestCount,
    boundary,
  );
  check(
    `${label} has one exact private gateway PDF path`,
    Array.isArray(boundary.pdfRequestPaths) &&
      boundary.pdfRequestPaths.length === 1 &&
      /^\/api\/project-assets\/[0-9a-f-]{36}\/original\.pdf$/u.test(
        boundary.pdfRequestPaths[0],
      ),
    boundary.pdfRequestPaths,
  );
}

function validateFixture(label, fixture) {
  check(`${label} is object`, isObject(fixture), {
    actualType: typeof fixture,
  });
  if (!isObject(fixture)) return;
  for (const field of [
    "pdfVersion",
    "pdfPages",
    "pdfBytes",
    "pdfSha256",
    "generatorSha256",
    "yoloTags",
    "yoloInstances",
    "denseAnnotations",
    "takeoffItems",
    "bucketRaster",
    "bucketPreviewWitness",
  ]) {
    exact(`${label}.${field}`, fixture[field], EXPECTED_FIXTURE[field]);
  }
  exact(`${label}.underlays`, fixture.underlays, EXPECTED_FIXTURE.underlays);
}

function validateHarness(label, harness, sourceSha) {
  check(`${label} is object`, isObject(harness), {
    actualType: typeof harness,
  });
  if (!isObject(harness)) return;
  for (const [field] of HARNESS_HASH_FIELDS) {
    check(
      `${label}.${field} is SHA-256`,
      SHA256_PATTERN.test(harness[field]),
      harness[field],
    );
  }
  const instrumentation = harness.instrumentation;
  check(`${label}.instrumentation is object`, isObject(instrumentation), {
    actualType: typeof instrumentation,
  });
  if (isObject(instrumentation)) {
    exact(
      `${label}.instrumentation.schemaVersion`,
      instrumentation.schemaVersion,
      INSTRUMENTATION_SCHEMA_VERSION,
    );
    exact(
      `${label}.instrumentation.scriptVersion`,
      instrumentation.scriptVersion,
      "bp-perf-v2-overlay-1",
    );
    exact(
      `${label}.instrumentation.sourceSha`,
      instrumentation.sourceSha,
      sourceSha,
    );
    for (const field of ["overlayProtocolSha256", "probeSha256"]) {
      check(
        `${label}.instrumentation.${field} is SHA-256`,
        SHA256_PATTERN.test(instrumentation[field]),
        instrumentation[field],
      );
    }
    exact(
      `${label} instrumentation probe matches harness probe`,
      instrumentation.probeSha256,
      harness.probeSha256,
    );
    const expectedFiles = [
      "src/components/viewer/PDFPage.tsx",
      "src/components/viewer/AnnotationOverlay.tsx",
      "src/components/viewer/DrawingPreviewLayer.tsx",
    ];
    check(
      `${label}.instrumentation.targets has exactly three entries`,
      Array.isArray(instrumentation.targets) &&
        instrumentation.targets.length === expectedFiles.length,
      instrumentation.targets,
    );
    if (Array.isArray(instrumentation.targets)) {
      instrumentation.targets.forEach((target, index) => {
        exact(
          `${label}.instrumentation.targets[${index}].file`,
          target?.file,
          expectedFiles[index],
        );
        for (const field of ["beforeSha256", "afterSha256"]) {
          check(
            `${label}.instrumentation.targets[${index}].${field} is SHA-256`,
            SHA256_PATTERN.test(target?.[field]),
            target?.[field],
          );
        }
        check(
          `${label}.instrumentation.targets[${index}] changed`,
          SHA256_PATTERN.test(target?.beforeSha256) &&
            SHA256_PATTERN.test(target?.afterSha256) &&
            target.beforeSha256 !== target.afterSha256,
          target,
        );
      });
    }
  }

  const worktree = harness.exactAppWorktree;
  check(`${label}.exactAppWorktree is object`, isObject(worktree), {
    actualType: typeof worktree,
  });
  if (isObject(worktree)) {
    check(
      `${label}.exactAppWorktree.root is a distinct absolute path`,
      typeof worktree.root === "string" &&
        resolve(worktree.root) === worktree.root &&
        resolve(worktree.root) !== scriptRoot,
      worktree.root,
    );
    exact(`${label}.exactAppWorktree.headSha`, worktree.headSha, sourceSha);
    exact(
      `${label}.exactAppWorktree.sourceCommitSha`,
      worktree.sourceCommitSha,
      sourceSha,
    );
    exact(
      `${label}.exactAppWorktree.gitStatus`,
      worktree.gitStatus,
      EXPECTED_OVERLAY_STATUS,
    );
  }
}

function validateArtifact(leg) {
  const { artifact, key, role, sourceSha } = leg;
  const label = key;
  check(`${label} top level is object`, isObject(artifact), {
    actualType: typeof artifact,
  });
  if (!isObject(artifact)) return;

  exact(
    `${label} schemaVersion`,
    artifact.schemaVersion,
    ARTIFACT_SCHEMA_VERSION,
  );
  exact(`${label} protocolVersion`, artifact.protocolVersion, PROTOCOL_VERSION);
  exact(`${label} validationGate`, artifact.validationGate, VALIDATION_GATE);
  exact(`${label} role`, artifact.role, role);
  exact(`${label} leg`, artifact.leg, key);
  exact(`${label} sourceSha`, artifact.sourceSha, sourceSha);
  exact(`${label} sourceCommitSha`, artifact.sourceCommitSha, sourceSha);
  check(
    `${label} sourceSha is exact SHA`,
    SHA1_PATTERN.test(artifact.sourceSha),
    artifact.sourceSha,
  );
  check(
    `${label} sourceCommitSha is exact SHA`,
    SHA1_PATTERN.test(artifact.sourceCommitSha),
    artifact.sourceCommitSha,
  );
  check(
    `${label} harnessSha is exact SHA`,
    SHA1_PATTERN.test(artifact.harnessSha),
    artifact.harnessSha,
  );
  exact(`${label} runs`, artifact.runs, RUNS);
  exact(`${label} smoke`, artifact.smoke, false);
  nonemptyString(`${label} mode`, artifact.mode);
  check(
    `${label} date is an ISO timestamp`,
    typeof artifact.date === "string" &&
      Number.isFinite(Date.parse(artifact.date)),
    artifact.date,
  );

  validateTransportBoundary(
    `${label}.transportBoundary`,
    artifact.transportBoundary,
  );
  exact(
    `${label}.thresholdContract`,
    artifact.thresholdContract,
    EXPECTED_THRESHOLD_CONTRACT,
  );
  validateFixture(`${label}.fixture`, artifact.fixture);
  validateHarness(`${label}.harness`, artifact.harness, sourceSha);

  check(`${label}.environment is object`, isObject(artifact.environment), {
    actualType: typeof artifact.environment,
  });
  if (isObject(artifact.environment)) {
    for (const field of [
      "node",
      "playwright",
      "chromium",
      "os",
      "cpu",
      "postgres",
    ]) {
      nonemptyString(
        `${label}.environment.${field}`,
        artifact.environment[field],
      );
    }
    check(
      `${label}.environment.viewport is object`,
      isObject(artifact.environment.viewport),
      artifact.environment.viewport,
    );
    if (isObject(artifact.environment.viewport)) {
      finite(
        `${label}.environment.viewport.width`,
        artifact.environment.viewport.width,
        {
          integer: true,
          minimum: 0,
          exclusiveMinimum: true,
        },
      );
      finite(
        `${label}.environment.viewport.height`,
        artifact.environment.viewport.height,
        {
          integer: true,
          minimum: 0,
          exclusiveMinimum: true,
        },
      );
    }
    finite(
      `${label}.environment.devicePixelRatio`,
      artifact.environment.devicePixelRatio,
      {
        minimum: 0,
        exclusiveMinimum: true,
      },
    );
  }

  const medians = artifact.medians;
  check(`${label}.medians is object`, isObject(medians), {
    actualType: typeof medians,
  });
  if (isObject(medians)) {
    for (const timingKey of TIMING_KEYS) {
      finite(`${label}.medians.${timingKey}`, medians[timingKey], {
        minimum: 0,
        exclusiveMinimum: true,
      });
    }
    validateProfiler(`${label}.medians.profiler`, medians.profiler);
  }

  check(
    `${label} samples length equals runs`,
    Array.isArray(artifact.samples) && artifact.samples.length === RUNS,
    {
      sampleCount: Array.isArray(artifact.samples)
        ? artifact.samples.length
        : null,
      runs: artifact.runs,
    },
  );
  if (Array.isArray(artifact.samples)) {
    artifact.samples.forEach((sample, index) => {
      const sampleLabel = `${label}.samples[${index}]`;
      check(`${sampleLabel} is object`, isObject(sample), {
        actualType: typeof sample,
      });
      if (!isObject(sample)) return;
      for (const timingKey of TIMING_KEYS) {
        finite(`${sampleLabel}.${timingKey}`, sample[timingKey], {
          minimum: 0,
          exclusiveMinimum: true,
        });
      }
      validateProfiler(`${sampleLabel}.profiler`, sample.profiler);
      validateBucketRaster(`${sampleLabel}.bucketRaster`, sample.bucketRaster);
      exact(
        `${sampleLabel}.bucketRaster fixture`,
        sample.bucketRaster,
        EXPECTED_FIXTURE.bucketRaster,
      );
      validateBucketOutcome(
        `${sampleLabel}.bucketOutcome`,
        sample.bucketOutcome,
      );
      validateNavOutcome(`${sampleLabel}.navOutcome`, sample.navOutcome);
      validateZoomOutcome(`${sampleLabel}.zoomOutcome`, sample.zoomOutcome);
      validateBucketTransportQuiescence(
        `${sampleLabel}.bucketTransportQuiescence`,
        sample.bucketTransportQuiescence,
      );
    });

    if (artifact.samples.length === RUNS && isObject(medians)) {
      for (const timingKey of TIMING_KEYS) {
        const values = artifact.samples.map((sample) => sample?.[timingKey]);
        if (
          values.every(
            (value) => typeof value === "number" && Number.isFinite(value),
          )
        ) {
          exact(
            `${label} recomputed median ${timingKey}`,
            medians[timingKey],
            median(values),
          );
        }
      }
      for (const scenario of PROFILER_SCENARIOS) {
        for (const target of PROFILER_TARGETS) {
          for (const field of PROFILER_FIELDS) {
            const values = artifact.samples.map(
              (sample) => sample?.profiler?.[scenario]?.[target]?.[field],
            );
            if (
              values.every(
                (value) => typeof value === "number" && Number.isFinite(value),
              )
            ) {
              exact(
                `${label} recomputed Profiler median ${scenario}.${target}.${field}`,
                medians?.profiler?.[scenario]?.[target]?.[field],
                median(values),
              );
            }
          }
        }
      }
    }
  }
  validateIntegrity(label, artifact);
}

for (const leg of legs) validateArtifact(leg);

check(
  "four distinct immutable retained artifact paths",
  new Set(legs.map((leg) => leg.path)).size === 4,
  legs.map((leg) => leg.path),
);
check(
  "four retained artifacts have distinct immutable byte identities",
  new Set(legs.map((leg) => leg.artifactSha256)).size === 4,
  Object.fromEntries(legs.map((leg) => [leg.key, leg.artifactSha256])),
);
const collectionTimestamps = legs.map((leg) => Date.parse(leg.artifact?.date));
check(
  "retained artifact timestamps follow pre1 -> post1 -> post2 -> pre2",
  collectionTimestamps.every(Number.isFinite) &&
    collectionTimestamps.every(
      (timestamp, index) =>
        index === 0 || timestamp > collectionTimestamps[index - 1],
    ),
  Object.fromEntries(legs.map((leg) => [leg.key, leg.artifact?.date])),
);
check(
  "verdict output does not overwrite a retained artifact",
  !legs.some((leg) => leg.path === resolve(args.out)),
  resolve(args.out),
);

equalAcross(
  "all legs exact schemaVersion",
  (artifact) => artifact.schemaVersion,
);
equalAcross(
  "all legs exact protocolVersion",
  (artifact) => artifact.protocolVersion,
);
equalAcross(
  "all legs exact validationGate",
  (artifact) => artifact.validationGate,
);
equalAcross("all legs runs", (artifact) => artifact.runs);
equalAcross("all legs smoke flag", (artifact) => artifact.smoke);
equalAcross("all legs mode", (artifact) => artifact.mode);
equalAcross(
  "all legs threshold contract",
  (artifact) => artifact.thresholdContract,
);
equalAcross("all legs fixture inputs", (artifact) => artifact.fixture);
equalAcross("all legs environment", (artifact) => artifact.environment);
equalAcross(
  "all legs common future harnessSha",
  (artifact) => artifact.harnessSha,
);
equalAcross(
  "all legs same-origin private-gateway browser boundary",
  (artifact) => artifact.transportBoundary?.browserBoundary,
);
equalAcross(
  "all legs private-gateway missing-underlay treatment",
  (artifact) => artifact.transportBoundary?.missingUnderlayTreatment,
);
for (const [field] of HARNESS_HASH_FIELDS) {
  equalAcross(
    `all legs harness.${field}`,
    (artifact) => artifact.harness?.[field],
  );
}
for (const field of [
  "schemaVersion",
  "scriptVersion",
  "overlayProtocolSha256",
  "probeSha256",
]) {
  equalAcross(
    `all legs instrumentation.${field}`,
    (artifact) => artifact.harness?.instrumentation?.[field],
  );
}
exact(
  "baseline instrumentation stable across pre1/pre2",
  byKey.pre1.artifact?.harness?.instrumentation,
  byKey.pre2.artifact?.harness?.instrumentation,
);
exact(
  "candidate instrumentation stable across post1/post2",
  byKey.post1.artifact?.harness?.instrumentation,
  byKey.post2.artifact?.harness?.instrumentation,
);
exact(
  "baseline exact app worktree stable across pre1/pre2",
  byKey.pre1.artifact?.harness?.exactAppWorktree,
  byKey.pre2.artifact?.harness?.exactAppWorktree,
);
exact(
  "candidate exact app worktree stable across post1/post2",
  byKey.post1.artifact?.harness?.exactAppWorktree,
  byKey.post2.artifact?.harness?.exactAppWorktree,
);
check(
  "both direct-parent roles use the same-origin private gateway",
  legs.every(
    (leg) =>
      leg.artifact?.transportBoundary?.browserBoundary ===
        "same-origin-private-gateway" &&
      leg.artifact?.transportBoundary?.sourceExact === true &&
      leg.artifact?.transportBoundary?.securityEvidence === false &&
      leg.artifact?.transportBoundary?.rationale === TRANSPORT_RATIONALE,
  ),
  Object.fromEntries(
    legs.map((leg) => [leg.key, leg.artifact?.transportBoundary]),
  ),
);

const harnessSha = byKey.pre1.artifact?.harnessSha;
let harnessCommitExists = false;
if (SHA1_PATTERN.test(harnessSha)) {
  try {
    execFileSync(
      "git",
      ["-C", scriptRoot, "cat-file", "-e", `${harnessSha}^{commit}`],
      { stdio: "ignore" },
    );
    harnessCommitExists = true;
  } catch {
    // Reported by the check below.
  }
}
check(
  "common harnessSha names an actual local commit",
  harnessCommitExists,
  harnessSha,
);
if (harnessCommitExists) {
  for (const [field, path] of HARNESS_HASH_FIELDS) {
    let committedSha256 = null;
    try {
      committedSha256 = sha256(
        execFileSync(
          "git",
          ["-C", scriptRoot, "show", `${harnessSha}:${path}`],
          { encoding: "buffer", maxBuffer: 128 * 1024 * 1024 },
        ),
      );
    } catch {
      // Missing harness blobs fail the identity check below.
    }
    check(
      `harnessSha committed ${path} matches artifact hash`,
      committedSha256 !== null &&
        committedSha256 === byKey.pre1.artifact?.harness?.[field],
      {
        committedSha256,
        artifactSha256: byKey.pre1.artifact?.harness?.[field],
      },
    );
  }
}

for (const sourceSha of [BASELINE_SOURCE_SHA, CANDIDATE_SOURCE_SHA]) {
  let exists = false;
  try {
    execFileSync(
      "git",
      ["-C", scriptRoot, "cat-file", "-e", `${sourceSha}^{commit}`],
      { stdio: "ignore" },
    );
    exists = true;
  } catch {
    // Reported by the check below.
  }
  check(`source commit exists ${sourceSha}`, exists, sourceSha);
}
let candidateDirectParent = null;
try {
  candidateDirectParent = execFileSync(
    "git",
    ["-C", scriptRoot, "rev-parse", `${CANDIDATE_SOURCE_SHA}^`],
    { encoding: "utf8" },
  ).trim();
} catch {
  // Source-existence checks report missing/malformed commits.
}
check(
  "candidate is an exact direct child of the fixed baseline",
  candidateDirectParent === BASELINE_SOURCE_SHA,
  { expectedParent: BASELINE_SOURCE_SHA, actualParent: candidateDirectParent },
);

for (const leg of legs) {
  const integrity = leg.artifact?.integrity ?? {};
  check(
    `${leg.key} zero page errors`,
    Array.isArray(integrity.pageErrors) && integrity.pageErrors.length === 0,
    integrity.pageErrors,
  );
  check(
    `${leg.key} zero unexpected request failures`,
    Array.isArray(integrity.unexpectedRequestFailures) &&
      integrity.unexpectedRequestFailures.length === 0,
    integrity.unexpectedRequestFailures,
  );
  check(
    `${leg.key} zero 429`,
    Array.isArray(integrity.http429) && integrity.http429.length === 0,
    integrity.http429,
  );
  check(
    `${leg.key} non-vacuous private-gateway-only missing-underlay witness`,
    Array.isArray(integrity.missingUnderlayRequests) &&
      integrity.missingUnderlayRequests.length > 0 &&
      integrity.missingUnderlayRequests.every(
        validPrivateMissingUnderlayRequest,
      ) &&
      integrity.missingUnderlay404s ===
        integrity.missingUnderlayRequests.length &&
      deepEqual(
        [
          ...new Set(
            integrity.missingUnderlayRequests.map((request) => request.family),
          ),
        ].sort(),
        ["private-gateway-page-underlay", "private-gateway-thumbnail"],
      ),
    integrity.missingUnderlayRequests,
  );
  check(
    `${leg.key} non-vacuous polygon persistence integrity`,
    Number.isInteger(integrity.annotationPosts) &&
      integrity.annotationPosts >= RUNS &&
      Array.isArray(integrity.polygonPostVertexCounts) &&
      integrity.polygonPostVertexCounts.length === RUNS &&
      integrity.polygonPostVertexCounts.every((count) => count === 20),
    {
      annotationPosts: integrity.annotationPosts,
      polygonPostVertexCounts: integrity.polygonPostVertexCounts,
    },
  );
  exact(
    `${leg.key} zero bucket server fallback`,
    integrity.bucketServerFallbacks,
    0,
  );
  exact(`${leg.key} served-SHA handshake`, integrity.servedShas, [
    leg.sourceSha,
  ]);
}

const candidateQuiescenceDiagnostics = [];
for (const leg of [byKey.post1, byKey.post2]) {
  const samples = Array.isArray(leg.artifact?.samples)
    ? leg.artifact.samples
    : [];
  samples.forEach((sample, sampleIndex) => {
    for (const phaseName of QUIESCENCE_PHASES) {
      const label = `${leg.key}.samples[${sampleIndex}].bucketTransportQuiescence.${phaseName}`;
      const phase = sample?.bucketTransportQuiescence?.[phaseName];
      gateCandidateQuiescence(label, phase);
      candidateQuiescenceDiagnostics.push({
        leg: leg.key,
        sampleIndex,
        phase: phaseName,
        values: candidatePhaseQuiescenceValues(phase),
      });
    }
  });
}
check(
  "all six candidate samples have warm and timed quiescence diagnostics",
  candidateQuiescenceDiagnostics.length === RUNS * 2 * QUIESCENCE_PHASES.length,
  {
    candidateSamples:
      candidateQuiescenceDiagnostics.length / QUIESCENCE_PHASES.length,
    phaseDiagnostics: candidateQuiescenceDiagnostics.length,
  },
);

function bucketPairDiagnostics(baselineLeg, candidateLeg) {
  const baseline = isObject(baselineLeg.artifact) ? baselineLeg.artifact : {};
  const candidate = isObject(candidateLeg.artifact)
    ? candidateLeg.artifact
    : {};
  const baselineBucket = baseline.medians?.bucket4000Ms;
  const candidateBucket = candidate.medians?.bucket4000Ms;
  const validTiming =
    typeof baselineBucket === "number" &&
    Number.isFinite(baselineBucket) &&
    baselineBucket > 0 &&
    typeof candidateBucket === "number" &&
    Number.isFinite(candidateBucket);
  const profiler = {};
  for (const target of PROFILER_TARGETS) {
    const baselineCommits =
      baseline.medians?.profiler?.bucket4000?.[target]?.commits;
    const candidateCommits =
      candidate.medians?.profiler?.bucket4000?.[target]?.commits;
    profiler[target] = {
      baselineCommits,
      candidateCommits,
      pass:
        Number.isFinite(baselineCommits) &&
        Number.isFinite(candidateCommits) &&
        candidateCommits <= baselineCommits,
    };
  }
  return {
    baselineLeg: baselineLeg.key,
    candidateLeg: candidateLeg.key,
    bucket4000Timing: {
      baseline: baselineBucket,
      candidate: candidateBucket,
      ratio: validTiming
        ? +(candidateBucket / baselineBucket).toFixed(4)
        : null,
      ratioCeilingExclusive: 1.6,
      ratioPass: validTiming && candidateBucket < baselineBucket * 1.6,
      candidateCeilingMsExclusive: 400,
      candidateCeilingPass: validTiming && candidateBucket < 400,
    },
    bucket4000ProfilerCommits: profiler,
    explicitlyNotGated: {
      polygon20Ms: true,
      polygonRafP95Ms: true,
      polygon20Profiler: true,
    },
  };
}

const firstForwardPair = bucketPairDiagnostics(byKey.pre1, byKey.post1);
const warmedReversePair = bucketPairDiagnostics(byKey.pre2, byKey.post2);
check(
  "warmed reverse Bucket timing candidate/baseline <1.6",
  warmedReversePair.bucket4000Timing.ratioPass,
  warmedReversePair.bucket4000Timing,
);
check(
  "warmed reverse candidate Bucket <400ms",
  warmedReversePair.bucket4000Timing.candidateCeilingPass,
  warmedReversePair.bucket4000Timing,
);
for (const [target, result] of Object.entries(
  warmedReversePair.bucket4000ProfilerCommits,
)) {
  check(
    `warmed reverse Bucket Profiler ${target} candidate<=baseline`,
    result.pass,
    result,
  );
}
exact(
  "polygon timing is explicitly non-gated",
  EXPECTED_THRESHOLD_CONTRACT.polygonTimingGated,
  false,
);
exact(
  "polygon rAF is explicitly non-gated",
  EXPECTED_THRESHOLD_CONTRACT.polygonRafGated,
  false,
);
exact(
  "only bucket4000 timing is gated",
  EXPECTED_THRESHOLD_CONTRACT.timingGateScenarios,
  ["bucket4000"],
);
exact(
  "only bucket4000 Profiler commits are gated",
  EXPECTED_THRESHOLD_CONTRACT.profilerCommitGateScenarios,
  ["bucket4000"],
);

const pass = checks.every((entry) => entry.pass);
const verdict = {
  schemaVersion: VERDICT_SCHEMA_VERSION,
  protocolVersion: PROTOCOL_VERSION,
  validationGate: VALIDATION_GATE,
  generatedAt: new Date().toISOString(),
  collectionOrder: legDefinitions.map((leg) => leg.key),
  baselineSourceSha: BASELINE_SOURCE_SHA,
  candidateSourceSha: CANDIDATE_SOURCE_SHA,
  harnessSha,
  thresholdContract: EXPECTED_THRESHOLD_CONTRACT,
  retainedLegs: legs.map((leg) => ({
    leg: leg.key,
    role: leg.role,
    path: leg.path,
    artifactSha256: leg.artifactSha256,
    sourceSha: leg.artifact?.sourceSha,
    harnessSha: leg.artifact?.harnessSha,
    runs: leg.artifact?.runs,
    transportBoundary: leg.artifact?.transportBoundary,
    sampleCount: Array.isArray(leg.artifact?.samples)
      ? leg.artifact.samples.length
      : null,
    medians: leg.artifact?.medians,
  })),
  pairDiagnostics: {
    firstForward: firstForwardPair,
    warmedReverse: warmedReversePair,
    gatedPair: "warmedReverse",
    timingAndProfilerGate: "bucket4000-only",
  },
  candidateQuiescenceDiagnostics,
  checks,
  pass,
};
writeFileSync(resolve(args.out), `${JSON.stringify(verdict, null, 2)}\n`, {
  flag: "wx",
});
console.log(
  JSON.stringify(
    {
      pass,
      retainedLegs: verdict.retainedLegs.map(
        ({ leg, sourceSha, artifactSha256 }) => ({
          leg,
          sourceSha,
          artifactSha256,
        }),
      ),
      gatedPair: warmedReversePair,
      candidateQuiescenceSamples:
        candidateQuiescenceDiagnostics.length / QUIESCENCE_PHASES.length,
      failedChecks: checks
        .filter((entry) => !entry.pass)
        .map((entry) => entry.name),
    },
    null,
    2,
  ),
);
if (!pass) process.exitCode = 1;
