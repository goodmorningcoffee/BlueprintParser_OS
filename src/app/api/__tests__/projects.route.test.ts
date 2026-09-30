// @vitest-environment node
// [refactor jun17 P1.3 family 4/7] CHARACTERIZATION for /api/projects (POST create, GET list), written
// WITH the migration onto services/projects.ts (no P0.3 char file existed for the collection, so this file
// IS the freeze). It asserts the NEW unified envelope {error:{code,message}} from the start. Frozen behavior:
//   • Both handlers are auth:"session" (legacy was auth-FIRST: requireAuth before req.json) — a signed-out
//     caller gets 401 BEFORE any field validation.
//   • POST create order: name/dataUrl required (400) → dataUrl company-prefix tenancy guard (400/404, the
//     cross-tenant-deletion CVE guard) → upload quota (429, 2-arg call so root admins are limited too) →
//     staging-manifest validation (400/413) → insert → processing trigger. The response is {id:publicId,
//     name, status} where status is the IN-MEMORY "uploading" even after the SFN branch flips the DB row to
//     "error" (the SFN catch mutates the DB, not the returned object — divergence frozen below).
//   • GET list returns a BARE ARRAY; root admins see all companies (+companyId/+companyName); non-root
//     callers get neither key (undefined → dropped by JSON.stringify); thumbnailUrl is non-null only for
//     completed projects.
//   • Sanctioned diff (d): a malformed/empty JSON body that legacy let req.json() throw on now gets a shell
//     400 (BAD_REQUEST/VALIDATION) instead of an unhandled 500.
//
// Test infra notes: STEP_FUNCTION_ARN is set in every test worker (setup-env.ts), so POST takes the SFN
// branch. We mock @aws-sdk/client-sfn so send() rejects DETERMINISTICALLY (no SDK retry latency) — the catch
// then flips the DB row to "error" while the response still reports the in-memory "uploading". @/lib/s3 is
// mocked to keep getS3Url real (GET list needs it) while making headS3Object controllable for the staging
// cap/missing-file cases. POST bodies MUST build dataUrl from the company's real dataKey (createWorld's
// project.dataUrl = "testco/<tag>" FAILS the prefix check, which wants "testco-<tag>/...").
import { beforeEach, describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

// SFN: send() rejects fast → createProject's catch sets the DB row to status:"error"; the response still
// returns the in-memory "uploading". Use real constructable test classes so this is specifically an
// ambiguous SDK-send rejection, not a constructor-mock failure under Vitest 4.
const sfnMocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@aws-sdk/client-sfn", () => ({
  SFNClient: class {
    send = sfnMocks.send;
  },
  StartExecutionCommand: class {
    constructor(readonly input: unknown) {}
  },
}));

// s3: keep getS3Url real (GET list thumbnailUrl + any pdf url), make headS3Object a controllable mock for
// the staging aggregate-cap + missing-file cases (the staging-validation 400s fire before it).
vi.mock("@/lib/s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/s3")>();
  return { ...actual, headS3Object: vi.fn() };
});

