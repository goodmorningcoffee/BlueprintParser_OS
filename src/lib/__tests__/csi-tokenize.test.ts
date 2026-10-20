/**
 * csi-tokenize.test.ts — pins the CSI v2 tokenizer (PLAN §5.4, IMPLEMENTATION §II S1).
 *
 * The builder (S2) and the runtime matcher (S3) both import this tokenizer, so any drift
 * here moves every pattern in the KB. All inputs are generic MasterFormat/trade phrases.
 */
import { describe, expect, it } from "vitest";
import {
  FOLD_EXCEPTIONS,
  FOLD_MAP,
  INSERT_WHITELIST,
  STOP_WORDS,
  canonToken,
  foldPlural,
  indexForms,
  isAbbrevDot,
  splitTextUnits,
  tokenize,
} from "../csi-tokenize";

const ts = (text: string, vocab?: ReadonlySet<string>) => tokenize(text, vocab).map((k) => k.t);

describe("csi-tokenize: word-form map", () => {
  it.each([
    ["CARPET", "carpet"],
    ["CARPETING", "carpet"],
    ["PAINT", "paint"],
    ["PAINTED", "paint"],
    ["PAINTING", "paint"],
    ["PANEL", "panel"],
    ["PANELING", "panel"],
    ["SURFACE", "surface"],
    ["SURFACING", "surface"],
    ["CURE", "cure"],
    ["DEMOLITION", "demolish"],
    ["INSULATION", "insulate"],
    ["REINFORCING", "reinforce"],
  ])("%s → %s", (word, expected) => {
    expect(ts(word)).toEqual([expected]);
  });

  // S2 term/fold review (2026-10-20): each of these folds merged two trades' MasterFormat
  // titles (METAL FRAMING → "metal frame" = 08 12 00 Metal Frames; CLEANING ROOM → 13 21 13
  // Clean Rooms; …), so the word stays its own token even with no vocabulary.
  it.each([
    "FRAMING", "FRAMED", "CLEANING", "COATED", "WIRING", "GLAZED",
    "INSULATED", "INSULATING", "CURED", "CURING", "WELDED", "WELDING",
  ])("%s is NOT folded (cross-trade collision)", (word) => {
    expect(ts(word)).toEqual([word.toLowerCase()]);
    expect(Object.hasOwn(FOLD_MAP, word.toLowerCase())).toBe(false);
  });

  it("applies a fold only when the stem is KB vocabulary (vocab given)", () => {
    expect(canonToken("PAINTING", new Set(["paint"]))).toBe("paint");
    expect(canonToken("PAINTING", new Set(["carpet"]))).toBe("painting");
    expect(ts("PAINTED CARPETING", new Set(["carpet"]))).toEqual(["painted", "carpet"]);
  });

  it("folds plural before the word form (PAINTINGS → paint)", () => {
    expect(ts("PAINTINGS COATINGS")).toEqual(["paint", "coat"]);
  });

  it("every FOLD_MAP stem is a fixed point and no key is also an exception", () => {
    expect(Object.keys(FOLD_MAP).length).toBeGreaterThanOrEqual(40);
    for (const [form, stem] of Object.entries(FOLD_MAP)) {
      expect(canonToken(stem), `${form} → ${stem}`).toBe(stem);
      expect(form in FOLD_EXCEPTIONS, form).toBe(false);
    }
  });
});

describe("csi-tokenize: exception list", () => {
  it("keeps glazing/roofing/flashing/siding as surface forms", () => {
    expect(ts("GLAZING ROOFING FLASHING SIDING")).toEqual(["glazing", "roofing", "flashing", "siding"]);
    expect(ts("FLASHINGS")).toEqual(["flashing"]);
  });

  it("also exposes the stem for indexing", () => {
    expect(indexForms("glazing")).toEqual(["glazing", "glaze"]);
    expect(indexForms("roofing")).toEqual(["roofing", "roof"]);
    expect(indexForms("flashing")).toEqual(["flashing", "flash"]);
    expect(indexForms("siding")).toEqual(["siding", "side"]);
    expect(indexForms("carpet")).toEqual(["carpet"]);
  });
});

