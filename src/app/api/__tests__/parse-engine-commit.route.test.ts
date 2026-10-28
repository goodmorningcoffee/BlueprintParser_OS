// @vitest-environment node
// [table pipeline WP-3.G] POST …/parse-engine/commit and DELETE …/parse-engine/region through the real route
// shells, the real project resolver, the real page-evidence loader, run.ts and Postgres. The engine
// (`runParseEngine`) and `applyOps` are mocked until WP-3.D fills them; S3 and Textract are in-memory fakes.
//   • 409 stale revision; 409 stale on a classic edit made after the draft loaded (viewHash, PLAN §1.1 row 7);
//     409 conflict → Replace / Keep both; a forged `machine` is ignored; a failed tag pass does not block Accept;
//   • page CSI shrinks on replace and on delete (K50); a paid recipe at commit makes ZERO Textract calls on a
//     cache hit and 409s on a miss; an evidence change rebases with `changedRows`; a lost op refuses;
//   • accept maps keynote tags on THIS sheet only, links them to the region, retires the replaced classic rows;
//   • the proposal verdict is accept WITH the accepted classId (K58); a text-region item records its verdict;
//   • lock order project → page: a commit and a proposal verdict on the same page both wait, neither deadlocks;
//   • the whole-array PATCH prunes the label of a region it dropped (WP-2.F follow-up);
//   • REPROCESS_COMPUTED_KEYS stays free of every key the commit writes; demo refused.
// All strings are synthetic (rule 12).
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({
  objects: new Map<string, Buffer>(),
  analyzed: 0,
  model: null as unknown,
  hash: "ev-1",
  engineRequests: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});
vi.mock("@/lib/s3", async (orig) => {
  const m = await orig<typeof import("@/lib/s3")>();
  return {
    ...m,
    downloadFromS3: vi.fn(async (key: string) => {
      const v = h.objects.get(key);
      if (!v) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
      return v;
    }),
    uploadToS3: vi.fn(async (key: string, body: Buffer) => {
      h.objects.set(key, body);
    }),
  };
});
vi.mock("@/lib/textract", async (orig) => {
  const m = await orig<typeof import("@/lib/textract")>();
  return {
    ...m,
    analyzePageImage: vi.fn(async () => {
      h.analyzed += 1;
      return { lines: [], words: [], tables: [] };
    }),
  };
});
vi.mock("@/server/services/parse-engine/flags", async (orig) => {
  const m = await orig<typeof import("@/server/services/parse-engine/flags")>();
  return { ...m, readParseEngineFlags: async () => m.resolveParseEngineFlags({ tools: { workspace: "engine" } }).flags };
});
vi.mock("@/lib/parse-engine/engine", () => ({
  runParseEngine: vi.fn(async (_evidence: unknown, request: Record<string, unknown>) => {
    h.engineRequests.push(request);
    return {
      model: structuredClone(h.model),
      alternatives: [],
      evidence: { words: 4, lines: 4, paidCropAvailable: false },
      words: [],
      stamp: {
        engine: "pe/1.0.0", caps: { rows: 1, cols: 1 }, methods: [{ id: "ocr-lines", v: 1, conf: 0.9, used: true }],
        budget: request.budget, evidenceHash: h.hash, paramsHash: "params-1", at: "2026-10-28T00:00:00.000Z",
      },
    };
  }),
}));
// A minimal applyOps for the ops these tests send (WP-3.D owns the real one).
vi.mock("@/lib/parse-engine/ops", () => ({
  applyOps: vi.fn((base: { model: Record<string, any> }, ops: Record<string, any>[]) => {
    const m = structuredClone(base.model);
    for (const op of ops) {
      if (op.op === "edit-cell") {
        const cell = m.cells.find((c: any) => c.row === op.row && c.col === op.col);
        if (cell) Object.assign(cell, { text: op.text, src: "edit" });
      }
      if (op.op === "set-title") m.title = { text: op.text, src: "user", conf: 1 };
    }
    return m;
  }),
}));

