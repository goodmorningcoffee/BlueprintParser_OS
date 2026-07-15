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
