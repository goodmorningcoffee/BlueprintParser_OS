// @vitest-environment node
// [csi-v2 S6] The three page-level CSI call sites (pages.ts recomputePageCsi, reprocess.ts, processing.ts)
// pass {lines: textractData.lines, context: {drawingNumber}} into detectCsiCodes (PLAN §7), and the REAL
// engine's output reflects it: "DUCTILE IRON UTILITY PIPING" is a division-33 phrase, which the facility
// gate (PLAN §6.7) emits only on a civil sheet (C-101 → discipline 'C'), never on A-101 or without context.
// Review fix round 1: dropping the context at all three sites together passed every other test (mutant m2).
// Adopted from the S6 verifier's out-of-tree probe (logs/s6verify-20261021T0530Z-context-arrival.*).
import { beforeEach, describe, expect, inject, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ args: [] as unknown[][] }));
vi.mock("@/lib/csi-detect", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/csi-detect")>();
  return { ...orig, detectCsiCodes: (...a: unknown[]) => { calls.args.push(a); return (orig.detectCsiCodes as (...x: unknown[]) => unknown)(...a); } };
});
vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});
vi.mock("@/lib/s3", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  headS3Object: vi.fn(async () => ({ exists: true, size: 8 })),
  uploadToS3: vi.fn(async () => {}),
  downloadFromS3: vi.fn(async () => Buffer.from("fake-bytes")),
}));
vi.mock("@/lib/pdf-rasterize", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  rasterizePage: vi.fn(async () => Buffer.alloc(32)),
  getPdfPageCount: vi.fn(async () => 1),
}));
const W = [
  { text: "DUCTILE", confidence: 99, bbox: [0.1, 0.1, 0.05, 0.01] },
  { text: "IRON", confidence: 99, bbox: [0.16, 0.1, 0.03, 0.01] },
  { text: "UTILITY", confidence: 99, bbox: [0.2, 0.1, 0.05, 0.01] },
  { text: "PIPING", confidence: 99, bbox: [0.26, 0.1, 0.05, 0.01] },
];
const TD = { lines: [{ text: "DUCTILE IRON UTILITY PIPING", confidence: 99, words: W, bbox: [0.1, 0.1, 0.21, 0.01] }], words: W };
vi.mock("@/lib/textract", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  analyzePageImageWithFallback: vi.fn(async () => TD),
}));
vi.mock("@/lib/keynotes", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  extractKeynotes: vi.fn(async () => ({ keynotes: [], warnings: [] })),
}));
const dn = vi.hoisted(() => ({ v: "C-101" as string | null }));
vi.mock("@/lib/title-block", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  extractDrawingNumber: () => dn.v,
}));

import { POST as recompute } from "@/app/api/pages/csi-recompute/route";
import { POST as reprocess } from "@/app/api/admin/reprocess/route";
import { processProject } from "@/lib/processing";
import { assertProjectWritable } from "@/server/api/project-write-capability";
import { db } from "@/lib/db";
import { pages } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { asUser, createPage, createUser, createWorld, makeReq } from "@/test/harness";
import { existsSync as __hasKbExists } from "node:fs";
import { join as __hasKbJoin } from "node:path";
// KB-backed tests skip without src/data/csi-kb.json (gitignored, owner ruling D1; see src/test/global-setup.ts).
const HAS_KB = __hasKbExists(__hasKbJoin(process.cwd(), "src/data/csi-kb.json"));

const dbUp = inject("dbUp") as boolean;
const RAW = "DUCTILE IRON UTILITY PIPING";
const codes = (v: unknown) => ((v as { code: string; triggers?: unknown[] }[]) || []).map((c) => `${c.code}#${c.triggers ? c.triggers.length : "none"}`);
beforeEach(() => { calls.args.length = 0; dn.v = "C-101"; });

describe.skipIf(!dbUp)("[csi-v2 S6] page context reaches detectCsiCodes at the 3 page-level call sites", () => {
  it.skipIf(!HAS_KB)("pages.ts recomputePageCsi", async () => {
    for (const [drawing, want] of [["C-101", ["33 05 19#1"]], ["A-101", []], [null, []]] as const) {
      calls.args.length = 0;
      const { user, project } = await createWorld();
      const page = await createPage(project.id, 1, { textractData: TD as never, rawText: RAW, drawingNumber: drawing });
      asUser(user);
      const res = await recompute(makeReq("/api/pages/csi-recompute", { method: "POST", body: { projectId: project.id, pageNumber: 1 } }));
      expect(res.status).toBe(200);
      expect(calls.args.length).toBe(1);
      expect(calls.args[0][1]).toEqual({ lines: TD.lines, context: { drawingNumber: drawing } });
      const [r] = await db.select({ csi: pages.csiCodes }).from(pages).where(eq(pages.id, page.id));
      expect(codes(r.csi)).toEqual(want);
    }
  }, 60000);

  it.skipIf(!HAS_KB)("reprocess.ts (admin reprocess, full scope)", async () => {
    const { company, project } = await createWorld();
    const admin = await createUser(company.id, { role: "admin" });
    const page = await createPage(project.id, 1, { textractData: TD as never, rawText: RAW, drawingNumber: "C-101", csiCodes: [] as never });
    asUser(admin);
    const res = await reprocess(makeReq("/api/admin/reprocess", { method: "POST" }));
    expect(res.status).toBe(200);
    await res.text();
    const mine = calls.args.filter((a) => a[0] === RAW);
    expect(mine.length).toBeGreaterThanOrEqual(1);
    expect(mine[0][1]).toEqual({ lines: TD.lines, context: { drawingNumber: "C-101" } });
    const [r] = await db.select({ csi: pages.csiCodes }).from(pages).where(eq(pages.id, page.id));
    expect(codes(r.csi)).toEqual(["33 05 19#1"]);
  }, 60000);

  it.skipIf(!HAS_KB)("processing.ts processProject (fake Textract payload)", async () => {
    for (const [drawing, want] of [["C-101", ["33 05 19#1"]], ["A-101", []]] as const) {
      calls.args.length = 0; dn.v = drawing;
      const { project } = await createWorld();
      await processProject(project.id, assertProjectWritable(project));
      expect(calls.args.length).toBe(1);
      expect(calls.args[0][0]).toBe(RAW);
      expect(calls.args[0][1]).toEqual({ lines: TD.lines, context: { drawingNumber: drawing } });
      const [r] = await db.select({ csi: pages.csiCodes, dn: pages.drawingNumber }).from(pages).where(eq(pages.projectId, project.id));
      expect(r.dn).toBe(drawing);
      expect(codes(r.csi)).toEqual(want);
    }
  }, 60000);
});