import sharp from "sharp";
import { POST as commitPOST } from "@/app/api/projects/[id]/parse-engine/commit/route";
import { DELETE as regionDELETE } from "@/app/api/projects/[id]/parse-engine/region/route";
import { POST as parsePOST } from "@/app/api/projects/[id]/parse-engine/parse/route";
import { POST as verdictPOST } from "@/app/api/projects/[id]/proposals/verdict/route";
import { PATCH as intelligencePATCH } from "@/app/api/pages/intelligence/route";
import { db } from "@/lib/db";
import { pages, projects } from "@/lib/db/schema";
import { REPROCESS_COMPUTED_KEYS } from "@/lib/intelligence-merge";
import { legacyView, viewHash } from "@/lib/parse-engine/legacy-view";
import type { StructureParagraphDoc, StructureTableModel } from "@/lib/parse-engine/types";
import type { ClassifierProposal } from "@/lib/classifier-engine/types";
import { regionSnapshot, snapshotHashOf } from "@/server/services/parse-labels";
import { resetParseSlotsForTest } from "@/server/services/parse-engine/concurrency";
import { asUser, createPage, createUser, createWorld, makeReq, params, publishDemoFixture, readJson, signedOut } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

const BOX: [number, number, number, number] = [0.7, 0.7, 0.95, 0.9];
const Q = { conf: 0.9, agreement: 0.9, flags: [] as string[] };

function keynoteModel(over: Partial<StructureTableModel> = {}): StructureTableModel {
  return {
    v: 1, kind: "keynote", bbox: BOX, headerRows: 1,
    rows: [
      { id: "r0", y0: 0.7, y1: 0.72, role: "header" },
      { id: "r1", y0: 0.72, y1: 0.75, role: "body", csi: [{ code: "09 91 23", description: "Synthetic paint", src: "engine" }] },
      { id: "r2", y0: 0.75, y1: 0.78, role: "body" },
    ],
    cols: [
      { id: "c1", x0: 0.7, x1: 0.75, label: "KEY", labelRaw: "KEY" },
      { id: "c2", x0: 0.75, x1: 0.95, label: "NOTE", labelRaw: "NOTE" },
    ],
    cells: [
      { row: "r0", col: "c1", text: "KEY", src: "ocr-lines" },
      { row: "r0", col: "c2", text: "NOTE", src: "ocr-lines" },
      { row: "r1", col: "c1", text: "QZ7", src: "ocr-lines" },
      { row: "r1", col: "c2", text: "LOREM", src: "ocr-lines" },
      { row: "r2", col: "c1", text: "QZ8", src: "ocr-lines" },
      { row: "r2", col: "c2", text: "IPSUM", src: "ocr-lines" },
    ],
    tag: { col: "c1", src: "header", scope: "sheet" },
    sources: { rows: ["ocr-lines"], cols: ["x-starts"] },
    quality: Q,
    ...over,
  };
}

const NOTES_BOX: [number, number, number, number] = [0.1, 0.1, 0.4, 0.3];
const notesModel: StructureParagraphDoc = {
  v: 1, kind: "notes", bbox: NOTES_BOX,
  blocks: [{ id: "b1", header: "GENERAL NOTES", headerNorm: "GENERAL NOTES", b: [0.1, 0.1, 0.4, 0.12] }],
  paragraphs: [
    { id: "p1", blockId: "b1", key: "1", keyPath: ["1"], keyNorm: "1", depth: 0, text: "Lorem ipsum", b: [0.1, 0.12, 0.4, 0.15], lineCount: 1 },
    { id: "p2", blockId: "b1", key: "2", keyPath: ["2"], keyNorm: "2", depth: 0, text: "Dolor sit", b: [0.1, 0.15, 0.4, 0.18], lineCount: 1 },
  ],
  sources: { segment: ["hanging-indent"] }, quality: Q,
};

const word = (text: string, x: number, y: number) => ({ text, confidence: 99, bbox: [x, y, 0.02, 0.01] });
const TEXTRACT_P1 = { lines: [], tables: [], words: [word("QZ7", 0.3, 0.3), word("QZ7", 0.4, 0.5), word("QZ8", 0.2, 0.2)] };
const TEXTRACT_P2 = { lines: [], tables: [], words: [word("QZ7", 0.3, 0.3)] };

