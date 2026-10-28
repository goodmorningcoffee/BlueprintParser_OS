// @vitest-environment node
// [table pipeline WP-3.J] Classic Accept / Notes Auto / Spec Auto on the paragraph engine (pure service level; the
// route wiring is in app/api/__tests__/regions-promote-engine.route.test.ts). Synthetic fixtures only (rule 12).
// Expected values were measured first (logs/TP-3/WP-3.J-probe3.log).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/csi-detect", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/csi-detect")>();
  return { ...orig, detectCsiFromGrid: vi.fn(), detectCsiCodes: vi.fn() };
});

import { detectCsiCodes, detectCsiFromGrid } from "@/lib/csi-detect";
import { readStructure } from "@/lib/parse-engine/read";
import { viewHash } from "@/lib/parse-engine/legacy-view";
import { zStructureModel } from "@/lib/parse-engine/schema";
import {
  classicAcceptOnEngine,
  notesAutoOnEngine,
  parseParagraphBox,
  specAutoOnEngine,
  textRegionKeyOf,
  type ClassicAcceptArgs,
} from "@/server/services/parse-engine/classic-paragraphs";
import type { CsiCode, TextractPageData } from "@/types";

type Box = [number, number, number, number];
const FIXTURES = join(process.cwd(), "src/lib/parse-engine/__fixtures__");
function fixture(id: string): { td: TextractPageData; region: Box; ltwh: Box; truth: { key: string; text: string }[] } {
  const f = JSON.parse(readFileSync(join(FIXTURES, `${id}.synthetic.json`), "utf8"));
  const r = f.region as Box;
  return { td: f.page as TextractPageData, region: r, ltwh: [r[0], r[1], r[2] - r[0], r[3] - r[1]], truth: f.truth.items };
}
const keyedTruth = (truth: { key: string; text: string }[]) =>
  truth.filter((i) => i.key !== "").map((i) => [i.key.replace(/^\(|[.)]$/g, ""), i.text]);

const AT = "2026-10-28T00:00:00.000Z";
const CODE = { code: "09 21 16", description: "Gypsum board", trade: "Finishes", division: "09" } as unknown as CsiCode;

function accept(id: string, kind: "notes" | "spec", type: string, over: Partial<ClassicAcceptArgs> = {}) {
  const { td, ltwh } = fixture(id);
  return classicAcceptOnEngine({
    kind, page: 3, textRegion: { type, bbox: ltwh }, textractData: td, tableName: "General Notes p.3",
    csiSeed: [], csiCtx: null, previous: null, at: AT, ...over,
  });
}

beforeEach(() => {
  vi.mocked(detectCsiFromGrid).mockReset().mockReturnValue([]);
  vi.mocked(detectCsiCodes).mockReset().mockReturnValue([]);
});