import { GET, POST } from "@/app/api/projects/route";
import { DELETE as DELETE_PROJECT } from "@/app/api/projects/[id]/route";
import { db } from "@/lib/db";
import {
  processingJobs,
  projectAssetDeletions,
  projects,
} from "@/lib/db/schema";
import {
  PROJECT_UPLOAD_PUBLICATION_FENCE_SECONDS,
  projectUploadStagingKey,
} from "@/lib/project-upload-authority";
import { eq, sql } from "drizzle-orm";
import { headS3Object } from "@/lib/s3";
import { manageDemo } from "@/server/services/demo";
import {
  asUser,
  createCompany,
  createPage,
  createProject,
  createUser,
  createWorld,
  makeReq,
  params,
  readJson,
  sessionState,
  signedOut,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

const post = (body: unknown) => POST(makeReq("/api/projects", { body }));
const getList = () => GET(makeReq("/api/projects", { method: "GET" }));
const GIB = 1024 * 1024 * 1024;
const canonicalProjectPath = (companyDataKey: string, hex = "a") =>
  `${companyDataKey}/${hex.repeat(20)}`;
const staged = (dataUrl: string, filename: string, index = 0) => ({
  filename,
  stagingKey: projectUploadStagingKey(dataUrl, filename, index),
});

beforeEach(() => {
  sfnMocks.send.mockReset();
  sfnMocks.send.mockRejectedValue(new Error("ambiguous SFN transport timeout"));
  vi.mocked(headS3Object).mockReset();
  vi.mocked(headS3Object).mockResolvedValue({
    exists: true,
    size: 1024,
    versionId: "version-1",
  });
});

describe.skipIf(!dbUp)("POST /api/projects (create)", () => {
  it("happy isolated-staging path → {id:publicId, name, status}; status is the in-memory 'uploading' while the DB row diverges to 'error'", async () => {
    const { company, user } = await createWorld();
    asUser(user);
    const dataUrl = canonicalProjectPath(company.dataKey, "a");

    const { status, body } = await readJson(
      await post({
        name: "My Project",
        dataUrl,
        stagingFiles: [staged(dataUrl, "plan.pdf")],
      }),
    );
    expect(status).toBe(200);
    expect(typeof body.id).toBe("string"); // publicId (uuid), NOT the numeric db id
    expect(body.name).toBe("My Project");
    expect(typeof body.status).toBe("string");
    expect(body.status).toBe("uploading"); // in-memory .returning() value — invariant regardless of SFN outcome
    expect("dbId" in body).toBe(false); // create response never exposes dbId (unlike GET /[id])

    // FROZEN divergence: the SFN send mock rejected → the catch flipped the persisted row to "error",
    // but the response object kept the in-memory "uploading". The new row exists with our dataUrl.
    const [row] = await db
      .select()
      .from(projects)
      .where(eq(projects.publicId, body.id));
    expect(row.dataUrl).toBe(dataUrl);
    expect(row.status).toBe("error");
  }, 15000);

  it("retains a named ingestion intent when StartExecution has an ambiguous rejection", async () => {
    const company = await createCompany();
    const admin = await createUser(company.id, { role: "admin" });
    asUser(admin);
    const dataUrl = canonicalProjectPath(company.dataKey, "b");

    const created = await readJson(
      await post({
        name: "Ambiguous SFN",
        dataUrl,
        stagingFiles: [staged(dataUrl, "plan.pdf")],
      }),
    );
    expect(created.status).toBe(200);
    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.publicId, created.body.id));
    const jobs = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.projectId, project.id));

    expect.soft(jobs).toHaveLength(1);
    expect
      .soft(jobs[0])
      .toMatchObject({ status: "running", modelConfig: null });
    expect.soft(jobs[0]?.executionId).toEqual(expect.any(String));
    expect.soft(jobs[0]?.executionId).not.toBe("");

    // Even if another status path later makes the project appear completed, provider-ambiguous
    // work remains an explicit blocker. Age only the separate upload-credential fence so this
    // assertion reaches the running-job policy.
    await db
      .update(projects)
      .set({
        status: "completed",
        createdAt: sql`CURRENT_TIMESTAMP - (${PROJECT_UPLOAD_PUBLICATION_FENCE_SECONDS + 1} * INTERVAL '1 second')`,
      })
      .where(eq(projects.id, project.id));

    await expect(
      manageDemo(
        { projectId: project.publicId, isDemo: true },
        sessionState.current!,
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Project has an active processing job",
    });

    const deletion = await readJson(
      await DELETE_PROJECT(
        makeReq(`/api/projects/${project.publicId}`, { method: "DELETE" }),
        params({ id: project.publicId }),
      ),
    );
    expect(deletion.status).toBe(409);
    expect(deletion.body.error).toEqual({
      code: "CONFLICT",
      message: "Project has an active processing job",
    });
    const [retained] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, project.id));
    expect(retained).toBeDefined();
  }, 15_000);

  it("signed-out → 401 UNAUTHORIZED before any field validation (auth-first)", async () => {
    signedOut();
    const { status, body } = await readJson(
      await post({ name: "x", dataUrl: "anything/x" }),
    );
    expect(status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("missing name/dataUrl → 400 with the verbatim legacy message", async () => {
    const { user } = await createWorld();
    asUser(user);
    const { status, body } = await readJson(await post({}));
    expect(status).toBe(400);
    expect(body.error).toEqual({
      code: "VALIDATION",
      message: "Name and dataUrl required",
    });
  });

  it("dataUrl outside the caller's company prefix → 400 (the cross-tenant-deletion guard), verbatim message", async () => {
    const { user } = await createWorld();
    asUser(user);
    // a well-formed dataUrl that does NOT start with the caller's "<dataKey>/" prefix
    const { status, body } = await readJson(
      await post({ name: "x", dataUrl: "someone-elses-company/secret" }),
    );
    expect(status).toBe(400);
    expect(body.error).toEqual({
      code: "VALIDATION",
      message:
        "Invalid dataUrl — must be inside your company prefix (use /api/s3/staging-credentials to obtain one)",
    });
  });

  it("rejects a same-company project root nested beneath a published demo asset prefix", async () => {
    const { company, user } = await createWorld();
    asUser(user);
    const demoRoot = canonicalProjectPath(company.dataKey, "d");
    const nestedRoot = `${demoRoot}/pages`;

    const { status, body } = await readJson(
      await post({
        name: "alias attack",
        dataUrl: nestedRoot,
        stagingFiles: [staged(nestedRoot, "plan.pdf")],
      }),
    );

    expect(status).toBe(400);
    expect(body.error.message).toBe(
      "Invalid dataUrl — must be inside your company prefix (use /api/s3/staging-credentials to obtain one)",
    );
    expect(headS3Object).not.toHaveBeenCalled();
  });

  it("rejects replay of an old staging manifest after its permanent storage root is retired", async () => {
    const company = await createCompany();
    const member = await createUser(company.id);
    asUser(member);
    const dataUrl = canonicalProjectPath(company.dataKey, "e");
    const retiredProjectPublicId = crypto.randomUUID();
    await db.insert(projectAssetDeletions).values({
      projectPublicId: retiredProjectPublicId,
      companyId: company.id,
      storageRoot: dataUrl,
      lifecycleEpoch: 4,
    });

    const replayedManifest = [staged(dataUrl, "plan.pdf")];
    vi.mocked(headS3Object).mockResolvedValueOnce({
      exists: true,
      size: 1024,
      versionId: "old-staging-version",
    });
    const { status, body } = await readJson(
      await post({
        name: "retired root replay",
        dataUrl,
        stagingFiles: replayedManifest,
      }),
    );

    expect(status).toBe(409);
    expect(body.error).toEqual({
      code: "CONFLICT",
      message: "Project storage root has been retired",
    });
    expect(headS3Object).toHaveBeenCalledExactlyOnceWith(
      replayedManifest[0].stagingKey,
    );
    expect(sfnMocks.send).not.toHaveBeenCalled();
    expect(
      await db.select().from(projects).where(eq(projects.dataUrl, dataUrl)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(projectAssetDeletions)
        .where(eq(projectAssetDeletions.storageRoot, dataUrl)),
    ).toEqual([
      expect.objectContaining({ projectPublicId: retiredProjectPublicId }),
    ]);
  });

  it("upload quota exhausted → 429 RATE_LIMITED (2-arg quota call: member daily limit = 3)", async () => {
    const company = await createCompany();
    const member = await createUser(company.id); // default role = member → DAILY_LIMIT 3
    // seed exactly 3 projects today (created_at defaults to now) → the 4th create trips the quota
    await createProject(company.id, member.id);
    await createProject(company.id, member.id);
    await createProject(company.id, member.id);
    asUser(member);

    const { status, body } = await readJson(
      await post({
        name: "fourth",
        dataUrl: canonicalProjectPath(company.dataKey, "c"),
      }),
    );
    expect(status).toBe(429);
    expect(body.error.code).toBe("RATE_LIMITED");
  });

  it("staging-manifest validation 400s (fire before any S3 HeadObject)", async () => {
    const { company, user } = await createWorld();
    asUser(user);
    const dataUrl = canonicalProjectPath(company.dataKey, "e");

    const empty = await readJson(
      await post({ name: "x", dataUrl, stagingFiles: [] }),
    );
    expect(empty.status).toBe(400);
    expect(empty.body.error.message).toBe(
      "stagingFiles must be a non-empty array",
    );

    const tooMany = await readJson(
      await post({
        name: "x",
        dataUrl,
        stagingFiles: Array.from({ length: 31 }, (_, i) => ({
          filename: `f${i}.pdf`,
          stagingKey: `${dataUrl}/staging/f${i}.pdf`,
        })),
      }),
    );
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error.message).toBe("Maximum 30 files per project");

    const badPrefix = await readJson(
      await post({
        name: "x",
        dataUrl,
        stagingFiles: [
          { filename: "f.pdf", stagingKey: "elsewhere/staging/f.pdf" },
        ],
      }),
    );
    expect(badPrefix.status).toBe(400);
    expect(badPrefix.body.error.message).toBe(
      "Each stagingFile needs its exact issued stagingKey",
    );

    const wrongOrder = await readJson(
      await post({
        name: "x",
        dataUrl,
        stagingFiles: [
          staged(dataUrl, "b.pdf", 1),
          staged(dataUrl, "a.pdf", 0),
        ],
      }),
    );
    expect(wrongOrder.status).toBe(400);
    expect(wrongOrder.body.error.message).toBe(
      "Each stagingFile needs its exact issued stagingKey",
    );
  });

  it("a staged file missing in S3 → 400 interpolating the human filename (not the stagingKey)", async () => {
    const { company, user } = await createWorld();
    asUser(user);
    const dataUrl = canonicalProjectPath(company.dataKey, "f");
    vi.mocked(headS3Object).mockResolvedValue({ exists: false } as any);

    const { status, body } = await readJson(
      await post({
        name: "x",
        dataUrl,
        stagingFiles: [staged(dataUrl, "floorplan.pdf")],
      }),
    );
    expect(status).toBe(400);
    expect(body.error.message).toBe("Staged file missing in S3: floorplan.pdf");
  });

  it("fails closed when S3 cannot pin the validated staging object to an immutable version", async () => {
    const { company, user } = await createWorld();
    asUser(user);
    const dataUrl = canonicalProjectPath(company.dataKey, "8");
    vi.mocked(headS3Object).mockResolvedValue({ exists: true, size: 1024 });

    const { status, body } = await readJson(
      await post({
        name: "x",
        dataUrl,
        stagingFiles: [staged(dataUrl, "floorplan.pdf")],
      }),
    );

    expect(status).toBe(409);
    expect(body.error.message).toBe(
      "Staged file is not version-pinned: floorplan.pdf",
    );
  });

  it("aggregate staged size over the 2GB cap → 413 with the 2048 MB message", async () => {
    const { company, user } = await createWorld();
    asUser(user);
    const dataUrl = canonicalProjectPath(company.dataKey, "9");
    // two 1.5 GiB files → 3 GiB total > 2 GiB cap
    vi.mocked(headS3Object).mockResolvedValue({
      exists: true,
      size: 1.5 * GIB,
      versionId: "oversized-version",
    } as any);

    const { status, body } = await readJson(
      await post({
        name: "x",
        dataUrl,
        stagingFiles: [
          staged(dataUrl, "a.pdf", 0),
          staged(dataUrl, "b.pdf", 1),
        ],
      }),
    );
    expect(status).toBe(413);
    expect(body.error.code).toBe("VALIDATION");
    expect(body.error.message).toMatch(
      /^Project exceeds 2048 MB cap \(got \d+ MB\)$/,
    );
  });

  it("malformed JSON body → shell 400 (sanctioned diff d; legacy let req.json() throw → 500)", async () => {
    const { user } = await createWorld();
    asUser(user);
    // empty body: legacy `await req.json()` threw → 500; now the shell parses undefined and zLooseBody 400s
    expect((await readJson(await post(undefined))).status).toBe(400);
    // literal null: legacy destructure of null threw → 500; now zLooseBody rejects null
    expect((await readJson(await post(null))).status).toBe(400);
    // non-object: zLooseBody (z.record) rejects → 400
    const num = await readJson(await post(42));
    expect(num.status).toBe(400);
    expect(num.body.error.code).toBe("VALIDATION");

    // The ordering corner of sanctioned diff (d): a genuinely malformed JSON body is rejected at the
    // shell's body-parse step (BAD_REQUEST) BEFORE auth — so even a SIGNED-OUT caller gets 400, not the
    // legacy 401 (legacy ran requireAuth before req.json() threw). makeReq always emits valid JSON, so we
    // build a raw Request with an unparseable body.
    signedOut();
    const malformed = new Request("http://test.local/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not valid json",
    });
    const badJson = await readJson(await POST(malformed));
    // [hardening sep30] REVERSED on purpose: auth:"session" authenticates FIRST, so a signed-out
    // caller never makes the server read or parse a body → 401, not 400.
    expect(badJson.status).toBe(401);
    expect(badJson.body.error.code).toBe("UNAUTHORIZED");
  });
});

