// @vitest-environment node
// [table pipeline WP-3.D] Correction ops (E-2), snapshots and replay, on engine results of the committed synthetic
// fixtures (rule 12: pseudo-text only). Every op type previews from the ParseResult alone (no fetch), applyOps is
// pure and idempotent for the idempotent ops, lost ops are reported, and ops replay onto a re-parse whose ids were
// re-matched through `prior`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cellTextMatrix } from "../cells";
import { runParseEngine } from "../engine";
import { applyOps, applyOpsDetailed, paragraphLines } from "../ops";
import { DEFAULT_PROFILE } from "../profile";
import { replayPlan, replayRegion } from "../replay-core";
import { diffSnapshots, snapshotHash, snapshotOf, stableHash } from "../snapshot";
import { zStructureModel } from "../schema";
import { CAPABILITY_VERSIONS } from "../version";
import type { CorrectionOp, EnginePageEvidence, ParseResult, StructureParagraphDoc, StructureTableModel } from "../types";
import { AT, fixture, fixtureEvidence, fixtureRequest } from "./engine-helpers";

const parse = (id: string, over: Parameters<typeof fixtureRequest>[1] = {}, ev?: EnginePageEvidence): Promise<ParseResult> => {
  const f = fixture(id);
  return runParseEngine(ev ?? fixtureEvidence(f), fixtureRequest(f, over), { at: AT, profile: DEFAULT_PROFILE });
};
const T = (m: unknown): StructureTableModel => m as StructureTableModel;
const P = (m: unknown): StructureParagraphDoc => m as StructureParagraphDoc;
const text = (m: StructureTableModel, row: string, col: string): string => m.cells.find((c) => c.row === row && c.col === col)?.text ?? "";
const matrix = (m: StructureTableModel): string[][] => cellTextMatrix(m.cells, m.rows.map((r) => r.id), m.cols.map((c) => c.id));

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(() => { throw new Error("applyOps must not fetch"); });
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => vi.unstubAllGlobals());

describe("applyOps: purity, identity, lost ops", () => {
  it("no ops → the fused model, unchanged; the base result is never mutated (deep-frozen)", async () => {
    const base = deepFreeze(await parse("syn-sched-basic"));
    expect(applyOps(base, [])).toEqual(base.model);
    const ops: CorrectionOp[] = [{ op: "move-line", axis: "rows", after: "r2", at: 0.15 }, { op: "edit-cell", row: "r3", col: "c2", text: "QX" }];
    expect(() => applyOps(base, ops)).not.toThrow();
  });

  it("an op whose target is gone does not land and changes nothing", async () => {
    const base = await parse("syn-sched-basic");
    const r = applyOpsDetailed(base, [
      { op: "edit-cell", row: "r999", col: "c1", text: "QX" },
      { op: "remove-line", axis: "rows", after: T(base.model).rows[T(base.model).rows.length - 1].id },
      { op: "pin-source", axis: "rows", method: "tatr" },
      { op: "set-kind", kind: "notes" },
      { op: "split-paragraph", p: "p1", atLine: 1 },
    ]);
    expect(r.landed).toEqual([false, false, false, false, false]);
    expect(r.model).toEqual(base.model);
  });
});