const PROPOSAL: ClassifierProposal = {
  id: "schedule-kind:p1:0.7,0.7,0.95,0.9", recipeId: "schedule-kind", recipeVersion: 3, engineVersion: "clf/0.1",
  pageNumber: 1, bbox: BOX, target: "schedule", p: 0.9, classId: "door", className: "Door schedule", group: "arch",
  nameP: 0.8, margin: 0.4, displayName: "Door schedule", detectWhy: [], nameWhy: [], features: { "detect.structure": 0.7 },
};
const OTHER_PROPOSAL: ClassifierProposal = { ...PROPOSAL, id: "schedule-kind:p1:0.1,0.1,0.4,0.3", bbox: NOTES_BOX };

async function world(opts: { demo?: boolean; pi?: Record<string, unknown>; csiCodes?: unknown[] } = {}) {
  const w = await createWorld();
  const page = await createPage(w.project.id, 1, {
    textractData: TEXTRACT_P1 as never, drawingNumber: "A-101",
    pageIntelligence: (opts.pi ?? {}) as never,
    ...(opts.csiCodes ? { csiCodes: opts.csiCodes as never } : {}),
  });
  const page2 = await createPage(w.project.id, 2, { textractData: TEXTRACT_P2 as never, drawingNumber: "A-102" });
  if (opts.demo) await publishDemoFixture(w.project.id);
  const png = await sharp({ create: { width: 200, height: 100, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
  h.objects.set(`${w.project.dataUrl}/pages/page_0001.png`, png);
  return { ...w, page, page2 };
}

const recipe = (over: Record<string, unknown> = {}) => ({ origin: "proposal", request: { page: 1, bbox: BOX, budget: "instant", kind: "keynote", ...over } });
const commit = (publicId: string, body: unknown) =>
  commitPOST(makeReq(`/api/projects/${publicId}/parse-engine/commit`, { body, headers: { "x-forwarded-for": "198.51.100.7" } }), params({ id: publicId }));
const removeRegion = (publicId: string, body: unknown) =>
  regionDELETE(makeReq(`/api/projects/${publicId}/parse-engine/region`, { method: "DELETE", body }), params({ id: publicId }));

async function pageRow(pageId: number) {
  const [row] = await db.select({ pi: pages.pageIntelligence, csi: pages.csiCodes }).from(pages).where(eq(pages.id, pageId));
  return { pi: row.pi as Record<string, any>, csi: (row.csi ?? []) as { code: string }[] };
}
async function projectPi(projectId: number) {
  const [row] = await db.select({ pi: projects.projectIntelligence }).from(projects).where(eq(projects.id, projectId));
  return (row.pi ?? {}) as Record<string, any>;
}

beforeEach(() => {
  h.analyzed = 0;
  h.model = keynoteModel();
  h.hash = "ev-1";
  h.engineRequests.length = 0;
  resetParseSlotsForTest();
  signedOut();
});
afterEach(() => vi.clearAllMocks());

describe.skipIf(!dbUp)("POST /api/projects/[id]/parse-engine/commit", () => {
  it("saves the region (projection + structure), a server-computed committed label (forged machine ignored), the verdict with the class, and maps tags on this sheet only", async () => {
    const { user, project, page } = await world({ pi: { classifierProposals: { engineVersion: "clf/0.1", recipes: {}, proposals: [PROPOSAL] } } });
    asUser(user);
    const r = await readJson(await commit(project.publicId, {
      recipe: recipe({ hints: { proposalId: PROPOSAL.id } }),
      ops: [{ op: "edit-cell", row: "r2", col: "c2", text: "IPSUM DOLOR" }, { op: "set-kind", kind: "keynote", classId: "window" }],
      evidenceHash: "ev-1", secondsToAccept: 12,
      machine: { kind: "spec", rowY: [], colX: [], headerRows: 0, cellHash: [] }, label: { verdict: "correct" },
    }));
    expect(r.status).toBe(200);
    const regionId = r.body.regionId as string;
    expect(regionId).toBe("sr-keynote-1-0.700_0.700_0.950_0.900");
    expect(r.body).toMatchObject({ ok: true, revision: 1, kind: "keynote", tagSummary: { keys: 2, tags: 2, hits: 3, none: 0, scope: "sheet" } });

    const { pi, csi } = await pageRow(page.id);
    const region = pi.parsedRegions.find((x: any) => x.id === regionId);
    expect(region).toMatchObject({ type: "keynote", source: "user", bbox: BOX });
    expect(region.data.rows).toEqual([{ KEY: "QZ7", NOTE: "LOREM" }, { KEY: "QZ8", NOTE: "IPSUM DOLOR" }]);
    expect(region.data.keynotes).toEqual([{ key: "QZ7", description: "LOREM" }, { key: "QZ8", description: "IPSUM DOLOR" }]);
    expect(region.data.structure.cells.find((c: any) => c.row === "r2" && c.col === "c2").text).toBe("IPSUM DOLOR");
    expect(region.data.links).toMatchObject({ origin: "workspace", revision: 1, proposalId: PROPOSAL.id });
    expect(region.data.links).not.toHaveProperty("acceptedBy"); // no user id in the page window (verify LOW-3)
    expect(region.data.links.viewHash).toBe(viewHash(region.data));
    expect(region.data.recipe.request).not.toHaveProperty("prior");
    expect(region.data.ops).toHaveLength(2);
    expect(region.csiTags.map((c: any) => c.code)).toContain("09 91 23");
    expect(csi.map((c) => c.code)).toContain("09 91 23");

    const label = pi.parseLabels[regionId];
    const machine = regionSnapshot({ type: "keynote", data: legacyView(keynoteModel(), { tableName: region.data.tableName }) });
    expect(label).toMatchObject({ v: 1, source: "workspace", verdict: "committed", by: user.id, kind: "keynote", proposalId: PROPOSAL.id, classIdAccepted: "window", secondsToAccept: 12 });
    expect(label.machine).toEqual(machine);
    expect(label.snapshotHash).toBe(snapshotHashOf(regionSnapshot(region)));
    expect(label.ops).toEqual([{ op: "edit-cell", n: 1 }, { op: "set-kind", n: 1 }]);
    expect(pi.proposalVerdicts[PROPOSAL.id]).toMatchObject({ verdict: "accept", classId: "window", regionId, proposedClassId: "door" });

    const tags = (await projectPi(project.id)).yoloTags as any[];
    expect(tags.map((t) => [t.tagText, t.scope, t.pageNumber, t.links])).toEqual([
      ["QZ7", "page", 1, { regionId, rowId: "r1", kind: "keynote" }],
      ["QZ8", "page", 1, { regionId, rowId: "r2", kind: "keynote" }],
    ]);
    expect(tags.flatMap((t) => t.instances.map((i: any) => i.pageNumber))).toEqual([1, 1, 1]); // never page 2
    expect(r.body.tags.replacedRegionIds).toEqual([regionId]);
    expect(r.body.tags.rows).toHaveLength(2);
    expect(r.body.updatedIntelligence).not.toHaveProperty("parseLabels");
  });

  it("409 stale on an old revision; the current revision re-saves in place as revision 2", async () => {
    const { user, project, page } = await world();
    asUser(user);
    const first = await readJson(await commit(project.publicId, { recipe: recipe(), ops: [] }));
    expect(first.status).toBe(200);
    const stale = await readJson(await commit(project.publicId, { recipe: recipe(), ops: [], regionId: first.body.regionId, revision: 0 }));
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: { code: "CONFLICT" }, reason: "stale", regionId: first.body.regionId, revision: 1 });
    const again = await readJson(await commit(project.publicId, { recipe: recipe(), ops: [], regionId: first.body.regionId, revision: 1 }));
    expect(again.status).toBe(200);
    expect(again.body.revision).toBe(2);
    expect((await pageRow(page.id)).pi.parsedRegions).toHaveLength(1);
    const gone = await readJson(await commit(project.publicId, { recipe: recipe(), ops: [], regionId: "parsed-missing", revision: 0 }));
    expect(gone.body).toMatchObject({ reason: "stale", revision: null });
  });

  it("409 stale when the region was edited in a classic panel after the draft loaded (same revision); the reloaded view re-saves", async () => {
    const { user, project, page } = await world();
    asUser(user);
    const first = await readJson(await commit(project.publicId, { recipe: recipe(), ops: [] }));
    expect(first.status).toBe(200);
    const regionId = first.body.regionId as string;
    const loadedView = viewHash((await pageRow(page.id)).pi.parsedRegions[0].data);
    // a classic rename spreads r.data, so links (revision 1) ride along unchanged
    const saved = (await pageRow(page.id)).pi.parsedRegions[0];
    const renamed = { ...saved, data: { ...saved.data, tableName: "Renamed classic" } };
    const patched = await intelligencePATCH(makeReq("/api/pages/intelligence", {
      method: "PATCH", body: { publicId: project.publicId, pageNumber: 1, intelligence: { parsedRegions: [renamed] } },
    }));
    expect(patched.status).toBe(200);
    const edited = (await pageRow(page.id)).pi.parsedRegions[0];
    expect(edited.data.links.revision).toBe(1);
    const editedView = viewHash(edited.data);
    expect(editedView).not.toBe(loadedView);

    const blind = await readJson(await commit(project.publicId, { recipe: recipe(), ops: [], regionId, revision: 1 }));
    expect(blind.status).toBe(409);
    expect(blind.body).toMatchObject({ reason: "stale", regionId, revision: 1, viewHash: editedView });
    const old = await readJson(await commit(project.publicId, { recipe: recipe(), ops: [], regionId, revision: 1, viewHash: loadedView }));
    expect(old.status).toBe(409);
    expect((await pageRow(page.id)).pi.parsedRegions[0].data.tableName).toBe("Renamed classic"); // nothing overwritten

    const reloaded = await readJson(await commit(project.publicId, { recipe: recipe(), ops: [], regionId, revision: 1, viewHash: blind.body.viewHash, tableName: "Renamed classic" }));
    expect(reloaded.status).toBe(200);
    expect(reloaded.body.revision).toBe(2);
    const after = (await pageRow(page.id)).pi.parsedRegions[0];
    expect(after.data.links.viewHash).toBe(viewHash(after.data));
    // an untouched workspace region re-saves at its revision without a viewHash
    expect((await commit(project.publicId, { recipe: recipe(), ops: [], regionId, revision: 2 })).status).toBe(200);
  });

  it("a failed tag pass does not block Accept: the region lands, its tags are left as they were, no tagSummary", async () => {
    const { defaultCommitDeps } = await import("@/server/services/parse-engine/commit");
    const spy = vi.spyOn(defaultCommitDeps, "matchTags").mockRejectedValueOnce(new Error("synthetic matcher outage"));
    const { user, project, page } = await world();
    asUser(user);
    const r = await readJson(await commit(project.publicId, { recipe: recipe(), ops: [] }));
    spy.mockRestore();
    expect(r.status).toBe(200);
    expect(r.body).not.toHaveProperty("tagSummary");
    expect(r.body.tags).toEqual({ rows: [], removed: [], replacedRegionIds: [] });
    expect((await pageRow(page.id)).pi.parsedRegions).toHaveLength(1);
    expect((await projectPi(project.id)).yoloTags ?? []).toEqual([]);
  });

  it("409 conflict on an overlapping saved region → Replace (its id + revision) retires its classic tags; Keep both saves a second region", async () => {
    const classic = {
      id: "parsed-c", type: "keynote", category: "keynotes", bbox: [0.7, 0.7, 0.95, 0.89], confidence: 0.9,
      csiTags: [{ code: "08 11 13", description: "region only", division: "08 00 00", trade: "" }],
      data: { keynotes: [{ key: "QZ7", description: "old" }], isPageSpecific: true },
    };
    const { user, project, page } = await world({
      pi: { parsedRegions: [classic], parseLabels: { "parsed-c": { v: 1, regionId: "parsed-c", kind: "keynote", source: "verdict-bar", verdict: "wrong", at: "2026-10-01T00:00:00.000Z", snapshotHash: "x" } } },
      csiCodes: [
        { code: "08 11 13", description: "region only", division: "08 00 00", trade: "" },
        { code: "26 05 00", description: "text", division: "26 00 00", trade: "", triggers: [] },
      ],
    });
    await db.update(projects).set({ projectIntelligence: { yoloTags: [
      { id: "keynote-1-QZ7-1", name: "QZ7", tagText: "QZ7", yoloClass: "", yoloModel: "", source: "keynote", scope: "page", pageNumber: 1, instances: [] },
      { id: "keynote-2-QZ7-1", name: "QZ7", tagText: "QZ7", yoloClass: "", yoloModel: "", source: "keynote", scope: "page", pageNumber: 2, instances: [] },
    ] } as never }).where(eq(projects.id, project.id));
    asUser(user);
    const clash = await readJson(await commit(project.publicId, { recipe: recipe(), ops: [] }));
    expect(clash.status).toBe(409);
    expect(clash.body).toMatchObject({ reason: "conflict", conflict: { regionId: "parsed-c", kind: "keynote", revision: 0, title: "keynotes", viewHash: viewHash(classic.data) } });

    const replaced = await readJson(await commit(project.publicId, { recipe: recipe(), ops: [], regionId: "parsed-c", revision: 0 }));
    expect(replaced.status).toBe(200);
    expect(replaced.body).toMatchObject({ regionId: "parsed-c", revision: 1 });
    let row = await pageRow(page.id);
    expect(row.pi.parsedRegions.map((x: any) => x.id)).toEqual(["parsed-c"]);
    expect(row.pi.parseLabels["parsed-c"].verdict).toBe("committed");
    expect(row.csi.map((c) => c.code)).toEqual(["26 05 00", "09 91 23"]); // K50: the replaced region's code went
    const ids = ((await projectPi(project.id)).yoloTags as any[]).map((t) => t.id);
    expect(ids).not.toContain("keynote-1-QZ7-1"); // the replaced classic table's row is retired
    expect(ids).toContain("keynote-2-QZ7-1");     // another sheet's row is not

    const both = await readJson(await commit(project.publicId, { recipe: recipe(), ops: [], onConflict: "keep-both" }));
    expect(both.status).toBe(200);
    row = await pageRow(page.id);
    expect(row.pi.parsedRegions.map((x: any) => x.id)).toEqual(["parsed-c", "sr-keynote-1-0.700_0.700_0.950_0.900"]);
  });

  it("an evidence change rebases: 409 with the rebased model and changedRows, ids re-matched via prior; the new hash commits", async () => {
    const { user, project } = await world();
    asUser(user);
    const base = keynoteModel();
    h.hash = "ev-2";
    h.model = keynoteModel({ rows: [base.rows[0], { ...base.rows[1], y1: 0.76 }, base.rows[2]] });
    const r = await readJson(await commit(project.publicId, { recipe: recipe(), ops: [{ op: "edit-cell", row: "r1", col: "c2", text: "X" }], base, evidenceHash: "ev-1" }));
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ reason: "rebased", changedRows: 1, evidenceHash: "ev-2" });
    expect(r.body.rebased.cells.find((c: any) => c.row === "r1" && c.col === "c2").text).toBe("X");
    expect(h.engineRequests[0].prior).toEqual(base);
    const ok = await readJson(await commit(project.publicId, { recipe: recipe(), ops: [{ op: "edit-cell", row: "r1", col: "c2", text: "X" }], base, evidenceHash: "ev-2" }));
    expect(ok.status).toBe(200);
  });

  it("a correction that no longer lands is refused (409 ops-lost), nothing is written", async () => {
    const { user, project, page } = await world();
    asUser(user);
    const r = await readJson(await commit(project.publicId, { recipe: recipe(), ops: [{ op: "edit-cell", row: "r77", col: "c2", text: "X" }] }));
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ reason: "ops-lost", lost: [{ index: 0, op: "edit-cell" }] });
    expect((await pageRow(page.id)).pi.parsedRegions).toBeUndefined();
  });

  it("a paid recipe reads the crop cache only: a miss is 409 paid-expired with zero Textract calls; after one paid parse, commit is free", async () => {
    const { user, project } = await world();
    asUser(user);
    const paid = recipe({ budget: "thorough", hints: { allowPaidTextract: true } });
    const miss = await readJson(await commit(project.publicId, { recipe: paid, ops: [] }));
    expect(miss.status).toBe(409);
    expect(miss.body).toMatchObject({ reason: "paid-expired", paidExpired: true, methods: ["textract"] });
    expect(h.analyzed).toBe(0);
    const parsed = await parsePOST(makeReq(`/api/projects/${project.publicId}/parse-engine/parse`, { body: paid.request, headers: { "x-forwarded-for": "198.51.100.7" } }), params({ id: project.publicId }));
    expect(parsed.status).toBe(200);
    expect(h.analyzed).toBe(1);
    const hit = await readJson(await commit(project.publicId, { recipe: paid, ops: [] }));
    expect(hit.status).toBe(200);
    expect(h.analyzed).toBe(1);
  });

  it("a text-region item records its accept verdict (content key) and links the classic text region", async () => {
    h.model = notesModel;
    const textRegion = { id: "region-0", type: "notes-numbered", bbox: [0.1, 0.1, 0.3, 0.2], confidence: 0.8, containedText: "" };
    const { user, project, page } = await world({ pi: { textRegions: [textRegion] } });
    asUser(user);
    const key = "tr:notes-numbered:0.10,0.10,0.40,0.30";
    const r = await readJson(await commit(project.publicId, {
      recipe: { origin: "text-region", request: { page: 1, bbox: NOTES_BOX, budget: "instant", kind: "notes" } }, ops: [], links: { textRegionKey: key },
    }));
    expect(r.status).toBe(200);
    expect(r.body.tagSummary).toBeUndefined();
    const { pi } = await pageRow(page.id);
    const region = pi.parsedRegions[0];
    expect(region).toMatchObject({ id: "sr-notes-1-0.100_0.100_0.400_0.300", type: "notes", sourceTextRegionId: "region-0" });
    expect(region.data.rows).toEqual([{ Key: "1", Note: "Lorem ipsum" }, { Key: "2", Note: "Dolor sit" }]);
    expect(pi.textRegionVerdicts[key]).toMatchObject({ verdict: "accept", type: "notes-numbered", b: [0.1, 0.1, 0.4, 0.3], by: user.id });
  });

  it("lock order project → page: a commit waits behind a held page lock, a concurrent verdict waits behind the commit; both land", async () => {
    const { user, project, page } = await world({ pi: { classifierProposals: { engineVersion: "clf/0.1", recipes: {}, proposals: [PROPOSAL, OTHER_PROPOSAL] } } });
    asUser(user);
    let released = 0;
    let holderStarted!: () => void;
    const started = new Promise<void>((resolve) => { holderStarted = resolve; });
    const holder = db.transaction(async (tx) => {
      await tx.select({ id: pages.id }).from(pages).where(eq(pages.id, page.id)).for("update");
      holderStarted();
      await new Promise((resolve) => setTimeout(resolve, 600));
      released = Date.now();
    });
    await started;
    const done: Record<string, number> = {};
    const c = commit(project.publicId, { recipe: recipe(), ops: [] }).then(async (res) => { done.commit = Date.now(); return readJson(res); });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const v = verdictPOST(
      makeReq(`/api/projects/${project.publicId}/proposals/verdict`, { body: { pageNumber: 1, proposalId: OTHER_PROPOSAL.id, verdict: "reject" } }),
      params({ id: project.publicId }),
    ).then(async (res) => { done.verdict = Date.now(); return readJson(res); });
    const [cr, vr] = await Promise.all([c, v, holder]);
    expect(cr.status).toBe(200);
    expect(vr.status).toBe(200);
    expect(done.commit).toBeGreaterThanOrEqual(released); // it WAITED for the page lock (not a vacuous pass)
    expect(done.verdict).toBeGreaterThanOrEqual(released);
    const { pi } = await pageRow(page.id);
    expect(pi.parsedRegions).toHaveLength(1);
    expect(pi.proposalVerdicts[OTHER_PROPOSAL.id].verdict).toBe("reject");
  });

  it("REPROCESS_COMPUTED_KEYS holds none of the keys the commit writes (unchanged by TP-3)", () => {
    for (const key of ["parsedRegions", "parseLabels", "proposalVerdicts", "textRegionVerdicts", "structureIndex", "yoloTags"]) {
      expect(REPROCESS_COMPUTED_KEYS as readonly string[]).not.toContain(key);
    }
  });

  it("demo refused for every role; signed out on a private project → 401; validation → 400", async () => {
    const demo = await world({ demo: true });
    signedOut();
    expect((await commit(demo.project.publicId, { recipe: recipe(), ops: [] })).status).toBe(403);
    expect((await removeRegion(demo.project.publicId, { pageNumber: 1, regionId: "x" })).status).toBe(403);
    asUser(demo.user);
    expect((await commit(demo.project.publicId, { recipe: recipe(), ops: [] })).status).toBe(403);
    const { user, project } = await world();
    signedOut();
    expect((await commit(project.publicId, { recipe: recipe(), ops: [] })).status).toBe(401);
    asUser(user);
    expect((await commit(project.publicId, { recipe: { origin: "proposal", request: { page: 1, bbox: BOX, budget: "free" } } })).status).toBe(400);
    expect((await commit(project.publicId, { recipe: recipe(), regionId: "x" })).status).toBe(400);
    const outsider = await createUser((await createWorld()).company.id);
    asUser(outsider);
    expect((await commit(project.publicId, { recipe: recipe(), ops: [] })).status).toBe(404);
  });
});

