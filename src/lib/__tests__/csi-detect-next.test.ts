/**
 * csi-detect-next.test.ts — behaviour pins for the rebuilt scorer.
 *
 * [csi-rebuild S7] The engine is UNWIRED and must stay that way until the gold
 * set is certified, pooling has run, and owner Q4 is answered. One test below
 * enforces that mechanically — it is the only guard against a change that
 * typechecks perfectly and silently swaps the production tagger.
 *
 * The scoring pins encode two design corrections that probing found, both of
 * which would otherwise be re-derived the hard way.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { detectCsiCodesNext, tokenize, idf, minSpan, type Kb } from "../../../eval/csi/csi-detect-next";

/**
 * Hand-built KB, PADDED to realistic scale.
 *
 * The padding is not decoration. `idf` is computed against `kb.codes.length`, and
 * `evidenceSaturation` is calibrated to the real 8,951-code database — so a
 * 4-code toy KB with real-world `df` values yields NEGATIVE idf and nothing ever
 * fires. Caught by these tests failing on their positive cases first time.
 */
const REAL_KB_SIZE = 8951;
const filler = Array.from({ length: REAL_KB_SIZE - 4 }, (_, i) => ({
  code: `99${String(i).padStart(4, "0")}`,
  description: `filler ${i}`,
  trade: "Filler",
  division: "99 00 00",
  phraseWords: [`filler${i}`],
  allWords: [`filler${i}`],
  tokens: [`filler${i}`],
}));

const kb: Kb = {
  codes: [
    { code: "099100", description: "painting", trade: "Finishes", division: "09 00 00",
      phraseWords: ["painting"], allWords: ["painting"], tokens: ["painting"] },
    { code: "121000", description: "art", trade: "Furnishings", division: "12 00 00",
      phraseWords: ["art"], allWords: ["art"], tokens: ["art"] },
    { code: "033000", description: "cast-in-place concrete", trade: "Concrete", division: "03 00 00",
      phraseWords: ["cast", "place", "concrete"], allWords: ["cast", "in", "place", "concrete"],
      tokens: ["cast", "concrete", "place"] },
    { code: "110000", description: "equipment systems", trade: "Equipment", division: "11 00 00",
      phraseWords: ["equipment", "systems"], allWords: ["equipment", "systems"], tokens: ["equipment", "systems"] },
    ...filler,
  ],
  tokenIndex: {
    painting: ["099100"], art: ["121000"],
    cast: ["033000"], concrete: ["033000"], place: ["033000"],
    equipment: ["110000"], systems: ["110000"],
  },
  // df chosen to mirror the real KB's spread: `equipment` is near-worthless (998
  // codes), `painting` moderately rare, `art` rare-in-KB but common on drawings.
  df: { painting: 30, art: 6, cast: 40, concrete: 320, place: 60, equipment: 998, systems: 351 },
};

const codesOf = (rs: { code: string }[]) => rs.map(r => r.code).sort();

describe("tokenization and IDF", () => {
  it("strips edge punctuation so 'PAINT,' matches 'paint'", () => {
    expect(tokenize("PAINT, CEILING; soffit.")).toEqual(["paint", "ceiling", "soffit"]);
  });

  it("drops stop words and short tokens, matching the KB builder", () => {
    expect(tokenize("the cast in place concrete")).toEqual(["cast", "place", "concrete"]);
  });

  it("idf falls as a token names more codes", () => {
    expect(idf(1, 8951)).toBeGreaterThan(idf(998, 8951));
    expect(idf(998, 8951)).toBeGreaterThan(0);
  });
});

describe("minSpan — the proximity signal the old engine lacked", () => {
  const pos = new Map([["a", [0, 100]], ["b", [5]], ["c", [102]]]);

  it("finds the tightest window containing every token", () => {
    expect(minSpan(pos, ["a", "b"])).toBe(6); // positions 0..5
    expect(minSpan(pos, ["a", "c"])).toBe(3); // positions 100..102
  });

  it("a single token spans 1, an absent token spans Infinity", () => {
    expect(minSpan(pos, ["a"])).toBe(1);
    expect(minSpan(pos, ["zzz"])).toBe(Infinity);
  });
});

