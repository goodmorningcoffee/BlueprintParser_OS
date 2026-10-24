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
import { reprocessClassifiersScope, storedChannelKind } from "@/server/services/reprocess-classifiers";
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
const regionsV2 = classifyRegionsV2({ pageNumber: 1, detections: [DET], textractData: { words: WORDS }, csiCodes: [] });

const piOf = async (pageId: number) => (await db.select({ pi: pages.pageIntelligence }).from(pages).where(eq(pages.id, pageId)))[0].pi as Record<string, unknown>;
const projectPi = async (id: number) => (await db.select({ pi: projects.projectIntelligence }).from(projects).where(eq(projects.id, id)))[0].pi as Record<string, unknown>;

describe.skipIf(!dbUp)("reprocessClassifiersScope", () => {
  it("writes classifierProposals for YOLO pages by jsonb merge, drops a stale record, skips the rest, refreshes projectIntelligence.proposals, and is idempotent", async () => {
    const { project } = await createWorld({ projectIntelligence: { yoloTags: [{ a: 1 }] } as never });
    const withLease = <T,>(id: number, op: (c: ReturnType<typeof assertProjectWritable>) => Promise<T>) => op(assertProjectWritable({ ...project, id }));
    const p1 = await createPage(project.id, 1, {
      drawingNumber: "A-601", textractData: { lines: [], words: WORDS } as never,
      pageIntelligence: { regionsV2, pageZones: { titleBlock: null, drawings: [], tables: [], legends: [], source: "fixed-fallback" }, parsedRegions: [{ id: "keep" }], proposalVerdicts: { old: { verdict: "accept" } }, channels: { v: 1, kind: "vector" }, foo: "bar" } as never,
    });
    const p2 = await createPage(project.id, 2, { pageIntelligence: { textRegions: [] } as never });
    // a stale record on a page whose YOLO rows are gone → dropped (counted updated), the other keys kept
    const p3 = await createPage(project.id, 3, { pageIntelligence: { classifierProposals: { engineVersion: "clf/0.0", recipes: {}, proposals: [] }, keep: 1 } as never });
    await db.insert(annotations).values({ projectId: project.id, pageNumber: 1, name: DET.name, minX: DET.minX, minY: DET.minY, maxX: DET.maxX, maxY: DET.maxY, source: "yolo", data: { confidence: DET.confidence, modelName: DET.modelName } } as never);

    const { stream, events } = fakeStream();
    const c = await reprocessClassifiersScope({ projects: [{ id: project.id, name: "set 1" }], withReprocessLease: withLease, stream, overlay: undefined });
    expect(c).toMatchObject({ total: 3, updated: 2, skipped: 1 });
    expect(c.proposals).toBe(1);
    expect(await piOf(p3.id)).toEqual({ keep: 1 });
    const pi1 = await piOf(p1.id);
    const stored = pi1.classifierProposals as { proposals: Array<{ classId: string | null; recipeId: string }> };
    expect(stored.proposals).toHaveLength(1);
    expect(stored.proposals[0]).toMatchObject({ recipeId: "schedules.v1", classId: "door" });
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
