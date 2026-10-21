/**
 * csi-capture-v2.test.ts — the CSI v2 S5 capture harness (`eval/csi/capture-v2.ts`, PLAN §8).
 *
 * The capture decides what compare.ts / sweep-tau.ts score, so: the corpus ⋈ lines join must fail
 * loud, the context must be exactly the S6 call's (PLAN §7), the τ=0 details must re-derive the
 * default-config codes, no drawing text may reach the build/ capture, and the two integrity checks
 * that need the KB must count what they say. Synthetic generic trade phrases only, no client text.
 * KB-backed describes `skipIf(!HAS_KB)` (src/data/csi-kb.json is gitignored, owner ruling D1).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadCsiKbFromFile } from "@/lib/csi-kb";
import type { LoadedKb } from "@/lib/csi-kb-types";
import type { V2Result } from "@/lib/csi-page";
import type { BboxLTWH, TextractLine } from "@/types";
import { capturePage, contextOf, inputOf, joinCorpus, pageChecks, type CorpusRow, type Joined } from "../../../eval/csi/capture-v2";
import { deriveAtTau } from "../../../eval/csi/sweep-tau";

const KB_REL = "src/data/csi-kb.json";
const HAS_KB = existsSync(join(process.cwd(), KB_REL));
let kb: LoadedKb;
beforeAll(() => {
  if (HAS_KB) kb = loadCsiKbFromFile(join(process.cwd(), KB_REL));
});

function line(text: string, y = 0.1): TextractLine {
  const ws = text.split(/\s+/).filter(Boolean);
  return {
    text, confidence: 99, bbox: [0.1, y, 0.01 * ws.length, 0.01],
    words: ws.map((w, i) => ({ text: w, confidence: 99, bbox: [0.1 + 0.01 * i, y, 0.009, 0.01] as BboxLTWH })),
  };
}
const row = (over: Partial<CorpusRow> = {}): CorpusRow => ({ bundle: "b", pageNumber: 1, drawingNumber: "A-101", discipline: "A", rawText: "x".repeat(20), ...over });
const joined = (texts: string[], over: Partial<CorpusRow> = {}): Joined => ({ row: row({ rawText: texts.join("\n"), ...over }), lines: texts.map((t, i) => line(t, 0.05 * (i + 1))) });

describe("capture-v2: join and the S6 call shape", () => {
  it("joins on bundle:pageNumber in corpus order; a missing or duplicated key throws", () => {
    const c = [row({ pageNumber: 2 }), row({ pageNumber: 1 })];
    const l = [{ bundle: "b", pageNumber: 1, lines: [] }, { bundle: "b", pageNumber: 2, lines: [line("X")] }];
    expect(joinCorpus(c, l).map((j) => [j.row.pageNumber, j.lines.length])).toEqual([[2, 1], [1, 0]]);
    expect(() => joinCorpus([row({ pageNumber: 3 })], l)).toThrow(/no lines row/);
    expect(() => joinCorpus(c, [...l, l[0]])).toThrow(/duplicate lines row/);
    expect(() => joinCorpus([c[0], c[0]], l)).toThrow(/duplicate corpus row/);
  });

  it("context = { discipline, drawingNumber } with absent fields omitted; noctx carries none", () => {
    expect(contextOf(row())).toEqual({ discipline: "A", drawingNumber: "A-101" });
    expect(contextOf(row({ discipline: null, drawingNumber: null }))).toEqual({});
    const j = joined(["GYPSUM BOARD"]);
    expect(inputOf(j, true)).toEqual({ lines: j.lines, context: { discipline: "A", drawingNumber: "A-101" } });
    expect(inputOf(j, false)).toEqual({ lines: j.lines });
    expect(inputOf(j, false, "text")).toEqual({ text: "GYPSUM BOARD" });
  });
});

describe.skipIf(!HAS_KB)("capture-v2: page rows", () => {
  it("rawText under 10 characters is skipped like the live contract (no detect call)", () => {
    const r = capturePage(joined(["GWB"]), kb, { withContext: true });
    expect(r.res0).toBeNull();
    expect(r.page.codes).toEqual([]);
    expect(r.page.codeDetails).toEqual([]);
  });

  it("codes at the default config; τ=0 details re-derive them at 0.75; no drawing text in the row", () => {
    const j = joined(["PROVIDE HOLLOW METAL DOORS AND FRAMES TYP.", "PAINTED GYPSUM BOARD PARTITIONS AT CORRIDOR", "SEALANT AT ALL JOINTS UNO"]);
    const { page, res0 } = capturePage(j, kb, { withContext: true });
    expect(page.codes.length).toBeGreaterThan(0);
    expect(page.codes).toContain("08 11 13");
    expect(deriveAtTau({ bundle: "b", page: 1, codes: [], codeDetails: page.codeDetails }, 0.75, 40).sort()).toEqual(page.codes);
    for (const d of page.codeDetails) expect(typeof d.confidence).toBe("number");
    const json = JSON.stringify(page);
    for (const t of j.lines) expect(json.toUpperCase()).not.toContain(t.text);
    expect(json).not.toMatch(/"text"|"bbox"/);
    expect(res0?.spans.length).toBeGreaterThan(0); // the private dump keeps the text
    expect(page.checks.childWithoutDiffToken).toBe(0);
    expect(page.checks.parentBesideDescendantSameRange).toBe(0);
    expect(page.checks.emittedCodes).toBeLessThanOrEqual(page.checks.emittedSpans);
  });
});

describe.skipIf(!HAS_KB)("capture-v2: integrity checks count what they say", () => {
  const span = (code: string, pattern: string, tokenStart: number, tokenEnd: number) =>
    ({ code, pattern, source: "title" as const, emitted: true, line: 0, tokenStart, tokenEnd, text: "", tier: 1 as const });
  const result = (spans: ReturnType<typeof span>[]): V2Result => ({ codes: [], spans, divisionHints: [] });

  it("childWithoutDiffToken: an emitted child span whose pattern's diff token is outside the range", () => {
    const lines = [line("HOLLOW METAL DOORS")];
    // 08 12 13 "Hollow Metal Frames": diff = {hollow} (the anchor) — present → 0; a range that skips it → 1
    expect(pageChecks(result([span("08 12 13", "Hollow Metal Frames", 0, 1)]), lines, kb).childWithoutDiffToken).toBe(0);
    expect(pageChecks(result([span("08 12 13", "Hollow Metal Frames", 1, 2)]), lines, kb).childWithoutDiffToken).toBe(1);
  });

  it("a span whose (code, source, pattern) is no KB pattern is a family owner, not a diff miss", () => {
    const c = pageChecks(result([span("08 10 00", "Hollow Metal Frames", 1, 2)]), [line("HOLLOW METAL DOORS")], kb);
    expect([c.familySpans, c.childWithoutDiffToken]).toEqual([1, 0]);
  });

  it("parentBesideDescendantSameRange: same line and overlapping → counted; disjoint or other line → not", () => {
    const lines = [line("HOLLOW METAL DOORS AND FRAMES")];
    const p = span("08 11 00", "Metal Doors and Frames", 1, 4), d = span("08 11 13", "Hollow Metal Doors and Frames", 0, 3);
    expect(pageChecks(result([p, d]), lines, kb).parentBesideDescendantSameRange).toBe(1);
    expect(pageChecks(result([{ ...p, tokenStart: 4, tokenEnd: 4 }, { ...d, tokenEnd: 3 }]), lines, kb).parentBesideDescendantSameRange).toBe(0);
    expect(pageChecks(result([{ ...p, line: 1 }, d]), [...lines, line("X")], kb).parentBesideDescendantSameRange).toBe(0);
  });
});
