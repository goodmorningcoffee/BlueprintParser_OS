// [table-pipeline WP-2.0a] Legacy goldens on REAL page slices. The slices and their goldens hold drawing
// text, so they live only in the private docs repo (PLAN §1.6 rule 12):
//   $BP_PRIVATE_GOLD_DIR (default <repo>/../../gitignore/projects/table_pipeline/fixtures_private)
//     slices/<prv-id>.json            bp-parse-fixture/1, synthetic:false
//     goldens/legacy-goldens.json     captured with BP_GOLDEN_CAPTURE=1
// Absent (GitHub CI, a fresh clone) → the suite SKIPS and logs why. Failures name ids only, never text.
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import { LEGACY_PATH_IDS } from "@/lib/legacy-joins/legacy-paths";
import {
  REPO_ROOT,
  computeGoldens,
  diffGoldens,
  incompleteWildcards,
  isDeclared,
  loadSlices,
  readDeclarations,
  readGoldens,
  staleDeclarations,
  writeGoldens,
} from "./golden-harness";

const DIR = resolve(process.env.BP_PRIVATE_GOLD_DIR ?? join(REPO_ROOT, "../../gitignore/projects/table_pipeline/fixtures_private"));
const SLICES = join(DIR, "slices");
const GOLDEN_FILE = join(DIR, "goldens/legacy-goldens.json");
const CAPTURE = process.env.BP_GOLDEN_CAPTURE === "1";
const present = existsSync(SLICES);

// Always runs, so the skip reason lands in the suite log (a skipped describe prints nothing).
it("logs whether the private slices are present", () => {
  if (present) console.info(`[legacy-golden-private] running on ${SLICES}`);
  else console.info(`[legacy-golden-private] SKIPPED: no private slices at ${SLICES} (set BP_PRIVATE_GOLD_DIR; real slices never enter BP2)`);
  expect(typeof present).toBe("boolean");
});

describe.skipIf(!present)("legacy goldens — private real slices", () => {
  const slices = present ? loadSlices(SLICES, ".json") : [];
  const first = computeGoldens(slices);

  it("has slices with prv- ids that are not marked synthetic", () => {
    expect(slices.length).toBeGreaterThan(0);
    const bad = slices.filter((s) => !/^prv-[A-Za-z0-9-]+$/.test(s.id) || s.synthetic === true).map((s) => s.id);
    expect(bad).toEqual([]);
  });

  it("is deterministic: a second run of every path is deep-equal (E-7)", () => {
    const second = computeGoldens(slices);
    const unequal = slices.flatMap((s) => LEGACY_PATH_IDS
      .filter((p) => !isDeepStrictEqual(first.fixtures[s.id][p], second.fixtures[s.id][p]))
      .map((p) => `${s.id} ${p}`));
    expect(unequal).toEqual([]);
  });

  it.skipIf(CAPTURE)("matches the private TP-1 goldens except the declared intended diffs", () => {
    const golden = readGoldens(GOLDEN_FILE);
    expect(golden !== null, `no private golden file at ${GOLDEN_FILE}: capture with BP_GOLDEN_CAPTURE=1`).toBe(true);
    const { changed, missing, extra } = diffGoldens(golden!, first);
    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
    const decls = readDeclarations();
    expect(changed.filter((pair) => !isDeclared(pair, decls)), "declare each pair in eval/parse-engine/intended-diffs.md (ids only)").toEqual([]);
    expect(staleDeclarations(changed, decls, "prv-").map((d) => `intended-diffs.md:${d.line} ${d.fixture} ${d.path}`)).toEqual([]);
    expect(incompleteWildcards(golden!, changed, decls, "prv-"), "a * row must differ on every fixture with output on that path").toEqual([]);
  });

  it.runIf(CAPTURE)("captures the private goldens (BP_GOLDEN_CAPTURE=1)", () => {
    mkdirSync(join(DIR, "goldens"), { recursive: true });
    writeGoldens(GOLDEN_FILE, first);
    expect(readGoldens(GOLDEN_FILE)?.fixtures).toEqual(first.fixtures);
  });
});
