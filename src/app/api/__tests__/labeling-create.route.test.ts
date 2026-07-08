// @vitest-environment node
// [P1-review COV-1/H-1] CHARACTERIZATION for POST /api/labeling/create — the ONLY folded route
// that shipped with ZERO coverage (services/labeling.ts header: "create is NOT integration-tested
// ... flag for the P1 phase review"). Written AFTER the P1.5 fold, so it pins the FOLDED
// behavior as it stands today (shell defineRoute auth:"session" + body:zLooseBody →
// createLabelingSessions). Frozen here:
//   • AUTH-FIRST (shell auth:"session"): 401 before any field check; malformed JSON is the ONE
//     exception — shell step 1 (sanctioned diff E) fires BEFORE auth.
//   • Empty body / non-object valid-JSON body → shell zod VALIDATION 400 (sanctioned E2: status
//     preserved vs legacy, MESSAGE drifted to zod's — pinned verbatim so future zod bumps or
//     schema swaps are loud).
//   • "projectId required" beats "Invalid project id" (diff C is gated AFTER the falsy check —
//     empty-string projectId gets the required message, not the uuid one).
//   • Ownership lookup WITH the isRootAdmin ternary bypass — the deliberate CONTRAST with
//     list/delete's strict company scoping (their R1 cases pin the opposite).
//   • FQ-8 demo gate: returns assertDemoFeatureEnabled's NextResponse VERBATIM through the
//     shell's Response passthrough — the LEGACY BARE {error: string} envelope (not
//     {error:{code,message}}), 403, `labeling` DEFAULT_ON=false so an unconfigured company
//     gates by default.
//   • FQ-5 TWO predicates, deliberately different: demo-gate bypass = isRootAdmin; rate-limit
//     bypass = role==="admin". A member-role root admin bypasses the gate but NOT the limit.
//   • FQ-6 rate limit = ROLLING 24h window, 10/company, 429, message says "/day".
//   • Missing LS env → 503 VALIDATION, message verbatim (checked AFTER the rate limit).
//   • FQ-7 page selection: "current" = [parseInt(pageRange)] with NO NaN guard (a non-numeric
//     pageRange really does produce a page_NaN.png task + a pageRange:"NaN" DB row — pinned
//     AS-IS, do not "fix" without a sanction); "range" without "-" → empty loop → 200
//     {success:true,sessions:[]} and ZERO writes; range end is clamped to numPages.
//   • [LB-1] UNPADDED `page_${n}.png` S3 keys (rest of repo pads to 4) — KNOWN BUG preserved.
//
// DELIBERATELY UNCOVERED: the tiling leg (sharp tile extraction + downloadFromS3/uploadToS3).
// @/lib/s3 is mocked with the importOriginal-spread pattern (getS3Url stays real — it is a pure
// string builder) and sharp is mocked to throw, so NO real image/S3 work can ever run here. The
// tiling leg remains review-verified only, per the task brief.
import { afterEach, describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

// Label Studio client mock — tests never talk to a live LS (same lsMocks shape as the sibling
// labeling-sessions-id test so the service module loads identically under both files).
const lsMocks = vi.hoisted(() => ({
  createProject: vi.fn(),
  importTasks: vi.fn(),
  deleteProject: vi.fn(),
  getProject: vi.fn(),
  healthCheck: vi.fn(),
}));
vi.mock("@/lib/label-studio", () => lsMocks);

// S3 mock (importOriginal spread): downloadFromS3/uploadToS3 are neutered so the tiling leg can
// never touch AWS; getS3Url is left REAL (pure CLOUDFRONT_DOMAIN string builder — its output IS
// part of the frozen contract via the importTasks payload).
const s3Mocks = vi.hoisted(() => ({
  downloadFromS3: vi.fn(() => {
    throw new Error("tiling leg must not run in route tests");
  }),
  uploadToS3: vi.fn(() => {
    throw new Error("tiling leg must not run in route tests");
  }),
}));
vi.mock("@/lib/s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/s3")>();
  return { ...actual, ...s3Mocks };
});

