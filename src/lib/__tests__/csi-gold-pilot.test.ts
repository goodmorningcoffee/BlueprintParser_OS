/**
 * csi-gold-pilot.test.ts — structural guards on the calibration pilot.
 *
 * [csi-rebuild P1.2b] The pilot's most important property is not its agreement
 * score — it is that **nothing in it is certified**. Protocol §9 requires an LLM
 * to propose and a HUMAN to dispose; both pilot passes were LLM-produced, so
 * every page carries `reviewed_by: null` and may not contribute to any acceptance
 * number.
 *
 * That invariant is exactly the kind that erodes quietly. Someone merges a
 * "consensus" label, or flips a flag to make a harness run, and the acceptance
 * bar silently starts counting uncertified opinions. This test makes that
 * erosion loud.
 *
 * When a human DOES review these pages, this test SHOULD fail — update it in the
 * same commit that records the review, and say who reviewed.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PILOT = join(process.cwd(), "eval/csi/gold-pilot.json");

interface Group { id: string; tier: string; division: string; codes: string[] }
interface Pass { groups: Group[]; confidence: string }
interface Pilot {
  schemaVersion: string;
  certification: { reviewed: boolean; statement: string };
  summary: { pilotPages: number; pagesLabeledBoth: number; meanSectionJaccard: number };
  pages: {
    bundle: string;
    page: number;
    passA: Pass | null;
    passB: Pass | null;
    agreement: { sectionJaccard: number | null; groupCountA: number | null; groupCountB: number | null };
    reviewed_by: string | null;
  }[];
}

const load = (): Pilot => JSON.parse(readFileSync(PILOT, "utf-8")) as Pilot;

describe("CSI calibration pilot", () => {
  it("exists and is the schema this suite understands", () => {
    expect(existsSync(PILOT), `missing ${PILOT}`).toBe(true);
    expect(load().schemaVersion).toBe("csi-gold-pilot/1");
  });

  it("NOTHING is certified — every page is reviewed_by: null", () => {
    const p = load();
    expect(p.certification.reviewed, "the pilot must not claim to be reviewed").toBe(false);

    const claimed = p.pages.filter(r => r.reviewed_by !== null).map(r => `${r.bundle}:${r.page}`);
    expect(
      claimed,
      "pages claiming human review. If a human really did review them, update this test " +
        "in the same commit and name the reviewer — do not let uncertified labels drift " +
        "into an acceptance number.",
    ).toEqual([]);
  });

  it("both passes are present and independent per page", () => {
    const p = load();
    expect(p.pages).toHaveLength(p.summary.pilotPages);
    expect(p.summary.pagesLabeledBoth).toBe(p.summary.pilotPages);
    for (const r of p.pages) {
      expect(r.passA, `${r.bundle}:${r.page} missing pass A`).not.toBeNull();
      expect(r.passB, `${r.bundle}:${r.page} missing pass B`).not.toBeNull();
    }
  });

  it("the passes were NOT collapsed into a consensus label", () => {
    // Merging two uncertified opinions into one destroys the disagreement signal
    // that is the pilot's entire product. Both passes must remain separately
    // readable, and at least some pages must actually differ — if every page were
    // identical, the two passes were not independent.
    const p = load();
    const differing = p.pages.filter(r => r.agreement.sectionJaccard !== null && r.agreement.sectionJaccard < 1);
    expect(differing.length, "no page differs at all — the passes were not independent").toBeGreaterThan(0);
  });

  it("every group is well-formed: division matches codes[0], codes are canonical", () => {
    const p = load();
    for (const r of p.pages) {
      for (const pass of [r.passA, r.passB]) {
        for (const g of pass!.groups) {
          expect(g.codes.length, `${r.bundle}:${r.page} ${g.id} has no codes`).toBeGreaterThan(0);
          // LABELING_PROTOCOL §5.2 / GRANULARITY_RUBRIC §1.1
          expect(g.division, `${r.bundle}:${r.page} ${g.id}: division must equal division of codes[0]`).toBe(
            g.codes[0].replace(/[\s.\-]/g, "").slice(0, 2),
          );
          expect(["primary", "secondary", "tertiary"]).toContain(g.tier);
        }
      }
    }
  });

  it("records the agreement figures the review budget is sized from", () => {
    // Not a quality bar — a pin. If the pilot is re-run and these move, the
    // budget reasoning in P1_PILOT_RESULTS.md moves with them.
    const p = load();
    expect(p.summary.meanSectionJaccard).toBeCloseTo(0.709, 2);

    const counts = p.pages.flatMap(r => [r.agreement.groupCountA!, r.agreement.groupCountB!]);
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    // The rubric's whole purpose: independent labelers produce a stable recall
    // denominator. 5.70 vs 5.75 across passes is that working.
    expect(mean).toBeGreaterThan(5);
    expect(mean).toBeLessThan(6.5);
  });
});

describe("negative labels (S3)", () => {
  interface WithNegatives {
    pages: {
      bundle: string;
      page: number;
      passA: { groups: { codes: string[] }[] } | null;
      passB: { groups: { codes: string[] }[] } | null;
      acceptable_divisions?: string[];
      should_not_divisions?: string[];
      should_not_codes?: string[];
      negativesProvenance?: { source: string; reasons: { code: string; why: string }[] };
    }[];
    negatives?: { pagesWithNegatives: number; floorRepairs: { page: string; added: string[] }[] };
  }
  const load2 = () => JSON.parse(readFileSync(PILOT, "utf-8")) as WithNegatives;

  it("acceptable_divisions is a superset of every division the page's own gold codes use", () => {
    // GRANULARITY_RUBRIC §1.1. Violating this scores the tagger as making a
    // cross-division error on a code THIS GOLD SET calls correct — the gold
    // contradicting itself, in the engine's disfavour.
    const f = load2();
    const violations: string[] = [];
    for (const p of f.pages) {
      if (!p.acceptable_divisions) continue;
      const acceptable = new Set(p.acceptable_divisions);
      const required = new Set(
        [...(p.passA?.groups ?? []), ...(p.passB?.groups ?? [])]
          .flatMap(g => g.codes)
          .map(c => c.replace(/[^0-9]/g, "").slice(0, 2)),
      );
      for (const d of required) if (!acceptable.has(d)) violations.push(`${p.bundle}:${p.page} missing div ${d}`);
    }
    expect(violations).toEqual([]);
  });

  it("acceptable and should_not divisions never overlap — a division cannot be both", () => {
    const f = load2();
    const contradictions: string[] = [];
    for (const p of f.pages) {
      const a = new Set(p.acceptable_divisions ?? []);
      for (const d of p.should_not_divisions ?? []) {
        if (a.has(d)) contradictions.push(`${p.bundle}:${p.page} div ${d} is both acceptable and should_not`);
      }
    }
    expect(contradictions).toEqual([]);
  });

  it("every should_not_code carries a recorded reason (provenance, not bare assertion)", () => {
    const f = load2();
    const unreasoned: string[] = [];
    for (const p of f.pages) {
      const reasons = new Map((p.negativesProvenance?.reasons ?? []).map(r => [r.code, r.why]));
      for (const c of p.should_not_codes ?? []) {
        const why = reasons.get(c);
        if (!why || why.trim().length < 10) unreasoned.push(`${p.bundle}:${p.page} ${c}`);
      }
    }
    expect(unreasoned).toEqual([]);
  });

  it("records any division the generator had to repair mechanically", () => {
    // A labeler omitting a required division is patched by the generator, but the
    // patch must be visible — otherwise the gold looks cleaner than it was.
    const f = load2();
    expect(f.negatives).toBeDefined();
    expect(Array.isArray(f.negatives!.floorRepairs)).toBe(true);
  });
});
