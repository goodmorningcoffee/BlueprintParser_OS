// @vitest-environment node
// Characterization for POST /api/labeling/create. In addition to the route/auth contract, this
// freezes the P2 immutable Label Studio asset-grant protocol:
//   • AUTH-FIRST (shell auth:"session"): 401 before any field check; malformed JSON is the ONE
//     exception — shell step 1 (sanctioned diff E) fires BEFORE auth.
//   • Empty body / non-object valid-JSON body → shell zod VALIDATION 400 (sanctioned E2: status
//     preserved vs legacy, MESSAGE drifted to zod's — pinned verbatim so future zod bumps or
//     schema swaps are loud).
//   • "projectId required" beats "Invalid project id" (diff C is gated AFTER the falsy check —
//     empty-string projectId gets the required message, not the uuid one).
//   • Ownership lookup WITH the isRootAdmin ternary bypass — the deliberate CONTRAST with
//     list/delete's strict company scoping (their R1 cases pin the opposite).
//   • FQ-6 rate limit = ROLLING 24h window, 10/company, 429, message says "/day".
//   • Missing LS env → 503 VALIDATION, message verbatim (checked AFTER the rate limit).
//   • Page selections are strict finite project-page ranges and fail before any S3/provider I/O.
//   • Sources use padded `page_000N.png` keys and an exact VersionId. Non-tiling tasks copy that
//     version; tiling reads it once and writes nine never-reused versioned snapshots.
//   • Label Studio receives revocable same-origin bearer URLs. BP persists only SHA-256 token
//     hashes, immutable snapshot versions, and an active grant↔session owner.
//   • Provider ambiguity retains an intent; known-provider failure revokes grants before cleanup,
//     deleting them on success and retaining revoked witnesses when provider cleanup fails.
import { afterEach, describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

// Label Studio client mock — tests never talk to a live LS (same lsMocks shape as the sibling
// labeling-sessions-id test so the service module loads identically under both files).
const lsMocks = vi.hoisted(() => {
  const binding = {
    baseUrl: "http://ls.test",
    instanceId: "fixture-provider-state",
  } as const;
  return {
    binding,
    configuredLabelStudioProvider: vi.fn(() => binding),
    createProject: vi.fn(),
    importTasks: vi.fn(),
    deleteProject: vi.fn(),
    findProjectsByExactDescription: vi.fn(),
    getProject: vi.fn(),
    healthCheck: vi.fn(),
  };
});
vi.mock("@/lib/label-studio", () => lsMocks);

// S3 authority boundary. Version strings derive from the key so DB witnesses can be matched back
// to exact mock calls without depending on async completion order.
const s3Mocks = vi.hoisted(() => ({
  headS3Object: vi.fn(async (key: string) => ({
    exists: true,
    versionId: `source-version:${key}`,
  })),
  copyS3ObjectVersion: vi.fn(
    async (
      _sourceKey: string,
      _sourceVersion: string,
      destinationKey: string,
    ) => `snapshot-version:${destinationKey}`,
  ),
  downloadFromS3: vi.fn(async () => Buffer.from("versioned-page-image")),
  uploadS3VersionedSnapshot: vi.fn(
    async (key: string) => `snapshot-version:${key}`,
  ),
}));
vi.mock("@/lib/s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/s3")>();
  return { ...actual, ...s3Mocks };
});

const sharpMocks = vi.hoisted(() => {
  const metadata = vi.fn(async () => ({ width: 300, height: 300 }));
  const toBuffer = vi.fn(async () => Buffer.from("tile-image"));
  const png = vi.fn(() => ({ toBuffer }));
  const extract = vi.fn(
    (_region: {
      left: number;
      top: number;
      width: number;
      height: number;
    }) => ({ png }),
  );
  const sharp = vi.fn(() => ({ metadata, extract }));
  return { sharp, metadata, extract, png, toBuffer };
});
vi.mock("sharp", () => ({
  default: sharpMocks.sharp,
}));

