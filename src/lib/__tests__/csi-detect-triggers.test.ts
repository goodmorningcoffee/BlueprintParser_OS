/**
 * csi-detect-triggers.test.ts — CSI trigger/TIER labeling FREEZE-FIRST baseline.
 *
 * [csi-rebuild P0.2] Companion to csi-detect.test.ts, which pins the engine's
 * CODE output. This file pins the other half: the per-word TRIGGER output and
 * the tier each trigger is labeled with.
 *
 * WHY A NEW FILE: csi-detect.test.ts carries an explicit "everything above this
 * block is the untouched C0 freeze-first baseline" contract (its line ~173).
 * These pins are a different arc; keeping them separate leaves that contract
 * legible.
 *
 * WHY IT MATTERS: before this file, NO test in the suite called detectCsiCodes
 * with a real `textractWords` array — every existing call passes `undefined` —
 * so `collectTriggersForEntry`, `normalizeTextractWords`, and the anchor
 * labeling path had zero coverage. The rebuild (PLAN P2) flips tier meaning to
 * evidence-strength. Without these pins that flip would land silently.
 *
 * THE INVERSION BEING FROZEN (this is the defect, pinned deliberately, NOT a
 * bug to fix here): the engine labels the RAREST / most diagnostic word of an
 * entry as tier 3, and ordinary phrase words as tier 2. The downstream ingest
 * then maps tier → confidence as
 *
 *     CSI_TIER_CONF = {1: 0.95, 2: 0.70, 3: 0.50}
 *     # tier -> confidence for CSI trigger marks (1=exact phrase, 2=bag-of-words, 3=anchor)
 *
 * (in the downstream heatmap ingest, `ingest/marks.py:54` — that file lives
 * outside this repo, under gitignore/brainstorms_notes/rebuild_notes/, so it is
 * quoted here rather than imported). The comment there says "3=anchor" — so the
 * strongest evidence class is knowingly assigned the LOWEST confidence.
 *
 * Corpus scale of the inversion, from the P0.1 baseline over all 471 pages:
 * 206,106 tier-3 triggers vs 19,949 tier-2 and 32 tier-1. ~91% of all evidence
 * is the tier weighted 0.50.
 *
 * When P2 flips tier semantics, these tests SHOULD fail. That is their job.
 * Update them deliberately, in the same commit as the flip.
 */
import { describe, it, expect } from "vitest";
import { detectCsiCodes } from "@/lib/csi-detect";
import { parseCsiTsv, type CsiDatabase, type CsiEntry } from "@/lib/csi-database";
import type { CsiCode, CsiCodeTrigger, TextractWord } from "@/types";

// ═══════════════════════════════════════════════════════════════
// Controlled fixture DB
//
// Frequencies are engineered so the anchor set is UNAMBIGUOUS — no reliance on
// sort tie-breaking. getAnchorWords takes the 4 rarest of an entry's
// phraseWords, so for entry 90 00 01:
//
//   zebra 1 · flange 1 · gasket 1 · widget 2 · spindle 3
//   → anchors = {zebra, flange, gasket, widget};  spindle is NOT an anchor.
//
// The three ties at frequency 1 are all inside the top 4 either way, so the
// SET is fixed regardless of how ties order.
// ═══════════════════════════════════════════════════════════════

const FIXTURE_TSV = [
  "col0\tcol1\tcode\tdescription\ttrade\tdivision",
  "x\tx\t90 00 01\tzebra flange gasket widget spindle\tFixture Trade\t90 00 00",
  "x\tx\t90 00 02\twidget spindle assembly panel\tFixture Trade\t90 00 00",
  "x\tx\t90 00 03\tspindle panel bracket cover\tFixture Trade\t90 00 00",
  "x\tx\t90 00 04\tpanel cover bracket mount\tFixture Trade\t90 00 00",
].join("\n");

const DB = parseCsiTsv(FIXTURE_TSV);
const TARGET = "90 00 01";