describe("scoring corrections found by probing", () => {
  it("a short generic code does NOT fire on one stray mention", () => {
    // The first design normalized by the code's own IDF total, so a 1-token code
    // was trivially 100% covered and `art` scored 1.0 on a single word. Evidence
    // MASS is what stops that.
    const page = "interior elevations show art on the north wall of the dining room area";
    expect(codesOf(detectCsiCodesNext(page, undefined, undefined, kb))).not.toContain("121000");
  });

  it("but a short code DOES fire when the page is genuinely about it", () => {
    // The whole point of dropping the word-count gates: `painting` is emittable.
    // Repetition is what makes it evidence rather than a passing reference.
    const page = "painting notes: painting all gypsum surfaces. painting to match. painting schedule painting";
    expect(codesOf(detectCsiCodesNext(page, undefined, undefined, kb))).toContain("099100");
  });

  it("scattered tokens do NOT count as evidence — proximity is required", () => {
    // `cast`, `place` and `concrete` all present but 400 words apart is
    // coincidence on a dense sheet, not a mention. Without this the threshold
    // could not control output at all: 0.55→0.99 only moved 233→37 codes/page.
    const filler = Array.from({ length: 200 }, (_, i) => `filler${i}`).join(" ");
    const scattered = `cast ${filler} place ${filler} concrete`;
    const together = "cast in place concrete slab on grade, cast in place concrete footings";
    expect(codesOf(detectCsiCodesNext(scattered, undefined, undefined, kb))).not.toContain("033000");
    expect(codesOf(detectCsiCodesNext(together, undefined, undefined, kb))).toContain("033000");
  });

  it("a code made only of near-worthless tokens never fires", () => {
    // `equipment` names 998 codes; `systems` 351. Both present, adjacent, and it
    // still must not fire — that is IDF doing its job.
    const page = "equipment systems equipment systems schedule for equipment systems";
    expect(codesOf(detectCsiCodesNext(page, undefined, undefined, kb))).not.toContain("110000");
  });

  it("returns [] for short input or a missing KB rather than throwing", () => {
    expect(detectCsiCodesNext("abc", undefined, undefined, kb)).toEqual([]);
    expect(detectCsiCodesNext("a long enough page of text here", undefined, undefined, undefined)).toEqual([]);
  });

  it("output is deterministic and confidence-ordered", () => {
    const page = "painting painting painting cast in place concrete cast in place concrete";
    const a = detectCsiCodesNext(page, undefined, undefined, kb);
    const b = detectCsiCodesNext(page, undefined, undefined, kb);
    expect(a).toEqual(b);
    for (let i = 1; i < a.length; i++) expect(a[i - 1].confidence).toBeGreaterThanOrEqual(a[i].confidence);
  });
});

describe("THE ENGINE MUST STAY UNWIRED", () => {
  it("no file under src/ imports csi-detect-next", () => {
    // It is signature-compatible with detectCsiCodes, so wiring it typechecks and
    // builds cleanly. Nothing else would catch it. Wiring is blocked on: a
    // certified gold set (§9), pooled adjudication (§5.0.1), and owner Q4.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) {
          if (name === "node_modules" || name === ".next") continue;
          walk(p);
        } else if (/\.tsx?$/.test(name) && !p.includes("__tests__")) {
          if (readFileSync(p, "utf-8").includes("csi-detect-next")) offenders.push(p);
        }
      }
    };
    walk(join(process.cwd(), "src"));
    expect(
      offenders,
      "csi-detect-next is imported from production code. It is NOT ready: the gold set is " +
        "uncertified, pooled adjudication has not run, and the code-format question is open.",
    ).toEqual([]);
  });
});
