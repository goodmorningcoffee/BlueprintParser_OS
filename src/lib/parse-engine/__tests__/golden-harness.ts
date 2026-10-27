/**
 * golden-harness.ts — shared by legacy-golden.test.ts (synthetic, committed) and
 * legacy-golden-private.test.ts (real slices, docs repo only). Table-pipeline WP-2.0a.
 *
 * The goldens are the outputs of every legacy path (lib/legacy-joins/legacy-paths.ts) captured at the
 * TP-1 head 67492cc. They are a BASELINE, not a freeze to re-capture: a WP that changes a legacy path on
 * purpose (WP-2.B onwards) leaves the golden file alone and DECLARES each changed (fixture, path) pair in
 * eval/parse-engine/intended-diffs.md. The test then fails on an undeclared diff and on a stale
 * declaration (a declared pair that no longer differs). Reports name ids only, never cell text, so the
 * private run can fail safely.
 *
 *   capture: BP_GOLDEN_CAPTURE=1 scripts/bp-suite -- legacy-golden   (writes, then the compare is skipped)
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { LEGACY_PATH_IDS, runLegacyPaths, type LegacyPathId, type LegacySlice } from "@/lib/legacy-joins/legacy-paths";
import { stableJson } from "../../../../scripts/parse-engine-fixtures/synthesize";

export const REPO_ROOT = resolve(__dirname, "../../../..");
export const INTENDED_DIFFS = join(REPO_ROOT, "eval/parse-engine/intended-diffs.md");
export const GOLDEN_BASE = "67492cc";

export interface GoldenFile {
  schema: "bp-legacy-goldens/1";
  base: string;
  paths: readonly string[];
  fixtures: Record<string, Record<string, unknown>>;
}

export interface Declaration {
  fixture: string; // a fixture id, or "*" for every fixture of that path (see incompleteWildcards)
  path: string;
  ks: string[];
  line: number;
}

/** All `*.json` slices in a directory with schema bp-parse-fixture/1, sorted by id. */
export function loadSlices(dir: string, suffix: string): (LegacySlice & { synthetic?: boolean; schema?: string })[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(suffix) && !f.startsWith("legacy-goldens"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
    .filter((fx) => fx.schema === "bp-parse-fixture/1");
}

export function computeGoldens(slices: readonly LegacySlice[]): GoldenFile {
  const fixtures: GoldenFile["fixtures"] = {};
  for (const s of slices) fixtures[s.id] = runLegacyPaths(s);
  return { schema: "bp-legacy-goldens/1", base: GOLDEN_BASE, paths: LEGACY_PATH_IDS, fixtures };
}

export function writeGoldens(file: string, g: GoldenFile): void {
  writeFileSync(file, stableJson(g));
}

export function readGoldens(file: string): GoldenFile | null {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as GoldenFile) : null;
}

/** (fixture, path) pairs whose current output differs from the golden; `missing` = no golden for that fixture/path. */
export function diffGoldens(golden: GoldenFile, current: GoldenFile): { changed: string[]; missing: string[]; extra: string[] } {
  const changed: string[] = [];
  const missing: string[] = [];
  for (const [id, paths] of Object.entries(current.fixtures)) {
    const g = golden.fixtures[id];
    for (const p of LEGACY_PATH_IDS) {
      if (!g || !(p in g)) missing.push(`${id} ${p}`);
      else if (!isDeepStrictEqual(g[p], paths[p])) changed.push(`${id} ${p}`);
    }
  }
  const extra = Object.keys(golden.fixtures).filter((id) => !(id in current.fixtures));
  return { changed, missing, extra };
}

const ID_RE = /^(?:syn|prv)-[A-Za-z0-9-]+$|^\*$/;

/** Parse the declaration table rows of intended-diffs.md: `| fixture | path | K… | WP | note |`. */
export function readDeclarations(file = INTENDED_DIFFS): Declaration[] {
  if (!existsSync(file)) return [];
  const out: Declaration[] = [];
  readFileSync(file, "utf8").split("\n").forEach((raw, i) => {
    const cells = raw.split("|").map((c) => c.trim());
    if (cells.length < 5 || cells[0] !== "") return;
    const [, fixture, path, ks] = cells;
    if (!ID_RE.test(fixture) || !(LEGACY_PATH_IDS as readonly string[]).includes(path)) return;
    out.push({ fixture, path, ks: ks.split(/[\s,]+/).filter(Boolean), line: i + 1 });
  });
  return out;
}

export function isDeclared(pair: string, decls: readonly Declaration[]): boolean {
  const [id, path] = pair.split(" ");
  return decls.some((d) => d.path === path && (d.fixture === id || d.fixture === "*"));
}

/** Declarations (restricted to ids of this run's prefix) that match no current diff. */
export function staleDeclarations(changed: readonly string[], decls: readonly Declaration[], prefix: "syn-" | "prv-"): Declaration[] {
  return decls.filter((d) => {
    if (d.fixture !== "*" && !d.fixture.startsWith(prefix)) return false;
    return !changed.some((pair) => {
      const [id, path] = pair.split(" ");
      return path === d.path && (d.fixture === id || (d.fixture === "*" && id.startsWith(prefix)));
    });
  });
}

/**
 * `*` rows that do not cover every fixture they waive. A `*` row for path P is accepted only when, in this
 * run, P's output differs from the golden on EVERY fixture of the run's prefix whose golden output on P is
 * non-null. Otherwise one changed fixture would waive unintended changes on all the others of that path
 * (WP-2.0a verification MED-3). Ids only, so the private run can report safely.
 */
export function incompleteWildcards(
  golden: GoldenFile,
  changed: readonly string[],
  decls: readonly Declaration[],
  prefix: "syn-" | "prv-",
): string[] {
  const differs = new Set(changed);
  return decls.filter((d) => d.fixture === "*").flatMap((d) => {
    const untouched = Object.keys(golden.fixtures).sort()
      .filter((id) => id.startsWith(prefix) && (golden.fixtures[id]?.[d.path] ?? null) !== null && !differs.has(`${id} ${d.path}`));
    if (untouched.length === 0) return [];
    const shown = untouched.slice(0, 8).join(", ") + (untouched.length > 8 ? ", …" : "");
    return [`intended-diffs.md:${d.line} * ${d.path}: unchanged on ${untouched.length} fixture(s) with output (${shown}); list the changed fixtures by id instead`];
  });
}

export type { LegacyPathId };