/** The anchors of the target entry, per the frequency table above. */
const ANCHORS = ["zebra", "flange", "gasket", "widget"];
/** A phrase word of the target entry that is NOT an anchor (too common). */
const NON_ANCHOR = "spindle";

/** Build a TextractWord list from tokens, with deterministic non-overlapping bboxes. */
function words(tokens: string[]): TextractWord[] {
  return tokens.map((text, i) => ({
    text,
    confidence: 99,
    // Explicit, binary-exact values — no 0.1*i float drift.
    bbox: [i / 8, 0.25, 0.0625, 0.03125] as [number, number, number, number],
  }));
}

function triggersOf(result: CsiCode[], code: string): CsiCodeTrigger[] {
  const hit = result.find(r => r.code === code);
  expect(hit, `expected ${code} to be detected`).toBeDefined();
  return hit!.triggers ?? [];
}

const asPairs = (ts: CsiCodeTrigger[]) => ts.map(t => [t.text, t.tier] as const);

describe("frequency fixture sanity (guards the tests below)", () => {
  it("word frequencies make the anchor set unambiguous", () => {
    expect(DB.entries).toHaveLength(4);
    expect(DB.wordFrequency.get("zebra")).toBe(1);
    expect(DB.wordFrequency.get("flange")).toBe(1);
    expect(DB.wordFrequency.get("gasket")).toBe(1);
    expect(DB.wordFrequency.get("widget")).toBe(2);
    expect(DB.wordFrequency.get("spindle")).toBe(3);

    const target = DB.entries.find(e => e.code === TARGET)!;
    expect(target.wordCount).toBe(5);
    expect(target.phraseWords).toEqual([...ANCHORS, NON_ANCHOR]);
  });
});

describe("trigger tiers — THE INVERSION (rarest word gets the LOWEST downstream confidence)", () => {
  // Scattered so no consecutive allWords span exists → tier 1 cannot fire and
  // the tier-3/tier-2 split is observable on its own.
  const TOKENS = ["zebra", "alpha", "flange", "beta", "gasket", "gamma", "widget", "delta", "spindle"];
  const TEXT = TOKENS.join(" ");

  it("anchors are labeled tier 3 and ordinary phrase words tier 2", () => {
    const result = detectCsiCodes(TEXT, words(TOKENS), undefined, DB);
    const pairs = asPairs(triggersOf(result, TARGET));

    // Tier 3 is collected BEFORE tier 2, so anchors come first in page order.
    expect(pairs).toEqual([
      ["zebra", 3],
      ["flange", 3],
      ["gasket", 3],
      ["widget", 3],
      ["spindle", 2],
    ]);
  });

  it("the inversion, stated as an assertion: more diagnostic ⇒ lower confidence", () => {
    // Quoted from ingest/marks.py:54 (downstream, outside this repo).
    const CSI_TIER_CONF: Record<1 | 2 | 3, number> = { 1: 0.95, 2: 0.7, 3: 0.5 };

    const result = detectCsiCodes(TEXT, words(TOKENS), undefined, DB);
    const ts = triggersOf(result, TARGET);

    const rarest = ts.find(t => t.text === "zebra")!;   // document frequency 1
    const common = ts.find(t => t.text === NON_ANCHOR)!; // document frequency 3

    // "zebra" identifies the entry almost uniquely; "spindle" is shared by 3 of
    // 4 entries. Evidence strength says zebra > spindle.
    expect(DB.wordFrequency.get("zebra")!).toBeLessThan(DB.wordFrequency.get(NON_ANCHOR)!);

    // …yet the tier it receives maps to a STRICTLY LOWER confidence downstream.
    expect(CSI_TIER_CONF[rarest.tier]).toBeLessThan(CSI_TIER_CONF[common.tier]);
    expect(CSI_TIER_CONF[rarest.tier]).toBe(0.5);
    expect(CSI_TIER_CONF[common.tier]).toBe(0.7);
  });
});