describe("classicAcceptOnEngine — notes (notesClassifier = engine)", () => {
  it("stores the legacy projection + structure/links/engine/recipe; readStructure trusts it (E-5)", async () => {
    const { data, csiTags } = await accept("syn-notes-subblocks", "notes", "notes-numbered");
    expect(Object.keys(data)).toEqual(["headers", "rows", "tagColumn", "rowCount", "columnCount", "rowBoundaries", "tableName", "structure", "links", "engine", "recipe"]);
    expect(data).toMatchObject({ headers: ["Key", "Note"], tagColumn: "Key", columnCount: 2, rowCount: 8, tableName: "General Notes p.3" });
    expect((data.rows as { Key: string }[]).map((r) => r.Key)).toEqual(["1", "2", "3", "4", "5", "1", "2", "3"]); // C04-10
    expect((data.rowBoundaries as number[]).length).toBe(9); // closed bands (C04-13)
    expect(zStructureModel.safeParse(data.structure).success).toBe(true);
    expect((data.structure as { blocks: { header: string | null }[] }).blocks.map((b) => b.header)).toEqual(["GENERAL NOTES", "ELECTRICAL NOTES"]);
    expect(data.links).toEqual({
      origin: "classic-engine", revision: 1, viewHash: viewHash(data),
      textRegionKey: textRegionKeyOf("notes-numbered", fixture("syn-notes-subblocks").region), acceptedAt: AT,
    });
    expect(data.recipe).toEqual({ origin: "text-region", request: { page: 3, bbox: fixture("syn-notes-subblocks").region, kind: "notes", budget: "instant" } });
    expect((data.engine as { budget: string; caps: Record<string, number> }).budget).toBe("instant");
    expect(Object.keys((data.engine as { caps: object }).caps).sort()).toEqual(["evidence", "kind", "paragraphs", "title"]);
    const read = readStructure({ type: "notes", data });
    expect(read).toMatchObject({ origin: "workspace", editedInClassic: false });
    expect(read.model).toEqual(data.structure);
    expect(csiTags).toEqual([]);
    expect(detectCsiFromGrid).toHaveBeenCalledWith(data.headers, data.rows, undefined, undefined);
  });

  it("a later classic edit of the projection reads as 'edited in Classic'", async () => {
    const { data } = await accept("syn-notes-subblocks", "notes", "notes-numbered");
    const edited = { ...data, rows: [...(data.rows as object[]).slice(1)] };
    expect(readStructure({ type: "notes", data: edited })).toMatchObject({ origin: "classic", editedInClassic: true });
  });

  it("the C04 probes through Accept: wrapped notes, 2.5 MM, two columns, key-value legend", async () => {
    for (const id of ["syn-notes-wrapped-hanging", "syn-notes-dimension-start", "syn-notes-two-column"]) {
      const { data } = await accept(id, "notes", "notes-numbered");
      expect((data.rows as { Key: string; Note: string }[]).filter((r) => r.Key).map((r) => [r.Key, r.Note])).toEqual(keyedTruth(fixture(id).truth));
    }
    // C04-04: the stored legacy grid of this region is key-only/value-only rows; the engine re-reads the box as pairs.
    const { data } = await accept("syn-kv-abbrev", "notes", "notes-key-value");
    expect((data.rows as { Key: string; Note: string }[]).map((r) => [r.Key, r.Note])).toEqual(keyedTruth(fixture("syn-kv-abbrev").truth));
  });

  it("CSI: a non-empty seed suppresses detection (the legacy seed rule); detected codes are returned", async () => {
    const seeded = await accept("syn-notes-subblocks", "notes", "notes-numbered", { csiSeed: [CODE] });
    expect(seeded.csiTags).toEqual([CODE]);
    expect(detectCsiFromGrid).not.toHaveBeenCalled();
    vi.mocked(detectCsiFromGrid).mockReturnValue([CODE]);
    expect((await accept("syn-notes-subblocks", "notes", "notes-numbered")).csiTags).toEqual([CODE]);
    vi.mocked(detectCsiFromGrid).mockImplementation(() => { throw new Error("kb down"); });
    expect((await accept("syn-notes-subblocks", "notes", "notes-numbered")).csiTags).toEqual([]); // non-fatal
  });

  it("re-accepting over a region (overrides.regionId) bumps its revision", async () => {
    const { data } = await accept("syn-notes-subblocks", "notes", "notes-numbered", { previous: { data: { links: { revision: 2 } } } });
    expect((data.links as { revision: number }).revision).toBe(3);
    const fresh = await accept("syn-notes-subblocks", "notes", "notes-numbered", { previous: { data: { headers: [] } } });
    expect((fresh.data.links as { revision: number }).revision).toBe(1);
  });

  it("refuses with the legacy 400 messages: no OCR, nothing in the box", async () => {
    const msg = "Could not bind grid from textRegion — try the Parser Manual mode instead";
    await expect(accept("syn-notes-subblocks", "notes", "notes-numbered", { textractData: null })).rejects.toMatchObject({ code: "VALIDATION", message: msg });
    await expect(accept("syn-notes-subblocks", "notes", "notes-numbered", { textRegion: { type: "notes-numbered", bbox: [0.01, 0.01, 0.02, 0.02] } }))
      .rejects.toMatchObject({ code: "VALIDATION", message: msg });
    await expect(accept("syn-notes-subblocks", "notes", "notes-numbered", { textRegion: { type: "notes-numbered", bbox: [0.5, 0.5, 0, 0.1] } }))
      .rejects.toMatchObject({ code: "VALIDATION", message: msg });
  });
});

