/**
 * csi-reachability.test.ts — how much of MasterFormat the v2 tagger can emit at all.
 *
 * [csi-v2 S6] Rewritten to the v2 rule (IMPLEMENTATION §II S6; PLAN v1 §7 "v2 reachability rule
 * with the delta recorded"). The pre-v2 census pinned a DEFECT of the 3-tier engine: at its
 * default config every entry with fewer than 3 significant words was unreachable for ANY input —
 * 2,362 of 8,951 TSV entries (26.4%), Furnishings 169/280, and everyday codes such as 09 91 00
 * Painting, 09 29 00 Gypsum Board and 09 51 00 Acoustical Ceilings among them.
 *
 * THE v2 RULE (an executable check, not a hand model of the engine; `reachOf` in
 * eval/csi/v2-baseline.ts, which also records the census in the v2 engine baseline): a code is REACHABLE iff the
 * printed text of at least one of its non-hint-only patterns, fed to `detectCsiV2` as free text on
 * two lines (one repeat lifts a loose 0.85 match over the default tau) at the DEFAULT config, emits
 * that code — with `context.discipline = 'C'`, the one context that opens the facility gate
 * (divisions 33–35, 40–48), so the census asks "is there ANY page".
 * What stays unreachable, by design (PLAN §6.3/§6.7): codes whose only patterns are one word and
 * not a curated csi_terms row (hint-only), Division 00/01 codes whose patterns are shorter than 3
 * tokens (text callers need ≥ 3; drawings never emit 00/01), and titles that lose to a deeper or
 * curated owner of the same words (frontier / E13 term ownership).
 *
 * DELTA (measured on kb-v2.4, 2026-10-21): unreachable 2,362 / 8,951 (26.4%) pre-v2 →
 * 409 / 8,935 (4.6%) v2. Of the 409: 145 have no usable pattern (143 hint-only, 2 none), 166 are
 * in Divisions 00/01 (the two groups overlap), 23 are Furnishings (was 169).
 * S5 tune (kb-v2.5, measured 2026-10-21, log gitignore/projects/csi_tagger_v2/logs/s5t-20261021T0640Z-span-facts.txt):
 * 409 → 422 unreachable. noPattern 2 → 5 (12 24 16.13 and 31 62 16.16 lose their lost-letter title set to
 * the code that also prints it; 33 82 63.16 "Control Panels" is a curated drop); lost 264 → 274
 * (measured, not itemised: candidates are the other curated drops, the new term rows owning their
 * words and the 0.7 out-of-order factor). Accepted for the S5 net gold/corpus gain.
 *
 * KB-backed: skipIf the KB is absent (scripts/bp-suite turns a skip into a failure).
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadCsiKb } from "@/lib/csi-kb";
import { reachCensus, type Reach } from "../../../eval/csi/v2-baseline";

const HAS_KB = existsSync(join(process.cwd(), "src/data/csi-kb.json"));

describe.skipIf(!HAS_KB)("MasterFormat reachability under the v2 rule (default config)", () => {
  const kb = HAS_KB ? loadCsiKb() : null;
  const res = kb ? reachCensus(kb) : new Map<string, Reach>();
  const count = (w: Reach) => [...res.values()].filter((v) => v === w).length;

  it("the census: 8,513 of 8,935 codes are reachable (4.7% unreachable, was 26.4%)", () => {
    expect(res.size).toBe(8935);
    expect({ reachable: count("reachable"), noPattern: count("noPattern"), hintOnly: count("hintOnly"), lost: count("lost") })
      .toEqual({ reachable: 8513, noPattern: 5, hintOnly: 143, lost: 274 });
    expect((res.size - count("reachable")) / res.size).toBeCloseTo(0.0472, 4);
  });

  it("the everyday interior codes the pre-v2 engine could never emit are reachable now", () => {
    for (const code of ["09 91 00", "09 91 23", "09 29 00", "09 51 00", "09 30 00", "06 22 00", "06 10 00"]) {
      expect(res.get(code), code).toBe("reachable");
    }
  });

  it("what is left is concentrated where the gates put it: Divisions 00/01 and one-word titles", () => {
    const unreach = [...res].filter(([, w]) => w !== "reachable").map(([c]) => c);
    const projectDiv = unreach.filter((c) => c.startsWith("00") || c.startsWith("01")).length;
    expect(projectDiv).toBe(166);
    expect(res.get("12 00 00")).toBe("hintOnly"); // "Furnishings" — one word, hint only (E6)
    // Furnishings was 169/280 unreachable pre-v2
    expect(unreach.filter((c) => c.startsWith("12")).length).toBe(23);
  });
});
