// @vitest-environment node
// Admin data tools §1.2c — webhook hardening: off-enum status is rejected before it reaches the
// enums, and a (late/retried) webhook never relabels an already-closed older ingest run.
import { describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { POST } from "@/app/api/processing/webhook/route";
import { db } from "@/lib/db";
import { processingJobs, projects } from "@/lib/db/schema";
import { asc, eq } from "drizzle-orm";
import { createWorld } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;
const SECRET = process.env.PROCESSING_WEBHOOK_SECRET!;

function hook(payload: unknown) {
  return POST(
    new Request("http://test.local/api/processing/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SECRET}`,
        "x-webhook-timestamp": String(Date.now()),
      },
      body: JSON.stringify(payload),
    }),
  );
}

describe.skipIf(!dbUp)("POST /api/processing/webhook — hardening", () => {
  it("off-enum status → 400 and nothing is written", async () => {
    const { project } = await createWorld({ status: "processing" });
    for (const status of ["processing", "uploading", "", undefined, 7]) {
      const res = await hook({ projectId: project.id, pages: [], status });
      expect(res.status).toBe(400);
    }
    const [row] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(row.status).toBe("processing");
  });

  it("closes only the running ingest row; an older closed run keeps its label", async () => {
    const { project } = await createWorld({ status: "processing" });
    await db.insert(processingJobs).values([
      { projectId: project.id, executionId: "old-run", status: "failed", error: "old failure" },
      { projectId: project.id, executionId: "new-run", status: "running" },
    ]);
    const res = await hook({ projectId: project.id, pages: [], status: "completed" });
    expect(res.status).toBe(200);
    const rows = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.projectId, project.id))
      .orderBy(asc(processingJobs.id));
    expect(rows.map((r) => [r.executionId, r.status, r.error])).toEqual([
      ["old-run", "failed", "old failure"],
      ["new-run", "completed", null],
    ]);
  });
});