describe.skipIf(!dbUp)("DELETE /api/projects/[id]/parse-engine/region", () => {
  it("removes the region, its label, its tag projection and the page CSI only it carried (K50); summaries recomputed", async () => {
    const { user, project, page } = await world({ csiCodes: [{ code: "26 05 00", description: "text", division: "26 00 00", trade: "", triggers: [] }] });
    asUser(user);
    const saved = await readJson(await commit(project.publicId, { recipe: recipe(), ops: [] }));
    const regionId = saved.body.regionId as string;
    expect((await pageRow(page.id)).csi.map((c) => c.code)).toEqual(["26 05 00", "09 91 23"]);
    expect(((await projectPi(project.id)).yoloTags as any[]).length).toBe(2);

    const r = await readJson(await removeRegion(project.publicId, { pageNumber: 1, regionId }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, deleted: true, csiCodeCount: 1, tags: { replacedRegionIds: [regionId] } });
    expect(r.body.tags.removed.sort()).toEqual([`${regionId}:r1`, `${regionId}:r2`]);
    const { pi, csi } = await pageRow(page.id);
    expect(pi.parsedRegions).toEqual([]);
    expect(pi.parseLabels).toEqual({});
    expect(csi.map((c) => c.code)).toEqual(["26 05 00"]);
    expect((await projectPi(project.id)).yoloTags).toEqual([]);
    expect((await projectPi(project.id)).structureIndex?.regions ?? {}).toEqual({});
    const again = await readJson(await removeRegion(project.publicId, { pageNumber: 1, regionId }));
    expect(again.body.deleted).toBe(false);
    expect((await removeRegion(project.publicId, { pageNumber: 1 })).status).toBe(400);
  });
});

