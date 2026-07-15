import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  SYNTHETIC_PDF_GENERATOR_RELATIVE_PATH,
  SYNTHETIC_PDF_RELATIVE_PATH,
  ensureSyntheticPdfFixture,
} from "../../e2e/ensure-synthetic-pdf.mjs";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function source(path) {
  return readFileSync(resolve(repositoryRoot, path), "utf8");
}

function gitText(args) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
}

test("synthetic PDF preflight generates a missing or empty fixture exactly once", (context) => {
  const root = mkdtempSync(join(tmpdir(), "bp-e2e-pdf-preflight-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const fixturePath = resolve(root, SYNTHETIC_PDF_RELATIVE_PATH);
  mkdirSync(dirname(fixturePath), { recursive: true });
  writeFileSync(fixturePath, "");

  const calls = [];
  const execute = (executable, args, options) => {
    calls.push({ executable, args, options });
    writeFileSync(fixturePath, "synthetic-pdf");
  };

  assert.equal(
    ensureSyntheticPdfFixture({ repositoryRoot: root, execute }),
    fixturePath,
  );
  assert.deepEqual(calls, [
    {
      executable: process.execPath,
      args: [
        resolve(root, SYNTHETIC_PDF_GENERATOR_RELATIVE_PATH),
        "--out",
        fixturePath,
      ],
      options: { cwd: root, stdio: "inherit" },
    },
  ]);

  assert.equal(
    ensureSyntheticPdfFixture({
      repositoryRoot: root,
      execute: () => assert.fail("usable fixture must not regenerate"),
    }),
    fixturePath,
  );
});

test("synthetic PDF preflight fails closed when the generator produces no fixture", (context) => {
  const root = mkdtempSync(join(tmpdir(), "bp-e2e-pdf-preflight-fail-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(
    () =>
      ensureSyntheticPdfFixture({
        repositoryRoot: root,
        execute: () => {},
      }),
    /completed without creating a non-empty fixture/u,
  );
});

test("Playwright global setup preserves the ESM fixture-helper boundary", () => {
  const setup = source("e2e/global-setup.ts");
  assert.doesNotMatch(
    setup,
    /^import\s+\{\s*ensureSyntheticPdfFixture\s*\}\s+from\s+"\.\/ensure-synthetic-pdf\.mjs";/mu,
  );
  const dynamicImport = setup.search(
    /const\s+\{\s*ensureSyntheticPdfFixture\s*\}\s*=\s*await\s+import\(\s*"\.\/ensure-synthetic-pdf\.mjs"\s*\)/u,
  );
  const ensureCall = setup.indexOf(
    "ensureSyntheticPdfFixture();",
    dynamicImport,
  );
  assert.notEqual(dynamicImport, -1);
  assert.ok(
    ensureCall > dynamicImport,
    "fixture preflight must run only after Node owns the literal .mjs import",
  );
});

test("global setup pins owner authority and reseeds the private project atomically", () => {
  const setup = source("e2e/global-setup.ts");
  const ownerStart = setup.indexOf("const user = await pool.query");
  const ownerEnd = setup.indexOf("const outsiderCompany", ownerStart);
  assert.notEqual(ownerStart, -1);
  assert.notEqual(ownerEnd, -1);
  const ownerSeed = setup.slice(ownerStart, ownerEnd);
  for (const fragment of [
    "username = excluded.username",
    "company_id = excluded.company_id",
    "role = 'member'",
    "can_run_models = false",
    "is_root_admin = false",
  ]) {
    assert.match(ownerSeed, new RegExp(fragment, "u"));
  }

  const privateStart = setup.indexOf(
    "const projectClient = await pool.connect()",
  );
  const privateEnd = setup.indexOf(
    "const demoClient = await pool.connect()",
    privateStart,
  );
  assert.notEqual(privateStart, -1);
  assert.notEqual(privateEnd, -1);
  const privateSeed = setup.slice(privateStart, privateEnd);
  const orderedFragments = [
    'projectClient.query("BEGIN")',
    "ON CONFLICT (data_url) DO NOTHING",
    "FOR UPDATE",
    "SET is_demo = false",
    "lifecycle_epoch = lifecycle_epoch + 1",
    "DELETE FROM project_mutation_leases WHERE project_id = $1",
    "DELETE FROM annotations WHERE project_id = $1",
    "DELETE FROM takeoff_items WHERE project_id = $1",
    "DELETE FROM pages WHERE project_id = $1",
    'projectClient.query("COMMIT")',
  ];
  let cursor = -1;
  for (const fragment of orderedFragments) {
    const next = privateSeed.indexOf(fragment, cursor + 1);
    assert.ok(
      next > cursor,
      `private seed transaction must contain ${fragment} in order`,
    );
    cursor = next;
  }
  assert.match(privateSeed, /projectClient\.query\("ROLLBACK"\)/u);
});

test("perf-v2 provenance hashes every retained server preflight", () => {
  const spec = source("e2e/viewer-perf-v2.spec.ts");
  const comparator = source("scripts/compare-viewer-perf-v2.mjs");
  for (const [field, path] of [
    ["fixturePreflightSha256", "e2e/ensure-synthetic-pdf.mjs"],
    ["startDevServerSha256", "e2e/start-dev-server.mjs"],
  ]) {
    assert.match(spec, new RegExp(`${field}: sha256File\\(`, "u"));
    assert.match(
      comparator,
      new RegExp(`\\["${field}", "${path.replaceAll(".", "\\.")}"\\]`, "u"),
    );
  }
  for (const configPath of [
    "playwright.config.ts",
    "playwright.perf-v2.config.ts",
    "playwright.annotation-owner-perf-v2.config.ts",
  ]) {
    const config = source(configPath);
    assert.match(config, /command: "node e2e\/cdn-stub\.mjs"/u);
    assert.match(
      config,
      /port: 9876,[\s\S]*?reuseExistingServer: false,[\s\S]*?timeout: 120_000,/u,
    );
  }
});

test("perf-v2 records symmetric old/new missing-underlay request families", () => {
  const spec = source("e2e/viewer-perf-v2.spec.ts");
  const comparator = source("scripts/compare-viewer-perf-v2.mjs");
  const families = [
    "legacy-thumbnail-proxy",
    "direct-cdn-page-underlay",
    "private-gateway-page-underlay",
    "private-gateway-thumbnail",
  ];
  for (const family of families) {
    assert.ok(spec.includes(`"${family}"`), `spec must record ${family}`);
    assert.ok(
      comparator.includes(`"${family}"`),
      `comparator must validate ${family}`,
    );
  }
  assert.ok(spec.includes("missingUnderlayRequests"));
  assert.ok(comparator.includes("expectedMissingUnderlayFamilies(role)"));
  assert.ok(
    comparator.includes(
      "candidateProfilerCommitsMustNotExceedBaselineForGatedScenarios",
    ),
  );
  assert.ok(
    comparator.includes("9edc329d1441c30924a7aa9d92f8fb3d16050698"),
    "the fixed baseline must be the candidate's exact parent",
  );
  assert.ok(
    comparator.includes("85522add9283c51c784266c744e1065c3662cddf"),
    "the comparator must pin the private-gateway candidate",
  );
  assert.ok(
    comparator.includes("candidateDirectParent === BASELINE_SOURCE_SHA"),
    "the comparator must fail closed on a non-direct-parent cohort",
  );
});

test("perf-v2 missing-underlay interception is source-compatible with the exact direct-parent cohort", (context) => {
  const baseline = "9edc329d1441c30924a7aa9d92f8fb3d16050698";
  const candidate = "85522add9283c51c784266c744e1065c3662cddf";
  try {
    gitText(["cat-file", "-e", `${baseline}^{commit}`]);
    gitText(["cat-file", "-e", `${candidate}^{commit}`]);
  } catch {
    context.skip("exact perf source history is unavailable in this checkout");
    return;
  }
  assert.equal(gitText(["rev-parse", `${candidate}^`]), baseline);

  const baselineSidebar = gitText([
    "show",
    `${baseline}:src/components/viewer/PageSidebar.tsx`,
  ]);
  const baselinePage = gitText([
    "show",
    `${baseline}:src/components/viewer/PDFPage.tsx`,
  ]);
  assert.ok(
    baselineSidebar.includes("`/api/projects/${publicId}/thumbnail/${page}`"),
  );
  assert.ok(
    baselinePage.includes(
      "`https://${cloudfront}/${dataUrl}/pages/page_${pageKey}.png`",
    ),
  );

  const candidateSidebar = gitText([
    "show",
    `${candidate}:src/components/viewer/PageSidebar.tsx`,
  ]);
  const candidatePage = gitText([
    "show",
    `${candidate}:src/components/viewer/PDFPage.tsx`,
  ]);
  assert.ok(
    candidateSidebar.includes(
      '`${assetBaseUrl}/thumbnails/page_${String(page).padStart(4, "0")}.png`',
    ),
  );
  assert.ok(
    candidatePage.includes("`${assetBaseUrl}/pages/page_${pageKey}.png`"),
  );
});

test("private-gateway Bucket quiescence mode brackets transport outside both workers and persists the full witness", () => {
  const spec = source("e2e/viewer-perf-v2.spec.ts");
  const sliceBetween = (startMarker, endMarker) => {
    const start = spec.indexOf(startMarker);
    const end = spec.indexOf(endMarker, start + startMarker.length);
    assert.notEqual(start, -1, `spec must contain ${startMarker}`);
    assert.notEqual(
      end,
      -1,
      `spec must contain ${endMarker} after ${startMarker}`,
    );
    return spec.slice(start, end);
  };
  const assertOrdered = (text, fragments, label) => {
    let cursor = -1;
    for (const fragment of fragments) {
      const next = text.indexOf(fragment, cursor + 1);
      assert.ok(next > cursor, `${label} must contain ${fragment} in order`);
      cursor = next;
    }
  };

  for (const fragment of [
    'const PRIVATE_GATEWAY_BUCKET_QUIESCENCE_GATE =\n  "private-gateway-bucket-quiescence-v1";',
    'const PRIVATE_GATEWAY_BUCKET_QUIESCENCE_SCHEMA_VERSION =\n  "bp-viewer-perf-v2.3.0-private-gateway-bucket-quiescence";',
    "const BUCKET_TRANSPORT_QUIET_MS = 100;",
    "const BUCKET_TRANSPORT_POLL_MS = 25;",
    "const BUCKET_TRANSPORT_STATS_TIMEOUT_MS = 30_000;",
    'process.env.PERF_VALIDATION_GATE || ""',
    "schemaVersion: EFFECTIVE_SCHEMA_VERSION",
    "protocolVersion: EFFECTIVE_PROTOCOL_VERSION",
    "? { validationGate: PERF_VALIDATION_GATE }",
    '? "scripts/compare-private-gateway-bucket-quiescence-v1.mjs"',
  ]) {
    assert.ok(
      spec.includes(fragment),
      `quiescence spec must retain ${fragment}`,
    );
  }

  const gateAllowlist = spec.indexOf(
    '["", PRIVATE_GATEWAY_BUCKET_QUIESCENCE_GATE]',
  );
  const gateAllowlistAssertion = spec.indexOf(
    ".toContain(PERF_VALIDATION_GATE)",
    gateAllowlist,
  );
  const worktreeValidation = spec.indexOf(
    "const worktree = validateInstrumentedWorktree()",
  );
  assert.ok(gateAllowlist >= 0);
  assert.ok(gateAllowlistAssertion > gateAllowlist);
  assert.ok(
    worktreeValidation > gateAllowlistAssertion,
    "unknown nonempty validation gates must fail before worktree validation or sampling",
  );
  assert.match(
    spec,
    /const EFFECTIVE_SCHEMA_VERSION = IS_PRIVATE_GATEWAY_BUCKET_QUIESCENCE_GATE\s*\? PRIVATE_GATEWAY_BUCKET_QUIESCENCE_SCHEMA_VERSION\s*: SCHEMA_VERSION;/u,
  );
  assert.match(
    spec,
    /const EFFECTIVE_PROTOCOL_VERSION = IS_PRIVATE_GATEWAY_BUCKET_QUIESCENCE_GATE\s*\? PRIVATE_GATEWAY_BUCKET_QUIESCENCE_GATE\s*: PROTOCOL_VERSION;/u,
  );

  const browserSnapshot = sliceBetween(
    "type BrowserPdfTransportSnapshot = {",
    "type UpstreamTransportSnapshot = {",
  );
  for (const field of [
    "observedAtEpochMs",
    "requestGeneration",
    "lifecycleGeneration",
    "activeCount",
  ]) {
    assert.ok(browserSnapshot.includes(`${field}: number;`));
  }
  const upstreamSnapshot = sliceBetween(
    "type UpstreamTransportSnapshot = {",
    "type TransportObservationWindow = {",
  );
  for (const field of [
    "requestGeneration",
    "lifecycleGeneration",
    "activeCount",
    "activeStreamCount",
  ]) {
    assert.ok(upstreamSnapshot.includes(`${field}: number;`));
  }
  const coherentObservation = sliceBetween(
    "type CoherentTransportObservation = {",
    "type BucketTransportQuietBarrier = {",
  );
  for (const field of [
    "observationWindow",
    "browserBefore",
    "upstream",
    "browserAfter",
    "browserBracketDeltas",
  ]) {
    assert.ok(coherentObservation.includes(`${field}:`));
  }
  const quietBarrier = sliceBetween(
    "type BucketTransportQuietBarrier = {",
    "type BucketTransportIntervalDeltas = {",
  );
  for (const fragment of [
    "requiredQuietMs: 100;",
    "pollIntervalMs: 25;",
    "browserPdfRequests: number;",
    "upstreamRequests: number;",
    "upstreamStreams: number;",
    "polls: number;",
    "stablePolls: number;",
    "stateChangeTransitions: number;",
    "observationWindow: TransportObservationWindow;",
    "pollObservations: CoherentTransportObservation[];",
  ]) {
    assert.ok(quietBarrier.includes(fragment));
  }
  const intervalDeltas = sliceBetween(
    "type BucketTransportIntervalDeltas = {",
    "type BucketTransportQuiescencePhase = {",
  );
  for (const field of [
    "browserRequestGeneration",
    "browserLifecycleGeneration",
    "upstreamRequestGeneration",
    "upstreamLifecycleGeneration",
  ]) {
    assert.ok(intervalDeltas.includes(`${field}: number;`));
  }
  const phaseWitness = sliceBetween(
    "type BucketTransportQuiescencePhase = {",
    "type BucketTransportQuiescence = {",
  );
  for (const fragment of [
    "quietBarrier: BucketTransportQuietBarrier;",
    "before: CoherentTransportObservation;",
    "after: CoherentTransportObservation;",
    "intervalDeltas: BucketTransportIntervalDeltas;",
  ]) {
    assert.ok(phaseWitness.includes(fragment));
  }
  const twoPhases = sliceBetween(
    "type BucketTransportQuiescence = {",
    "type BrowserPdfTransportTracker = {",
  );
  assert.ok(twoPhases.includes("warm1000: BucketTransportQuiescencePhase;"));
  assert.ok(twoPhases.includes("timed4000: BucketTransportQuiescencePhase;"));

  const bucketMeasurement = sliceBetween(
    "async function measureBucket4000(page: Page)",
    "async function measurePolygon20(page: Page)",
  );
  assertOrdered(
    bucketMeasurement,
    [
      "const warmQuietBarrier",
      'observeBucketTransportQuietBarrier(page, "bucket warm1000")',
      "await installBucketRaster(pageCanvas, 1000, 667)",
      "await page.mouse.click(",
      "const warmAfter",
      "await captureCoherentTransportObservation(page)",
      "completeBucketTransportQuiescencePhase(",
    ],
    "warm worker quiescence witness",
  );
  const timedStart = bucketMeasurement.indexOf("const timedQuietBarrier");
  assert.ok(timedStart >= 0);
  const timedMeasurement = bucketMeasurement.slice(timedStart);
  assertOrdered(
    timedMeasurement,
    [
      "const timedQuietBarrier",
      'observeBucketTransportQuietBarrier(page, "bucket timed4000")',
      "const raster = await installBucketRaster(pageCanvas, 4000, 2667)",
      'await resetProfiler(page, "bucket4000")',
      "await startFrameSampler(page)",
      "await page.mouse.click(",
      "const settlement = await page.evaluate",
      "const gaps = await stopFrameSampler(page)",
      "const timedAfter",
      "await captureCoherentTransportObservation(page)",
      "completeBucketTransportQuiescencePhase(",
      "const profiler = await profilerSnapshot(page)",
    ],
    "timed worker quiescence witness",
  );
  assert.ok(
    bucketMeasurement.includes(
      "bucketTransportQuiescence: { warm1000, timed4000 }",
    ),
  );

  assert.match(
    spec,
    /IS_PRIVATE_GATEWAY_BUCKET_QUIESCENCE_GATE\s*\? \(\[\s*"private-gateway-page-underlay",\s*"private-gateway-thumbnail",\s*\] satisfies MissingUnderlayFamily\[\]\)\s*: expectedMissingUnderlayFamilies;/u,
  );
  assert.match(
    spec,
    /IS_PRIVATE_GATEWAY_BUCKET_QUIESCENCE_GATE\s*\? "same-origin-private-gateway"\s*: expectedTransportBoundary;/u,
  );
  for (const fragment of [
    'timingGateScenarios: ["bucket4000"]',
    'profilerCommitGateScenarios: ["bucket4000"]',
    "polygonTimingGated: false",
    "polygonRafGated: false",
    "activeCountsMustBeZero: true",
    "generationDeltasMustBeZero: true",
    "bucketTransportQuiescence: samples.map(",
    "(sample) => sample.bucketTransportQuiescence!",
  ]) {
    assert.ok(
      spec.includes(fragment),
      `quiescence artifact must retain ${fragment}`,
    );
  }
});

test("private-gateway Bucket quiescence comparator pins the new pair without weakening the historical comparator", () => {
  const historical = source("scripts/compare-viewer-perf-v2.mjs");
  const comparator = source(
    "scripts/compare-private-gateway-bucket-quiescence-v1.mjs",
  );
  const sliceBetween = (text, startMarker, endMarker) => {
    const start = text.indexOf(startMarker);
    const end = text.indexOf(endMarker, start + startMarker.length);
    assert.notEqual(start, -1, `comparator must contain ${startMarker}`);
    assert.notEqual(end, -1, `comparator must contain ${endMarker}`);
    return text.slice(start, end);
  };

  for (const [name, sha] of [
    ["BASELINE_SOURCE_SHA", "9edc329d1441c30924a7aa9d92f8fb3d16050698"],
    ["CANDIDATE_SOURCE_SHA", "85522add9283c51c784266c744e1065c3662cddf"],
  ]) {
    assert.ok(
      historical.includes(`const ${name} = "${sha}";`),
      `historical comparator must retain ${name}=${sha}`,
    );
  }
  assert.ok(
    historical.includes("candidateDirectParent === BASELINE_SOURCE_SHA"),
    "historical comparator must retain its original direct-parent gate",
  );

  for (const fragment of [
    '"bp-viewer-perf-v2.3.0-private-gateway-bucket-quiescence"',
    'const PROTOCOL_VERSION = "private-gateway-bucket-quiescence-v1";',
    'const VALIDATION_GATE = "private-gateway-bucket-quiescence-v1";',
    'const BASELINE_SOURCE_SHA = "d0500f79940e3083d6bd727233d143d9058c80c5";',
    'const CANDIDATE_SOURCE_SHA = "0e990e30631fd840b4146c8a6ab2739a2af2756c";',
    'const QUIESCENCE_PHASES = ["warm1000", "timed4000"]',
    "requiredQuietMs: 100",
    "pollIntervalMs: 25",
    "stablePolls: 5",
    "window.elapsedMs < 30_000",
    'timingGateScenarios: ["bucket4000"]',
    'profilerCommitGateScenarios: ["bucket4000"]',
    "polygonTimingGated: false",
    "polygonRafGated: false",
  ]) {
    assert.ok(
      comparator.includes(fragment),
      `quiescence comparator must retain ${fragment}`,
    );
  }
  assert.match(
    comparator,
    /\{ key: "pre1", role: "baseline", sourceSha: BASELINE_SOURCE_SHA \},\s*\{ key: "post1", role: "candidate", sourceSha: CANDIDATE_SOURCE_SHA \},\s*\{ key: "post2", role: "candidate", sourceSha: CANDIDATE_SOURCE_SHA \},\s*\{ key: "pre2", role: "baseline", sourceSha: BASELINE_SOURCE_SHA \}/u,
  );
  assert.match(
    comparator,
    /\["-C", scriptRoot, "rev-parse", `\$\{CANDIDATE_SOURCE_SHA\}\^`\][\s\S]*?candidateDirectParent === BASELINE_SOURCE_SHA/u,
  );

  const bracketValidation = sliceBetween(
    comparator,
    "function validateBrowserSnapshot",
    "function activeVector",
  );
  for (const fragment of [
    '"observedAtEpochMs"',
    '"requestGeneration"',
    '"lifecycleGeneration"',
    '"activeCount"',
    '"activeStreamCount"',
    '"observationWindow"',
    '"browserBefore"',
    '"upstream"',
    '"browserAfter"',
    '"browserBracketDeltas"',
  ]) {
    assert.ok(bracketValidation.includes(fragment));
  }
  const barrierValidation = sliceBetween(
    comparator,
    "function validateQuietBarrier",
    "function validateQuiescencePhase",
  );
  for (const fragment of [
    '"initialActive"',
    '"browserPdfRequests"',
    '"upstreamRequests"',
    '"upstreamStreams"',
    '"polls"',
    '"stablePolls"',
    '"stateChangeTransitions"',
    '"observationWindow"',
    '"stableObservationWindow"',
    '"pollObservations"',
    "observation?.browserBefore?.activeCount",
    "observation?.upstream?.activeCount",
    "observation?.upstream?.activeStreamCount",
    "observation?.browserAfter?.activeCount",
  ]) {
    assert.ok(
      barrierValidation.includes(fragment),
      `quiet barrier validator must retain ${fragment}`,
    );
  }
  const phaseValidation = sliceBetween(
    comparator,
    "function validateQuiescencePhase",
    "function validPrivateMissingUnderlayRequest",
  );
  for (const fragment of [
    '"quietBarrier"',
    '"before"',
    '"after"',
    '"intervalDeltas"',
    '"browserRequestGeneration"',
    '"browserLifecycleGeneration"',
    '"upstreamRequestGeneration"',
    '"upstreamLifecycleGeneration"',
    "phase.before",
    "phase.after",
  ]) {
    assert.ok(
      phaseValidation.includes(fragment),
      `phase validator must retain ${fragment}`,
    );
  }
  const exactCandidateGate = sliceBetween(
    comparator,
    "function gateCandidateQuiescence",
    "function validPrivateMissingUnderlayRequest",
  );
  for (const fragment of [
    "values.quietBarrierInitialActive.browserPdfRequests === 0",
    "values.quietBarrierInitialActive.upstreamRequests === 0",
    "values.quietBarrierInitialActive.upstreamStreams === 0",
    "values.quietBarrierPolls === QUIET_BARRIER_CONTRACT.stablePolls",
    "values.quietBarrierStablePolls === QUIET_BARRIER_CONTRACT.stablePolls",
    "values.pollActiveCounts.length === QUIET_BARRIER_CONTRACT.stablePolls",
    "values.quietBarrierStateChangeTransitions",
    "values.pollActiveCounts.every(",
    "counts.every((count) => count === 0)",
    "values.pollCoherenceDiagnostics.length ===",
    "diagnostic.coherenceRetries === 0",
    "diagnostic.coherenceStateTransitions === 0",
    "values.beforeAfterActiveCounts.every(",
    "values.browserBracketDeltas.every(",
    "Object.values(values.intervalDeltas).every((delta) => delta === 0)",
  ]) {
    assert.ok(
      exactCandidateGate.includes(fragment),
      `exact candidate no-drain gate must retain ${fragment}`,
    );
  }
  assert.match(
    exactCandidateGate,
    /exact\([\s\S]*?zero quiet-barrier state-change transitions[\s\S]*?values\.quietBarrierStateChangeTransitions,\s*0,/u,
  );

  for (const fragment of [
    "integrity.bucketTransportQuiescence",
    "artifact.samples.map((sample) => sample?.bucketTransportQuiescence)",
    "all legs same-origin private-gateway browser boundary",
    "both direct-parent roles use the same-origin private gateway",
    '"private-gateway-page-underlay"',
    '"private-gateway-thumbnail"',
  ]) {
    assert.ok(
      comparator.includes(fragment),
      `comparator must retain ${fragment}`,
    );
  }

  const candidateWitnessGate = sliceBetween(
    comparator,
    "const candidateQuiescenceDiagnostics = []",
    "function bucketPairDiagnostics",
  );
  for (const fragment of [
    "for (const leg of [byKey.post1, byKey.post2])",
    "samples.forEach((sample, sampleIndex)",
    "for (const phaseName of QUIESCENCE_PHASES)",
    "gateCandidateQuiescence(label, phase)",
    "candidateQuiescenceDiagnostics.length ===",
    "RUNS * 2 * QUIESCENCE_PHASES.length",
  ]) {
    assert.ok(
      candidateWitnessGate.includes(fragment),
      `all-candidate witness gate must retain ${fragment}`,
    );
  }

  const pairDiagnostics = sliceBetween(
    comparator,
    "function bucketPairDiagnostics",
    "const pass = checks.every",
  );
  for (const fragment of [
    "baseline.medians?.bucket4000Ms",
    "candidate.medians?.bucket4000Ms",
    "baseline.medians?.profiler?.bucket4000",
    "candidate.medians?.profiler?.bucket4000",
    "const warmedReversePair = bucketPairDiagnostics(byKey.pre2, byKey.post2)",
    "warmedReversePair.bucket4000Timing.ratioPass",
    "warmedReversePair.bucket4000Timing.candidateCeilingPass",
    "warmedReversePair.bucket4000ProfilerCommits",
    "explicitlyNotGated",
    "polygon20Ms: true",
    "polygonRafP95Ms: true",
    "polygon20Profiler: true",
    '"only bucket4000 timing is gated"',
    '"only bucket4000 Profiler commits are gated"',
  ]) {
    assert.ok(
      pairDiagnostics.includes(fragment),
      `warmed Bucket-only gate must retain ${fragment}`,
    );
  }
  assert.doesNotMatch(pairDiagnostics, /candidate\.medians\?\.polygon/u);
  assert.doesNotMatch(pairDiagnostics, /baseline\.medians\?\.polygon/u);
});