// sharp is dynamically imported ONLY inside the (uncovered) tiling branch — mock it defensively
// so an accidental `tiling:true` in a future test fails loudly instead of doing image work.
vi.mock("sharp", () => ({
  default: vi.fn(() => {
    throw new Error("sharp must not run in route tests");
  }),
}));

import { randomUUID } from "crypto";
import { POST } from "@/app/api/labeling/create/route";
import { db } from "@/lib/db";
import { companies, labelingSessions } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  asUser,
  createCompany,
  createProject as createProjectFixture,
  createUser,
  createWorld,
  makeReq,
  readJson,
  signedOut,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

const post = (body?: unknown) => POST(makeReq("/api/labeling/create", { body }));

// Verbatim copy of the service's DEFAULT_LABEL_CONFIG — every LS project is created with it.
const LS_CONFIG = `<View>
  <Image name="image" value="$image" zoomControl="true" rotateControl="true"/>
</View>`;

// [LB-1] UNPADDED page key via the REAL getS3Url (CLOUDFRONT_DOMAIN stubbed per-test).
const img = (dataUrl: string, n: number | string) =>
  `https://cdn.test.invalid/${dataUrl}/pages/page_${n}.png`;

/** Env for the post-rate-limit legs. Trailing slash on the URL pins the replace(/\/$/, ""). */
function stubLsEnv() {
  vi.stubEnv("LABEL_STUDIO_URL", "http://ls.test/");
  vi.stubEnv("LABEL_STUDIO_API_KEY", "test-key");
  vi.stubEnv("CLOUDFRONT_DOMAIN", "cdn.test.invalid"); // deterministic getS3Url regardless of container env
}

/** Force the LS env EMPTY (falsy) — the test process may inherit real values from the container. */
function stubNoLsEnv() {
  vi.stubEnv("LABEL_STUDIO_URL", "");
  vi.stubEnv("LABEL_STUDIO_API_KEY", "");
}

/** Seed n labeling sessions for the rate-limit window (createdAt defaults to NOW() → in-window). */
async function seedSessions(projectId: number, companyId: number, n: number) {
  await db.insert(labelingSessions).values(
    Array.from({ length: n }, (_, i) => ({
      projectId,
      companyId,
      labelStudioProjectId: 90000 + i,
      labelStudioUrl: "http://ls.test/projects/90000",
      taskType: "generic",
      pageRange: "1-3",
      status: "active",
    })),
  );
}

