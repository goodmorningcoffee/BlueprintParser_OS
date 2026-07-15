// Make every E2E server entry point capable of bootstrapping the generated PDF.
// Playwright starts webServer processes before globalSetup, so the CDN stub
// cannot rely on globalSetup to create this ignored fixture on a fresh clone.
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SYNTHETIC_PDF_RELATIVE_PATH = "test/fixtures/synthetic-100pg.pdf";
export const SYNTHETIC_PDF_GENERATOR_RELATIVE_PATH =
  "scripts/make-synthetic-pdf.mjs";
export const E2E_REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

function isUsableFixture(path, fileExists, fileStat) {
  if (!fileExists(path)) return false;
  const stats = fileStat(path);
  return stats.isFile() && stats.size > 0;
}

export function ensureSyntheticPdfFixture({
  repositoryRoot = E2E_REPOSITORY_ROOT,
  fixtureRelativePath = SYNTHETIC_PDF_RELATIVE_PATH,
  generatorRelativePath = SYNTHETIC_PDF_GENERATOR_RELATIVE_PATH,
  execute = execFileSync,
  fileExists = existsSync,
  fileStat = statSync,
} = {}) {
  const fixturePath = resolve(repositoryRoot, fixtureRelativePath);
  if (isUsableFixture(fixturePath, fileExists, fileStat)) return fixturePath;

  const generatorPath = resolve(repositoryRoot, generatorRelativePath);
  console.log(`[e2e-fixture] generating ${fixtureRelativePath}…`);
  execute(process.execPath, [generatorPath, "--out", fixturePath], {
    cwd: repositoryRoot,
    stdio: "inherit",
  });

  if (!isUsableFixture(fixturePath, fileExists, fileStat)) {
    throw new Error(
      `synthetic PDF generator completed without creating a non-empty fixture: ${fixturePath}`,
    );
  }
  return fixturePath;
}
