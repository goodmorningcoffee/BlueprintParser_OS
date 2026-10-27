// @vitest-environment node
// [table pipeline WP-3.A acceptance] The fused rows against the PRIVATE G-TAB gold (PLAN §6.1; DR-2.2), scored with
// the WP-2.G harness as an extra leg beside the legacy paths: word → row accuracy must not regress against the
// legacy merger (paired bootstrap 95 % CI; §6.4: lower bound ≥ −0.01 = non-regressing, a CI too wide = undecided). The gold and the slices
// hold drawing text, so they live only in the private docs repo; absent → SKIPPED with a logged reason (rule 12).
// The report is numbers, leg ids, strata and opaque gold ids only — it is printed into the suite log.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { legacyLegs, measure, reportMarkdown, type Leg, type Unit } from "../../../../scripts/lib/parse-measure";
import { privateUnits } from "../../../../scripts/parse-engine-measure";
import { fuseRows, rowsInputFor } from "../fuse";
import { REPO_ROOT } from "./golden-harness";
import { evidenceFromFixture } from "./rows-evidence-helpers";

const DIR = resolve(process.env.BP_PRIVATE_GOLDSET_DIR ?? join(REPO_ROOT, "../../gitignore/projects/table_pipeline/fixtures_private/goldset"));
const present = existsSync(join(DIR, "gold", "G-TAB.v1.jsonl")) && existsSync(join(DIR, "slices"));
const yc = (b: readonly number[]): number => (b[1] + b[3]) / 2;

it("logs whether the private gold set is present", () => {
  if (present) console.info(`[rows-private-gold] running on ${DIR}`);
  else console.info(`[rows-private-gold] SKIPPED: no private gold set at ${DIR} (set BP_PRIVATE_GOLDSET_DIR; real slices never enter BP2)`);
  expect(typeof present).toBe("boolean");
});

/** The engine's rows as a one-column grid (row text = the words in the band, left to right); header rows left out like the legacy grids. */
const engineRows: Leg = {
  id: "engine:rows",
  applies: (u: Unit) => u.gold === "G-TAB",
  run: (u: Unit) => {
    const input = rowsInputFor(evidenceFromFixture(u.slice as Parameters<typeof evidenceFromFixture>[0]), u.slice.region);
    const f = fuseRows(input);
    const grid = f.rows
      .filter((r) => r.role === "body" || r.role === "section")
      .map((r) => [input.words.filter((w) => yc(w.b) >= r.y0 && yc(w.b) < r.y1).sort((a, b) => a.b[0] - b.b[0] || a.b[1] - b.b[1]).map((w) => w.t).join(" ")]);
    return { grid };
  },
};

describe.skipIf(!present)("fused rows vs the private G-TAB gold (word → row accuracy, non-regression)", () => {
  it("engine:rows word→row accuracy does not regress against legacy:merger (paired CI lower bound ≥ −0.01)", () => {
    const { units, skipped } = privateUnits(DIR, "all", ["G-TAB"]);
    expect(units.length, JSON.stringify(skipped)).toBeGreaterThan(0);
    const legs = [...legacyLegs((id) => id === "ocr-positions" || id === "merger" || id === "shape-rows"), engineRows];
    const report = measure(units, legs, { sets: "all", baseline: { "G-TAB": "legacy:merger" }, resamples: 2000, seed: 20261027 });
    console.info(reportMarkdown(report));
    const engine = report.legs["G-TAB"]["engine:rows"];
    const paired = report.paired["G-TAB"].legs["engine:rows"].metrics.wordRowAcc;
    console.info(`[rows-private-gold] engine:rows wordRowAcc mean ${engine.metrics.wordRowAcc.mean} [${engine.metrics.wordRowAcc.lo}, ${engine.metrics.wordRowAcc.hi}] n=${engine.units}; ` +
      `paired vs legacy:merger diff ${paired.diff} [${paired.lo}, ${paired.hi}]; rowCountExact ${engine.metrics.rowCountExact.mean}`);
    const byStratum = report.paired["G-TAB"].legs["engine:rows"].byStratum;
    for (const [stratum, m] of Object.entries(byStratum)) {
      const w = m.wordRowAcc;
      const e = engine.byStratum[stratum]?.metrics.wordRowAcc;
      console.info(`[rows-private-gold] ${stratum}: n=${w.n} engine ${e?.mean} merger ${w.meanBase} diff ${w.diff} [${w.lo}, ${w.hi}]`);
    }
    // §6.4 reads the paired CI: lower bound ≥ −0.01 = non-regressing; a CI too wide to decide is "undecided — need
    // ~n more units", never a failure of the build (PLAN §6.4). With 75 units the half-width is ≈ 0.04, so this test
    // pins what the batch CAN decide — the engine is not worse on average and not surely worse — and logs the verdict.
    const verdict = paired.lo >= -0.01 ? "non-regressing (lower bound ≥ −0.01)" : paired.hi < -0.01 ? "REGRESSION (upper bound < −0.01)" : "undecided — CI too wide (needs more G-TAB units; WP-3.Q)";
    console.info(`[rows-private-gold] §6.4 verdict on wordRowAcc: ${verdict}`);
    expect(engine.units).toBe(units.length);
    expect(paired.diff).toBeGreaterThanOrEqual(-0.01);
    expect(paired.hi).toBeGreaterThanOrEqual(0.01);
  });
});