describe("trigger tiers — labeling priority is phrase > anchor > word, one label per word INDEX", () => {
  it("a consecutive span consumes its words: one tier-1 trigger, no tier-2/3 for those indices", () => {
    const tokens = ["alpha", "zebra", "flange", "gasket", "widget", "spindle", "beta"];
    const result = detectCsiCodes(tokens.join(" "), words(tokens), undefined, DB);
    const ts = triggersOf(result, TARGET);

    // Every phrase word sits inside the span, so tier 1 is the ONLY label —
    // even though zebra/flange/gasket/widget are anchors.
    expect(ts).toHaveLength(1);
    expect(ts[0].tier).toBe(1);
    expect(ts[0].text).toBe("zebra flange gasket widget spindle");
  });

  it("labels are per-INDEX, not per-word: a repeat outside the span still gets its own tier-3 label", () => {
    //                 0        1       2        3         4         5          6
    const tokens = ["zebra", "beta", "zebra", "flange", "gasket", "widget", "spindle"];
    const result = detectCsiCodes(tokens.join(" "), words(tokens), undefined, DB);
    const ts = triggersOf(result, TARGET);

    // Span matches at indices 2..6. The zebra at index 0 is untouched by the
    // span and is an anchor, so it is labeled tier 3 on its own.
    expect(asPairs(ts)).toEqual([
      ["zebra flange gasket widget spindle", 1],
      ["zebra", 3],
    ]);
  });

  it("tier-1 bbox is the union across the matched span", () => {
    const tokens = ["alpha", "zebra", "flange", "gasket", "widget", "spindle", "beta"];
    const ws = words(tokens);
    const result = detectCsiCodes(tokens.join(" "), ws, undefined, DB);
    const span = triggersOf(result, TARGET)[0];

    // Span covers indices 1..5. Each word is [i/8, 0.25, 0.0625, 0.03125].
    const first = ws[1].bbox;
    const last = ws[5].bbox;
    const expectedLeft = first[0];
    const expectedRight = last[0] + last[2];
    expect(span.bbox[0]).toBeCloseTo(expectedLeft, 10);
    expect(span.bbox[1]).toBeCloseTo(0.25, 10);
    expect(span.bbox[2]).toBeCloseTo(expectedRight - expectedLeft, 10);
    expect(span.bbox[3]).toBeCloseTo(0.03125, 10); // all words share one row
  });
});

describe("anchor selection mechanics", () => {
  it("only the 4 RAREST phrase words are anchors — the 5th falls through to tier 2", () => {
    const tokens = ["zebra", "alpha", "flange", "beta", "gasket", "gamma", "widget", "delta", "spindle"];
    const result = detectCsiCodes(tokens.join(" "), words(tokens), undefined, DB);
    const ts = triggersOf(result, TARGET);

    const tier3Words = ts.filter(t => t.tier === 3).map(t => t.text);
    expect(tier3Words).toHaveLength(4); // getAnchorWords topN default
    expect(new Set(tier3Words)).toEqual(new Set(ANCHORS));
    expect(tier3Words).not.toContain(NON_ANCHOR);
  });

  it("an EMPTY wordFrequency map falls back to the first N phrase words (documented guard)", () => {
    // Hand-built bundle: parseCsiTsv can never produce an empty frequency map
    // alongside non-empty entries, but the guard at getAnchorWords exists for
    // the builtin-DB-file-not-found path, which memoizes an empty bundle.
    const entry: CsiEntry = {
      code: "91 00 01",
      phraseWords: ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"],
      allWords: ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"],
      description: "alpha bravo charlie delta echo foxtrot",
      trade: "Fixture Trade",
      division: "91 00 00",
      wordCount: 6,
    };
    const emptyFreqDb: CsiDatabase = { entries: [entry], wordFrequency: new Map() };

    // Scattered so tier 1 cannot fire and the anchor split is visible.
    const tokens = ["alpha", "x1", "bravo", "x2", "charlie", "x3", "delta", "x4", "echo", "x5", "foxtrot"];
    const result = detectCsiCodes(tokens.join(" "), words(tokens), undefined, emptyFreqDb);
    const ts = triggersOf(result, "91 00 01");

    // slice(0, 4) of phraseWords — positional, not frequency-ranked.
    expect(ts.filter(t => t.tier === 3).map(t => t.text)).toEqual(["alpha", "bravo", "charlie", "delta"]);
    expect(ts.filter(t => t.tier === 2).map(t => t.text)).toEqual(["echo", "foxtrot"]);
  });
});

