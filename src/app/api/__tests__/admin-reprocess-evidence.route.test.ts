// @vitest-environment node
// [evidence T4 2026-10-24] DB-backed proof for POST /api/admin/reprocess?scope=evidence: it writes
// ONLY pageIntelligence.evidence (merged in SQL, every other key byte-identical), skips pages
// without OCR, leaves an unchanged page alone on a second run, and ends with a `done` line.
import { describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { POST } from "@/app/api/admin/reprocess/route";
import { db } from "@/lib/db";
import { annotations, pages } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { asUser, createPage, createUser, createWorld, makeReq } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

async function drain(res: Response): Promise<Record<string, any>[]> {
  const text = await res.text();
  return text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const OCR = {
  lines: [],
  words: [{ text: "DOOR", confidence: 90, bbox: [0.1, 0.1, 0.04, 0.01] }],
  tables: [{ bbox: [0.5, 0.1, 0.4, 0.3], rowCount: 3, colCount: 2, cells: [] }],
};

describe.skipIf(!dbUp)("POST /api/admin/reprocess?scope=evidence", () => {
  it("writes only the evidence key, from stored OCR × YOLO rows; a re-run rewrites nothing", async () => {
    const { company, project } = await createWorld();
    const admin = await createUser(company.id, { role: "admin" });
    const userKeys = { parsedRegions: [{ id: "pr-ev", type: "schedule" }], classification: { discipline: "A" }, someFutureKey: 1 };
    const page = await createPage(project.id, 1, { textractData: OCR as any, pageIntelligence: userKeys as any });
    const bare = await createPage(project.id, 2, { pageIntelligence: { keep: true } as any }); // no OCR
    await db.insert(annotations).values([
      { name: "text_box", minX: 0.09, minY: 0.095, maxX: 0.15, maxY: 0.115, pageNumber: 1, threshold: 0.1, source: "yolo", projectId: project.id, data: { confidence: 0.9, modelName: "yolo_text" } as any },
      { name: "text_box", minX: 0.6, minY: 0.6, maxX: 0.62, maxY: 0.61, pageNumber: 1, threshold: 0.1, source: "yolo", projectId: project.id, data: { confidence: 0.55, modelName: "yolo_text" } as any },
    ]);

    asUser(admin);
    const lines = await drain(await POST(makeReq("/api/admin/reprocess?scope=evidence", { method: "POST" })));
    expect(lines.find((l) => l.type === "project")).toMatchObject({ name: project.name, pages: 2, yoloPages: 1 });
    expect(lines.at(-1)).toMatchObject({ type: "done", updated: 1, skipped: 1, noOcr: 1, unchanged: 0, errors: 0, total: 2 });

    const [row] = await db.select().from(pages).where(eq(pages.id, page.id));
    const pi = row.pageIntelligence as Record<string, any>;
    expect(Object.keys(pi).sort()).toEqual(["classification", "evidence", "parsedRegions", "someFutureKey"]);
    expect(pi.parsedRegions).toEqual(userKeys.parsedRegions);
    expect(pi.evidence).toMatchObject({
      v: 1,
      counts: { ocrWords: 1, both: 1, holes: 1, tables: 1 },
      holes: [{ bbox: [0.6, 0.6, 0.62, 0.61], conf: 0.55, zone: "notes" }],
      tables: [{ rows: 3, cols: 2, cells: 0 }],
    });
    const [bareRow] = await db.select().from(pages).where(eq(pages.id, bare.id));
    expect(bareRow.pageIntelligence).toEqual({ keep: true });

    const again = await drain(await POST(makeReq("/api/admin/reprocess?scope=evidence", { method: "POST" })));
    expect(again.at(-1)).toMatchObject({ type: "done", updated: 0, unchanged: 1, noOcr: 1 });
    const [row2] = await db.select().from(pages).where(eq(pages.id, page.id));
    expect((row2.pageIntelligence as Record<string, any>).evidence.computedAt).toBe(pi.evidence.computedAt);
  }, 30000);
});