const rowsFor = (projectId: number) =>
  db.select().from(labelingSessions).where(eq(labelingSessions.projectId, projectId));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe.skipIf(!dbUp)("POST /api/labeling/create", () => {
  // ── shell + auth ───────────────────────────────────────────────────────────

  it("malformed-JSON body → 400 BAD_REQUEST 'Invalid JSON body', fired BEFORE the 401 (shell E)", async () => {
    signedOut(); // proves the 400 precedes auth (legacy: uncaught SyntaxError 500)
    const res = await POST(
      new Request("http://test.local/api/labeling/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
    );
    const { status, body } = await readJson(res);
    expect(status).toBe(400); // NOT 401
    expect(body.error).toEqual({ code: "BAD_REQUEST", message: "Invalid JSON body" });
  });

  it("signed-out with a valid body → 401 (AUTH-FIRST, shell auth:'session')", async () => {
    signedOut();
    const { status, body } = await readJson(await post({ projectId: randomUUID() }));
    expect(status).toBe(401);
    expect(body.error).toEqual({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  it("empty body → 400 VALIDATION (shell E2: legacy was an authed SyntaxError 500; zod message pinned verbatim)", async () => {
    asUser(await createUser((await createCompany()).id));
    const { status, body } = await readJson(await post()); // no body at all → raw undefined
    expect(status).toBe(400);
    expect(body.error).toEqual({
      code: "VALIDATION",
      message: "Invalid input: expected record, received undefined",
    });
  });

  it("non-object valid-JSON body → 400 VALIDATION (shell E2: legacy destructured to 'projectId required'; status kept, message drifted)", async () => {
    asUser(await createUser((await createCompany()).id));
    const { status, body } = await readJson(await post(42));
    expect(status).toBe(400);
    expect(body.error).toEqual({
      code: "VALIDATION",
      message: "Invalid input: expected record, received number",
    });
  });

  // ── service field validation ───────────────────────────────────────────────

  it("missing projectId → 400 'projectId required'; empty-string projectId gets the SAME message (falsy check wins over the uuid check)", async () => {
    asUser(await createUser((await createCompany()).id));
    let r = await readJson(await post({}));
    expect(r.status).toBe(400);
    expect(r.body.error).toEqual({ code: "VALIDATION", message: "projectId required" });

    r = await readJson(await post({ projectId: "" })); // falsy → required-400, NOT "Invalid project id"
    expect(r.status).toBe(400);
    expect(r.body.error).toEqual({ code: "VALIDATION", message: "projectId required" });
  });

  it("non-uuid projectId → 400 'Invalid project id' (diff C: legacy fed it to the pg uuid column → 500)", async () => {
    asUser(await createUser((await createCompany()).id));
    const { status, body } = await readJson(await post({ projectId: "not-a-uuid" }));
    expect(status).toBe(400);
    expect(body.error).toEqual({ code: "VALIDATION", message: "Invalid project id" });
  });

  // ── ownership lookup ───────────────────────────────────────────────────────

  it("unknown projectId → 404 'Project not found' (distinct from list/delete's bare 'Not found')", async () => {
    const { user } = await createWorld();
    asUser(user);
    const { status, body } = await readJson(await post({ projectId: randomUUID() }));
    expect(status).toBe(404);
    expect(body.error).toEqual({ code: "NOT_FOUND", message: "Project not found" });
  });

  it("plain member cross-company → 404 'Project not found' (and(publicId, companyId) scope)", async () => {
    const { project } = await createWorld(); // victim company's project
    asUser(await createUser((await createCompany()).id)); // caller from another company
    const { status, body } = await readJson(await post({ projectId: project.publicId }));
    expect(status).toBe(404);
    expect(body.error).toEqual({ code: "NOT_FOUND", message: "Project not found" });
    expect(await rowsFor(project.id)).toHaveLength(0);
  });

  it("ROOT ADMIN cross-company → SUCCEEDS (isRootAdmin ternary bypass — the deliberate CONTRAST with list/delete R1); the row books to the PROJECT's company", async () => {
    const { company, project } = await createWorld(); // victim company's project
    const root = await createUser((await createCompany()).id, { isRootAdmin: true }); // role stays default (member)
    asUser(root);
    stubLsEnv();
    lsMocks.createProject.mockResolvedValueOnce({ id: 91001 });
    lsMocks.importTasks.mockResolvedValueOnce(undefined);

    const { status, body } = await readJson(await post({ projectId: project.publicId }));
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    const rows = await rowsFor(project.id);
    expect(rows).toHaveLength(1);
    // [P1-review] observed as-is: the INSERT books company_id to the PROJECT's company, while the
    // rate-limit COUNT above scoped to the CALLER's companyId (session.user.companyId). So a
    // member-role root admin creating cross-company consumes the TARGET company's rolling-24h
    // quota but is only ever gated by their OWN company's count. Pinned, not fixed.
    expect(rows[0].companyId).toBe(company.id);
  });

  // ── demo gate (FQ-8 passthrough + FQ-5 predicate) ──────────────────────────

  it("demo project + plain member → 403 with the LEGACY BARE envelope {error: string} (FQ-8 verbatim passthrough; labeling DEFAULT_ON=false)", async () => {
    const { company, user } = await createWorld();
    const demo = await createProjectFixture(company.id, user.id, { isDemo: true });
    asUser(user);
    const { status, body } = await readJson(await post({ projectId: demo.publicId }));
    expect(status).toBe(403);
    // NOT {error:{code,message}} — demo-features.ts still owns the legacy {error:string} shape.
    expect(body).toEqual({
      error: "Labeling Wizard is disabled for demo users. Sign in to use this feature.",
    });
    expect(await rowsFor(demo.id)).toHaveLength(0);
  });

  it("demo project + role-'admin' NON-root → STILL the 403 demo gate (FQ-5: the gate's bypass predicate is isRootAdmin, NOT role)", async () => {
    const { company, user } = await createWorld();
    const demo = await createProjectFixture(company.id, user.id, { isDemo: true });
    asUser(await createUser(company.id, { role: "admin" })); // company admin, not root
    const { status, body } = await readJson(await post({ projectId: demo.publicId }));
    expect(status).toBe(403);
    expect(body).toEqual({
      error: "Labeling Wizard is disabled for demo users. Sign in to use this feature.",
    });
  });

  it("demo gate OPENS when pipelineConfig.demo.labeling=true → falls through to the env 503 (runtime kill-switch honored)", async () => {
    const { company, user } = await createWorld();
    await db
      .update(companies)
      .set({ pipelineConfig: { demo: { labeling: true } } as never })
      .where(eq(companies.id, company.id));
    const demo = await createProjectFixture(company.id, user.id, { isDemo: true });
    asUser(user);
    stubNoLsEnv();
    const { status, body } = await readJson(await post({ projectId: demo.publicId }));
    expect(status).toBe(503); // past the gate (else 403) and past the empty rate-limit → env check
    expect(body.error).toEqual({
      code: "VALIDATION",
      message: "Label Studio not configured. Set LABEL_STUDIO_URL and LABEL_STUDIO_API_KEY.",
    });
  });

  // ── rate limit (FQ-5 predicate split + FQ-6 window) ────────────────────────

  it("member with 10 sessions in the rolling 24h window → 429 'Daily labeling limit reached (10 projects/day)' (fires BEFORE the env check)", async () => {
    const { company, user, project } = await createWorld();
    await seedSessions(project.id, company.id, 10);
    asUser(user);
    stubNoLsEnv(); // env empty: a 429 (not 503) proves the rate limit precedes the env check
    const { status, body } = await readJson(await post({ projectId: project.publicId }));
    expect(status).toBe(429);
    expect(body.error).toEqual({
      code: "RATE_LIMITED",
      message: "Daily labeling limit reached (10 projects/day)",
    });
    expect(await rowsFor(project.id)).toHaveLength(10); // no 11th row
  });

  it("FQ-5 BOTH predicates: member-role ROOT admin on an own-company demo project + 10 seeded → 429 (demo gate bypassed via isRootAdmin; rate limit NOT bypassed — role !== 'admin')", async () => {
    const company = await createCompany();
    const rootMember = await createUser(company.id, { role: "member", isRootAdmin: true });
    const demo = await createProjectFixture(company.id, rootMember.id, { isDemo: true });
    await seedSessions(demo.id, company.id, 10);
    asUser(rootMember);
    stubNoLsEnv();
    const { status, body } = await readJson(await post({ projectId: demo.publicId }));
    // 403 here would mean the demo gate fired (it must not — isRootAdmin bypasses it);
    // 503 would mean the rate limit was bypassed (it must not — role is "member").
    expect(status).toBe(429);
    expect(body.error).toEqual({
      code: "RATE_LIMITED",
      message: "Daily labeling limit reached (10 projects/day)",
    });
  });

  it("role 'admin' bypasses the rate limit: 10 seeded → still 200 success (FQ-5 other arm)", async () => {
    const { company, project } = await createWorld();
    const admin = await createUser(company.id, { role: "admin" });
    await seedSessions(project.id, company.id, 10);
    asUser(admin);
    stubLsEnv();
    lsMocks.createProject.mockResolvedValueOnce({ id: 91002 });
    lsMocks.importTasks.mockResolvedValueOnce(undefined);
    const { status, body } = await readJson(await post({ projectId: project.publicId }));
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(await rowsFor(project.id)).toHaveLength(11); // the 11th row was created
  });

  // ── LS env check ───────────────────────────────────────────────────────────

  it("LABEL_STUDIO env unset → 503 VALIDATION, message verbatim", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    stubNoLsEnv();
    const { status, body } = await readJson(await post({ projectId: project.publicId }));
    expect(status).toBe(503);
    expect(body.error).toEqual({
      code: "VALIDATION",
      message: "Label Studio not configured. Set LABEL_STUDIO_URL and LABEL_STUDIO_API_KEY.",
    });
  });

  // ── success paths + page selection (FQ-7, LB-1) ────────────────────────────

  it("happy: default selection = ALL pages, one chunk → 200 {success:true,sessions:[…]}; UNPADDED page_N.png URLs (LB-1), default label config, DB row frozen", async () => {
    const { company, user, project } = await createWorld(); // numPages 3
    asUser(user);
    stubLsEnv();
    lsMocks.createProject.mockResolvedValueOnce({ id: 91003 });
    lsMocks.importTasks.mockResolvedValueOnce(undefined);

    const { status, body } = await readJson(await post({ projectId: project.publicId }));
    expect(status).toBe(200);

    // Single chunk → title is the BARE project name; config is the default image-only view.
    expect(lsMocks.createProject).toHaveBeenCalledExactlyOnceWith(project.name, LS_CONFIG);
    // [LB-1] UNPADDED page_1.png (NOT page_0001.png) — known bug, deliberately preserved.
    expect(lsMocks.importTasks).toHaveBeenCalledExactlyOnceWith(91003, [
      { data: { image: img(project.dataUrl, 1) }, meta: { pageNumber: 1 } },
      { data: { image: img(project.dataUrl, 2) }, meta: { pageNumber: 2 } },
      { data: { image: img(project.dataUrl, 3) }, meta: { pageNumber: 3 } },
    ]);

    const rows = await rowsFor(project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      companyId: company.id,
      labelStudioProjectId: 91003,
      labelStudioUrl: "http://ls.test/projects/91003", // trailing slash on env URL stripped
      taskType: "generic",
      labels: null,
      pageRange: "1-3",
      tilingEnabled: false,
      tileGrid: null,
      status: "active",
    });
    expect(body).toEqual({
      success: true,
      sessions: [
        {
          id: rows[0].id,
          labelStudioProjectId: 91003,
          labelStudioUrl: "http://ls.test/projects/91003",
          pageRange: "1-3",
          taskCount: 3,
        },
      ],
    });
    // The uncovered tiling leg really did not run.
    expect(s3Mocks.downloadFromS3).not.toHaveBeenCalled();
    expect(s3Mocks.uploadToS3).not.toHaveBeenCalled();
  });

  it("pagesPerProject clamps to min 2 (input 1) → TWO chunks with '(pages X-Y)' titles, two sessions + two rows", async () => {
    const { user, project } = await createWorld(); // numPages 3 → chunks [1,2] + [3]
    asUser(user);
    stubLsEnv();
    lsMocks.createProject
      .mockResolvedValueOnce({ id: 91004 })
      .mockResolvedValueOnce({ id: 91005 });
    lsMocks.importTasks.mockResolvedValue(undefined);

    const { status, body } = await readJson(
      await post({ projectId: project.publicId, pagesPerProject: 1 }),
    );
    expect(status).toBe(200);
    expect(lsMocks.createProject).toHaveBeenNthCalledWith(1, `${project.name} (pages 1-2)`, LS_CONFIG);
    expect(lsMocks.createProject).toHaveBeenNthCalledWith(2, `${project.name} (pages 3)`, LS_CONFIG);
    expect(body.sessions).toEqual([
      expect.objectContaining({ labelStudioProjectId: 91004, pageRange: "1-2", taskCount: 2 }),
      expect.objectContaining({ labelStudioProjectId: 91005, pageRange: "3", taskCount: 1 }),
    ]);
    expect(await rowsFor(project.id)).toHaveLength(2);
  });

  it("pageSelection 'current' → the single page [parseInt(pageRange)]", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    stubLsEnv();
    lsMocks.createProject.mockResolvedValueOnce({ id: 91006 });
    lsMocks.importTasks.mockResolvedValueOnce(undefined);

    const { status, body } = await readJson(
      await post({ projectId: project.publicId, pageSelection: "current", pageRange: "2" }),
    );
    expect(status).toBe(200);
    expect(lsMocks.importTasks).toHaveBeenCalledExactlyOnceWith(91006, [
      { data: { image: img(project.dataUrl, 2) }, meta: { pageNumber: 2 } },
    ]);
    expect(body.sessions).toEqual([
      expect.objectContaining({ pageRange: "2", taskCount: 1 }),
    ]);
  });

  it("FQ-7: 'current' with a NON-NUMERIC pageRange → a page_NaN.png task and a pageRange:'NaN' row — NO NaN guard, pinned AS-IS", async () => {
    // [P1-review] observed as-is: parseInt("abc") = NaN flows straight through — the LS project
    // is created with a task pointing at .../pages/page_NaN.png and the DB row stores
    // pageRange "NaN". Documented in the service header (FQ-7); do NOT add a guard here
    // without a sanctioned-diff entry.
    const { user, project } = await createWorld();
    asUser(user);
    stubLsEnv();
    lsMocks.createProject.mockResolvedValueOnce({ id: 91007 });
    lsMocks.importTasks.mockResolvedValueOnce(undefined);

    const { status, body } = await readJson(
      await post({ projectId: project.publicId, pageSelection: "current", pageRange: "abc" }),
    );
    expect(status).toBe(200);
    expect(lsMocks.importTasks).toHaveBeenCalledExactlyOnceWith(91007, [
      { data: { image: img(project.dataUrl, "NaN") }, meta: { pageNumber: NaN } },
    ]);
    expect(body.sessions).toEqual([
      expect.objectContaining({ pageRange: "NaN", taskCount: 1 }),
    ]);
    const rows = await rowsFor(project.id);
    expect(rows[0].pageRange).toBe("NaN");
  });

  it("FQ-7: 'range' WITHOUT a dash → 200 {success:true,sessions:[]} — empty loop, ZERO LS calls, ZERO rows", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    stubLsEnv(); // env check passes, THEN the NaN end kills the loop
    const { status, body } = await readJson(
      await post({ projectId: project.publicId, pageSelection: "range", pageRange: "2" }),
    );
    expect(status).toBe(200);
    expect(body).toEqual({ success: true, sessions: [] });
    expect(lsMocks.createProject).not.toHaveBeenCalled();
    expect(lsMocks.importTasks).not.toHaveBeenCalled();
    expect(await rowsFor(project.id)).toHaveLength(0);
  });

  it("'range' end is clamped to numPages: '2-99' on a 3-page project → pages 2-3", async () => {
    const { user, project } = await createWorld(); // numPages 3
    asUser(user);
    stubLsEnv();
    lsMocks.createProject.mockResolvedValueOnce({ id: 91008 });
    lsMocks.importTasks.mockResolvedValueOnce(undefined);

    const { status, body } = await readJson(
      await post({ projectId: project.publicId, pageSelection: "range", pageRange: "2-99" }),
    );
    expect(status).toBe(200);
    expect(lsMocks.importTasks).toHaveBeenCalledExactlyOnceWith(91008, [
      { data: { image: img(project.dataUrl, 2) }, meta: { pageNumber: 2 } },
      { data: { image: img(project.dataUrl, 3) }, meta: { pageNumber: 3 } },
    ]);
    expect(body.sessions).toEqual([
      expect.objectContaining({ pageRange: "2-3", taskCount: 2 }),
    ]);
  });
});
