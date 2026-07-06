// @vitest-environment node
// [refactor jul6 S035] CHARACTERIZATION for the processing family (webhook POST + dev POST),
// written as THE FREEZE before the P1.5 fold onto services/processing-routes.ts. The webhook
// becomes the shell's FIRST auth:"webhookSecret" consumer — checkWebhookSecret
// (defineRoute.ts:111-129) was AUTHORED as a replica of this route's inline check (its JSDoc
// says so); this freeze verifies the parity BEHAVIORALLY branch-by-branch. Engines mocked
// (@/lib/textract parse fns; @/lib/processing processProject); REAL DB. Frozen:
//   • PQ5-1 webhook auth ladder (all flat 401s → envelope at fold, diff A): bad/missing
//     Bearer → "Unauthorized" (constant-time, length-gated) · missing x-webhook-timestamp →
//     "Missing timestamp" · older than 5min → "Webhook expired" · more than 60s in the
//     future → "Webhook expired". Secret from PROCESSING_WEBHOOK_SECRET (stubbed).
//   • PQ5-2 webhook body: dbId projectId → 404 "Project not found"; page UPSERT loop
//     (existing → update w/ drawingNumber||existing fallback; new → insert w/ name
//     "Page N" fallback); search_vector raw-SQL per page; ★ the P0.5-G1 JOB-CLOSE pin:
//     processingError is written ONLY when payload.error !== undefined (a success ping
//     must NOT clobber a seeded processingError — pinned with a survivor); processingJobs
//     → completed/failed. Catch-all LEAKS err.message ?? "Webhook failed" (→ B).
//     req.json() is post-auth unguarded → malformed-with-VALID-auth = raw rejection (→ E;
//     the shell's body-first ordering also makes malformed-with-BAD-auth 400 — the S033
//     systemic trait, expected).
//   • PQ5-3 dev: ★ ENV-GUARD-BEFORE-AUTH (prod && !DEV_PROCESSING_ENABLED → 403 "Dev
//     processing not enabled" EVEN SIGNED-OUT — forces auth:"none"+service-resolved at
//     fold) → requireAuth 401 → projectId 400 → company-scoped publicId 404 "Not found"
//     → processProject → {success:true, ...result} SPREAD → catch leaks (→ B).
// Assertions tagged [S035 fold] flip in the fold commit (sanctioned A/B/E only).
import { describe, expect, inject, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

const h = vi.hoisted(() => ({
  parseTextractResponse: vi.fn(),
  extractRawText: vi.fn(),
  processProject: vi.fn(),
}));
vi.mock("@/lib/textract", () => ({
  parseTextractResponse: h.parseTextractResponse,
  extractRawText: h.extractRawText,
  analyzePageImage: vi.fn(),
  analyzePageImageWithFallback: vi.fn(),
}));
vi.mock("@/lib/processing", () => ({ processProject: h.processProject }));

import { POST as webhookPOST } from "@/app/api/processing/webhook/route";
import { POST as devPOST } from "@/app/api/processing/dev/route";
import { asUser, createCompany, createPage, createProject, createUser, createWorld, makeReq, readJson, signedOut } from "@/test/harness";
import { db } from "@/lib/db";
import { pages as pagesTable, projects as projectsTable, processingJobs } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";

const dbUp = inject("dbUp") as boolean;
const SECRET = "test-webhook-secret";

function hook(body: unknown, headers: Record<string, string> = {}) {
  return webhookPOST(makeReq("/api/processing/webhook", {
    body,
    headers: {
      authorization: `Bearer ${SECRET}`,
      "x-webhook-timestamp": String(Date.now()),
      ...headers,
    },
  }));
}
const dev = (b: unknown) => devPOST(makeReq("/api/processing/dev", { body: b }));

beforeEach(() => {
  vi.clearAllMocks();
  signedOut();
  vi.stubEnv("PROCESSING_WEBHOOK_SECRET", SECRET);
  h.parseTextractResponse.mockReturnValue({ words: [{ text: "w" }], lines: [] });
  h.extractRawText.mockReturnValue("extracted raw text");
  h.processProject.mockResolvedValue({ pagesProcessed: 3 });
});
afterEach(() => vi.unstubAllEnvs());

describe.skipIf(!dbUp)("POST /api/processing/webhook — auth ladder (PQ5-1)", () => {
  it("bad/missing Bearer, missing/stale/future timestamp — each branch's status+message", async () => {
    let r = await readJson(await hook({ projectId: 1, pages: [], status: "completed" }, { authorization: "Bearer wrong" }));
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }); // [S035 fold: A applied]
    r = await readJson(await webhookPOST(makeReq("/api/processing/webhook", { body: {}, headers: {} })));
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }); // no header [S035 fold: A applied]
    r = await readJson(await webhookPOST(makeReq("/api/processing/webhook", { body: {}, headers: { authorization: `Bearer ${SECRET}` } })));
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: { code: "UNAUTHORIZED", message: "Missing timestamp" } }); // [S035 fold: A applied]
    r = await readJson(await hook({}, { "x-webhook-timestamp": String(Date.now() - 6 * 60 * 1000) }));
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: { code: "UNAUTHORIZED", message: "Webhook expired" } }); // stale [S035 fold: A applied]
    r = await readJson(await hook({}, { "x-webhook-timestamp": String(Date.now() + 2 * 60 * 1000) }));
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: { code: "UNAUTHORIZED", message: "Webhook expired" } }); // future [S035 fold: A applied]
  });
});

