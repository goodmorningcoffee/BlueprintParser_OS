/**
 * csi-gold-frame.test.ts — enforces the mechanical rules of the gold-set frame.
 *
 * [csi-rebuild P1.1] LABELING_PROTOCOL.md §10 lists five quality checks the gold
 * set must satisfy before it can be used for acceptance. Checks 1, 2 and 4 are
 * mechanical, so the protocol promises they are "enforced by the selector's own
 * test" — this is that test. Checks 3 and 5 (spot-check disagreement rate, every
 * label reviewed) need labels, which do not exist yet; they land with the labels.
 *
 * These are structural invariants, not characterization pins. If one fails, the
 * FRAME is wrong — do not adjust the assertion, fix select-gold-frame.ts and
 * regenerate. A leaked page between dev and test silently converts the acceptance
 * bar into a number about itself.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MANIFEST = join(process.cwd(), "eval/csi/gold-frame.json");

interface Frame {
  schemaVersion: string;
  params: { targetPages: number; floorPerStratum: number; pilotSize: number };
  frame: {
    corpusPages: number;
    framePages: number;
    excluded: { bundle: string; page: number; reason: string }[];
    selectedPages: number;
    dev: number;
    test: number;
  };
  splitQuality: {
    clusters: number;
    adjacentPairsStraddling: number;
    perBundle: { bundle: string; dev: number; test: number }[];
    strataWithDisjointBundles: string[];
  };
  strata: { stratum: string; population: number; weight: number; selected: number; dev: number; test: number }[];
  pilot: { bundle: string; page: number; stratum: string }[];
  pages: {
    bundle: string;
    page: number;
    disciplineGroup: string;
    stratum: string;
    split: "dev" | "test";
    oldEngineCodeCount: number;
  }[];
}

const load = (): Frame => JSON.parse(readFileSync(MANIFEST, "utf-8")) as Frame;
const key = (p: { bundle: string; page: number }) => `${p.bundle}:${p.page}`;

describe("gold-set frame manifest", () => {
  it("exists and is the schema this suite understands", () => {
    expect(existsSync(MANIFEST), `missing ${MANIFEST} — see eval/csi/LABELING_PROTOCOL.md`).toBe(true);
    expect(load().schemaVersion).toBe("csi-gold-frame/1");
  });

  it("§10.4 — no page is selected twice, and dev/test do not overlap", () => {
    const f = load();
    const keys = f.pages.map(key);
    expect(new Set(keys).size, "a page appears more than once in the frame").toBe(keys.length);

    const dev = new Set(f.pages.filter(p => p.split === "dev").map(key));
    const test = new Set(f.pages.filter(p => p.split === "test").map(key));
    const leaked = [...dev].filter(k => test.has(k));
    expect(leaked, "pages present in BOTH halves — the test half is contaminated").toEqual([]);
  });

  it("§8/§10.4 — no correlation cluster straddles the split", () => {
    const f = load();
    // Consecutive sheets of one drawing series are near-duplicates. If any pair
    // lands on opposite sides, dev tuning leaks into test through siblings and
    // the acceptance number is measuring its own training data.
    expect(
      f.splitQuality.adjacentPairsStraddling,
      "adjacent sheets split across dev/test — near-duplicate leakage",
    ).toBe(0);

    // Recompute from the page list rather than trusting the recorded number.
    const split = new Map(f.pages.map(p => [key(p), p.split]));
    const straddles = f.pages.filter(p => {
      const next = split.get(`${p.bundle}:${p.page + 1}`);
      return next !== undefined && next !== p.split;
    });
    expect(straddles.map(key)).toEqual([]);
  });

  it("§8 — the split is not confounded with project, except where arithmetic forbids", () => {
    const f = load();
    // A stratum whose dev and test halves share no project measures the project,
    // not the tagger. Unavoidable for tiny strata: 3 pages from 2 projects cannot
    // put both projects on both sides. Enforce it where it IS avoidable.
    const bySize = new Map(f.strata.map(s => [s.stratum, s.selected]));
    const avoidable = f.splitQuality.strataWithDisjointBundles.filter(s => (bySize.get(s) ?? 0) > 8);
    expect(avoidable, "project-disjoint strata large enough to have been balanced").toEqual([]);

    // No project may sit entirely on one side unless it contributes ≤1 page.
    const lopsided = f.splitQuality.perBundle.filter(b => b.dev + b.test > 1 && (b.dev === 0 || b.test === 0));
    expect(lopsided, "a whole project landed on one side of the split").toEqual([]);
  });

  it("§10.1 — every stratum contributes at least one page to each half", () => {
    const f = load();
    const starved = f.strata.filter(s => s.dev < 1 || s.test < 1).map(s => `${s.stratum} (dev ${s.dev}, test ${s.test})`);
    expect(starved, "a stratum missing from one half makes that half unrepresentative").toEqual([]);
  });

  it("§10.2 — all four discipline groups appear in both halves", () => {
    const f = load();
    const groups = (split: string) => new Set(f.pages.filter(p => p.split === split).map(p => p.disciplineGroup));
    for (const split of ["dev", "test"]) {
      expect([...groups(split)].sort(), `discipline groups missing from ${split}`).toEqual(["A", "MEP", "OTHER", "S"]);
    }
  });

  it("stratum counts and split tallies agree with the page list", () => {
    const f = load();
    expect(f.pages).toHaveLength(f.frame.selectedPages);
    expect(f.strata.reduce((n, s) => n + s.selected, 0)).toBe(f.frame.selectedPages);
    expect(f.strata.reduce((n, s) => n + s.dev + s.test, 0)).toBe(f.frame.selectedPages);
    expect(f.pages.filter(p => p.split === "dev")).toHaveLength(f.frame.dev);
    expect(f.pages.filter(p => p.split === "test")).toHaveLength(f.frame.test);

    for (const s of f.strata) {
      const inStratum = f.pages.filter(p => p.stratum === s.stratum);
      expect(inStratum, `stratum ${s.stratum} page count`).toHaveLength(s.selected);
      expect(s.selected).toBeLessThanOrEqual(s.population);
    }
  });

  it("frame accounting closes: corpus = frame + excluded, and the target is met", () => {
    const f = load();
    expect(f.frame.framePages + f.frame.excluded.length).toBe(f.frame.corpusPages);
    expect(f.frame.selectedPages).toBe(f.params.targetPages);
    // PLAN §3 P1 asks for 150–300 labeled pages.
    expect(f.frame.selectedPages).toBeGreaterThanOrEqual(150);
    expect(f.frame.selectedPages).toBeLessThanOrEqual(300);
  });

  it("reweighting is sound: population/selected weights reconstruct the frame size", () => {
    const f = load();
    const reconstructed = f.strata.reduce((n, s) => n + s.weight * s.selected, 0);
    expect(reconstructed).toBeCloseTo(f.frame.framePages, 0);
  });

  it("§9.1 — the pilot is dev-only and spans the required extremes", () => {
    const f = load();
    const byKey = new Map(f.pages.map(p => [key(p), p]));
    const dev = new Set(f.pages.filter(p => p.split === "dev").map(key));

    expect(f.pilot.length).toBeLessThanOrEqual(f.params.pilotSize);
    const outsideDev = f.pilot.map(key).filter(k => !dev.has(k));
    expect(outsideDev, "pilot pages outside dev would contaminate the test half").toEqual([]);

    const pilotPages = f.pilot.map(p => byKey.get(key(p))!);
    expect(new Set(pilotPages.map(p => p.disciplineGroup))).toEqual(new Set(["A", "MEP", "OTHER", "S"]));

    // A silent page (where the old engine's misses live) and a 151+ page (where
    // its false positives live) — the two failure modes must both be calibrated.
    const buckets = new Set(pilotPages.map(p => p.stratum.split("|")[1]));
    expect(buckets.has("0"), "pilot has no silent page — misses go uncalibrated").toBe(true);
    expect(buckets.has("151+"), "pilot has no high-volume page — FPs go uncalibrated").toBe(true);
  });

  it("§3.1 guard — strata keys are discipline|volume, never a CSI division", () => {
    const f = load();
    // A stratum keyed by a CSI division would mean the frame was built from old
    // engine output, which is the one thing the protocol forbids.
    for (const s of f.strata) {
      const [group, bucket] = s.stratum.split("|");
      expect(["A", "MEP", "S", "OTHER"]).toContain(group);
      expect(["0", "1-10", "11-50", "51-150", "151+"]).toContain(bucket);
    }
  });
});