describe.skipIf(!dbUp)("PATCH /api/pages/intelligence prunes the label of a dropped region (WP-2.F follow-up)", () => {
  it("drops only the labels whose region the PATCH removed; a PATCH without parsedRegions keeps every label", async () => {
    const label = (regionId: string) => ({ v: 1, regionId, kind: "schedule", source: "verdict-bar", verdict: "correct", at: "2026-10-01T00:00:00.000Z", snapshotHash: "x" });
    const A = { id: "parsed-a", type: "schedule", category: "a", bbox: [0.1, 0.1, 0.3, 0.3], confidence: 0.9, data: { headers: ["K"], rows: [{ K: "1" }] } };
    const B = { ...A, id: "parsed-b", bbox: [0.5, 0.5, 0.7, 0.7] };
    const { user, project, page } = await world({ pi: { parsedRegions: [A, B], parseLabels: { "parsed-a": label("parsed-a"), "parsed-b": label("parsed-b") } } });
    asUser(user);
    const patch = (intelligence: unknown) =>
      intelligencePATCH(makeReq("/api/pages/intelligence", { method: "PATCH", body: { publicId: project.publicId, pageNumber: 1, intelligence } }));
    expect((await patch({ rejectedTextRegionIds: ["region-9"] })).status).toBe(200);
    expect(Object.keys((await pageRow(page.id)).pi.parseLabels).sort()).toEqual(["parsed-a", "parsed-b"]);
    expect((await patch({ parsedRegions: [A] })).status).toBe(200);
    expect(Object.keys((await pageRow(page.id)).pi.parseLabels)).toEqual(["parsed-a"]);
  });
});