describe.skipIf(!dbUp)("GET /api/projects (list)", () => {
  it("signed-out → 401 UNAUTHORIZED", async () => {
    signedOut();
    const { status, body } = await readJson(await getList());
    expect(status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("member list: bare array, company-scoped, with the frozen element shape and NO companyId/companyName", async () => {
    const company = await createCompany();
    const member = await createUser(company.id);
    const completed = await createProject(company.id, member.id, {
      status: "completed",
    });
    const uploading = await createProject(company.id, member.id, {
      status: "uploading",
    });
    // a project in ANOTHER company — the non-root caller must NOT see it (the list's companyId scope)
    const otherCo = await createCompany();
    const foreign = await createProject(
      otherCo.id,
      (await createUser(otherCo.id)).id,
      { status: "completed" },
    );
    asUser(member);

    const { status, body } = await readJson(await getList());
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true); // bare array, NOT { projects: [...] }

    const byId = Object.fromEntries(body.map((p: any) => [p.id, p]));
    const c = byId[completed.publicId];
    const u = byId[uploading.publicId];
    expect(c).toBeDefined();
    expect(u).toBeDefined();
    // TENANT ISOLATION (frozen): dropping the non-root `eq(companyId)` scope would leak this — every
    // other list test runs in its own fresh company and would still pass, so freeze the negative here.
    expect(byId[foreign.publicId]).toBeUndefined();

    // frozen element shape
    for (const el of [c, u]) {
      expect(typeof el.id).toBe("string"); // publicId
      expect(typeof el.name).toBe("string");
      expect(typeof el.numPages).toBe("number");
      expect(el.dataUrl).toBeUndefined();
      expect("isDemo" in el).toBe(true);
      expect("createdAt" in el).toBe(true);
      // non-root caller: these keys are undefined → dropped by JSON.stringify → absent
      expect("companyId" in el).toBe(false);
      expect("companyName" in el).toBe(false);
    }

    // thumbnailUrl is non-null ONLY for completed projects; pagesProcessed is null when no pages exist
    expect(c.thumbnailUrl).toBeTruthy();
    expect(u.thumbnailUrl).toBeNull();
    expect(c.pagesProcessed).toBeNull();
  });

  it("freezes the pageCounts derivation + the numPages/pagesProcessed divergence", async () => {
    const company = await createCompany();
    const member = await createUser(company.id);
    // project WITH real pages: the live count overrides the numPages column for BOTH derived fields
    const withPages = await createProject(company.id, member.id, {
      status: "completed",
      numPages: 5,
    });
    await createPage(withPages.id, 1);
    await createPage(withPages.id, 2);
    // project with NO pages: numPages falls back to the column, but pagesProcessed → null (the divergence)
    const noPages = await createProject(company.id, member.id, {
      status: "completed",
      numPages: 5,
    });
    asUser(member);

    const byId = Object.fromEntries(
      (await readJson(await getList())).body.map((p: any) => [p.id, p]),
    );
    // pageCounts[id] = 2 → numPages = pagesProcessed = 2 (the count overrides the stored numPages:5)
    expect(byId[withPages.publicId].numPages).toBe(2);
    expect(byId[withPages.publicId].pagesProcessed).toBe(2);
    // pageCounts[id] = undefined → numPages = (undefined || 5 || 0) = 5, but pagesProcessed = (undefined || null) = null
    expect(byId[noPages.publicId].numPages).toBe(5);
    expect(byId[noPages.publicId].pagesProcessed).toBeNull();
  });

  it("root admin sees cross-company projects, with companyId + companyName populated", async () => {
    const otherCo = await createCompany();
    const otherUser = await createUser(otherCo.id);
    const foreign = await createProject(otherCo.id, otherUser.id, {
      status: "completed",
    });

    const rootCo = await createCompany();
    const root = await createUser(rootCo.id, {
      isRootAdmin: true,
      role: "admin",
    });
    asUser(root);

    const { status, body } = await readJson(await getList());
    expect(status).toBe(200);
    const el = body.find((p: any) => p.id === foreign.publicId);
    expect(el).toBeDefined(); // root reads another company's project
    expect(typeof el.companyId).toBe("number");
    expect(el.companyId).toBe(otherCo.id);
    expect(typeof el.companyName).toBe("string");
    expect(el.companyName).toBe(otherCo.name);
  });
});
