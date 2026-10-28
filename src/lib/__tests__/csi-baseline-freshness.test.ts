/**
 * csi-baseline-freshness.test.ts — keeps the P0.1 corpus baseline honest.
 *
 * [csi-rebuild P0.2] `eval/csi/baseline-old-engine.json` records what the engine
 * emitted over all 471 corpus pages, and it records a sha256 of each file that
 * defines engine behavior. Without this test, nothing connects the two: someone
 * edits the scorer, the artifact silently stops describing the engine, and the
 * next person compares against a number that no longer means anything.
 *
 * THIS TEST IS DESIGNED TO FAIL when the engine changes. That is not a defect —
 * it is the same deliberate-failure contract as csi-company-db.test.ts's
 * six-field surface pin. When P2 changes the engine, recapture the baseline in
 * the SAME commit (README in eval/csi/ has the two commands) and this goes green
 * again with a new set of hashes.
 *
 * What it does NOT do: re-run the engine over the corpus. That needs the 48 MB
 * extracted NDJSON, which is not committed. This is the cheap guard that says
 * "the expensive artifact is or is not still valid".
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ARTIFACT = join(process.cwd(), "eval/csi/baseline-old-engine.json");

interface Baseline {
  schemaVersion: string;
  engineSha: Record<string, string>;
  summary: { pagesTotal: number; codesTotal: number; triggersTotal: number };
  pages: { bundle: string; page: number; codes: string[]; triggers: { t1: number; t2: number; t3: number } }[];
}

const sha256File = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

/**
 * [csi-v2 S6] Engine files that MOVED since the artifact was captured. The artifact keys its
 * hashes by path; the old engine was `git mv`ed byte-identical to `csi-detect-legacy.ts` (the
 * new `csi-detect.ts` is the v2 entry point, not the engine this artifact measured). Only the
 * PATH is retargeted — every recorded hash is compared exactly as captured.
 */
const MOVED: Record<string, string> = {
  "src/lib/csi-detect.ts": "src/lib/csi-detect-legacy.ts",
};
const currentPath = (recordedRel: string) => MOVED[recordedRel] ?? recordedRel;

describe("CSI corpus baseline artifact", () => {
  it("exists and is the schema this suite understands", () => {
    expect(existsSync(ARTIFACT), `missing ${ARTIFACT} — see eval/csi/README.md`).toBe(true);
    const b = JSON.parse(readFileSync(ARTIFACT, "utf-8")) as Baseline;
    expect(b.schemaVersion).toBe("csi-baseline/1");
    expect(Object.keys(b.engineSha).length).toBeGreaterThan(0);
  });

  it("still describes the CURRENT engine — every recorded engineSha matches the tree", () => {
    const b = JSON.parse(readFileSync(ARTIFACT, "utf-8")) as Baseline;

    const drifted: string[] = [];
    for (const [rel, recorded] of Object.entries(b.engineSha)) {
      const abs = join(process.cwd(), currentPath(rel));
      expect(existsSync(abs), `baseline references a file that no longer exists: ${currentPath(rel)}`).toBe(true);
      if (sha256File(abs) !== recorded) drifted.push(currentPath(rel));
    }

    expect(
      drifted,
      drifted.length === 0
        ? ""
        : `\n\nThe CSI corpus baseline is STALE — these engine files changed since it was captured:\n` +
          drifted.map(f => `  • ${f}`).join("\n") +
          `\n\nThat is expected if you meant to change engine behavior. Recapture in THIS commit:\n` +
          `  eval/csi/extract-corpus.sh <bundles-dir> <work>/corpus.ndjson\n` +
          `  npx esbuild eval/csi/capture.ts --bundle --platform=node --target=node24 \\\n` +
          `    --outfile=build/csi-capture.js --alias:@=./src --external:pg-native\n` +
          `  node build/csi-capture.js <work>/corpus.ndjson eval/csi/baseline-old-engine.json\n` +
          `\nSee eval/csi/README.md. Do not delete this test to make it pass.\n`,
    ).toEqual([]);
  });

  it("the moved old engine is still pinned: every MOVED target is a recorded file, under its new path", () => {
    const b = JSON.parse(readFileSync(ARTIFACT, "utf-8")) as Baseline;
    for (const [from, to] of Object.entries(MOVED)) {
      expect(Object.keys(b.engineSha)).toContain(from);
      expect(existsSync(join(process.cwd(), to)), `moved engine file missing: ${to}`).toBe(true);
    }
  });

  it("summary totals agree with the per-page rows (artifact is internally consistent)", () => {
    const b = JSON.parse(readFileSync(ARTIFACT, "utf-8")) as Baseline;

    expect(b.pages).toHaveLength(b.summary.pagesTotal);
    expect(b.pages.reduce((n, p) => n + p.codes.length, 0)).toBe(b.summary.codesTotal);
    expect(b.pages.reduce((n, p) => n + p.triggers.t1 + p.triggers.t2 + p.triggers.t3, 0)).toBe(
      b.summary.triggersTotal,
    );
  });

  it("records the tier inversion at corpus scale (the number P2 has to move)", () => {
    // Not a tolerance — an exact pin. If these move, the engine moved, and the
    // engineSha test above will already have told you why.
    const b = JSON.parse(readFileSync(ARTIFACT, "utf-8")) as Baseline;
    const t = b.pages.reduce(
      (acc, p) => ({ t1: acc.t1 + p.triggers.t1, t2: acc.t2 + p.triggers.t2, t3: acc.t3 + p.triggers.t3 }),
      { t1: 0, t2: 0, t3: 0 },
    );

    expect(t).toEqual({ t1: 32, t2: 19949, t3: 206106 });

    // The shape of the defect: the tier downstream weights LOWEST (0.50) carries
    // the overwhelming majority of evidence, and the tier weighted highest
    // (0.95) is statistically absent.
    const total = t.t1 + t.t2 + t.t3;
    expect(t.t3 / total).toBeGreaterThan(0.9);
    expect(t.t1 / total).toBeLessThan(0.001);
  });
});
