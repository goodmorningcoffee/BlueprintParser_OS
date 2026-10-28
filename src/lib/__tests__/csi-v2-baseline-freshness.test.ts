/**
 * csi-v2-baseline-freshness.test.ts — keeps the v2 engine baseline honest (IMPLEMENTATION §II S6).
 *
 * The v2 twin of csi-baseline-freshness.test.ts. `eval/csi/results/v2-engine-baseline.json`
 * records the sha256 of every file that defines v2 behaviour (`V2_ENGINE_FILES`, eval/csi/
 * v2-baseline.ts), the sha256 of the KB artifact and the reachability census. THIS TEST IS
 * DESIGNED TO FAIL when the engine or the KB changes: recapture in the SAME commit
 *   npx esbuild eval/csi/v2-baseline.ts --bundle --platform=node --target=node24 --alias:@=./src \
 *     --external:pg-native --outfile=build/csi-v2base.js && node build/csi-v2base.js
 * and re-run eval/csi/run-eval.sh so the S5 numbers in eval/csi/results/ describe the same engine.
 * Do not delete this test to make it pass. The KB checks skip when the gitignored KB is absent
 * (scripts/bp-suite's BP_REQUIRE_CSI_KB=1 turns that skip into a failed run).
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { V2_BASELINE_FILE, V2_BASELINE_SCHEMA, V2_ENGINE_FILES, type V2Baseline } from "../../../eval/csi/v2-baseline";
import { CSI_KB_FILE, loadCsiKb } from "@/lib/csi-kb";

const root = process.cwd();
const HAS_KB = existsSync(join(root, CSI_KB_FILE));
const sha256File = (rel: string) => createHash("sha256").update(readFileSync(join(root, rel))).digest("hex");
const read = (): V2Baseline => JSON.parse(readFileSync(join(root, V2_BASELINE_FILE), "utf-8")) as V2Baseline;

const RECAPTURE = "\nRecapture in THIS commit: node build/csi-v2base.js (see this file's header), then re-run eval/csi/run-eval.sh.\n";

describe("CSI v2 engine baseline artifact", () => {
  it("exists, is the schema this suite understands, and lists exactly V2_ENGINE_FILES", () => {
    expect(existsSync(join(root, V2_BASELINE_FILE)), `missing ${V2_BASELINE_FILE}`).toBe(true);
    const b = read();
    expect(b.schemaVersion).toBe(V2_BASELINE_SCHEMA);
    expect(Object.keys(b.engineSha).sort()).toEqual([...V2_ENGINE_FILES].sort());
  });

  it("still describes the CURRENT v2 engine — every recorded engineSha matches the tree", () => {
    const drifted = Object.entries(read().engineSha).filter(([rel, sha]) => sha256File(rel) !== sha).map(([rel]) => rel);
    expect(drifted, drifted.length ? `\nThe v2 engine baseline is STALE — changed since capture:\n  ${drifted.join("\n  ")}${RECAPTURE}` : "").toEqual([]);
  });

  it("is numbers-only (no client text can ride in it)", () => {
    const text = readFileSync(join(root, V2_BASELINE_FILE), "utf-8");
    expect(text.length).toBeLessThan(4000);
    expect(Object.keys(read()).sort()).toEqual(["engineSha", "kb", "reach", "schemaVersion"]);
  });
});

describe.skipIf(!HAS_KB)("CSI v2 engine baseline — the KB", () => {
  it("still describes the CURRENT KB artifact (sha256, builder version, sizes)", () => {
    const b = read();
    const kb = loadCsiKb();
    expect(b.kb.file).toBe(CSI_KB_FILE);
    expect(sha256File(CSI_KB_FILE), `the KB changed since the v2 baseline was captured${RECAPTURE}`).toBe(b.kb.sha256);
    expect({ builderVersion: kb.header.builderVersion, codes: kb.codes.length, patterns: kb.patterns.length })
      .toEqual({ builderVersion: b.kb.builderVersion, codes: b.kb.codes, patterns: b.kb.patterns });
  });
});