describe("csi-tokenize: plural fold", () => {
  it.each([
    ["glass", "glass"],
    ["glasses", "glass"],
    ["gas", "gas"],
    ["bus", "bus"],
    ["canvas", "canvas"],
    ["brass", "brass"],
    ["truss", "truss"],
    ["trusses", "truss"],
    ["doors", "door"],
    ["tiles", "tile"],
    ["assemblies", "assembly"],
    ["accessories", "accessory"],
    ["finishes", "finish"],
    ["switches", "switch"],
    ["boxes", "box"],
    ["acoustics", "acoustic"],
    ["ties", "tie"],
    ["apparatus", "apparatus"],
    ["chassis", "chassis"],
  ])("%s → %s", (word, expected) => {
    expect(foldPlural(word)).toBe(expected);
  });

  // IMPLEMENTATION E12 D8: words ending in s that are not plurals (EIFS used to fold to "eif").
  it.each([
    ["EIFS", "eifs"],
    ["ASBESTOS", "asbestos"],
    ["Atlas", "atlas"],
    ["PLEXIGLAS", "plexiglas"],
  ])("tokenize(%s)[0].t is %s (plural-invariant, D8)", (word, expected) => {
    expect(tokenize(word)[0].t).toBe(expected);
    expect(foldPlural(expected)).toBe(expected);
  });

  it.each([
    ["niche", "niches"],
    ["leaf", "leaves"],
    ["axis", "axes"],
    ["shelf", "shelves"],
  ])("%s and %s land on one token", (singular, plural) => {
    expect(ts(plural)).toEqual(ts(singular));
    expect(ts(singular)).toEqual([singular]);
  });
});

describe("csi-tokenize: Object.prototype keys are ordinary words", () => {
  it.each(["constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf"])("%s", (w) => {
    const lower = w.toLowerCase();
    expect(foldPlural(w)).toBe(w);
    expect(foldPlural(lower)).toBe(lower);
    expect(canonToken(w.toUpperCase())).toBe(lower);
    expect(indexForms(lower)).toEqual([lower]);
    expect(ts(`THE ${w.toUpperCase()} SHALL`)).toEqual([lower]);
  });

  it("tokenize('CONSTRUCTOR') keeps the word", () => {
    expect(tokenize("CONSTRUCTOR").map((k) => k.t)).toEqual(["constructor"]);
  });
});

describe("csi-tokenize: drops", () => {
  it("drops length-1 and all-digit tokens, keeps alphanumerics", () => {
    expect(ts("A 2 10 X FLOOR 12B 2X4")).toEqual(["floor", "12b", "2x4"]);
  });

  it("drops English function words but never not/no/others/existing", () => {
    for (const w of ["not", "no", "others", "other", "existing", "all", "any", "new", "see"]) {
      expect(STOP_WORDS.has(w), w).toBe(false);
    }
    expect(ts("NOT IN CONTRACT")).toEqual(["not", "contract"]);
    expect(ts("BY OTHERS")).toEqual(["other"]);
    expect(ts("NO EXISTING WORK TO REMAIN")).toEqual(["no", "existing", "work", "remain"]);
  });

  it("R-13 INSULATION yields only 'insulate' (R-digit rows are regex patterns, not tokens)", () => {
    expect(ts("R-13 INSULATION")).toEqual(["insulate"]);
  });
});

describe("csi-tokenize: positions and splitting", () => {
  it("pos indexes the original whitespace-split sequence; '-' and '/' share a pos", () => {
    const toks = tokenize("  HOLLOW METAL DOOR/FRAME  FIRE-RATED");
    expect(toks.map((k) => [k.t, k.raw, k.pos])).toEqual([
      ["hollow", "HOLLOW", 0],
      ["metal", "METAL", 1],
      ["door", "DOOR", 2],
      ["frame", "FRAME", 2],
      ["fire", "FIRE", 3],
      ["rated", "RATED", 3],
    ]);
  });

  it("start/end are offsets into the untrimmed input, end-exclusive, and slice back to raw", () => {
    const text = "  HOLLOW METAL DOOR/FRAME  FIRE-RATED";
    const toks = tokenize(text);
    expect(toks.map((k) => [k.raw, k.start, k.end])).toEqual([
      ["HOLLOW", 2, 8],
      ["METAL", 9, 14],
      ["DOOR", 15, 19],
      ["FRAME", 20, 25],
      ["FIRE", 27, 31],
      ["RATED", 32, 37],
    ]);
    for (const k of toks) expect(text.slice(k.start, k.end)).toBe(k.raw);
  });

  it("offsets skip dropped pieces and words, including Unicode dashes", () => {
    const text = "R-13 INSULATION, 3‐5/8\" MTL. STUDS @ 16\" O.C.";
    const toks = tokenize(text);
    expect(toks.map((k) => [k.t, k.pos])).toEqual([
      ["insulate", 1],
      ["mtl", 3],
      ["stud", 4],
      ["oc", 7],
    ]);
    for (const k of toks) expect(text.slice(k.start, k.end)).toBe(k.raw);
  });

  it("a regex hit on the raw text maps to tokens by offset overlap (E7)", () => {
    const text = "PROVIDE R-19 INSULATION AT EXTERIOR WALLS";
    const m = /R-\d+ INSULATION/i.exec(text);
    expect(m).not.toBeNull();
    const a = m!.index;
    const b = a + m![0].length;
    const hit = tokenize(text).filter((k) => k.start < b && k.end > a).map((k) => k.t);
    expect(hit).toEqual(["insulate"]);
  });

  it("bbox is never set by tokenize", () => {
    for (const k of tokenize("GYPSUM BOARD")) expect("bbox" in k).toBe(false);
  });

  it("strips punctuation inside a piece", () => {
    expect(ts("(GYPSUM) BOARD, OWNER'S")).toEqual(["gypsum", "board", "owner"]);
  });
});