describe("classicAcceptOnEngine — spec (specClassifier = engine)", () => {
  it("the spec hierarchy reaches sections + structure (1.01 › A), CSI over the section text, viewHash covers csiTags", async () => {
    vi.mocked(detectCsiCodes).mockReturnValue([CODE]);
    const { data, csiTags } = await accept("syn-spec-section", "spec", "spec-text", { tableName: "Spec p.3" });
    expect(Object.keys(data)).toEqual(["sections", "tableName", "csiTags", "structure", "links", "engine", "recipe"]);
    const sections = data.sections as { sectionHeader: string; body: string }[];
    expect(sections.map((s) => s.sectionHeader)).toEqual(["SECTION 09 21 16 - ZFKMP ZYSFM", "PART 1 GENERAL", "PART 2 PRODUCTS"]);
    expect(sections[1].body.split("\n").map((l) => l.split(" ")[0])).toEqual(["1.01", "A.", "B.", "1.02", "A."]);
    const structure = data.structure as { kind: string; spec?: { section?: string }; paragraphs: { keyPath: string[]; depth: number }[] };
    expect(structure.kind).toBe("spec");
    expect(structure.paragraphs.map((p) => p.keyPath.join(" › "))).toEqual(["1.01", "1.01 › A", "1.01 › B", "1.02", "1.02 › A", "2.01", "2.01 › A"]);
    expect(structure.paragraphs.map((p) => p.depth)).toEqual([0, 1, 1, 0, 1, 0, 1]);
    expect(csiTags).toEqual([CODE]);
    expect(data.csiTags).toEqual([CODE]);
    const text = sections.map((s) => `${s.sectionHeader}\n${s.body}`).join("\n\n");
    expect(detectCsiCodes).toHaveBeenCalledWith(text, undefined, undefined, undefined);
    expect(readStructure({ type: "spec", data })).toMatchObject({ origin: "workspace", editedInClassic: false });
    expect(readStructure({ type: "spec", data: { ...data, csiTags: [] } })).toMatchObject({ editedInClassic: true });
  });

  it("a sentence that starts 'see note 4' does not open a section (C04-09)", async () => {
    const { data } = await accept("syn-spec-sentence-header-trap", "spec", "spec-text");
    const sections = data.sections as { sectionHeader: string; body: string }[];
    expect(sections.map((s) => s.sectionHeader)).toEqual(["SECTION 06 10 00 - ZFKMP"]);
    expect((data.structure as { paragraphs: { keyPath: string[] }[] }).paragraphs.map((p) => p.keyPath.join(">"))).toEqual(["1.01", "1.01>A", "1.01>B", "1.02"]);
  });

  it("refuses with the legacy spec messages", async () => {
    await expect(accept("syn-spec-section", "spec", "spec-text", { textractData: null }))
      .rejects.toMatchObject({ code: "VALIDATION", message: "Page has no OCR data for spec binding" });
    await expect(accept("syn-spec-section", "spec", "spec-text", { textRegion: { type: "spec-text", bbox: [0.01, 0.01, 0.02, 0.02] } }))
      .rejects.toMatchObject({ code: "VALIDATION", message: "Could not detect spec section headers in region — try the Parser Manual mode instead" });
  });
});

describe("Notes Auto / Spec Auto on the engine (notesAuto / specAuto = engine)", () => {
  it("notes: the legacy response shape (+ structure, engine); CSI mapped to {code, description}", async () => {
    vi.mocked(detectCsiFromGrid).mockReturnValue([CODE]);
    const { td, region } = fixture("syn-notes-subblocks");
    const res = await notesAutoOnEngine({ page: 3, regionBbox: region, textractData: td, csiCtx: null });
    expect(Object.keys(res)).toEqual(["headers", "rows", "rowBoundaries", "csiTags", "structure", "engine"]);
    expect(res.headers).toEqual(["Key", "Note"]);
    expect((res.rows as { Key: string }[]).map((r) => r.Key)).toEqual(["1", "2", "3", "4", "5", "1", "2", "3"]);
    expect(res.csiTags).toEqual([{ code: CODE.code, description: CODE.description }]);
    expect((res.structure as { kind: string }).kind).toBe("notes");
  });

  it("notes: an empty box gives the legacy no-result shape", async () => {
    const { td } = fixture("syn-notes-subblocks");
    expect(await notesAutoOnEngine({ page: 3, regionBbox: [0.01, 0.01, 0.02, 0.02], textractData: td, csiCtx: null }))
      .toEqual({ headers: [], rows: [], csiTags: [], note: "No numbered items detected in region" });
  });

  it("spec: sections + one top per section + unmapped CSI with pageKind spec; empty box → the legacy note", async () => {
    vi.mocked(detectCsiCodes).mockReturnValue([CODE]);
    const { td, region } = fixture("syn-spec-section");
    const res = await specAutoOnEngine({ page: 3, regionBbox: region, textractData: td, csiCtx: null });
    expect(Object.keys(res)).toEqual(["sections", "rowBoundaries", "csiTags", "structure", "engine"]);
    expect((res.sections as unknown[]).length).toBe(3);
    expect(res.rowBoundaries).toEqual([0.15, 0.16365, 0.26865]);
    expect(res.csiTags).toEqual([CODE]);
    expect(vi.mocked(detectCsiCodes).mock.calls[0][1]).toEqual({ context: { pageKind: "spec" } });
    expect(await specAutoOnEngine({ page: 3, regionBbox: [0.01, 0.01, 0.02, 0.02], textractData: td, csiCtx: null }))
      .toEqual({ sections: [], csiTags: [], note: "No spec section headers detected in region" });
  });

  it("is deterministic: the same box twice gives the same model and stamp except the clock (E-7)", async () => {
    const { td, region } = fixture("syn-notes-two-column");
    const a = await parseParagraphBox({ page: 1, bbox: region, kind: "notes", textractData: td });
    const b = await parseParagraphBox({ page: 1, bbox: region, kind: "notes", textractData: td });
    expect(JSON.stringify(a!.result.model)).toBe(JSON.stringify(b!.result.model));
    expect({ ...a!.result.stamp, at: "" }).toEqual({ ...b!.result.stamp, at: "" });
  });

  it("the text-region key is WP-3.F's content key (MinMax, two decimals)", () => {
    expect(textRegionKeyOf("notes-numbered", [0.1234, 0.5, 0.987, 0.6666])).toBe("tr:notes-numbered:0.12,0.50,0.99,0.67");
  });
});