describe("every table op previews from the ParseResult alone (no fetch)", () => {
  let base: ParseResult;
  let m0: StructureTableModel;
  beforeEach(async () => {
    base = await parse("syn-sched-basic");
    m0 = T(base.model);
  });
  const one = (op: CorrectionOp): StructureTableModel => {
    const r = applyOpsDetailed(base, [op]);
    expect(r.landed, op.op).toEqual([true]);
    expect(zStructureModel.safeParse(r.model).success).toBe(true);
    return T(r.model);
  };

  it("pin-source: an alternative's geometry on one axis; null returns to the fused axis", () => {
    const alt = base.alternatives.find((a) => a.method === "ocr-lines")!;
    const m = one({ op: "pin-source", axis: "rows", method: "ocr-lines" });
    expect([m.rows[0].y0, ...m.rows.map((r) => r.y1)].map((v) => v.toFixed(5))).toEqual(alt.geometry.rowLines.map((v) => v.toFixed(5)));
    const xs = base.alternatives.find((a) => a.method === "x-starts")!;
    const mc = one({ op: "pin-source", axis: "cols", method: "x-starts" });
    expect(mc.cols.length).toBe(xs.geometry.colLines.length - 1);
    const back = applyOps(base, [{ op: "pin-source", axis: "cols", method: "x-starts" }, { op: "pin-source", axis: "cols", method: null }]);
    expect(T(back).cols.map((c) => [c.id, c.x0, c.x1])).toEqual(m0.cols.map((c) => [c.id, c.x0, c.x1]));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("set-lines replaces part 0's rows; ids re-match the old bands", () => {
    const lines = [m0.rows[0].y0, m0.rows[0].y1, m0.rows[2].y1, m0.rows[m0.rows.length - 1].y1];
    const m = one({ op: "set-lines", axis: "rows", at: lines });
    expect(m.rows.length).toBe(3);
    expect(m.rows[0].id).toBe(m0.rows[0].id);
    expect(m.headerRows).toBe(1);
  });

  it("move-line, add-line, remove-line on rows and columns", () => {
    const [r1, r2, r3] = m0.rows;
    const y = (r2.y0 + r2.y1) / 2;
    const moved = one({ op: "move-line", axis: "rows", after: r2.id, at: y });
    expect(moved.rows[1].y1).toBeCloseTo(y, 6);
    expect(moved.rows[2].y0).toBeCloseTo(y, 6);
    const added = one({ op: "add-line", axis: "rows", at: (r3.y0 + r3.y1) / 2 });
    expect(added.rows.length).toBe(m0.rows.length + 1);
    expect(added.rows[3].id).toBe(`r${m0.rows.length + 1}`);
    const removed = one({ op: "remove-line", axis: "rows", after: r2.id });
    expect(removed.rows.length).toBe(m0.rows.length - 1);
    expect(text(removed, r2.id, "c1")).toBe([text(m0, r2.id, "c1"), text(m0, r3.id, "c1")].join("\n"));
    void r1;
    const [c1, c2, c3, c4] = m0.cols;
    const cAdded = one({ op: "add-line", axis: "cols", at: (c2.x0 + c2.x1) / 2 });
    expect(cAdded.cols.length).toBe(m0.cols.length + 1);
    const cRemoved = one({ op: "remove-line", axis: "cols", after: c3.id });
    expect(cRemoved.cols.length).toBe(m0.cols.length - 1);
    expect(cRemoved.cols[2].labelRaw).toBe(`${c3.labelRaw} ${c4.labelRaw}`);
    const cMoved = one({ op: "move-line", axis: "cols", after: c1.id, at: c1.x1 + 0.002 });
    expect(cMoved.cols[0].x1).toBeCloseTo(c1.x1 + 0.002, 6);
  });

  it("user-boxes (Draw cells) redraws both axes from boxes", () => {
    const rows = m0.rows.slice(1, 4).map((r) => [m0.bbox[0], r.y0, m0.bbox[2], r.y1] as [number, number, number, number]);
    const cols = m0.cols.slice(0, 2).map((c) => [c.x0, m0.bbox[1], c.x1, m0.bbox[3]] as [number, number, number, number]);
    const m = one({ op: "user-boxes", rows, cols });
    expect(m.rows.length).toBe(3);
    expect(m.cols.length).toBe(2);
    expect(matrix(m)[0][0]).toBe(text(m0, m0.rows[1].id, m0.cols[0].id));
  });

  it("merge-cells, set-header-rows", () => {
    const m = one({ op: "merge-cells", row: m0.rows[2].id, col: m0.cols[3].id, rs: 1, cs: 2 });
    const anchor = m.cells.find((c) => c.row === m0.rows[2].id && c.col === m0.cols[3].id)!;
    expect(anchor.cs).toBe(2);
    expect(anchor.text).toBe([text(m0, m0.rows[2].id, m0.cols[3].id), text(m0, m0.rows[2].id, m0.cols[4].id)].filter(Boolean).join(" "));
    const h = one({ op: "set-header-rows", n: 2 });
    expect(h.headerRows).toBe(2);
    expect(h.cols[0].labelRaw).toBe(`${m0.cols[0].labelRaw} ${text(m0, m0.rows[1].id, m0.cols[0].id)}`);
    const none = one({ op: "set-header-rows", n: 0 });
    expect(none.headerRows).toBe(0);
    expect(none.cols[0].label).toBe("Column 1");
  });

  it("overlays: tag column + scope, column role, rename (K06), edit cell, row key, CSI, title, kind", () => {
    expect(one({ op: "set-tag-col", col: "c2" }).tag).toEqual({ col: "c2", src: "user", scope: "project" });
    expect(one({ op: "set-tag-col", col: null }).tag).toBeUndefined();
    expect(one({ op: "set-tag-scope", scope: "sheet" }).tag?.scope).toBe("sheet");
    expect(one({ op: "set-col-role", col: "c3", role: "qty" }).cols[2].role).toBe("qty");
    expect(one({ op: "set-col-role", col: "c3", role: null }).cols[2].role).toBeUndefined();
    expect(one({ op: "rename-col", col: "c2", label: m0.cols[0].label }).cols[1].label).toBe(`${m0.cols[0].label} (2)`);
    const edited = one({ op: "edit-cell", row: "r3", col: "c2", text: "QX EDIT" });
    expect(edited.cells.find((c) => c.row === "r3" && c.col === "c2")).toMatchObject({ text: "QX EDIT", src: "edit" });
    expect(one({ op: "set-row-key", row: "r2", text: "QX-9" }).rows[1].key).toEqual({ kind: "text", text: "QX-9" });
    expect(one({ op: "set-csi", target: { row: "r2" }, codes: [{ code: "08 11 13", description: "QX", src: "user" }] }).rows[1].csi?.[0].code).toBe("08 11 13");
    expect(one({ op: "set-title", text: "QX SCHEDULE" }).title).toEqual({ text: "QX SCHEDULE", src: "user", conf: 1 });
    const k = one({ op: "set-kind", kind: "keynote", classId: "keynote-table" });
    expect([k.kind, k.classId]).toEqual(["keynote", "keynote-table"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("an edit survives a later geometry op (two phases); ops are idempotent where the op is a state", () => {
    const ops: CorrectionOp[] = [
      { op: "edit-cell", row: "r3", col: "c2", text: "QX EDIT" },
      { op: "move-line", axis: "rows", after: "r4", at: (m0.rows[3].y1 + m0.rows[4].y1) / 2 },
      { op: "pin-source", axis: "cols", method: "x-starts" },
      { op: "set-tag-col", col: "c1" },
      { op: "rename-col", col: "c2", label: "QX NAME" },
      { op: "set-header-rows", n: 1 },
    ];
    const once = applyOps(base, ops);
    expect(text(T(once), "r3", "c2")).toBe("QX EDIT");
    const twice = applyOps({ ...base, model: once }, ops);
    expect(twice).toEqual(once);
    expect(applyOps(base, ops)).toEqual(once); // pure: same input, same output
  });
});

describe("every paragraph op previews from the ParseResult alone (no fetch)", () => {
  let base: ParseResult;
  let d0: StructureParagraphDoc;
  beforeEach(async () => {
    base = await parse("syn-notes-lettered");
    d0 = P(base.model);
  });
  const one = (op: CorrectionOp): StructureParagraphDoc => {
    const r = applyOpsDetailed(base, [op]);
    expect(r.landed, op.op).toEqual([true]);
    expect(zStructureModel.safeParse(r.model).success).toBe(true);
    return P(r.model);
  };

  it("split, merge, re-key, un-key", () => {
    const p1 = d0.paragraphs[0];
    expect(p1.lineCount).toBeGreaterThanOrEqual(2);
    const lines = paragraphLines(d0, base.words).filter((l) => l.p === p1.id);
    const split = one({ op: "split-paragraph", p: p1.id, atLine: 1 });
    expect(split.paragraphs.length).toBe(d0.paragraphs.length + 1);
    expect(split.paragraphs[1]).toMatchObject({ blockId: p1.blockId, key: null, text: lines.slice(1).map((l) => l.text).join(" ") });
    expect(split.paragraphs[0].lineCount).toBe(1);
    const merged = one({ op: "merge-paragraph", p: d0.paragraphs[1].id });
    expect(merged.paragraphs.length).toBe(d0.paragraphs.length - 1);
    expect(merged.paragraphs[0].text.startsWith(p1.text)).toBe(true);
    expect(merged.paragraphs[0].text).toContain(`${d0.paragraphs[1].key}.`); // the printed key became text
    const rekeyed = one({ op: "set-paragraph-key", p: p1.id, key: "Z" });
    expect(rekeyed.paragraphs[0]).toMatchObject({ key: "Z", keyNorm: "Z" });
    const unkeyed = one({ op: "set-paragraph-key", p: p1.id, key: null });
    expect(unkeyed.paragraphs[0]).toMatchObject({ key: null, keyNorm: "", keyPath: [] });
    expect(unkeyed.paragraphs[0].text.startsWith(`${p1.key}.`)).toBe(true);
  });

  it("mark-block-header: the line heads a new block and the paragraphs after it move under it", () => {
    const all = paragraphLines(d0, base.words);
    const third = d0.paragraphs[2];
    const idx = all.findIndex((l) => l.p === third.id && l.line === 0);
    const d = one({ op: "mark-block-header", lineIndex: idx });
    expect(d.blocks.length).toBe(d0.blocks.length + 1);
    const nb = d.blocks.find((b) => !d0.blocks.some((x) => x.id === b.id))!;
    expect(nb.header).toBe(all[idx].text);
    expect(d.paragraphs.filter((p) => p.blockId === nb.id).length).toBeGreaterThan(0);
    expect(d.paragraphs.slice(0, 2).every((p) => p.blockId === d0.paragraphs[0].blockId)).toBe(true);
  });

  it("CSI, title, kind; a table op does not land on a document", () => {
    expect(one({ op: "set-csi", target: { p: "p2" }, codes: [{ code: "01 10 00", description: "QX", src: "user" }] }).paragraphs[1].csi?.length).toBe(1);
    expect(one({ op: "set-title", text: "QX NOTES" }).title?.text).toBe("QX NOTES");
    expect(one({ op: "set-kind", kind: "spec" }).kind).toBe("spec");
    expect(applyOpsDetailed(base, [{ op: "edit-cell", row: "r1", col: "c1", text: "QX" }]).landed).toEqual([false]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("snapshots", () => {
  it("snapshotOf / snapshotHash / diffSnapshots", async () => {
    const base = await parse("syn-sched-basic");
    const m = T(base.model);
    const s = snapshotOf(m);
    expect(s.rowY.length).toBe(m.rows.length + 1);
    expect(s.colX.length).toBe(m.cols.length + 1);
    expect(s.tagCol).toBe(0);
    expect(snapshotHash(s)).toMatch(/^ss1:[0-9a-f]{28}$/);
    expect(snapshotHash(snapshotOf(T(applyOps(base, []))))).toBe(snapshotHash(s));
    expect(diffSnapshots(s, s).same).toBe(true);
    const moved = snapshotOf(T(applyOps(base, [{ op: "move-line", axis: "rows", after: "r3", at: (m.rows[2].y0 + m.rows[2].y1) / 2 }])));
    expect(diffSnapshots(s, moved)).toMatchObject({ same: false, rowsChanged: 1, colsChanged: 0 });
    const edited = snapshotOf(T(applyOps(base, [{ op: "edit-cell", row: "r4", col: "c5", text: "QX" }])));
    expect(diffSnapshots(s, edited)).toMatchObject({ same: false, rowsChanged: 0, cellsChanged: 1 });
    const notes = await parse("syn-notes-lettered");
    const sn = snapshotOf(notes.model);
    expect(sn.paragraphs?.length).toBe(P(notes.model).paragraphs.length);
    expect(diffSnapshots(s, sn).kindChanged).toBe(true);
  });

  it("stableHash ignores key order and undefined members", () => {
    expect(stableHash({ a: 1, b: [1, 2], c: undefined })).toBe(stableHash({ b: [1, 2], a: 1 }));
    expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }));
  });
});

describe("replay: ops re-applied onto a re-parse with re-matched ids", () => {
  it("prior ids carry the ops to the same logical rows; a lost op is reported", async () => {
    const f = fixture("syn-sched-basic");
    const ev = fixtureEvidence(f);
    const first = await parse("syn-sched-basic");
    // the committed model had other ids (minted on an earlier parse): r1 → r101 …
    const prior: StructureTableModel = { ...T(first.model), rows: T(first.model).rows.map((r) => ({ ...r, id: `r${Number(r.id.slice(1)) + 100}` })) };
    const ops: CorrectionOp[] = [
      { op: "edit-cell", row: "r103", col: "c2", text: "QX EDIT" },
      { op: "move-line", axis: "rows", after: "r104", at: (prior.rows[3].y1 + prior.rows[4].y1) / 2 },
      { op: "set-row-key", row: "r999", text: "QX" },
    ];
    // the evidence moved a little since (a re-OCR): every word 0.0004 lower
    const moved: EnginePageEvidence = { ...ev, evidenceHash: "moved", words: ev.words.map((w) => ({ ...w, b: [w.b[0], w.b[1] + 0.0004, w.b[2], w.b[3] + 0.0004] })), lines: ev.lines.map((l) => ({ ...l, b: [l.b[0], l.b[1] + 0.0004, l.b[2], l.b[3] + 0.0004] })) };
    const out = await replayRegion(moved, { request: fixtureRequest(f), origin: "proposal" }, ops, prior, runParseEngine, { at: AT, profile: DEFAULT_PROFILE });
    expect(T(out.result.model).rows.map((r) => r.id)).toEqual(prior.rows.map((r) => r.id));
    expect(out.landed).toEqual([true, true, false]);
    expect(out.lost).toEqual([2]);
    expect(text(T(out.model), "r103", "c2")).toBe("QX EDIT");
    expect(out.diff?.rowsChanged).toBeGreaterThan(0);
    // client preview and server re-application agree: the same ops on the same result give the same model
    expect(applyOps(out.result, ops)).toEqual(out.model);
  });

  it("replayPlan reads a stored region's recipe, ops and stale capabilities", async () => {
    const r = await parse("syn-sched-basic");
    const data = { structure: r.model, engine: { ...r.stamp, caps: { ...r.stamp.caps, rows: CAPABILITY_VERSIONS.rows - 1 } }, recipe: { request: fixtureRequest(fixture("syn-sched-basic")), origin: "draw" as const }, ops: [] };
    expect(replayPlan(data)).toMatchObject({ stale: ["rows"], ops: [], prior: r.model });
    expect(replayPlan({ structure: r.model })).toBeNull();
  });
});

describe("replay of a stored CORRECTED model: ids re-match against its opsBase (WP-3.D verify HIGH-1)", () => {
  const opts = { at: AT, profile: DEFAULT_PROFILE };
  const rowOf = (m: StructureTableModel, t: string): [string, number, number] | null => {
    const c = m.cells.find((x) => x.text === t);
    const r = c ? m.rows.find((x) => x.id === c.row) : undefined;
    return r ? [r.id, r.y0, r.y1] : null;
  };
  const nextNum = (ids: string[]): number => Math.max(...ids.map((id) => Number(id.slice(1)))) + 1;

  for (const frac of [0.3, 0.5, 0.7]) {
    it(`add-line at ${frac * 100} % of a row + an edit on each half, replayed through replayPlan(stored data)`, async () => {
      const f = fixture("syn-sched-basic");
      const ev = fixtureEvidence(f);
      const base = await parse("syn-sched-basic");
      const m = T(base.model);
      const r4 = m.rows[3];
      const minted = `r${nextNum(m.rows.map((r) => r.id))}`;
      const ops: CorrectionOp[] = [
        { op: "add-line", axis: "rows", at: r4.y0 + frac * (r4.y1 - r4.y0) },
        { op: "edit-cell", row: minted, col: m.cols[1].id, text: "QX LOWER" },
        { op: "edit-cell", row: r4.id, col: m.cols[1].id, text: "QX UPPER" },
      ];
      const applied = applyOpsDetailed(base, ops);
      expect(applied.landed).toEqual([true, true, true]);
      // what WP-3.G stores: the corrected model, which names the machine ids its ops were recorded on
      const stored = T(applied.model);
      expect(stored.opsBase?.rows.map((r) => r.id)).toEqual(m.rows.map((r) => r.id));
      expect(zStructureModel.safeParse(stored).success).toBe(true);
      const plan = replayPlan({ structure: stored, engine: base.stamp, recipe: { request: fixtureRequest(f), origin: "draw" }, ops })!;
      const out = await replayRegion(ev, plan.recipe, plan.ops, plan.prior, runParseEngine, opts);
      expect(T(out.result.model).rows.map((r) => r.id)).toEqual(m.rows.map((r) => r.id));
      expect(out.landed).toEqual([true, true, true]);
      expect(out.lost).toEqual([]);
      expect(rowOf(T(out.model), "QX LOWER")).toEqual(rowOf(stored, "QX LOWER"));
      expect(rowOf(T(out.model), "QX UPPER")).toEqual(rowOf(stored, "QX UPPER"));
      expect(out.model).toEqual(stored);
    });
  }

  it("split-paragraph + a key on the new paragraph, replayed through replayPlan(stored data)", async () => {
    let checked = 0;
    for (const id of ["syn-notes-dimension-start", "syn-notes-lettered"]) {
      const f = fixture(id);
      const ev = fixtureEvidence(f);
      const base = await parse(id);
      const d = P(base.model);
      const multi = d.paragraphs.find((p) => p.lineCount >= 2);
      if (!multi) continue;
      const minted = `p${nextNum(d.paragraphs.map((p) => p.id))}`;
      const ops: CorrectionOp[] = [{ op: "split-paragraph", p: multi.id, atLine: 1 }, { op: "set-paragraph-key", p: minted, key: "QK" }];
      const applied = applyOpsDetailed(base, ops);
      expect(applied.landed, id).toEqual([true, true]);
      const stored = P(applied.model);
      expect(stored.opsBase?.paragraphs.map((p) => p.id)).toEqual(d.paragraphs.map((p) => p.id));
      expect(zStructureModel.safeParse(stored).success).toBe(true);
      const plan = replayPlan({ structure: stored, recipe: { request: fixtureRequest(f), origin: "draw" }, ops })!;
      const out = await replayRegion(ev, plan.recipe, plan.ops, plan.prior, runParseEngine, opts);
      expect(out.landed, id).toEqual([true, true]);
      const qk = (doc: StructureParagraphDoc) => doc.paragraphs.find((p) => p.key === "QK");
      expect(qk(P(out.model))?.b, id).toEqual(qk(stored)?.b);
      expect(out.model, id).toEqual(stored);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("ops that change no band leave no opsBase; a base's own opsBase is kept", async () => {
    const base = await parse("syn-sched-basic");
    const m = T(base.model);
    expect(T(applyOps(base, [{ op: "edit-cell", row: m.rows[2].id, col: m.cols[1].id, text: "QX" }])).opsBase).toBeUndefined();
    const moved = T(applyOps(base, [{ op: "add-line", axis: "rows", at: (m.rows[3].y0 + m.rows[3].y1) / 2 }]));
    const again = T(applyOps({ ...base, model: moved }, [{ op: "add-line", axis: "rows", at: (m.rows[5].y0 + m.rows[5].y1) / 2 }]));
    expect(again.opsBase).toEqual(moved.opsBase);
  });

  it("a fresh band that matches no machine band never takes an id an op minted", async () => {
    const f = fixture("syn-sched-basic");
    const base = await parse("syn-sched-basic");
    const m = T(base.model);
    const stored = T(applyOps(base, [{ op: "add-line", axis: "rows", at: (m.rows[3].y0 + m.rows[3].y1) / 2 }]));
    const minted = `r${nextNum(m.rows.map((r) => r.id))}`;
    expect(stored.rows.map((r) => r.id)).toContain(minted);
    // the machine parse the ops were recorded on lacked the last band (the evidence has grown a row since)
    const last = m.rows[m.rows.length - 1].id;
    const prior: StructureTableModel = { ...stored, opsBase: { ...stored.opsBase!, rows: stored.opsBase!.rows.filter((r) => r.id !== last) } };
    const re = T((await runParseEngine(fixtureEvidence(f), fixtureRequest(f, { prior }), opts)).model);
    expect(re.rows.map((r) => r.id)).not.toContain(minted);
    expect(re.rows[re.rows.length - 1].id).toBe(`r${nextNum([...stored.rows.map((r) => r.id)])}`);
  });
});

describe("op edge cases pinned by the WP-3.D verify mutations (LOW-1, LOW-3)", () => {
  it("remove-line never merges across parts (M5)", async () => {
    const f = fixture("syn-sched-two-blocks");
    const mid = (f.region[0] + f.region[2]) / 2;
    const left: [number, number, number, number] = [f.region[0], f.region[1], mid, f.region[3]];
    const right: [number, number, number, number] = [mid, f.region[1], f.region[2], f.region[3]];
    const base = await runParseEngine(fixtureEvidence(f), { page: 1, bbox: left, parts: [right], budget: "instant", kind: "schedule" }, { at: AT, profile: DEFAULT_PROFILE });
    const m = T(base.model);
    const lastOfPart0 = m.rows.filter((r) => (r.part ?? 0) === 0).pop()!;
    expect(m.rows[m.rows.indexOf(lastOfPart0) + 1]?.part).toBe(1);
    const r = applyOpsDetailed(base, [{ op: "remove-line", axis: "rows", after: lastOfPart0.id }]);
    expect(r.landed).toEqual([false]);
    expect(r.model).toEqual(base.model);
  });

  it("add-line hands a shape key to the band that holds its shape (M6)", async () => {
    let checked = 0;
    for (const id of ["syn-sched-shapes-centred-3line", "syn-sched-shapes-hex", "syn-keynote-shapes"]) {
      const base = await parse(id);
      const m = T(base.model);
      const row = m.rows.find((r) => r.key && r.key.kind !== "text");
      if (!row || !row.key || row.key.kind === "text") continue;
      const cy = (row.key.shapeBbox[1] + row.key.shapeBbox[3]) / 2;
      if (!(cy > row.y0 && cy < row.y1)) continue;
      const minted = `r${Math.max(...m.rows.map((r) => Number(r.id.slice(1)))) + 1}`;
      const below = T(applyOps(base, [{ op: "add-line", axis: "rows", at: (cy + row.y1) / 2 }]));
      expect(below.rows.find((r) => r.id === row.id)?.key, id).toEqual(row.key);
      expect(below.rows.find((r) => r.id === minted)?.key, id).toBeUndefined();
      const above = T(applyOps(base, [{ op: "add-line", axis: "rows", at: (row.y0 + cy) / 2 }]));
      expect(above.rows.find((r) => r.id === minted)?.key, id).toEqual(row.key);
      expect(above.rows.find((r) => r.id === row.id)?.key, id).toBeUndefined();
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("pin-source on columns keeps the box edges as the outer lines, as fusion does (LOW-3)", async () => {
    const base = await parse("syn-sched-textract-header-row");
    const m = T(base.model);
    const alt = base.alternatives.find((a) => a.method === "textract-cells")!;
    const pinned = T(applyOps(base, [{ op: "pin-source", axis: "cols", method: "textract-cells" }]));
    expect(pinned.cols[0].x0).toBe(m.bbox[0]);
    expect(pinned.cols[pinned.cols.length - 1].x1).toBe(m.bbox[2]);
    const inner = alt.geometry.colLines.slice(1, -1).filter((x) => x > m.bbox[0] && x < m.bbox[2]);
    expect(pinned.cols.slice(1).map((c) => c.x0.toFixed(6))).toEqual(inner.map((x) => (Math.round(x * 1e6) / 1e6).toFixed(6)));
  });
});
