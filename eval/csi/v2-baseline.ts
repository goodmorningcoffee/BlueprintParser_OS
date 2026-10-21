/**
 * v2-baseline.ts — the CSI v2 ENGINE baseline: which files and which KB the recorded v2 numbers
 * describe (IMPLEMENTATION §II S6 "csi-v2-baseline-freshness.test.ts (v2 files + KB sha)").
 *
 * The v2 twin of `capture.ts`'s `engineSha` block for the old engine. `eval/csi/results/
 * v2-engine-baseline.json` (numbers only, committed) records the sha256 of every file that defines
 * v2 behaviour, the sha256 of the KB artifact, and the reachability census (csi-reachability.test.ts
 * rule). `src/lib/__tests__/csi-v2-baseline-freshness.test.ts` fails when any of them drifts, so a
 * v2 number quoted from `eval/csi/results/` cannot silently stop describing the engine. The S5
 * corpus results (`run-eval.sh`) belong next to it; re-run both after an engine change.
 *
 * Build + run (from the repo root; the bundle name must contain "csi-v2base" — argv guard):
 *   npx esbuild eval/csi/v2-baseline.ts --bundle --platform=node --target=node20 --alias:@=./src \
 *     --external:pg-native --outfile=build/csi-v2base.js
 *   node build/csi-v2base.js eval/csi/results/v2-engine-baseline.json
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CSI_KB_FILE, loadCsiKb } from "@/lib/csi-kb";
import { detectCsiV2 } from "@/lib/csi-page";
import type { KbCode, LoadedKb } from "@/lib/csi-kb-types";

export const V2_BASELINE_SCHEMA = "csi-v2-baseline/1";
export const V2_BASELINE_FILE = "eval/csi/results/v2-engine-baseline.json";

/** Every file whose bytes define what the v2 tagger emits through `detectCsiCodes`. */
export const V2_ENGINE_FILES: readonly string[] = [
  "src/lib/csi-tokenize.ts",
  "src/lib/csi-kb-types.ts",
  "src/lib/csi-kb.ts",
  "src/lib/csi-span-own.ts",
  "src/lib/csi-span-match.ts",
  "src/lib/csi-page.ts",
  "src/lib/csi-kb-overlay.ts",
  "src/lib/csi-v2-config.ts",
  "src/lib/csi-detect.ts",
];

export type Reach = "reachable" | "noPattern" | "hintOnly" | "lost";

/** csi-reachability.test.ts's rule: some non-hint-only pattern's printed text, as free text on TWO
 *  lines (one repeat: a loose single match scores 0.85 × 0.88 < the default tau, twice it clears it)
 *  at the default config with discipline 'C' (opens the facility gate), emits the code. */
export function reachOf(kb: LoadedKb, c: KbCode): Reach {
  const pats = c.patternIds.map((id) => kb.patterns[id]);
  if (!pats.length) return "noPattern";
  const usable = pats.filter((p) => p.kind === "regex" || !p.hintOnly);
  if (!usable.length) return "hintOnly";
  for (const p of usable) {
    if (p.kind === "regex") return "reachable"; // a regex term row matches its own surface (E7)
    const r = detectCsiV2({ text: `${p.text}\n${p.text}`, context: { discipline: "C" } }, {}, kb);
    if (r.codes.some((x) => x.code === c.code)) return "reachable";
  }
  return "lost";
}

export function reachCensus(kb: LoadedKb): Map<string, Reach> {
  const out = new Map<string, Reach>();
  for (const c of kb.codes) out.set(c.code, reachOf(kb, c));
  return out;
}

export interface V2Baseline {
  schemaVersion: string;
  engineSha: Record<string, string>;
  kb: { file: string; sha256: string; builderVersion: string; codes: number; patterns: number };
  reach: Record<Reach, number> & { codes: number };
}

const sha256File = (root: string, rel: string) => createHash("sha256").update(readFileSync(join(root, rel))).digest("hex");

export function captureV2Baseline(root: string): V2Baseline {
  const kb = loadCsiKb();
  const census = reachCensus(kb);
  const reach = { codes: census.size, reachable: 0, noPattern: 0, hintOnly: 0, lost: 0 };
  for (const v of census.values()) reach[v]++;
  const engineSha: Record<string, string> = {};
  for (const f of V2_ENGINE_FILES) engineSha[f] = sha256File(root, f);
  return {
    schemaVersion: V2_BASELINE_SCHEMA,
    engineSha,
    kb: {
      file: CSI_KB_FILE, sha256: sha256File(root, CSI_KB_FILE), builderVersion: kb.header.builderVersion,
      codes: kb.codes.length, patterns: kb.patterns.length,
    },
    reach,
  };
}

function main(): void {
  const out = process.argv[2] ?? V2_BASELINE_FILE;
  const b = captureV2Baseline(process.cwd());
  writeFileSync(out, JSON.stringify(b, null, 2) + "\n");
  console.log(`wrote ${out}: kb ${b.kb.builderVersion} ${b.kb.sha256.slice(0, 16)}… · reach ${b.reach.reachable}/${b.reach.codes}`);
}

if (process.argv[1]?.includes("csi-v2base")) main();
