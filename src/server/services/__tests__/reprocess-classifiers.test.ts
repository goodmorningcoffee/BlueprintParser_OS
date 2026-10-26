// @vitest-environment node
// [clf 2a 2026-10-24] The Reprocess "Classifiers" scope against the real test DB: a page with stored
// YOLO rows + regionsV2 gets `pageIntelligence.classifierProposals` by jsonb merge (user-owned
// `proposalVerdicts`, `parsedRegions` and unknown keys untouched); a page without YOLO rows is left as
// it was and counted skipped; an unchanged page is not rewritten; `projectIntelligence.proposals` is
// merged beside the other keys; a project that throws is one `error` line and the stream still gets
// `done`. No root gate: the engine is pure TS.
import { describe, expect, inject, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { annotations, pages, projects } from "@/lib/db/schema";
import { classifyRegionsV2 } from "@/lib/region-classifier-v2";
import type { TextractWord } from "@/types";
import { assertProjectWritable } from "@/server/api/project-write-capability";
import { regionsV2OrCompute, reprocessClassifiersScope, storedChannelKind } from "@/server/services/reprocess-classifiers";
import type { ReprocessStream } from "@/server/services/reprocess-stream";
import { createPage, createWorld } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

function fakeStream() {
  const events: Record<string, unknown>[] = [];
  const stream: ReprocessStream = { send: (e) => { events.push(e); }, debug: () => {}, isClosed: () => false, close: () => {}, debugEnabled: false };
  return { stream, events };
}

const w = (text: string, x: number, y: number, h = 0.012): TextractWord => ({ text, confidence: 99, bbox: [x, y, text.length * 0.007, h] });
const WORDS: TextractWord[] = [w("DOOR", 0.52, 0.19, 0.018), w("SCHEDULE", 0.57, 0.19, 0.018), ...["DOOR", "NO", "FRAME", "HDWR", "RATING", "SIZE"].map((t, i) => w(t, 0.51 + i * 0.07, 0.22))];
for (let r = 0; r < 8; r++) WORDS.push(w(`10${r}`, 0.51, 0.25 + r * 0.02), w("HM", 0.58, 0.25 + r * 0.02), w("WD", 0.65, 0.25 + r * 0.02), w("PR", 0.72, 0.25 + r * 0.02));
const DET = { name: "tables", minX: 0.5, minY: 0.21, maxX: 0.9, maxY: 0.45, confidence: 0.9, modelName: "yolo_medium" };
// [shape-tags fix 3] the fitted detect head weighs the page's yolo_primitive grid and its Textract TABLE (rowCount), as
// real sheets carry them; a bare yolo_medium box over 8 OCR rows now scores p ≈ .12 (< .5) and is rightly not proposed.
const GRID = { name: "grid", minX: 0.5, minY: 0.21, maxX: 0.9, maxY: 0.45, confidence: 0.6, modelName: "yolo_primitive" };
const TABLES = [{ bbox: [0.5, 0.21, 0.4, 0.24] as [number, number, number, number], cells: [], rowCount: 9, colCount: 6 }];
const OCR = { words: WORDS, tables: TABLES };
const regionsV2 = classifyRegionsV2({ pageNumber: 1, detections: [DET, GRID], textractData: OCR, csiCodes: [] });
const insertYolo = (projectId: number) => db.insert(annotations).values([DET, GRID].map((d) => ({ projectId, pageNumber: 1, name: d.name, minX: d.minX, minY: d.minY, maxX: d.maxX, maxY: d.maxY, source: "yolo", data: { confidence: d.confidence, modelName: d.modelName } })) as never);

const piOf = async (pageId: number) => (await db.select({ pi: pages.pageIntelligence }).from(pages).where(eq(pages.id, pageId)))[0].pi as Record<string, unknown>;
const projectPi = async (id: number) => (await db.select({ pi: projects.projectIntelligence }).from(projects).where(eq(projects.id, id)))[0].pi as Record<string, unknown>;

describe.skipIf(!dbUp)("reprocessClassifiersScope", () => {
  it("writes classifierProposals for YOLO pages by jsonb merge, drops a stale record, skips the rest, refreshes projectIntelligence.proposals, and is idempotent", async () => {
    const { project } = await createWorld({ projectIntelligence: { yoloTags: [{ a: 1 }] } as never });
    const withLease = <T,>(id: number, op: (c: ReturnType<typeof assertProjectWritable>) => Promise<T>) => op(assertProjectWritable({ ...project, id }));
    const p1 = await createPage(project.id, 1, {
      drawingNumber: "A-601", textractData: { lines: [], ...OCR } as never,
      pageIntelligence: { regionsV2, pageZones: { titleBlock: null, drawings: [], tables: [], legends: [], source: "fixed-fallback" }, parsedRegions: [{ id: "keep" }], proposalVerdicts: { old: { verdict: "accept" } }, channels: { v: 1, kind: "vector" }, foo: "bar" } as never,
    });
    const p2 = await createPage(project.id, 2, { pageIntelligence: { textRegions: [] } as never });
    // a stale record on a page whose YOLO rows are gone → dropped (counted updated), the other keys kept
    const p3 = await createPage(project.id, 3, { pageIntelligence: { classifierProposals: { engineVersion: "clf/0.0", recipes: {}, proposals: [] }, keep: 1 } as never });
    await insertYolo(project.id);

    const { stream, events } = fakeStream();
    const c = await reprocessClassifiersScope({ projects: [{ id: project.id, name: "set 1" }], withReprocessLease: withLease, stream, overlay: undefined });
    expect(c).toMatchObject({ total: 3, updated: 2, skipped: 1 });
    expect(c.proposals).toBe(1);
    expect(await piOf(p3.id)).toEqual({ keep: 1 });
    const pi1 = await piOf(p1.id);
    const stored = pi1.classifierProposals as { proposals: Array<{ classId: string | null; recipeId: string }> };
    expect(stored.proposals).toHaveLength(1);
    expect(stored.proposals[0]).toMatchObject({ recipeId: "schedules.v1", classId: "door" });
    // wiring: the scope fed the engine textractData->'tables' and the yolo_primitive rows the fitted head depends on
    const f1 = (stored.proposals[0] as unknown as { features: Record<string, number> }).features;
    expect(f1["detect.textract"]).toBeGreaterThan(0.9);
    expect(f1["detect.gridCover"]).toBeGreaterThan(0.9);
    expect(pi1.proposalVerdicts).toEqual({ old: { verdict: "accept" } });
    expect(pi1.parsedRegions).toEqual([{ id: "keep" }]);
    expect(pi1.foo).toBe("bar");
    expect(pi1.regionsV2).toBeDefined();
    expect(await piOf(p2.id)).toEqual({ textRegions: [] });
    const ppi = await projectPi(project.id);
    expect(ppi.yoloTags).toEqual([{ a: 1 }]);
    expect((ppi.proposals as { total: number; items: Array<{ pageNumber: number; classId: string | null }> }).total).toBe(1);
    expect((ppi.proposals as { items: Array<{ pageNumber: number }> }).items[0].pageNumber).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: "done", updated: 2, skipped: 1, total: 3 });

    // second run: nothing changed → nothing rewritten
    const again = await reprocessClassifiersScope({ projects: [{ id: project.id, name: "set 1" }], withReprocessLease: withLease, stream: fakeStream().stream, overlay: undefined });
    expect(again).toMatchObject({ total: 3, updated: 0, skipped: 3 });
    expect(storedChannelKind(pi1)).toBe("vector");
    expect(storedChannelKind({})).toBeNull();
  });

  // [clf visibility 2026-10-25] the owner's case: YOLO rows but no stored regionsV2 (Intelligence never re-run)
  it("computes regionsV2 for a YOLO page that has none stored, persists it beside the proposals, and reports the counts", async () => {
    const { project } = await createWorld();
    const withLease = <T,>(id: number, op: (c: ReturnType<typeof assertProjectWritable>) => Promise<T>) => op(assertProjectWritable({ ...project, id }));
    const p1 = await createPage(project.id, 1, { drawingNumber: "A-601", textractData: { lines: [], ...OCR } as never, pageIntelligence: { proposalVerdicts: { old: { verdict: "accept" } }, keep: 1 } as never });
    await createPage(project.id, 2, { pageIntelligence: { textRegions: [] } as never });
    await insertYolo(project.id);

    const { stream, events } = fakeStream();
    const c = await reprocessClassifiersScope({ projects: [{ id: project.id, name: "set 2" }], withReprocessLease: withLease, stream, overlay: undefined });
    expect(c).toMatchObject({ total: 2, updated: 1, skipped: 1, proposals: 1 });
    const pi1 = await piOf(p1.id);
    expect((pi1.regionsV2 as { regions: unknown[] }).regions.length).toBeGreaterThan(0);
    expect((pi1.classifierProposals as { proposals: Array<{ classId: string | null }> }).proposals[0]).toMatchObject({ classId: "door" });
    expect(pi1.proposalVerdicts).toEqual({ old: { verdict: "accept" } });
    expect(pi1.keep).toBe(1);
    expect(events.find((e) => e.type === "classifiers")).toMatchObject({ project: "set 2", pages: 2, yoloPages: 1, regionsComputed: 1, proposals: 1, truncated: false });
    expect(events.some((e) => e.type === "warning")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done", proposals: 1 });

    // second run: the regions are stored now → nothing computed, nothing rewritten, proposals still counted
    const again = fakeStream();
    const c2 = await reprocessClassifiersScope({ projects: [{ id: project.id, name: "set 2" }], withReprocessLease: withLease, stream: again.stream, overlay: undefined });
    expect(c2).toMatchObject({ updated: 0, skipped: 2, proposals: 1 });
    expect(again.events.find((e) => e.type === "classifiers")).toMatchObject({ regionsComputed: 0, proposals: 1 });
  });

  it("a project with pages but no YOLO detections gets the 'run YOLO load first' warning and 0 proposals", async () => {
    const { project } = await createWorld();
    const withLease = <T,>(id: number, op: (c: ReturnType<typeof assertProjectWritable>) => Promise<T>) => op(assertProjectWritable({ ...project, id }));
    await createPage(project.id, 1, { textractData: { lines: [], words: WORDS } as never });
    const { stream, events } = fakeStream();
    const c = await reprocessClassifiersScope({ projects: [{ id: project.id, name: "set 3" }], withReprocessLease: withLease, stream, overlay: undefined });
    expect(c).toMatchObject({ total: 1, updated: 0, skipped: 1, proposals: 0 });
    expect(events.map((e) => e.type)).toEqual(["project", "warning", "classifiers", "done"]);
    expect(events[1]).toMatchObject({ project: "set 3", message: "no YOLO detections — run YOLO load first" });
    expect(events[2]).toMatchObject({ pages: 1, yoloPages: 0, regionsComputed: 0, proposals: 0 });
  });

  it("a project that throws is one error line; the stream still ends with done", async () => {
    const { stream, events } = fakeStream();
    const c = await reprocessClassifiersScope({
      projects: [{ id: 999999, name: "set 9" }],
      withReprocessLease: async () => { throw new Error("lease refused"); },
      stream, overlay: { custom: [], patches: {} },
    });
    expect(c).toMatchObject({ total: 0, updated: 0 });
    expect(events.map((e) => e.type)).toEqual(["error", "done"]);
    expect(events[0]).toMatchObject({ project: "set 9", error: "lease refused" });
  });
});

describe("regionsV2OrCompute (no DB)", () => {
  const input = { pageNumber: 1, detections: [DET, GRID], textractData: OCR, csiCodes: [] };
  it("returns the stored record untouched, computes when a YOLO page has none, and never computes without detections", () => {
    expect(regionsV2OrCompute({ regionsV2 }, input)).toEqual({ regionsV2, computed: false });
    const fresh = regionsV2OrCompute({ pageZones: undefined }, input);
    expect(fresh.computed).toBe(true);
    expect(fresh.regionsV2).toEqual(regionsV2);
    expect(regionsV2OrCompute({}, { ...input, detections: [] })).toEqual({ regionsV2: undefined, computed: false });
    expect(regionsV2OrCompute(null, { ...input, detections: [] })).toEqual({ regionsV2: undefined, computed: false });
  });
});