describe("csi-tokenize: abbreviation dot", () => {
  it("'GYP. BD.' gives gyp and bd, both with abbrevDot", () => {
    expect(tokenize("GYP. BD.")).toEqual([
      { t: "gyp", raw: "GYP.", pos: 0, start: 0, end: 4, abbrevDot: true },
      { t: "bd", raw: "BD.", pos: 1, start: 5, end: 8, abbrevDot: true },
    ]);
  });

  it("isAbbrevDot is ALL-CAPS 2–5 letters + '.' only", () => {
    expect(isAbbrevDot("MTL.")).toBe(true);
    expect(isAbbrevDot("(GYP.")).toBe(true);
    expect(isAbbrevDot("N.I.C.")).toBe(true);
    expect(isAbbrevDot("O.C.")).toBe(true);
    expect(isAbbrevDot("A.F.F.")).toBe(true);
    expect(isAbbrevDot("(U.L.)")).toBe(true);
    for (const raw of ["Gyp.", "G.", "ABCDEF.", "GYP", "GYP.BD", "R13."]) {
      expect(isAbbrevDot(raw), raw).toBe(false);
    }
    expect(tokenize("Paint.")[0].abbrevDot).toBeUndefined();
  });

  it("splitTextUnits does not split at an abbreviation dot", () => {
    expect(splitTextUnits("GYP. BD. ON MTL. STUD")).toEqual(["GYP. BD. ON MTL. STUD"]);
    const known = new Set(["gyp", "bd", "mtl"]);
    expect(splitTextUnits("GYP. BD. ON MTL. STUD", known)).toEqual(["GYP. BD. ON MTL. STUD"]);
  });

  it("'END OF NOTE. NEXT' splits when abbreviations are known (PLAN §5.4)", () => {
    const known = new Set(["gyp", "bd", "mtl"]);
    expect(splitTextUnits("END OF NOTE. NEXT", known)).toEqual(["END OF NOTE", "NEXT"]);
    // Dotted abbreviations never split a unit, known-gated or shape-only.
    expect(splitTextUnits("ALL WORK N.I.C. SEE SPEC", new Set(["nic"]))).toEqual(["ALL WORK N.I.C. SEE SPEC"]);
    expect(splitTextUnits("STUDS AT 16 O.C. TYP")).toEqual(["STUDS AT 16 O.C. TYP"]);
    expect(splitTextUnits("MOUNT 7'-0\" A.F.F. U.L. LISTED")).toEqual(["MOUNT 7'-0\" A.F.F. U.L. LISTED"]);
  });

  it("shape-only default is PLAN §6.1's regex exactly (and so keeps 'NOTE. NEXT' together)", () => {
    const plan = (s: string) =>
      s.split(/\n|;|(?<!\b[A-Z]{2,5})\.\s/).map((u) => u.trim()).filter(Boolean);
    const samples = [
      "END OF NOTE. NEXT",
      "end of note. next",
      "GYP. BD. ON MTL. STUD",
      "PROVIDE SEALANT; SEE SPEC.\nPAINTED GWB. TYP.",
      "XGYPSUM. BOARD",
      "A1B. C",
    ];
    for (const s of samples) expect(splitTextUnits(s), s).toEqual(plan(s));
    expect(splitTextUnits("END OF NOTE. NEXT")).toEqual(["END OF NOTE. NEXT"]);
    expect(splitTextUnits("end of note. next")).toEqual(["end of note", "next"]);
  });

  it("splits on newline and semicolon; drops empty units", () => {
    expect(splitTextUnits("CONCRETE;\n\nMASONRY ;STEEL")).toEqual(["CONCRETE", "MASONRY", "STEEL"]);
  });
});

