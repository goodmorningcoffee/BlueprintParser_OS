// @vitest-environment node
// [refactor jun12 P0.3] CHARACTERIZATION for POST /api/processing/webhook —
// the ingest completion callback (worker → NAT → ALB → here).
//
// ⚠️ G1 IS DELIBERATELY FROZEN AS-IS HERE: the worker sends pages:[] and this
// route unconditionally writes numPages = payload.pages.length (0) and
// processingError = payload.error ?? null, clobbering what processing.ts
// already wrote. The "numPages becomes 0" assertion below DOCUMENTS THE BUG;
// P0.5-G1 (worker sends real counts / webhook stops writing those fields)
// flips that assertion in the same commit as the fix.
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

  it("[G1 FROZEN BUG] worker-style empty pages[] clobbers numPages to 0 and nulls processingError", async () => {
    const { project } = await createWorld({
      status: "processing",
      numPages: 47, // what processing.ts correctly wrote during ingest
      processingError: "3 pages failed OCR", // real partial-failure info
    });
    // exactly what scripts/process-worker.ts sends today: pages: []
    const res = await POST(
      webhookReq({ projectId: project.id, pages: [], status: "completed", processingTime: 99 }),
    );
    expect(res.status).toBe(200);
    const [row] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(row.status).toBe("completed");
    expect(row.processingTime).toBe(99);
    // ── the bug, asserted on purpose (see file header) ──
    expect(row.numPages).toBe(0); // ← P0.5-G1 flips this to 47
    expect(row.processingError).toBeNull(); // ← and this to "3 pages failed OCR"
  });
});