describe("word normalization parity between detection and trigger collection", () => {
  it("QUIRK: punctuation is NOT stripped, so a trigger can be missed for a word detection matched", () => {
    // rawText and the Textract word list disagree only in punctuation. Detection
    // tokenizes rawText on whitespace; trigger collection lowercases the word
    // text and nothing more. So "gasket," never equals "gasket".
    const tokens = ["zebra", "alpha", "flange", "beta", "gasket", "gamma", "widget", "delta", "spindle"];
    const ws = words(tokens);
    ws[4] = { ...ws[4], text: "gasket," };

    // rawText keeps the CLEAN token, so the code is still detected…
    const result = detectCsiCodes(tokens.join(" "), ws, undefined, DB);
    const ts = triggersOf(result, TARGET);

    // …but no trigger is produced for the punctuated word.
    expect(ts.map(t => t.text)).not.toContain("gasket");
    expect(ts.map(t => t.text)).not.toContain("gasket,");
    expect(ts.filter(t => t.tier === 3)).toHaveLength(3); // one anchor lost
  });

  it("uppercase Textract text still matches (lowercasing IS applied)", () => {
    const tokens = ["zebra", "alpha", "flange", "beta", "gasket", "gamma", "widget", "delta", "spindle"];
    const ws = words(tokens).map(w => ({ ...w, text: w.text.toUpperCase() }));
    const result = detectCsiCodes(tokens.join(" "), ws, undefined, DB);
    expect(triggersOf(result, TARGET)).toHaveLength(5);
  });

  it("empty-text words are skipped rather than labeled", () => {
    const tokens = ["zebra", "alpha", "flange", "beta", "gasket", "gamma", "widget", "delta", "spindle"];
    const ws = words(tokens);
    ws.splice(1, 0, { text: "", confidence: 99, bbox: [0.9, 0.9, 0.01, 0.01] });
    const result = detectCsiCodes(tokens.join(" "), ws, undefined, DB);
    const ts = triggersOf(result, TARGET);
    expect(ts.map(t => t.text)).not.toContain("");
    expect(ts).toHaveLength(5);
  });
});

describe("the triggers key itself", () => {
  it("omitting textractWords omits the key entirely — it is absent, not an empty array", () => {
    const tokens = ["zebra", "alpha", "flange", "beta", "gasket", "gamma", "widget", "delta", "spindle"];
    const result = detectCsiCodes(tokens.join(" "), undefined, undefined, DB);
    const hit = result.find(r => r.code === TARGET)!;
    expect(hit).toBeDefined();
    expect("triggers" in hit).toBe(false);
  });

  it("triggers are collected ONLY for codes that cleared the confidence threshold", () => {
    const tokens = ["zebra", "alpha", "flange", "beta", "gasket", "gamma", "widget", "delta", "spindle"];
    const ws = words(tokens);

    // Entry 90 00 02 shares widget+spindle with the input but scores
    // (2/4)² × 0.75 = 0.1875 — below the 0.4 gate.
    const result = detectCsiCodes(tokens.join(" "), ws, undefined, DB);
    expect(result.map(r => r.code)).toEqual([TARGET]);

    // Drop the threshold and it appears, now WITH triggers of its own.
    const loose = detectCsiCodes(tokens.join(" "), ws, { matchingConfidenceThreshold: 0.1 }, DB);
    const second = loose.find(r => r.code === "90 00 02");
    expect(second).toBeDefined();
    expect(second!.triggers!.length).toBeGreaterThan(0);
  });
});