describe("csi-tokenize: boundaryBefore (E1)", () => {
  const marked = (text: string) =>
    tokenize(text).filter((k) => k.boundaryBefore).map((k) => k.t);

  it.each([
    ["SEALANT. GYPSUM BOARD", "."],
    ["SEALANT; GYPSUM BOARD", ";"],
    ["SEALANT: GYPSUM BOARD", ":"],
    ["SEALANT (GYPSUM BOARD)", "("],
    ["SEALANT . GYPSUM BOARD", "a detached ."],
    ["SEALANT ;GYPSUM BOARD", "; leading the next word"],
  ])("%s → boundary before gypsum (%s)", (text) => {
    expect(marked(text)).toEqual(["gypsum"]);
  });

  it("is not set after an abbreviation dot (GYP.)", () => {
    expect(marked("GYP. BD. ON MTL. STUD")).toEqual([]);
    expect(marked("(GYP.) BOARD")).toEqual([]);
  });

  it("abbrevDot is shape-only, so an ALL-CAPS 2–5 letter word ending a sentence is exempt too", () => {
    // Same ambiguity as splitTextUnits' shape-only default: `PAINT.` looks like `GYP.`.
    expect(marked("PAINT. GYPSUM BOARD")).toEqual([]);
    // With a `known` set the exemption is gated (PLAN §5.4): PAINT is not an abbreviation.
    const known = new Set(["gyp", "bd", "mtl", "nic", "oc"]);
    expect(tokenize("PAINT. GYPSUM BOARD", undefined, known).filter((k) => k.boundaryBefore).map((k) => k.t)).toEqual(["gypsum"]);
    expect(tokenize("GYP. BD. ON MTL. STUD", undefined, known).filter((k) => k.boundaryBefore)).toEqual([]);
    // Dotted drawing abbreviations are abbreviation dots too (N.I.C., O.C., A.F.F., U.L.).
    expect(tokenize("ALL WORK N.I.C. LISTED", undefined, known).filter((k) => k.boundaryBefore)).toEqual([]);
    expect(tokenize("STUDS 16\" O.C. TYP").filter((k) => k.boundaryBefore)).toEqual([]);
    expect(marked("PAINT; GYPSUM BOARD")).toEqual(["gypsum"]);
  });

  it("is still set when a boundary follows the abbreviation dot", () => {
    expect(marked("GYP.; BOARD")).toEqual(["board"]);
  });

  it("is set after a non-abbreviation dot (mixed case, 6+ letters, digits)", () => {
    expect(marked("Paint. Gypsum")).toEqual(["gypsum"]);
    expect(marked("CONCRETE. MASONRY")).toEqual(["masonry"]);
  });

  it("counts boundaries inside dropped words but not a decimal point", () => {
    expect(marked("PAINT 1. GYPSUM")).toEqual(["gypsum"]);
    expect(marked("SEALANT 2.5 GAL")).toEqual([]);
  });

  it("is never set on the first token, nor by ')', ',', '-' or '/'", () => {
    expect(marked("(GYPSUM BOARD")).toEqual([]);
    expect(marked(". GYPSUM BOARD")).toEqual([]);
    expect(marked("GYPSUM), BOARD DOOR/FRAME FIRE-RATED")).toEqual([]);
  });

  it("is absent (not false) when there is no boundary", () => {
    for (const k of tokenize("HOLLOW METAL DOOR")) expect("boundaryBefore" in k).toBe(false);
  });
});

describe("csi-tokenize: insert whitelist parity", () => {
  it("covers the six pinned words", () => {
    expect(Object.keys(INSERT_WHITELIST).sort()).toEqual(
      ["fire-rated", "moisture-resistant", "panel", "sheet", "type", "wall"],
    );
  });

  it.each(Object.entries(INSERT_WHITELIST))("%s tokenizes to its normalized form", (orig, norm) => {
    expect(ts(orig).join(" ")).toBe(norm);
    expect(ts(norm).join(" ")).toBe(norm);
  });
});

describe("csi-tokenize: determinism", () => {
  it("same input twice gives deep-equal output", () => {
    const text = "HOLLOW METAL DOORS AND FRAMES; PTD. GYP. BD. R-19 INSULATION, ACOUSTICAL PANEL CEILINGS";
    expect(tokenize(text)).toEqual(tokenize(text));
    const vocab = new Set(["paint", "panel"]);
    expect(tokenize(text, vocab)).toEqual(tokenize(text, vocab));
    expect(splitTextUnits(text)).toEqual(splitTextUnits(text));
  });
});
