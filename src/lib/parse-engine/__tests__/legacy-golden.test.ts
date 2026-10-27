// [table-pipeline WP-2.0a] Legacy goldens on the SYNTHETIC fixtures (lib/parse-engine/__fixtures__).
// Every legacy parse path (lib/legacy-joins/legacy-paths.ts) runs on every fixture, twice; the result
// must equal the TP-1 golden except for the (fixture, path) pairs declared in
// eval/parse-engine/intended-diffs.md. See golden-harness.ts for the rules.
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import { LEGACY_PATH_IDS } from "@/lib/legacy-joins/legacy-paths";
import {
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

const FIXTURE_DIR = join(__dirname, "../__fixtures__");
const GOLDEN_FILE = join(FIXTURE_DIR, "legacy-goldens.synthetic.json");
const CAPTURE = process.env.BP_GOLDEN_CAPTURE === "1";

const slices = loadSlices(FIXTURE_DIR, ".synthetic.json");

describe("legacy goldens — synthetic fixtures", () => {
  it("has ≥ 40 synthetic fixtures with unique syn- ids", () => {
    expect(slices.length).toBeGreaterThanOrEqual(40);
    expect(new Set(slices.map((s) => s.id)).size).toBe(slices.length);
    for (const s of slices) {
      expect(s.id).toMatch(/^syn-[a-z0-9-]+$/);
      expect(s.synthetic, s.id).toBe(true);
    }
  });

  const first = computeGoldens(slices);

  it("is deterministic: a second run of every path is deep-equal (E-7)", () => {
    const second = computeGoldens(slices);
    const unequal = slices.flatMap((s) => LEGACY_PATH_IDS
      .filter((p) => !isDeepStrictEqual(first.fixtures[s.id][p], second.fixtures[s.id][p]))
      .map((p) => `${s.id} ${p}`));
    expect(unequal).toEqual([]);
  });

  it.skipIf(CAPTURE)("matches the TP-1 goldens except the declared intended diffs", () => {
    const golden = readGoldens(GOLDEN_FILE);
    expect(golden, `no golden file: capture with BP_GOLDEN_CAPTURE=1 at ${GOLDEN_FILE}`).not.toBeNull();
    const { changed, missing, extra } = diffGoldens(golden!, first);
    expect(missing, "fixtures/paths without a golden (re-capture only for NEW fixtures)").toEqual([]);
    expect(extra, "goldens for fixtures that no longer exist").toEqual([]);
    const decls = readDeclarations();
    const undeclared = changed.filter((pair) => !isDeclared(pair, decls));
    expect(undeclared, "legacy output changed: declare each pair in eval/parse-engine/intended-diffs.md").toEqual([]);
  });

  it.skipIf(CAPTURE)("intended-diffs.md declares only real diffs, each with a K number", () => {
    const golden = readGoldens(GOLDEN_FILE);
    const decls = readDeclarations();
    for (const d of decls) expect(d.ks.some((k) => /^K\d{2}$/.test(k)), `intended-diffs.md:${d.line} cites no K number`).toBe(true);
    if (!golden) return;
    const { changed } = diffGoldens(golden, first);
    const stale = staleDeclarations(changed, decls, "syn-");
    expect(stale.map((d) => `intended-diffs.md:${d.line} ${d.fixture} ${d.path}`), "declared diffs that no longer differ").toEqual([]);
    expect(incompleteWildcards(golden, changed, decls, "syn-"), "a * row must differ on every fixture with output on that path").toEqual([]);
  });

  it("refuses a * row that leaves a fixture with output unchanged (one diff must not waive a whole path)", () => {
    const golden = {
      schema: "bp-legacy-goldens/1" as const,
      base: "t",
      paths: LEGACY_PATH_IDS,
      fixtures: { "syn-a": { manual: { x: 1 } }, "syn-b": { manual: { x: 2 } }, "syn-c": { manual: null } },
    };
    const star = [{ fixture: "*", path: "manual", ks: ["K07"], line: 9 }];
    // only syn-a changed: syn-b has output and did not change, so the * row is refused
    expect(incompleteWildcards(golden, ["syn-a manual"], star, "syn-")).toEqual([
      "intended-diffs.md:9 * manual: unchanged on 1 fixture(s) with output (syn-b); list the changed fixtures by id instead",
    ]);
    // both fixtures with output changed (syn-c's null output is not required to): accepted
    expect(incompleteWildcards(golden, ["syn-a manual", "syn-b manual"], star, "syn-")).toEqual([]);
    // per-id rows are unaffected
    expect(incompleteWildcards(golden, ["syn-a manual"], [{ ...star[0], fixture: "syn-a" }], "syn-")).toEqual([]);
  });

  it.runIf(CAPTURE)("captures the goldens (BP_GOLDEN_CAPTURE=1)", () => {
    writeGoldens(GOLDEN_FILE, first);
    expect(readGoldens(GOLDEN_FILE)?.fixtures).toEqual(first.fixtures);
  });
});