import { createHash, randomUUID } from "crypto";
import { POST } from "@/app/api/labeling/create/route";
import { db } from "@/lib/db";
import {
  companies,
  labelingSessions,
  labelStudioAssetGrants,
  labelStudioProjectIntents,
  projectMutationLeases,
} from "@/lib/db/schema";
import { reconcileLabelStudioProjectIntent } from "@/lib/label-studio-project-intent";
import { logger } from "@/lib/logger";
import { eq, sql } from "drizzle-orm";
import {
  asUser,
  createCompany,
  createLabelingSessionFixture,
  createProject as createProjectFixture,
  createUser,
  createWorld,
  makeReq,
  publishDemoFixture,
  readJson,
  signedOut,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

const post = (body?: unknown) =>
  POST(makeReq("/api/labeling/create", { body }));

// Verbatim copy of the service's DEFAULT_LABEL_CONFIG — every LS project is created with it.
const LS_CONFIG = `<View>
  <Image name="image" value="$image" zoomControl="true" rotateControl="true"/>
</View>`;

const canonicalPageKey = (dataUrl: string, pageNumber: number) =>
  `${dataUrl}/pages/page_${String(pageNumber).padStart(4, "0")}.png`;

const snapshotKey = (dataUrl: string, grantId: string) =>
  `${dataUrl}/label-studio-assets/${grantId}.png`;

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

interface ImportedGrantTask {
  data: { image: string };
  meta: Record<string, number>;
}

function parseGrantTask(task: ImportedGrantTask): {
  id: string;
  token: string;
  meta: Record<string, number>;
} {
  const url = new URL(task.data.image);
  expect(url.origin).toBe("https://app.test");
  const match = /^\/api\/label-assets\/([0-9a-f-]{36})$/.exec(url.pathname);
  expect(match).not.toBeNull();
  const token = url.searchParams.get("token");
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect([...url.searchParams.keys()]).toEqual(["token"]);
  return { id: match![1], token: token!, meta: task.meta };
}

/** Env for the post-rate-limit legs. Trailing slash on the URL pins the replace(/\/$/, ""). */
function stubLsEnv() {
  vi.stubEnv("LABEL_STUDIO_URL", "http://ls.test/");
  vi.stubEnv("LABEL_STUDIO_API_KEY", "test-key");
  vi.stubEnv("LABEL_STUDIO_INSTANCE_ID", "fixture-provider-state");
  vi.stubEnv("NEXTAUTH_URL", "https://app.test/base/path");
}

/** Force the LS env EMPTY (falsy) — the test process may inherit real values from the container. */
function stubNoLsEnv() {
  vi.stubEnv("LABEL_STUDIO_URL", "");
  vi.stubEnv("LABEL_STUDIO_API_KEY", "");
  vi.stubEnv("LABEL_STUDIO_INSTANCE_ID", "");
}

/** Seed n labeling sessions for the rate-limit window (createdAt defaults to NOW() → in-window). */
async function seedSessions(
  project: Parameters<typeof createLabelingSessionFixture>[0],
  n: number,
) {
  for (let i = 0; i < n; i++) {
    await createLabelingSessionFixture(project, {
      labelStudioProjectId: 90000 + i,
      labelStudioUrl: "http://ls.test/projects/90000",
      taskType: "generic",
      pageRange: "1-3",
      status: "active",
    });
  }
}

const rowsFor = (projectId: number) =>
  db
    .select()
    .from(labelingSessions)
    .where(eq(labelingSessions.projectId, projectId));

const intentsFor = (projectId: number) =>
  db
    .select()
    .from(labelStudioProjectIntents)
    .where(eq(labelStudioProjectIntents.projectId, projectId));

const grantsFor = (projectId: number) =>
  db
    .select()
    .from(labelStudioAssetGrants)
    .where(eq(labelStudioAssetGrants.projectId, projectId));

const INTENT_MARKER = /^bp-labeling-intent:([0-9a-f-]{36})$/;

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
    expect(body.error).toEqual({
      code: "BAD_REQUEST",
      message: "Invalid JSON body",
    });
  });

  it("signed-out with a valid body → 401 (AUTH-FIRST, shell auth:'session')", async () => {
    signedOut();
    const { status, body } = await readJson(
      await post({ projectId: randomUUID() }),
    );
    expect(status).toBe(401);
    expect(body.error).toEqual({
      code: "UNAUTHORIZED",
      message: "Unauthorized",
    });
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
    expect(r.body.error).toEqual({
      code: "VALIDATION",
      message: "projectId required",
    });

    r = await readJson(await post({ projectId: "" })); // falsy → required-400, NOT "Invalid project id"
    expect(r.status).toBe(400);
    expect(r.body.error).toEqual({
      code: "VALIDATION",
      message: "projectId required",
    });
  });

  it("non-uuid projectId → 400 'Invalid project id' (diff C: legacy fed it to the pg uuid column → 500)", async () => {
    asUser(await createUser((await createCompany()).id));
    const { status, body } = await readJson(
      await post({ projectId: "not-a-uuid" }),
    );
    expect(status).toBe(400);
    expect(body.error).toEqual({
      code: "VALIDATION",
      message: "Invalid project id",
    });
  });

  // ── ownership lookup ───────────────────────────────────────────────────────

  it("unknown projectId → 404 'Project not found' (distinct from list/delete's bare 'Not found')", async () => {
    const { user } = await createWorld();
    asUser(user);
    const { status, body } = await readJson(
      await post({ projectId: randomUUID() }),
    );
    expect(status).toBe(404);
    expect(body.error).toEqual({
      code: "NOT_FOUND",
      message: "Project not found",
    });
  });

  it("plain member cross-company → 404 'Project not found' (and(publicId, companyId) scope)", async () => {
    const { project } = await createWorld(); // victim company's project
    asUser(await createUser((await createCompany()).id)); // caller from another company
    const { status, body } = await readJson(
      await post({ projectId: project.publicId }),
    );
    expect(status).toBe(404);
    expect(body.error).toEqual({
      code: "NOT_FOUND",
      message: "Project not found",
    });
    expect(await rowsFor(project.id)).toHaveLength(0);
  });

  it("ROOT ADMIN cross-company → SUCCEEDS (isRootAdmin ternary bypass — the deliberate CONTRAST with list/delete R1); the row books to the PROJECT's company", async () => {
    const { company, project } = await createWorld(); // victim company's project
    const root = await createUser((await createCompany()).id, {
      isRootAdmin: true,
    }); // role stays default (member)
    asUser(root);
    stubLsEnv();
    lsMocks.createProject.mockResolvedValueOnce({ id: 91001 });
    lsMocks.importTasks.mockResolvedValueOnce(undefined);

    const { status, body } = await readJson(
      await post({ projectId: project.publicId }),
    );
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

  // ── demo gate (canonical all-role read-only denial) ───────────────────────

  it("demo project + plain member → canonical project-derived read-only denial", async () => {
    const { company, user } = await createWorld();
    const demo = await createProjectFixture(company.id, user.id, {
      isDemo: true,
    });
    asUser(user);
    const { status, body } = await readJson(
      await post({ projectId: demo.publicId }),
    );
    expect(status).toBe(403);
    expect(body).toEqual({
      error: { code: "FORBIDDEN", message: "Demo projects are read-only" },
    });
    expect(await rowsFor(demo.id)).toHaveLength(0);
  });

  it("demo project + role-'admin' NON-root → canonical project-derived read-only denial", async () => {
    const { company, user } = await createWorld();
    const demo = await createProjectFixture(company.id, user.id, {
      isDemo: true,
    });
    asUser(await createUser(company.id, { role: "admin" })); // company admin, not root
    const { status, body } = await readJson(
      await post({ projectId: demo.publicId }),
    );
    expect(status).toBe(403);
    expect(body).toEqual({
      error: { code: "FORBIDDEN", message: "Demo projects are read-only" },
    });
  });

  it("L5 freeze: demo create denies signed-out, member, admin, and root even when the feature flag is enabled", async () => {
    const { company, user } = await createWorld();
    await db
      .update(companies)
      .set({ pipelineConfig: { demo: { labeling: true } } as never })
      .where(eq(companies.id, company.id));
    const demo = await createProjectFixture(company.id, user.id, {
      isDemo: true,
    });
    const admin = await createUser(company.id, { role: "admin" });
    const root = await createUser((await createCompany()).id, {
      role: "admin",
      isRootAdmin: true,
    });
    stubLsEnv();
    lsMocks.createProject.mockResolvedValue({ id: 91919 });
    lsMocks.importTasks.mockResolvedValue(undefined);
    const statuses: number[] = [];
    for (const actor of [null, user, admin, root]) {
      actor ? asUser(actor) : signedOut();
      statuses.push(
        (await readJson(await post({ projectId: demo.publicId }))).status,
      );
    }
    expect.soft(statuses).toEqual([403, 403, 403, 403]);
    expect.soft(lsMocks.createProject).not.toHaveBeenCalled();
    expect.soft(lsMocks.importTasks).not.toHaveBeenCalled();
    expect.soft(await rowsFor(demo.id)).toEqual([]);
  });

  // ── rate limit (FQ-5 predicate split + FQ-6 window) ────────────────────────

  it("member with 10 sessions in the rolling 24h window → 429 'Daily labeling limit reached (10 projects/day)' (fires BEFORE the env check)", async () => {
    const { user, project } = await createWorld();
    await seedSessions(project, 10);
    asUser(user);
    stubNoLsEnv(); // env empty: a 429 (not 503) proves the rate limit precedes the env check
    const { status, body } = await readJson(
      await post({ projectId: project.publicId }),
    );
    expect(status).toBe(429);
    expect(body.error).toEqual({
      code: "RATE_LIMITED",
      message: "Daily labeling limit reached (10 projects/day)",
    });
    expect(await rowsFor(project.id)).toHaveLength(10); // no 11th row
  });

  it("L5 freeze: root cannot bypass demo read-only even when a later rate limit would fire", async () => {
    const company = await createCompany();
    const rootMember = await createUser(company.id, {
      role: "member",
      isRootAdmin: true,
    });
    const quotaProject = await createProjectFixture(company.id, rootMember.id);
    const demo = await createProjectFixture(company.id, rootMember.id);
    await seedSessions(quotaProject, 10);
    await publishDemoFixture(demo.id);
    asUser(rootMember);
    stubNoLsEnv();
    const { status, body } = await readJson(
      await post({ projectId: demo.publicId }),
    );
    expect(status).toBe(403);
    expect(body.error).toEqual({
      code: "FORBIDDEN",
      message: "Demo projects are read-only",
    });
    expect(await rowsFor(quotaProject.id)).toHaveLength(10);
  });

  it("role 'admin' bypasses the rate limit: 10 seeded → still 200 success (FQ-5 other arm)", async () => {
    const { company, project } = await createWorld();
    const admin = await createUser(company.id, { role: "admin" });
    await seedSessions(project, 10);
    asUser(admin);
    stubLsEnv();
    lsMocks.createProject.mockResolvedValueOnce({ id: 91002 });
    lsMocks.importTasks.mockResolvedValueOnce(undefined);
    const { status, body } = await readJson(
      await post({ projectId: project.publicId }),
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(await rowsFor(project.id)).toHaveLength(11); // the 11th row was created
  });

  it("owner ruling 2026-10-21: a MEMBER-role root admin bypasses the daily labeling limit (10 seeded → reaches the env check)", async () => {
    const company = await createCompany();
    const rootMember = await createUser(company.id, { role: "member", isRootAdmin: true });
    const project = await createProjectFixture(company.id, rootMember.id);
    await seedSessions(project, 10);
    asUser(rootMember);
    stubNoLsEnv(); // a non-429 here proves the rate limit was skipped (the env check is next)
    const { status, body } = await readJson(
      await post({ projectId: project.publicId }),
    );
    expect(status).toBe(503); // the env check, which runs AFTER the (skipped) rate limit
    expect(body.error?.code).not.toBe("RATE_LIMITED");
    expect(await rowsFor(project.id)).toHaveLength(10);
  });

  // ── LS env check ───────────────────────────────────────────────────────────

  it("LABEL_STUDIO env unset → 503 VALIDATION, message verbatim", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    stubNoLsEnv();
    const { status, body } = await readJson(
      await post({ projectId: project.publicId }),
    );
    expect(status).toBe(503);
    expect(body.error).toEqual({
      code: "VALIDATION",
      message:
        "Label Studio not configured. Set LABEL_STUDIO_URL, LABEL_STUDIO_INSTANCE_ID, and LABEL_STUDIO_API_KEY.",
    });
  });

  // ── immutable snapshot grants + page selection ──────────────────────────────

  it("happy: padded exact-version sources become unique active snapshot grants; only token hashes reach BP storage", async () => {
    const { company, user, project } = await createWorld(); // numPages 3
    asUser(user);
    stubLsEnv();
    lsMocks.createProject.mockResolvedValueOnce({ id: 91003 });
    lsMocks.importTasks.mockResolvedValueOnce(undefined);

    const { status, body } = await readJson(
      await post({ projectId: project.publicId }),
    );
    expect(status).toBe(200);

    // Single chunk → title is the BARE project name; config is the default image-only view.
    expect(lsMocks.createProject).toHaveBeenCalledExactlyOnceWith(
      lsMocks.binding,
      project.name,
      LS_CONFIG,
      expect.stringMatching(INTENT_MARKER),
    );
    expect(lsMocks.importTasks).toHaveBeenCalledTimes(1);
    expect(lsMocks.importTasks.mock.calls[0]?.[1]).toBe(91003);
    const imported = lsMocks.importTasks.mock
      .calls[0]?.[2] as ImportedGrantTask[];
    expect(imported.map((task) => task.meta)).toEqual([
      { pageNumber: 1 },
      { pageNumber: 2 },
      { pageNumber: 3 },
    ]);
    const importedGrants = imported.map(parseGrantTask);
    expect(new Set(importedGrants.map(({ id }) => id)).size).toBe(3);
    expect(new Set(importedGrants.map(({ token }) => token)).size).toBe(3);

    const expectedSources = [1, 2, 3].map((pageNumber) =>
      canonicalPageKey(project.dataUrl, pageNumber),
    );
    expect(s3Mocks.headS3Object.mock.calls.map(([key]) => key).sort()).toEqual(
      [...expectedSources].sort(),
    );
    expect(
      s3Mocks.copyS3ObjectVersion.mock.calls
        .map(([sourceKey, sourceVersion, destinationKey]) => ({
          sourceKey,
          sourceVersion,
          destinationKey,
        }))
        .sort((left, right) => left.sourceKey.localeCompare(right.sourceKey)),
    ).toEqual(
      importedGrants
        .map(({ id, meta }) => {
          const sourceKey = canonicalPageKey(project.dataUrl, meta.pageNumber);
          return {
            sourceKey,
            sourceVersion: `source-version:${sourceKey}`,
            destinationKey: snapshotKey(project.dataUrl, id),
          };
        })
        .sort((left, right) => left.sourceKey.localeCompare(right.sourceKey)),
    );

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
    const grants = await grantsFor(project.id);
    expect(grants).toHaveLength(3);
    const grantsById = new Map(grants.map((grant) => [grant.id, grant]));
    for (const importedGrant of importedGrants) {
      const grant = grantsById.get(importedGrant.id);
      expect(grant).toMatchObject({
        projectId: project.id,
        companyId: company.id,
        lifecycleEpoch: project.lifecycleEpoch,
        provisioningIntentId: null,
        labelingSessionId: rows[0].id,
        tokenHash: sha256(importedGrant.token),
        snapshotVersionId: `snapshot-version:${snapshotKey(project.dataUrl, importedGrant.id)}`,
        state: "active",
        revokedAt: null,
      });
      expect(grant).not.toHaveProperty("token");
      expect(Object.values(grant ?? {})).not.toContain(importedGrant.token);
    }
    const marker = lsMocks.createProject.mock.calls[0]?.[3] as string;
    const intentId = INTENT_MARKER.exec(marker)?.[1];
    expect(intentId).toBeDefined();
    expect(rows[0].provisioningIntentId).toBe(intentId);
    expect(await intentsFor(project.id)).toHaveLength(0);
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
    // Non-tiling copies source versions; it never downloads or uploads tile bytes.
    expect(s3Mocks.downloadFromS3).not.toHaveBeenCalled();
    expect(s3Mocks.uploadS3VersionedSnapshot).not.toHaveBeenCalled();
  });

  it("ambiguous provider create preserves its pre-POST marker intent without retrying or compensating an unknown identity", async () => {
    const { user, project } = await createWorld();
    const ambiguousError = new Error("simulated ambiguous Label Studio POST");
    let intentDuringPost:
      typeof labelStudioProjectIntents.$inferSelect | undefined;
    let mutationLeaseDuringPost:
      typeof projectMutationLeases.$inferSelect | undefined;
    asUser(user);
    stubLsEnv();
    lsMocks.createProject.mockImplementationOnce(
      async (_provider, _title, _config, marker) => {
        [intentDuringPost] = await intentsFor(project.id);
        [mutationLeaseDuringPost] = await db
          .select()
          .from(projectMutationLeases)
          .where(eq(projectMutationLeases.projectId, project.id));
        expect(intentDuringPost).toMatchObject({
          marker,
          providerProjectId: null,
          state: "creating",
          lifecycleEpoch: project.lifecycleEpoch,
        });
        expect(intentDuringPost?.leaseToken).toBe(
          mutationLeaseDuringPost?.token,
        );
        throw ambiguousError;
      },
    );

    const { status, body } = await readJson(
      await post({ projectId: project.publicId }),
    );

    expect(status).toBe(500);
    expect(body.error).toEqual({
      code: "INTERNAL",
      message: "Internal server error",
    });
    expect(lsMocks.createProject).toHaveBeenCalledTimes(1);
    expect(lsMocks.importTasks).not.toHaveBeenCalled();
    expect(lsMocks.deleteProject).not.toHaveBeenCalled();
    expect(await rowsFor(project.id)).toHaveLength(0);
    expect(await grantsFor(project.id)).toHaveLength(0);
    // Immutable private snapshots precede provider CREATE, but no bearer authority is persisted
    // until a known provider identity exists.
    expect(s3Mocks.headS3Object).toHaveBeenCalledTimes(3);
    expect(s3Mocks.copyS3ObjectVersion).toHaveBeenCalledTimes(3);
    expect(await intentsFor(project.id)).toEqual([
      expect.objectContaining({
        id: intentDuringPost?.id,
        marker: intentDuringPost?.marker,
        providerProjectId: null,
        state: "create_uncertain",
        leaseToken: null,
        leaseExpiresAt: null,
        lastError: ambiguousError.message,
      }),
    ]);
    expect(
      await db
        .select()
        .from(projectMutationLeases)
        .where(eq(projectMutationLeases.projectId, project.id)),
    ).toHaveLength(0);
  });

  it("quarantines a provider ID owned by another session without importing, deleting, or marker-recovery deletion", async () => {
    const existing = await createWorld();
    const providerProjectId = 91991;
    const existingSession = await createLabelingSessionFixture(
      existing.project,
      {
        labelStudioProjectId: providerProjectId,
        providerBaseUrl: lsMocks.binding.baseUrl,
        providerInstanceId: lsMocks.binding.instanceId,
      },
    );
    const target = await createWorld();
    asUser(target.user);
    stubLsEnv();
    lsMocks.createProject.mockResolvedValueOnce({ id: providerProjectId });

    const { status, body } = await readJson(
      await post({ projectId: target.project.publicId }),
    );

    expect(status).toBe(500);
    expect(body.error).toEqual({
      code: "INTERNAL",
      message: "Internal server error",
    });
    expect(lsMocks.importTasks).not.toHaveBeenCalled();
    expect(lsMocks.deleteProject).not.toHaveBeenCalled();
    expect(await rowsFor(existing.project.id)).toEqual([
      expect.objectContaining({
        id: existingSession.id,
        labelStudioProjectId: providerProjectId,
        status: "active",
      }),
    ]);
    expect(await rowsFor(target.project.id)).toHaveLength(0);
    expect(await grantsFor(target.project.id)).toHaveLength(0);

    const [retained] = await intentsFor(target.project.id);
    if (!retained) throw new Error("Expected quarantined provider intent");
    expect(retained).toEqual(
      expect.objectContaining({
        providerProjectId: null,
        state: "create_uncertain",
        leaseToken: null,
        leaseExpiresAt: null,
      }),
    );

    lsMocks.findProjectsByExactDescription.mockResolvedValueOnce([
      { id: providerProjectId, description: retained.marker },
    ]);
    await expect(
      reconcileLabelStudioProjectIntent(retained.id),
    ).rejects.toBeDefined();
    expect(lsMocks.deleteProject).not.toHaveBeenCalled();
    expect(await rowsFor(existing.project.id)).toEqual([
      expect.objectContaining({ id: existingSession.id, status: "active" }),
    ]);
    expect(await intentsFor(target.project.id)).toEqual([
      expect.objectContaining({
        id: retained.id,
        providerProjectId: null,
        state: "create_uncertain",
        leaseToken: null,
        leaseExpiresAt: null,
      }),
    ]);
  });

  it("importTasks failure compensates the known provider, removes its durable intent, and stores no session", async () => {
    const { user, project } = await createWorld();
    let revokedDuringCleanup: Array<
      typeof labelStudioAssetGrants.$inferSelect
    > = [];
    asUser(user);
    stubLsEnv();
    lsMocks.createProject.mockResolvedValueOnce({ id: 91009 });
    lsMocks.importTasks.mockRejectedValueOnce(new Error("LS import failed"));
    lsMocks.deleteProject.mockImplementationOnce(async () => {
      revokedDuringCleanup = await grantsFor(project.id);
    });

    const { status, body } = await readJson(
      await post({ projectId: project.publicId }),
    );

    expect(status).toBe(500);
    expect(body.error).toEqual({
      code: "INTERNAL",
      message: "Internal server error",
    });
    expect(lsMocks.deleteProject).toHaveBeenCalledExactlyOnceWith(
      lsMocks.binding,
      91009,
    );
    const imported = lsMocks.importTasks.mock
      .calls[0]?.[2] as ImportedGrantTask[];
    const importedGrants = imported.map(parseGrantTask);
    expect(revokedDuringCleanup).toHaveLength(3);
    for (const grant of revokedDuringCleanup) {
      const task = importedGrants.find(({ id }) => id === grant.id);
      expect(task).toBeDefined();
      expect(grant).toMatchObject({
        state: "revoked",
        labelingSessionId: null,
        tokenHash: sha256(task!.token),
      });
      expect(grant.provisioningIntentId).not.toBeNull();
      expect(grant.revokedAt).toBeInstanceOf(Date);
    }
    expect(await rowsFor(project.id)).toHaveLength(0);
    expect(await grantsFor(project.id)).toHaveLength(0);
    expect(await intentsFor(project.id)).toHaveLength(0);
  });

  it("still attempts provider deletion when the first grant-revocation write fails", async () => {
    const { user, project } = await createWorld();
    const revocationError = "fixture rejected grant revocation";
    let triggerInstalled = false;
    const logSpy = vi
      .spyOn(logger, "error")
      .mockImplementation(() => undefined);
    asUser(user);
    stubLsEnv();
    lsMocks.createProject.mockImplementationOnce(
      async (
        _provider: unknown,
        _title: string,
        _config: string,
        marker: string,
      ) => {
        const intentId = marker.replace("bp-labeling-intent:", "");
        await db.execute(
          sql.raw(`
          CREATE OR REPLACE FUNCTION bp_test_reject_one_grant_revocation()
          RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF OLD.provisioning_intent_id = '${intentId}'::uuid
               AND NEW.state = 'revoked' THEN
              RAISE EXCEPTION '${revocationError}';
            END IF;
            RETURN NEW;
          END;
          $$;
          DROP TRIGGER IF EXISTS bp_test_reject_one_grant_revocation
            ON label_studio_asset_grants;
          CREATE TRIGGER bp_test_reject_one_grant_revocation
            BEFORE UPDATE ON label_studio_asset_grants
            FOR EACH ROW EXECUTE FUNCTION bp_test_reject_one_grant_revocation();
        `),
        );
        triggerInstalled = true;
        return { id: 91911 };
      },
    );
    lsMocks.importTasks.mockRejectedValueOnce(new Error("LS import failed"));
    lsMocks.deleteProject.mockResolvedValueOnce(undefined);

    try {
      const { status } = await readJson(
        await post({ projectId: project.publicId }),
      );

      expect(status).toBe(500);
      expect(lsMocks.deleteProject).toHaveBeenCalledExactlyOnceWith(
        lsMocks.binding,
        91911,
      );
      expect(logSpy).toHaveBeenCalledWith(
        "[LABELING] Failed to revoke orphan Label Studio asset grants:",
        expect.objectContaining({
          cause: expect.objectContaining({
            message: expect.stringContaining(revocationError),
          }),
        }),
      );
      expect(await rowsFor(project.id)).toHaveLength(0);
      expect(await intentsFor(project.id)).toEqual([
        expect.objectContaining({
          providerProjectId: 91911,
          state: "cleanup_pending",
          leaseToken: null,
          leaseExpiresAt: null,
        }),
      ]);
      expect(await grantsFor(project.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ state: "provisioning" }),
        ]),
      );
      expect(
        await db
          .select()
          .from(projectMutationLeases)
          .where(eq(projectMutationLeases.projectId, project.id)),
      ).toHaveLength(0);
    } finally {
      if (triggerInstalled) {
        await db.execute(
          sql.raw(`
          DROP TRIGGER IF EXISTS bp_test_reject_one_grant_revocation
            ON label_studio_asset_grants;
          DROP FUNCTION IF EXISTS bp_test_reject_one_grant_revocation();
        `),
        );
      }
      logSpy.mockRestore();
    }
  });

  it("compensation failure is logged and retains the known provider identity as a retryable intent", async () => {
    const { user, project } = await createWorld();
    const cleanupError = new Error("LS cleanup failed");
    const logSpy = vi
      .spyOn(logger, "error")
      .mockImplementation(() => undefined);
    asUser(user);
    stubLsEnv();
    lsMocks.createProject.mockResolvedValueOnce({ id: 91010 });
    lsMocks.importTasks.mockRejectedValueOnce(new Error("LS import failed"));
    lsMocks.deleteProject.mockRejectedValueOnce(cleanupError);

    try {
      const { status, body } = await readJson(
        await post({ projectId: project.publicId }),
      );

      expect(status).toBe(500);
      expect(body.error).toEqual({
        code: "INTERNAL",
        message: "Internal server error",
      });
      expect(lsMocks.deleteProject).toHaveBeenCalledExactlyOnceWith(
        lsMocks.binding,
        91010,
      );
      expect(logSpy).toHaveBeenCalledWith(
        "[LABELING] Failed to compensate orphan Label Studio project:",
        cleanupError,
      );
      expect(await rowsFor(project.id)).toHaveLength(0);
      const intents = await intentsFor(project.id);
      expect(intents).toEqual([
        expect.objectContaining({
          providerProjectId: 91010,
          state: "cleanup_pending",
          leaseToken: null,
          leaseExpiresAt: null,
          consecutiveFailures: 1,
          lastError: cleanupError.message,
        }),
      ]);
      const imported = lsMocks.importTasks.mock
        .calls[0]?.[2] as ImportedGrantTask[];
      const importedGrants = imported.map(parseGrantTask);
      const retainedGrants = await grantsFor(project.id);
      expect(retainedGrants).toHaveLength(3);
      for (const grant of retainedGrants) {
        const task = importedGrants.find(({ id }) => id === grant.id);
        expect(task).toBeDefined();
        expect(grant).toMatchObject({
          provisioningIntentId: intents[0].id,
          labelingSessionId: null,
          tokenHash: sha256(task!.token),
          state: "revoked",
        });
        expect(grant.revokedAt).toBeInstanceOf(Date);
        expect(grant).not.toHaveProperty("token");
      }
    } finally {
      logSpy.mockRestore();
    }
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
    expect(lsMocks.createProject).toHaveBeenNthCalledWith(
      1,
      lsMocks.binding,
      `${project.name} (pages 1-2)`,
      LS_CONFIG,
      expect.stringMatching(INTENT_MARKER),
    );
    expect(lsMocks.createProject).toHaveBeenNthCalledWith(
      2,
      lsMocks.binding,
      `${project.name} (pages 3)`,
      LS_CONFIG,
      expect.stringMatching(INTENT_MARKER),
    );
    expect(lsMocks.createProject.mock.calls[0]?.[3]).not.toBe(
      lsMocks.createProject.mock.calls[1]?.[3],
    );
    expect(lsMocks.importTasks).toHaveBeenCalledTimes(2);
    expect(lsMocks.importTasks.mock.calls[0]?.[1]).toBe(91004);
    expect(lsMocks.importTasks.mock.calls[1]?.[1]).toBe(91005);
    const firstChunk = (
      lsMocks.importTasks.mock.calls[0]?.[2] as ImportedGrantTask[]
    ).map(parseGrantTask);
    const secondChunk = (
      lsMocks.importTasks.mock.calls[1]?.[2] as ImportedGrantTask[]
    ).map(parseGrantTask);
    expect(firstChunk.map(({ meta }) => meta)).toEqual([
      { pageNumber: 1 },
      { pageNumber: 2 },
    ]);
    expect(secondChunk.map(({ meta }) => meta)).toEqual([{ pageNumber: 3 }]);
    const firstIds = new Set(firstChunk.map(({ id }) => id));
    expect(secondChunk.every(({ id }) => !firstIds.has(id))).toBe(true);
    expect(body.sessions).toEqual([
      expect.objectContaining({
        labelStudioProjectId: 91004,
        pageRange: "1-2",
        taskCount: 2,
      }),
      expect.objectContaining({
        labelStudioProjectId: 91005,
        pageRange: "3",
        taskCount: 1,
      }),
    ]);
    const rows = await rowsFor(project.id);
    expect(rows).toHaveLength(2);
    const sessionByProvider = new Map(
      rows.map((row) => [row.labelStudioProjectId, row.id]),
    );
    const grants = await grantsFor(project.id);
    expect(grants).toHaveLength(3);
    const grantById = new Map(grants.map((grant) => [grant.id, grant]));
    for (const [providerId, chunk] of [
      [91004, firstChunk],
      [91005, secondChunk],
    ] as const) {
      for (const task of chunk) {
        expect(grantById.get(task.id)).toMatchObject({
          state: "active",
          provisioningIntentId: null,
          labelingSessionId: sessionByProvider.get(providerId),
          tokenHash: sha256(task.token),
        });
      }
    }
    expect(
      new Set(
        s3Mocks.copyS3ObjectVersion.mock.calls.map(
          ([, , destinationKey]) => destinationKey,
        ),
      ).size,
    ).toBe(3);
    expect(await intentsFor(project.id)).toHaveLength(0);
  });

  it("the intent reconciler excludes a due row while any active project mutation lease exists", async () => {
    const { company, project } = await createWorld();
    const intentId = randomUUID();
    const marker = `bp-labeling-intent:${intentId}`;
    const [intent] = await db
      .insert(labelStudioProjectIntents)
      .values({
        id: intentId,
        projectId: project.id,
        companyId: company.id,
        lifecycleEpoch: project.lifecycleEpoch,
        marker,
        providerBaseUrl: lsMocks.binding.baseUrl,
        providerInstanceId: lsMocks.binding.instanceId,
        state: "create_uncertain",
        nextAttemptAt: new Date(0),
      })
      .returning();
    const [activeMutation] = await db
      .insert(projectMutationLeases)
      .values({
        projectId: project.id,
        lifecycleEpoch: project.lifecycleEpoch,
        kind: "labeling-active-mutation-test",
        expiresAt: new Date(0),
      })
      .returning();

    try {
      await expect(reconcileLabelStudioProjectIntent(intent.id)).resolves.toBe(
        "unavailable",
      );

      expect(lsMocks.findProjectsByExactDescription).not.toHaveBeenCalled();
      expect(lsMocks.deleteProject).not.toHaveBeenCalled();
      expect(await intentsFor(project.id)).toEqual([
        expect.objectContaining({
          id: intent.id,
          state: "create_uncertain",
          attemptCount: 0,
          leaseToken: null,
          leaseExpiresAt: null,
        }),
      ]);
    } finally {
      await db
        .delete(labelStudioProjectIntents)
        .where(eq(labelStudioProjectIntents.id, intent.id));
      await db
        .delete(projectMutationLeases)
        .where(eq(projectMutationLeases.token, activeMutation.token));
    }
  });

  it("pageSelection 'current' snapshots the exact padded page source", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    stubLsEnv();
    lsMocks.createProject.mockResolvedValueOnce({ id: 91006 });
    lsMocks.importTasks.mockResolvedValueOnce(undefined);

    const { status, body } = await readJson(
      await post({
        projectId: project.publicId,
        pageSelection: "current",
        pageRange: "2",
      }),
    );
    expect(status).toBe(200);
    expect(lsMocks.importTasks.mock.calls[0]?.[1]).toBe(91006);
    const task = parseGrantTask(
      (lsMocks.importTasks.mock.calls[0]?.[2] as ImportedGrantTask[])[0],
    );
    expect(task.meta).toEqual({ pageNumber: 2 });
    const sourceKey = canonicalPageKey(project.dataUrl, 2);
    expect(s3Mocks.headS3Object).toHaveBeenCalledExactlyOnceWith(
      sourceKey,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(s3Mocks.copyS3ObjectVersion).toHaveBeenCalledExactlyOnceWith(
      sourceKey,
      `source-version:${sourceKey}`,
      snapshotKey(project.dataUrl, task.id),
    );
    expect(body.sessions).toEqual([
      expect.objectContaining({ pageRange: "2", taskCount: 1 }),
    ]);
  });

  it.each([
    ["current", "abc"],
    ["current", "0"],
    ["current", "4"],
    ["range", "2"],
    ["range", "0-2"],
    ["range", "3-2"],
    ["range", "4-99"],
  ] as const)(
    "rejects invalid %s pageRange %s before any snapshot or provider call",
    async (pageSelection, pageRange) => {
      const { user, project } = await createWorld();
      asUser(user);
      stubLsEnv();

      const { status, body } = await readJson(
        await post({ projectId: project.publicId, pageSelection, pageRange }),
      );

      expect(status).toBe(400);
      expect(body.error).toEqual({
        code: "VALIDATION",
        message: "Invalid page range",
      });
      expect(s3Mocks.headS3Object).not.toHaveBeenCalled();
      expect(s3Mocks.copyS3ObjectVersion).not.toHaveBeenCalled();
      expect(s3Mocks.downloadFromS3).not.toHaveBeenCalled();
      expect(s3Mocks.uploadS3VersionedSnapshot).not.toHaveBeenCalled();
      expect(lsMocks.createProject).not.toHaveBeenCalled();
      expect(lsMocks.importTasks).not.toHaveBeenCalled();
      expect(lsMocks.deleteProject).not.toHaveBeenCalled();
      expect(await rowsFor(project.id)).toHaveLength(0);
      expect(await grantsFor(project.id)).toHaveLength(0);
      expect(await intentsFor(project.id)).toHaveLength(0);
    },
  );

  it("'range' end is clamped to numPages: '2-99' on a 3-page project → pages 2-3", async () => {
    const { user, project } = await createWorld(); // numPages 3
    asUser(user);
    stubLsEnv();
    lsMocks.createProject.mockResolvedValueOnce({ id: 91008 });
    lsMocks.importTasks.mockResolvedValueOnce(undefined);

    const { status, body } = await readJson(
      await post({
        projectId: project.publicId,
        pageSelection: "range",
        pageRange: "2-99",
      }),
    );
    expect(status).toBe(200);
    expect(lsMocks.importTasks.mock.calls[0]?.[1]).toBe(91008);
    const imported = (
      lsMocks.importTasks.mock.calls[0]?.[2] as ImportedGrantTask[]
    ).map(parseGrantTask);
    expect(imported.map(({ meta }) => meta)).toEqual([
      { pageNumber: 2 },
      { pageNumber: 3 },
    ]);
    expect(
      s3Mocks.copyS3ObjectVersion.mock.calls
        .map(([sourceKey]) => sourceKey)
        .sort(),
    ).toEqual(
      [
        canonicalPageKey(project.dataUrl, 2),
        canonicalPageKey(project.dataUrl, 3),
      ].sort(),
    );
    expect(body.sessions).toEqual([
      expect.objectContaining({ pageRange: "2-3", taskCount: 2 }),
    ]);
  });

  it("tiling reads one exact padded source version and uploads nine unique versioned grant snapshots", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    stubLsEnv();
    lsMocks.createProject.mockResolvedValueOnce({ id: 91011 });
    lsMocks.importTasks.mockResolvedValueOnce(undefined);

    const { status, body } = await readJson(
      await post({
        projectId: project.publicId,
        pageSelection: "current",
        pageRange: "1",
        tiling: true,
      }),
    );

    expect(status).toBe(200);
    const sourceKey = canonicalPageKey(project.dataUrl, 1);
    expect(s3Mocks.headS3Object).toHaveBeenCalledExactlyOnceWith(
      sourceKey,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(s3Mocks.downloadFromS3).toHaveBeenCalledExactlyOnceWith(
      sourceKey,
      `source-version:${sourceKey}`,
    );
    expect(s3Mocks.copyS3ObjectVersion).not.toHaveBeenCalled();

    expect(sharpMocks.metadata).toHaveBeenCalledTimes(1);
    expect(sharpMocks.extract.mock.calls.map(([region]) => region)).toEqual(
      Array.from({ length: 9 }, (_, tile) => ({
        left: (tile % 3) * 100,
        top: Math.floor(tile / 3) * 100,
        width: 100,
        height: 100,
      })),
    );
    expect(sharpMocks.toBuffer).toHaveBeenCalledTimes(9);
    expect(s3Mocks.uploadS3VersionedSnapshot).toHaveBeenCalledTimes(9);

    expect(lsMocks.importTasks.mock.calls[0]?.[1]).toBe(91011);
    const imported = (
      lsMocks.importTasks.mock.calls[0]?.[2] as ImportedGrantTask[]
    ).map(parseGrantTask);
    expect(imported.map(({ meta }) => meta)).toEqual(
      Array.from({ length: 9 }, (_, tile) => ({
        pageNumber: 1,
        row: Math.floor(tile / 3),
        col: tile % 3,
      })),
    );
    expect(new Set(imported.map(({ id }) => id)).size).toBe(9);
    expect(
      new Set(s3Mocks.uploadS3VersionedSnapshot.mock.calls.map(([key]) => key)),
    ).toEqual(
      new Set(imported.map(({ id }) => snapshotKey(project.dataUrl, id))),
    );

    const rows = await rowsFor(project.id);
    expect(rows).toEqual([
      expect.objectContaining({
        labelStudioProjectId: 91011,
        pageRange: "1",
        tilingEnabled: true,
        tileGrid: 3,
        status: "active",
      }),
    ]);
    const grants = await grantsFor(project.id);
    expect(grants).toHaveLength(9);
    const grantsById = new Map(grants.map((grant) => [grant.id, grant]));
    for (const task of imported) {
      expect(grantsById.get(task.id)).toMatchObject({
        labelingSessionId: rows[0].id,
        provisioningIntentId: null,
        tokenHash: sha256(task.token),
        snapshotVersionId: `snapshot-version:${snapshotKey(project.dataUrl, task.id)}`,
        state: "active",
      });
    }
    expect(body.sessions).toEqual([
      expect.objectContaining({
        labelStudioProjectId: 91011,
        pageRange: "1",
        taskCount: 9,
      }),
    ]);
  });
});