describe.skipIf(!dbUp)("POST /api/processing/webhook — body semantics (PQ5-2)", () => {
  it("unknown dbId → 404; malformed-with-valid-auth → raw rejection", async () => {
    const r = await readJson(await hook({ projectId: 999999999, pages: [], status: "completed" }));
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: { code: "NOT_FOUND", message: "Project not found" } }); // [S035 fold: A applied]
    // [S035 fold: E — becomes 400 BAD_REQUEST; note the shell also 400s BAD-auth+malformed (S033 trait)]
    const raw = new Request("http://test.local/api/processing/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}`, "x-webhook-timestamp": String(Date.now()) },
      body: "{oops",
    });
    const rr = await readJson(await webhookPOST(raw));
    expect(rr.status).toBe(400);
    expect(rr.body).toEqual({ error: { code: "BAD_REQUEST", message: "Invalid JSON body" } }); // [S035 fold: E applied]
  });

  it("★ G1 pin: upsert both paths, search_vector, processingError NOT clobbered on success, job closed", async () => {
    const { project } = await createWorld({ processingError: "partial: 2 pages failed" } as never);
    await createPage(project.id, 1, { drawingNumber: "A-101" });
    await db.insert(processingJobs).values({ projectId: project.id, executionId: "job-x", status: "running" } as never);
    const { status, body } = await readJson(await hook({
      projectId: project.id,
      status: "completed",
      processingTime: 42,
      pages: [
        { pageNumber: 1, textractBlocks: [] }, // existing → UPDATE; no drawingNumber → keeps A-101
        { pageNumber: 2, textractBlocks: [], drawingNumber: "A-102" }, // new → INSERT
      ],
    }));
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    const rows = await db.select().from(pagesTable).where(eq(pagesTable.projectId, project.id)).orderBy(pagesTable.pageNumber);
    expect(rows).toHaveLength(2);
    expect(rows[0].drawingNumber).toBe("A-101"); // || existing fallback
    expect(rows[0].rawText).toBe("extracted raw text");
    expect(rows[1].name).toBe("A-102"); // insert name = drawingNumber || "Page N"
    const [sv] = await db.execute(
      // search_vector must be populated for both pages
      (await import("drizzle-orm")).sql`SELECT COUNT(*)::int AS c FROM pages WHERE project_id = ${project.id} AND search_vector IS NOT NULL`
    ).then((r: any) => r.rows);
    expect(sv.c).toBe(2);
    const [proj] = await db.select().from(projectsTable).where(eq(projectsTable.id, project.id));
    expect(proj.status).toBe("completed");
    expect(proj.processingTime).toBe(42);
    expect(proj.processingError).toBe("partial: 2 pages failed"); // ★ G1: NOT clobbered (payload.error undefined)
    const [job] = await db.select().from(processingJobs).where(eq(processingJobs.projectId, project.id));
    expect(job.status).toBe("completed");
  });

  it("error payload writes processingError + fails the job; engine throw → LEAKY 500", async () => {
    const { project } = await createWorld();
    await db.insert(processingJobs).values({ projectId: project.id, executionId: "job-y", status: "running" } as never);
    let r = await readJson(await hook({ projectId: project.id, status: "error", error: "worker exploded", pages: [] }));
    expect(r.status).toBe(200);
    const [proj] = await db.select().from(projectsTable).where(eq(projectsTable.id, project.id));
    expect(proj.processingError).toBe("worker exploded");
    const [job] = await db.select().from(processingJobs).where(eq(processingJobs.projectId, project.id));
    expect(job.status).toBe("failed");
    expect(job.error).toBe("worker exploded");
    // engine throw inside the loop → catch-all leak [S035 fold: B — generic INTERNAL 500]
    h.parseTextractResponse.mockImplementation(() => { throw new Error("textract parse died"); });
    r = await readJson(await hook({ projectId: project.id, status: "completed", pages: [{ pageNumber: 3, textractBlocks: [] }] }));
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: { code: "INTERNAL", message: "Internal server error" } }); // [S035 fold: B applied]
  });
});

describe.skipIf(!dbUp)("POST /api/processing/dev (PQ5-3)", () => {
  it("★ ENV-GUARD-BEFORE-AUTH: prod+disabled → 403 even signed-out; then 401/400/404 ladder", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEV_PROCESSING_ENABLED", "false");
    let r = await readJson(await dev({ projectId: "x" }));
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: { code: "FORBIDDEN", message: "Dev processing not enabled" } }); // guard-before-auth held [S035 fold: A applied]
    vi.unstubAllEnvs();
    vi.stubEnv("PROCESSING_WEBHOOK_SECRET", SECRET);
    r = await readJson(await dev({ projectId: "x" }));
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }); // [S035 fold: A applied]
    const { user, project } = await createWorld();
    asUser(user);
    r = await readJson(await dev({}));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: { code: "VALIDATION", message: "projectId required" } }); // [S035 fold: A applied]
    const other = await createCompany();
    asUser(await createUser(other.id));
    r = await readJson(await dev({ projectId: project.publicId }));
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: { code: "NOT_FOUND", message: "Not found" } }); // [S035 fold: A applied]
  });

  it("happy spreads processProject's result; throw → LEAKY 500", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    let r = await readJson(await dev({ projectId: project.publicId }));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true, pagesProcessed: 3 }); // spread pinned
    expect(h.processProject).toHaveBeenCalledWith(project.id);
    h.processProject.mockRejectedValue(new Error("pipeline died"));
    r = await readJson(await dev({ projectId: project.publicId }));
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: { code: "INTERNAL", message: "Internal server error" } }); // [S035 fold: B applied]
  });
});
