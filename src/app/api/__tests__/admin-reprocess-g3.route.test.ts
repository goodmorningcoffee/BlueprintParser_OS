// @vitest-environment node
// [refactor jun12 P0.3] END-TO-END regression net for G3 (fixed in S001,
// commit ea5b782): POST /api/admin/reprocess?scope=intelligence must NEVER
// destroy user-promoted parsedRegions again. Before the fix this route
// rebuilt pageIntelligence from {} and wholesale-wrote it — one admin click
// wiped every parse region across all company projects (plan 09 §2.1).
//
// The route streams newline-delimited JSON progress; we drain the stream
// fully (that's when the work happens) before asserting on the DB.
import { describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});
// [TP-1 WP-1.B K02] Race seam: a concurrent user write runs after a page's analysis (computed from
// the loop-start snapshot) and before that page's write. Passthrough unless a test sets `race.write`.
const race = vi.hoisted(() => ({ write: null as null | (() => Promise<void>), armed: false }));
vi.mock("@/lib/page-analysis", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/page-analysis")>();
  return {
    ...orig,
    analyzePageIntelligence: (...args: Parameters<typeof orig.analyzePageIntelligence>) => {
      race.armed = race.write !== null;
      return orig.analyzePageIntelligence(...args);
    },
  };
});
vi.mock("@/server/api/project-write-capability", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/server/api/project-write-capability")>();
  return {
    ...orig,
    withProjectWrite: async (...args: Parameters<typeof orig.withProjectWrite>) => {
      const concurrent = race.armed ? race.write : null;
      if (concurrent) {
        race.write = null;
        race.armed = false;
        await concurrent();
      }
      return orig.withProjectWrite(...args);
    },
  };
});

import { POST } from "@/app/api/admin/reprocess/route";
import { POST as promotePOST } from "@/app/api/regions/promote/route";
import { db } from "@/lib/db";
import { pages } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { asUser, createPage, createUser, createWorld, makeReq } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

describe.skipIf(!dbUp)("POST /api/admin/reprocess?scope=intelligence (G3 regression)", () => {
  it("preserves user parsedRegions and unknown keys; clears stale computed keys", async () => {
    const { company, project } = await createWorld();
    const admin = await createUser(company.id, { role: "admin" });

    const userParsedRegions = [
      { id: "pr-1", type: "schedule", bbox: [0.1, 0.1, 0.5, 0.5], data: { rows: 3 } },
    ];
    const page = await createPage(project.id, 1, {
      // minimal-but-real textract payload: route requires it or skips the page
      textractData: { lines: [], words: [] } as any,
      rawText: "",
      csiCodes: [] as any,
      pageIntelligence: {
        parsedRegions: userParsedRegions, // ← user work product (G3 victim)
        someFutureKey: { keep: "me" }, // ← unknown key must also survive
        classifiedTables: [{ stale: true }], // ← computed: cleared when not recomputed
        yoloHeatmap: { stale: true }, // ← computed: cleared (no YOLO data seeded)
      } as any,
    });

    asUser(admin);
    const res = await POST(
      makeReq("/api/admin/reprocess?scope=intelligence", { method: "POST" }), // no body — route catches & processes ALL company projects
    );
    expect(res.status).toBe(200);
    const streamText = await res.text(); // drain: processing happens inside the stream
    const lines = streamText.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.some((l) => l.type === "complete" || l.type === "done" || l.updated !== undefined || l.type === "project")).toBe(true);

    const [row] = await db.select().from(pages).where(eq(pages.id, page.id));
    const pi = row.pageIntelligence as Record<string, unknown>;
    expect(pi).toBeTruthy();
    // ── THE G3 ASSERTIONS ──
    expect(pi.parsedRegions).toEqual(userParsedRegions); // survived, byte-identical
    expect(pi.someFutureKey).toEqual({ keep: "me" }); // unknown keys survive too
    expect(pi).not.toHaveProperty("classifiedTables"); // stale computed key refreshed-away
    expect(pi).not.toHaveProperty("yoloHeatmap");
  }, 30000);

  // [TP-1 WP-1.B K02] The reprocess wrote each page's WHOLE pageIntelligence from the snapshot read at
  // loop start; a promote that landed on the page meanwhile was erased when the loop reached it.
  it("[K02] a promote landing between the snapshot read and the page write survives", async () => {
    const { company, project } = await createWorld();
    const admin = await createUser(company.id, { role: "admin" });
    const page = await createPage(project.id, 1, {
      textractData: { lines: [], words: [] } as any,
      rawText: "",
      csiCodes: [] as any,
      pageIntelligence: { parsedRegions: [{ id: "pr-1", type: "schedule", bbox: [0.1, 0.1, 0.5, 0.5], data: {} }], yoloHeatmap: { stale: true } } as any,
    });
    asUser(admin);
    let promoteStatus = 0;
    race.write = async () => {
      const r = await promotePOST(makeReq("/api/regions/promote", {
        method: "POST",
        body: { publicId: project.publicId, pageNumber: 1, type: "legend", overrides: { regionId: "pr-2", bbox: [0.6, 0.6, 0.9, 0.9], data: { tableName: "Legend" } } },
      }));
      promoteStatus = r.status;
    };
    const res = await POST(makeReq("/api/admin/reprocess?scope=intelligence", { method: "POST" }));
    expect(res.status).toBe(200);
    await res.text();
    expect(race.write).toBeNull(); // the concurrent write ran inside the race window
    expect(promoteStatus).toBe(200);
    const [row] = await db.select().from(pages).where(eq(pages.id, page.id));
    const pi = row.pageIntelligence as Record<string, any>;
    expect(pi.parsedRegions.map((r: { id: string }) => r.id)).toEqual(["pr-1", "pr-2"]); // the promote survived
    expect(pi).not.toHaveProperty("yoloHeatmap"); // the reprocess still cleared its stale computed key
  }, 30000);

  it("pages without textractData are skipped untouched", async () => {
    const { company, project } = await createWorld();
    const admin = await createUser(company.id, { role: "admin" });
    const bare = await createPage(project.id, 2, {
      pageIntelligence: { parsedRegions: [{ id: "pr-2" }] } as any, // no textractData
    });
    asUser(admin);
    const res = await POST(makeReq("/api/admin/reprocess?scope=intelligence", { method: "POST" }));
    await res.text();
    const [row] = await db.select().from(pages).where(eq(pages.id, bare.id));
    expect((row.pageIntelligence as any).parsedRegions).toEqual([{ id: "pr-2" }]);
  }, 30000);

  it("403 for non-admin members", async () => {
    const { user } = await createWorld();
    asUser(user);
    const res = await POST(makeReq("/api/admin/reprocess?scope=intelligence", { method: "POST" }));
    expect(res.status).toBe(403);
  });
});
