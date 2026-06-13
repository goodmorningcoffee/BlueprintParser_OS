// @vitest-environment node
// [refactor jun12 P0.3] CHARACTERIZATION for POST /api/processing/webhook —
// the ingest completion callback (worker → NAT → ALB → here).
//
// [refactor jun13 P0.5-G1] FIXED + asserts flipped (were frozen-as-bug in
// S002): the route is now JOB-CLOSE ONLY — status + processingTime +
// processingError only when explicitly sent. It must never write numPages
// (processing.ts wrote the real PDF page count during ingest) and never
// null-clobber processingError (processing.ts wrote real partial-failure
// info; the old `payload.error || null` erased it on every success ping).
import { describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { POST } from "@/app/api/processing/webhook/route";
import { db } from "@/lib/db";
import { pages, projects } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { createWorld, makeReq } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;
const SECRET = process.env.PROCESSING_WEBHOOK_SECRET!;

function webhookReq(payload: unknown, over: { auth?: string | null; ts?: string | null } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const auth = over.auth === undefined ? `Bearer ${SECRET}` : over.auth;
  const ts = over.ts === undefined ? String(Date.now()) : over.ts;
  if (auth !== null) headers.authorization = auth;
  if (ts !== null) headers["x-webhook-timestamp"] = ts;
  return new Request("http://test.local/api/processing/webhook", {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
}

describe.skipIf(!dbUp)("POST /api/processing/webhook — auth", () => {
  it("401 without bearer, with wrong secret, without timestamp, with stale timestamp", async () => {
    const payload = { projectId: 1, pages: [], status: "completed" };
    expect((await POST(webhookReq(payload, { auth: null }))).status).toBe(401);
    expect((await POST(webhookReq(payload, { auth: "Bearer wrong-secret-xx" }))).status).toBe(401);
    expect((await POST(webhookReq(payload, { ts: null }))).status).toBe(401);
    expect((await POST(webhookReq(payload, { ts: String(Date.now() - 6 * 60 * 1000) }))).status).toBe(401);
  });

  it("404 for unknown projectId (auth ok)", async () => {
    const res = await POST(webhookReq({ projectId: 999999999, pages: [], status: "completed" }));
    expect(res.status).toBe(404);
  });
});

describe.skipIf(!dbUp)("POST /api/processing/webhook — behavior", () => {
  it("upserts pages from textract blocks (insert path) and updates search vector", async () => {
    const { project } = await createWorld({ status: "processing", numPages: 0 });
    const res = await POST(
      webhookReq({
        projectId: project.id,
        status: "completed",
        processingTime: 12,
        pages: [{ pageNumber: 5, textractBlocks: [], drawingNumber: "A-501" }],
      }),
    );
    expect(res.status).toBe(200);
    const [page] = await db
      .select()
      .from(pages)
      .where(and(eq(pages.projectId, project.id), eq(pages.pageNumber, 5)));
    expect(page).toBeTruthy();
    expect(page.name).toBe("A-501");
    expect(page.drawingNumber).toBe("A-501");
  });

  it("[G1 FIXED] worker job-close ping preserves numPages and processingError", async () => {
    const { project } = await createWorld({
      status: "processing",
      numPages: 47, // what processing.ts correctly wrote during ingest
      processingError: "3 pages failed OCR", // real partial-failure info
    });
    // what scripts/process-worker.ts sends post-G1: empty pages + real counts
    const res = await POST(
      webhookReq({
        projectId: project.id,
        pages: [],
        pagesProcessed: 44,
        pageErrors: 3,
        status: "completed",
        processingTime: 99,
      }),
    );
    expect(res.status).toBe(200);
    const [row] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(row.status).toBe("completed");
    expect(row.processingTime).toBe(99);
    // ── the G1 contract: ingest-written truth survives the close ping ──
    expect(row.numPages).toBe(47);
    expect(row.processingError).toBe("3 pages failed OCR");
  });

  it("[G1] explicit error payload still records processingError and error status", async () => {
    const { project } = await createWorld({ status: "processing", numPages: 12 });
    const res = await POST(
      webhookReq({
        projectId: project.id,
        pages: [],
        status: "error",
        error: "step function task crashed",
      }),
    );
    expect(res.status).toBe(200);
    const [row] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(row.status).toBe("error");
    expect(row.processingError).toBe("step function task crashed");
    expect(row.numPages).toBe(12); // never touched, even on the error path
  });
});
