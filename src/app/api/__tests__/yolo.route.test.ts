// @vitest-environment node
// [refactor jul6 S031] CHARACTERIZATION for the YOLO family (status GET / run POST /
// load POST), written as THE FREEZE before the P1.5 fold onto services/yolo.ts.
// Engines/infra mocked at module seams (yolo, s3, aws-sdk client, compute-usage,
// quotas, toggles, email, audit, abuse, the 6 classifier engines, project-analysis);
// REAL DB via harness for projects/models/modelAccess/companies/processingJobs. Frozen:
//   • YQ-1 THREE ROOT-ADMIN SEMANTICS in ONE family (do not unify): run's project lookup
//     is company-scoped with NO root bypass (root cross-company → 404) · run's demo
//     "yoloRun" gate IS root-bypassed (isRootAdmin skips it) · run's SageMaker cap is
//     root-bypassed (no reservation; usage recorded after the fact).
//   • YQ-2 load's auth is the S020-credentials CLASS: signed-out → 403 "Admin only"
//     (NOT 401 — auth:"admin" in the shell would 401 first; fold = auth:"none" +
//     service-resolved manual check). member → 403; admin/root of OWN company only.
//   • YQ-3 run's ORDER is AUTH-FIRST then TOGGLES then QUOTA then req.json — the body
//     is parsed AFTER three gates (opposite of the parse family; malformed bodies at
//     legacy reject raw ONLY once auth+toggles+quota pass). quota 429 = quota.message
//     with NO fallback (no ||). Toggles read fresh from S3 (getToggles(true)).
//   • YQ-4 run quirks: numPages null/0 → 400 "Project page count is unknown..." ·
//     unknown model AND foreign-model-without-grant → the SAME 404 "Model not found"
//     (no existence leak) · company-wide grant (userId NULL) or per-user grant both
//     admit · config.yaml REGENERATED to S3 every run (defaults 0.10/0.60/1280/2000)
//     BEFORE the page-check/cap/job try-block · HeadObject miss → 400 "Page images not
//     found..." · cap-denied → 429 cap.message + recordAbuseEvent + audit (SES only
//     with ROOT_ADMIN_EMAIL + throttle) · startYoloJob throw → releaseReservation +
//     500 leak "Failed to start SageMaker job: <msg>" · post-start ledger failures are
//     swallowed (job already started) · outer catch leaks err.message.
//   • YQ-5 load quirks: unknown modelId PROCEEDS with empty class config (no 404) ·
//     S3 list empty → 404 "No results found" · file loop skips non-.json/_manifest/
//     page_0, per-file parse errors continue, bbox_normalized||bbox||zeros,
//     class_name||class_<id> · zero detections → HTTP 200 {success:false,
//     detectionsLoaded:0, filesProcessed, error:"No detections found in result files"}
//     (IN-BAND 200 error — never flips) · P2 performs delete-previous + creator-scoped
//     batch inserts in one lifecycle-locked transaction; DB errors remain in-band and roll
//     the replacement back · the post-YOLO cascade + summaries
//     are soft-fail (response stays success) · PI updates SPREAD-MERGE (user keys
//     survive — the G3-correct writer) · csiCodes merged from model classCsiCodes.
// Assertions tagged [S031 fold] flip in the fold commit (sanctioned A/B/E only).
// [2026-10-23] run/load are ROOT-ONLY (owner): the real shells now pass through
// services/yolo-root-gate.ts (demo preflight → 401/403 → root) before the services. The YQ-* blocks
// below characterize the SERVICES, so they call yoloRun/yoloLoad through a test-local shell identical
// to the pre-gate route (auth:"none" + zLooseBody); the gate itself and the L5 demo freezes run
// against the REAL routes (describe "root gate").
import { describe, expect, inject, it, vi, beforeEach, afterEach } from "vitest";
import { YoloStartRefusedError } from "@/lib/yolo";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

const h = vi.hoisted(() => ({
  getYoloJobStatus: vi.fn(),
  createYoloJobName: vi.fn(),
  startYoloJob: vi.fn(),
  uploadToS3: vi.fn(),
  s3Send: vi.fn(),
  sdkSend: vi.fn(),
  checkYoloQuota: vi.fn(),
  getToggles: vi.fn(),
  reserveSagemakerPages: vi.fn(),
  releaseReservation: vi.fn(),
  stampReservationJob: vi.fn(),
  recordComputeUsage: vi.fn(),
  shouldSendCapAlert: vi.fn(),
  recordAbuseEvent: vi.fn(),
  sendAlertEmail: vi.fn(),
  audit: vi.fn(),
  runHeuristicEngine: vi.fn(),
  getEffectiveRules: vi.fn(),
  classifyTables: vi.fn(),
  classifyPageRegions: vi.fn(),
  computeYoloHeatmap: vi.fn(),
  reduceRegionVotes: vi.fn(),
  collectAllVotes: vi.fn(),
  computeProjectSummaries: vi.fn(),
}));

vi.mock("@/lib/yolo", async (importOriginal) => ({
  // the real refusal class: yoloRun's catch tells a provider-confirmed refusal apart by instanceof
  YoloStartRefusedError: (await importOriginal<typeof import("@/lib/yolo")>()).YoloStartRefusedError,
  getYoloJobStatus: h.getYoloJobStatus,
  createYoloJobName: h.createYoloJobName,
  startYoloJob: h.startYoloJob,
}));
vi.mock("@/lib/s3", () => ({
  getS3Url: vi.fn(() => "http://cdn.test/x"),
  downloadFromS3: vi.fn(),
  uploadToS3: h.uploadToS3,
  deleteProjectFiles: vi.fn(),
  s3Client: { send: h.s3Send },
  S3_BUCKET: "test-bucket",
}));
// yolo/load constructs its OWN S3Client — mock the SDK itself (commands become tagged POJOs)
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = h.sdkSend;
  },
  ListObjectsV2Command: class {
    constructor(public input: unknown) {
      (this as any).__t = "list";
    }
  },
  GetObjectCommand: class {
    constructor(public input: unknown) {
      (this as any).__t = "get";
    }
  },
  HeadObjectCommand: class {
    constructor(public input: unknown) {
      (this as any).__t = "head";
    }
  },
}));
vi.mock("@/lib/quotas", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/quotas")>()),
  checkYoloQuota: h.checkYoloQuota,
}));
vi.mock("@/lib/toggles", () => ({ getToggles: h.getToggles }));
vi.mock("@/lib/compute-usage", () => ({
  reserveSagemakerPages: h.reserveSagemakerPages,
  releaseReservation: h.releaseReservation,
  stampReservationJob: h.stampReservationJob,
  recordComputeUsage: h.recordComputeUsage,
  shouldSendCapAlert: h.shouldSendCapAlert,
}));
vi.mock("@/lib/admin-logs/record-abuse", () => ({
  recordAbuseEvent: h.recordAbuseEvent,
}));
vi.mock("@/lib/email", () => ({ sendAlertEmail: h.sendAlertEmail }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/heuristic-engine", () => ({
  getEffectiveRules: h.getEffectiveRules,
  runHeuristicEngine: h.runHeuristicEngine,
}));
vi.mock("@/lib/table-classifier", () => ({ classifyTables: h.classifyTables }));
vi.mock("@/lib/composite-classifier", () => ({
  classifyPageRegions: h.classifyPageRegions,
}));
vi.mock("@/lib/spatial/yolo-heatmap", () => ({
  computeYoloHeatmap: h.computeYoloHeatmap,
}));
vi.mock("@/lib/ensemble/region-ensemble", () => ({
  reduceRegionVotes: h.reduceRegionVotes,
}));
vi.mock("@/lib/ensemble/vote-adapters", () => ({
  collectAllVotes: h.collectAllVotes,
}));
vi.mock("@/lib/project-analysis", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/project-analysis")>()),
  computeProjectSummaries: h.computeProjectSummaries,
}));

import { GET as statusGET } from "@/app/api/yolo/status/route";
import { POST as runPOST } from "@/app/api/yolo/run/route";
import { POST as loadPOST } from "@/app/api/yolo/load/route";
import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { yoloLoad, yoloRun } from "@/server/services/yolo";
import {
  asUser,
  createCompany,
  createProject,
  createPage,
  createUser,
  createWorld,
  makeReq,
  readJson,
  signedOut,
} from "@/test/harness";
import { db } from "@/lib/db";
import { FIXED_TITLE_BLOCK_ZONE } from "@/lib/page-zones";
import {
  models,
  modelAccess,
  processingJobs,
  pages as pagesTable,
  annotations as annotationsTable,
} from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { logger } from "@/lib/logger";

const dbUp = inject("dbUp") as boolean;

/** The pre-2026-10-23 shells (no root gate): the services' own characterized behaviour. */
const runService = defineRoute({ auth: "none", body: zLooseBody, handler: ({ body, req }) => yoloRun(body, req) });
const loadService = defineRoute({ auth: "none", body: zLooseBody, handler: ({ body }) => yoloLoad(body) });

// [refactor jul23 P4.1 U7] Only the observe module's entries — logger.warn is shared.
const shapeRegistryWarns = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter(
    (c) => typeof c[0] === "string" && (c[0] as string).startsWith("[shape-registry]"),
  );

async function createModel(
  companyId: number,
  over: Record<string, unknown> = {},
) {
  const name = `model-${Math.random().toString(36).slice(2, 8)}`;
  const [m] = await db
    .insert(models)
    .values({
      name,
      type: "yolo",
      companyId,
      s3Path: `models/${name}`,
      config: {
        classes: ["door"],
        classCsiCodes: { door: ["08 11 00"] },
        classKeywords: {},
      },
      ...over,
    } as never)
    .returning();
  return m;
}

/** yolo/load S3 fixtures: one results file with one detection by default. */
function seedS3Results(files: Array<{ key: string; body: unknown }>) {
  h.sdkSend.mockImplementation(async (cmd: any) => {
    if (cmd.__t === "list") {
      return { Contents: files.map((f) => ({ Key: f.key })) };
    }
    if (cmd.__t === "get") {
      const f = files.find((x) => x.key === (cmd.input as any).Key);
      return {
        Body: { transformToString: async () => JSON.stringify(f?.body ?? {}) },
      };
    }
    throw new Error("unexpected sdk command");
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  signedOut();
  h.getYoloJobStatus.mockResolvedValue({ status: "Completed", progress: 100 });
  h.createYoloJobName.mockReturnValue("job-abc");
  h.startYoloJob.mockResolvedValue("job-abc");
  h.uploadToS3.mockResolvedValue(undefined);
  h.s3Send.mockResolvedValue({}); // run's HeadObject: resolves = pages exist
  h.checkYoloQuota.mockResolvedValue({ allowed: true });
  h.getToggles.mockResolvedValue({
    sagemakerEnabled: true,
    quotaEnabled: true,
  });
  h.reserveSagemakerPages.mockResolvedValue({
    allowed: true,
    reservationId: 77,
  });
  h.shouldSendCapAlert.mockReturnValue(false);
  h.stampReservationJob.mockResolvedValue(undefined);
  h.recordComputeUsage.mockResolvedValue(undefined);
  h.releaseReservation.mockResolvedValue(undefined);
  h.getEffectiveRules.mockReturnValue([]);
  h.runHeuristicEngine.mockReturnValue([]);
  h.classifyTables.mockReturnValue([]);
  h.classifyPageRegions.mockReturnValue({
    tables: [],
    titleBlocks: [],
    drawings: [],
  });
  h.computeYoloHeatmap.mockReturnValue({
    confidentRegions: [],
    classContributions: {},
  });
  h.collectAllVotes.mockReturnValue([]);
  h.reduceRegionVotes.mockReturnValue([]);
  h.computeProjectSummaries.mockResolvedValue(null);
});

// ─── GET /api/yolo/status ────────────────────────────────────────────────────
describe.skipIf(!dbUp)("GET /api/yolo/status", () => {
  const call = (qs: string) =>
    statusGET(makeReq(`/api/yolo/status${qs}`, { method: "GET" }));

  it("requires an own-company durable YOLO witness before provider status", async () => {
    let r = await readJson(await call("?jobName=j1"));
    expect(r.status).toBe(401);
    expect(r.body).toEqual({
      error: { code: "UNAUTHORIZED", message: "Unauthorized" },
    }); // [S031 fold: A applied]
    const { user, project } = await createWorld();
    asUser(user);
    r = await readJson(await call(""));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({
      error: { code: "VALIDATION", message: "jobName required" },
    }); // [S031 fold: A applied]
    expect(h.getYoloJobStatus).not.toHaveBeenCalled();

    r = await readJson(await call("?jobName=j1"));
    expect(r.status).toBe(404);
    expect(r.body).toEqual({
      error: { code: "NOT_FOUND", message: "Not found" },
    });
    expect(h.getYoloJobStatus).not.toHaveBeenCalled();

    await db.insert(processingJobs).values({
      projectId: project.id,
      executionId: "j1",
      status: "running",
      modelConfig: { modelId: 1, modelName: "owned" },
    });
    r = await readJson(await call("?jobName=j1"));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: "Completed", progress: 100 }); // engine passthrough
    expect(h.getYoloJobStatus).toHaveBeenCalledWith("j1");
    h.getYoloJobStatus.mockRejectedValue(
      new Error("sfn down — must not appear"),
    );
    r = await readJson(await call("?jobName=j1"));
    expect(r.status).toBe(500);
    expect(r.body).toEqual({
      error: { code: "INTERNAL", message: "Internal server error" },
    }); // [S031 fold: B applied — fixed literal retired]
  });

  it("hides another company's YOLO witness even from a root session", async () => {
    const own = await createWorld();
    const root = await createUser(own.company.id, {
      role: "admin",
      isRootAdmin: true,
    });
    const foreign = await createWorld();
    await db.insert(processingJobs).values({
      projectId: foreign.project.id,
      executionId: "foreign-job",
      status: "running",
      modelConfig: { modelId: 2, modelName: "foreign" },
    });

    asUser(root);
    const r = await readJson(await call("?jobName=foreign-job"));
    expect(r.status).toBe(404);
    expect(r.body).toEqual({
      error: { code: "NOT_FOUND", message: "Not found" },
    });
    expect(h.getYoloJobStatus).not.toHaveBeenCalled();
  });
});

// ─── POST /api/yolo/run ──────────────────────────────────────────────────────
describe.skipIf(!dbUp)(
  "POST /api/yolo/run — gates in order (YQ-3/YQ-4)",
  () => {
    const call = (b: unknown, headers: Record<string, string> = {}) =>
      runService(makeReq("/api/yolo/run", { body: b, headers }));
    const realCall = (b: unknown) => runPOST(makeReq("/api/yolo/run", { body: b }));

    async function runWorld(
      userOver: Record<string, unknown> = {},
      projOver: Record<string, unknown> = {},
    ) {
      const company = await createCompany();
      const user = await createUser(company.id, {
        canRunModels: true,
        ...userOver,
      } as never);
      const project = await createProject(company.id, user.id, {
        numPages: 5,
        ...projOver,
      } as never);
      const model = await createModel(company.id);
      return { company, user, project, model };
    }

    it("auth-first ladder: 401 signed-out → canRunModels 403 → sagemaker-toggle 403 → quota 429 (no fallback) → field 400", async () => {
      let r = await readJson(await call({}));
      expect(r.status).toBe(401);
      expect(r.body).toEqual({
        error: { code: "UNAUTHORIZED", message: "Unauthorized" },
      }); // [S031 fold: A applied]
      const { user } = await runWorld({ canRunModels: false });
      asUser(user);
      r = await readJson(await call({}));
      expect(r.status).toBe(403);
      expect(r.body).toEqual({
        error: {
          code: "FORBIDDEN",
          message:
            "You don't have permission to run models. Ask your admin to enable it.",
        },
      }); // [S031 fold: A applied]
      const w = await runWorld();
      asUser(w.user);
      h.getToggles.mockResolvedValue({
        sagemakerEnabled: false,
        quotaEnabled: true,
      });
      r = await readJson(await call({}));
      expect(r.status).toBe(403);
      expect(r.body).toEqual({
        error: {
          code: "FORBIDDEN",
          message:
            "SageMaker is disabled by admin. Enable it in Admin > Toggles.",
        },
      }); // [S031 fold: A applied]
      expect(h.getToggles).toHaveBeenCalledWith(true); // fresh S3 read pinned
      h.getToggles.mockResolvedValue({
        sagemakerEnabled: true,
        quotaEnabled: true,
      });
      h.checkYoloQuota.mockResolvedValue({
        allowed: false,
        message: "YOLO daily cap reached",
      });
      r = await readJson(await call({}));
      expect(r.status).toBe(429);
      expect(r.body).toEqual({
        error: { code: "RATE_LIMITED", message: "YOLO daily cap reached" },
      }); // NO || fallback (YQ-3) [S031 fold: A applied]
      // owner ruling 2026-10-21: root flag + user id ride along (exemption + per-user overrides)
      expect(h.checkYoloQuota).toHaveBeenLastCalledWith(
        w.user.companyId,
        w.user.isRootAdmin,
        w.user.id,
      );
      h.checkYoloQuota.mockResolvedValue({ allowed: true });
      r = await readJson(await call({ projectId: w.project.publicId }));
      expect(r.status).toBe(400);
      expect(r.body).toEqual({
        error: {
          code: "VALIDATION",
          message: "projectId and modelId required",
        },
      }); // [S031 fold: A applied]
    });

    it("owner ruling 2026-10-21: a root admin's run passes isRootAdmin=true to the YOLO quota", async () => {
      h.getToggles.mockResolvedValue({ sagemakerEnabled: true, quotaEnabled: true });
      const w = await runWorld({ isRootAdmin: true });
      asUser(w.user);
      const r = await readJson(await call({ projectId: w.project.publicId }));
      expect(r.status).toBe(400); // past the quota, stopped by the field check
      expect(h.checkYoloQuota).toHaveBeenCalledExactlyOnceWith(w.company.id, true, w.user.id);
    });

    it("malformed body rejects RAW only AFTER auth+toggles+quota pass (YQ-3)", async () => {
      // [S031 fold: E — shell parses body FIRST → malformed becomes 400 BAD_REQUEST even
      // signed-out; the auth-first gate ORDER inverts for unparseable bodies ONLY. Pinned
      // as a sanctioned-E ordering note; parseable-body gate order is unchanged.]
      const { user } = await runWorld();
      asUser(user);
      const raw = new Request("http://test.local/api/yolo/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{oops",
      });
      let rr = await readJson(await runPOST(raw));
      expect(rr.status).toBe(400);
      expect(rr.body).toEqual({
        error: { code: "BAD_REQUEST", message: "Invalid JSON body" },
      }); // [S031 fold: E applied]
      // E ordering note pinned: the shell parses the body PRE-auth — malformed 400s even signed-out
      signedOut();
      rr = await readJson(
        await runPOST(
          new Request("http://test.local/api/yolo/run", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{oops",
          }),
        ),
      );
      expect(rr.status).toBe(400);
      expect(rr.body.error.code).toBe("BAD_REQUEST");
    });

    it("YQ-1a: company-scoped lookup — ROOT cross-company gets 404 (NO bypass); numPages gate", async () => {
      const w = await runWorld();
      const otherCo = await createCompany();
      const rootUser = await createUser(otherCo.id, {
        canRunModels: true,
        isRootAdmin: true,
        role: "admin",
      } as never);
      asUser(rootUser);
      let r = await readJson(
        await call({ projectId: w.project.publicId, modelId: w.model.id }),
      );
      expect(r.status).toBe(404);
      expect(r.body).toEqual({
        error: { code: "NOT_FOUND", message: "Project not found" },
      }); // root does NOT bypass here [S031 fold: A applied]
      const w2 = await runWorld({}, { numPages: 0 });
      asUser(w2.user);
      r = await readJson(
        await call({ projectId: w2.project.publicId, modelId: w2.model.id }),
      );
      expect(r.status).toBe(400);
      expect(r.body).toEqual({
        error: {
          code: "VALIDATION",
          message:
            "Project page count is unknown. Reprocess the project before running models.",
        },
      }); // [S031 fold: A applied]
    });

    it("L5 freeze: demo yoloRun denies signed-out, member, admin, and root before every job side effect", async () => {
      const w = await runWorld({}, { isDemo: true });
      const member = w.user;
      const admin = await createUser(w.company.id, {
        canRunModels: true,
        role: "admin",
      } as never);
      const root = await createUser(w.company.id, {
        canRunModels: true,
        isRootAdmin: true,
        role: "admin",
      } as never);
      const statuses: number[] = [];
      for (const actor of [null, member, admin, root]) {
        actor ? asUser(actor) : signedOut();
        statuses.push(
          (
            await readJson(
              await realCall({ // [2026-10-23] the REAL (root-gated) route: demo preflight still answers first
                projectId: w.project.publicId,
                modelId: w.model.id,
              }),
            )
          ).status,
        );
      }
      expect.soft(statuses).toEqual([403, 403, 403, 403]);
      expect.soft(h.startYoloJob).not.toHaveBeenCalled();
      expect.soft(h.uploadToS3).not.toHaveBeenCalled();
      expect.soft(h.recordComputeUsage).not.toHaveBeenCalled();
      expect
        .soft(
          await db
            .select()
            .from(processingJobs)
            .where(eq(processingJobs.projectId, w.project.id)),
        )
        .toEqual([]);
    });

    it("YQ-4: unknown model AND foreign-model-without-grant → SAME 404; grants admit", async () => {
      const w = await runWorld();
      asUser(w.user);
      let r = await readJson(
        await call({ projectId: w.project.publicId, modelId: 999999 }),
      );
      expect(r.status).toBe(404);
      expect(r.body).toEqual({
        error: { code: "NOT_FOUND", message: "Model not found" },
      }); // [S031 fold: A applied]
      const foreignCo = await createCompany();
      const foreignModel = await createModel(foreignCo.id);
      r = await readJson(
        await call({ projectId: w.project.publicId, modelId: foreignModel.id }),
      );
      expect(r.status).toBe(404);
      expect(r.body).toEqual({
        error: { code: "NOT_FOUND", message: "Model not found" },
      }); // no existence leak [S031 fold: A applied]
      await db.insert(modelAccess).values({
        modelId: foreignModel.id,
        companyId: w.company.id,
        enabled: true,
        userId: null,
      } as never);
      r = await readJson(
        await call({ projectId: w.project.publicId, modelId: foreignModel.id }),
      );
      expect(r.status).toBe(200); // company-wide grant admits
    });

    it("happy path: config.yaml regenerated, job tracked, reservation stamped, audit; response shape", async () => {
      const w = await runWorld();
      asUser(w.user);
      const { status, body } = await readJson(
        await call({ projectId: w.project.publicId, modelId: w.model.id }),
      );
      expect(status).toBe(200);
      expect(body).toEqual({ jobName: "job-abc", status: "running" });
      // config.yaml written BEFORE the job with DB-config + defaults (0.10→"0.1"/0.60→"0.6"/1280/2000)
      const [yamlKey, yamlBuf, mime] = h.uploadToS3.mock.calls[0];
      expect(yamlKey).toBe(`${w.model.s3Path}/config.yaml`);
      expect(mime).toBe("text/yaml");
      const yaml = (yamlBuf as Buffer).toString();
      expect(yaml).toContain("confidence_threshold: 0.1");
      expect(yaml).toContain("iou_threshold: 0.6");
      expect(yaml).toContain("image_size: 1280");
      expect(yaml).toContain("max_detections: 2000");
      expect(yaml).toContain("  - door");
      expect(h.startYoloJob).toHaveBeenCalledWith(
        w.project.dataUrl,
        w.model.s3Path,
        w.model.name,
        "job-abc",
      );
      expect(h.stampReservationJob).toHaveBeenCalledWith(77, "job-abc"); // non-root: reservation stamped
      expect(h.audit).toHaveBeenCalledWith(
        "yolo_job_started",
        expect.anything(),
      );
      const jobs = await db
        .select()
        .from(processingJobs)
        .where(eq(processingJobs.projectId, w.project.id));
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        executionId: "job-abc",
        status: "running",
      });
    });

    it("HeadObject miss → 400 'Page images not found...'; cap denied → 429 + abuse + audit, no email w/o env", async () => {
      const w = await runWorld();
      asUser(w.user);
      h.s3Send.mockRejectedValue(new Error("404 head"));
      let r = await readJson(
        await call({ projectId: w.project.publicId, modelId: w.model.id }),
      );
      expect(r.status).toBe(400);
      expect(r.body).toEqual({
        error: {
          code: "VALIDATION",
          message:
            "Page images not found. The project needs to be processed first (or reprocessed if it was uploaded before the image pipeline was added).",
        },
      }); // [S031 fold: A applied]
      h.s3Send.mockResolvedValue({});
      h.reserveSagemakerPages.mockResolvedValue({
        allowed: false,
        message: "Company cap hit",
        capHit: "company",
        companyUsed: 100,
        companyLimit: 100,
        userUsed: 0,
        userLimit: null,
      });
      r = await readJson(
        await call(
          { projectId: w.project.publicId, modelId: w.model.id },
          {
            "x-forwarded-for": "198.51.100.9, 203.0.113.77",
          },
        ),
      );
      expect(r.status).toBe(429);
      expect(r.body).toEqual({
        error: { code: "RATE_LIMITED", message: "Company cap hit" },
      }); // [S031 fold: A applied]
      expect(h.recordAbuseEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "SAGEMAKER_CAP_HIT",
          ip: "203.0.113.77",
        }),
      );
      expect(h.audit).toHaveBeenCalledWith("yolo_cap_hit", expect.anything());
      expect(h.sendAlertEmail).not.toHaveBeenCalled(); // no ROOT_ADMIN_EMAIL in test env
    });

    it("ambiguous startYoloJob throw leaves a named running blocker + reservation; outer catch stays controlled", async () => {
      // [S031 fold: B — "Failed to start SageMaker job: <msg>" → ApiError INTERNAL
      // "Failed to start SageMaker job" (suffix dropped, prefix kept — UQ-2/symbol-search
      // precedent); the outer err.message leak → generic INTERNAL 500]
      const w = await runWorld();
      asUser(w.user);
      h.startYoloJob.mockRejectedValue(new Error("sfn exploded"));
      let r = await readJson(
        await call({ projectId: w.project.publicId, modelId: w.model.id }),
      );
      expect(r.status).toBe(500);
      // [S031 fold: B applied — suffix dropped, prefix KEPT (surfaces, S024 pin class)]
      expect(r.body).toEqual({
        error: { code: "INTERNAL", message: "Failed to start SageMaker job" },
      });
      expect(h.releaseReservation).not.toHaveBeenCalled();
      const [uncertainJob] = await db
        .select()
        .from(processingJobs)
        .where(eq(processingJobs.projectId, w.project.id));
      expect(uncertainJob).toMatchObject({
        executionId: "job-abc",
        status: "running",
        error: "SageMaker start outcome unknown",
      });
      h.startYoloJob.mockResolvedValue("job-abc");
      h.stampReservationJob.mockRejectedValue(new Error("ledger down"));
      r = await readJson(
        await call({ projectId: w.project.publicId, modelId: w.model.id }),
      );
      expect(r.status).toBe(200); // post-start ledger failure swallowed (job already started)
    });

    it("an AWS-confirmed quota refusal surfaces as a 429 RETRYABLE, closes the intent row as failed and releases the page reservation", async () => {
      // [2026-10-21 bulk YOLO] lib/yolo maps ResourceLimitExceeded → YoloStartRefusedError (429) naming
      // the instance type; confirmedAbsent means a Describe found no job under that name. yoloRun then
      // closes the job intent as failed with "SageMaker job never accepted: <reason>" (2026-10-22: was a
      // delete; the prefix keeps it out of the daily job count, and it no longer blocks delete/publish or
      // lingers as "running"), releases the reservation, and passes the 429 RETRYABLE through so the
      // admin sees "No SageMaker quota for <type>" and the bulk queue pauses + retries.
      const w = await runWorld();
      asUser(w.user);
      const message = "No SageMaker quota for ml.g5.xlarge processing jobs (ResourceLimitExceeded): …";
      h.startYoloJob.mockRejectedValue(new YoloStartRefusedError(message, true));
      const r = await readJson(
        await call({ projectId: w.project.publicId, modelId: w.model.id }),
      );
      expect(r.status).toBe(429);
      expect(r.body).toEqual({ error: { code: "RETRYABLE", message } });
      expect(h.releaseReservation).toHaveBeenCalledExactlyOnceWith(77);
      const jobs = await db
        .select()
        .from(processingJobs)
        .where(eq(processingJobs.projectId, w.project.id));
      expect(jobs).toEqual([expect.objectContaining({ status: "failed", error: `SageMaker job never accepted: ${message}` })]);
    });

    it("an unconfirmed start outcome surfaces as a 500 naming the AWS error and keeps the intent + reservation as a named blocker", async () => {
      const w = await runWorld();
      asUser(w.user);
      // lib/yolo-start-errors: an outcome Describe could not settle is INTERNAL (never retryable).
      const message = "SageMaker start outcome unknown (TimeoutError) — check Stuck jobs before retrying";
      h.startYoloJob.mockRejectedValue(new YoloStartRefusedError(message, false, "INTERNAL", "TimeoutError"));
      const r = await readJson(
        await call({ projectId: w.project.publicId, modelId: w.model.id }),
      );
      expect(r.status).toBe(500);
      expect(r.body).toEqual({ error: { code: "INTERNAL", message } });
      expect(h.releaseReservation).not.toHaveBeenCalled();
      const [job] = await db
        .select()
        .from(processingJobs)
        .where(eq(processingJobs.projectId, w.project.id));
      expect(job).toMatchObject({ status: "running", error: "SageMaker start outcome unknown" });
    });

    it("a root admin's confirmed quota refusal closes the intent row as failed (root holds no reservation)", async () => {
      const w = await runWorld({ isRootAdmin: true });
      asUser(w.user);
      h.startYoloJob.mockRejectedValue(new YoloStartRefusedError("No SageMaker quota for ml.g4dn.xlarge …", true));
      const r = await readJson(
        await call({ projectId: w.project.publicId, modelId: w.model.id }),
      );
      expect(r.status).toBe(429);
      expect(h.releaseReservation).not.toHaveBeenCalled();
      expect(h.recordComputeUsage).not.toHaveBeenCalled();
      const jobs = await db
        .select()
        .from(processingJobs)
        .where(eq(processingJobs.projectId, w.project.id));
      expect(jobs).toEqual([expect.objectContaining({ status: "failed" })]);
    });
  },
);

// ─── POST /api/yolo/load ─────────────────────────────────────────────────────
describe.skipIf(!dbUp)("POST /api/yolo/load (YQ-2/YQ-5)", () => {
  const call = (b: unknown) => loadService(makeReq("/api/yolo/load", { body: b }));
  const realCall = (b: unknown) => loadPOST(makeReq("/api/yolo/load", { body: b }));

  async function loadWorld() {
    const company = await createCompany();
    const admin = await createUser(company.id, { role: "admin" } as never);
    const project = await createProject(company.id, admin.id);
    const model = await createModel(company.id);
    return { company, admin, project, model };
  }
  const detFile = (key: string, dets: unknown[]) => ({
    key,
    body: { detections: dets },
  });
  const DET = {
    class_id: 1,
    class_name: "door",
    confidence: 0.9,
    bbox_normalized: [0.1, 0.2, 0.3, 0.4],
  };

  it("L5 freeze: demo yoloLoad denies signed-out, member, admin, and root before S3/DB writes", async () => {
    const company = await createCompany();
    const member = await createUser(company.id);
    const admin = await createUser(company.id, { role: "admin" } as never);
    const root = await createUser(company.id, {
      role: "admin",
      isRootAdmin: true,
    } as never);
    const project = await createProject(company.id, member.id, {
      isDemo: true,
    });
    const model = await createModel(company.id);
    seedS3Results([
      detFile(`${project.dataUrl}/yolo-output/demo/page_0001.json`, [DET]),
    ]);
    const statuses: number[] = [];
    for (const actor of [null, member, admin, root]) {
      actor ? asUser(actor) : signedOut();
      statuses.push(
        (
          await readJson(
            await realCall({ // [2026-10-23] the REAL (root-gated) route
              projectId: project.publicId,
              modelId: model.id,
              modelName: "demo",
            }),
          )
        ).status,
      );
    }
    expect.soft(statuses).toEqual([403, 403, 403, 403]);
    expect.soft(h.sdkSend).not.toHaveBeenCalled();
    expect
      .soft(
        await db
          .select()
          .from(annotationsTable)
          .where(eq(annotationsTable.projectId, project.id)),
      )
      .toEqual([]);
    expect.soft(h.computeProjectSummaries).not.toHaveBeenCalled();
  });

  it("YQ-2: signed-out → 403 'Admin only' (NOT 401); member → 403; cross-company → 404", async () => {
    let r = await readJson(
      await call({ projectId: "x", modelId: 1, modelName: "m" }),
    );
    expect(r.status).toBe(403);
    expect(r.body).toEqual({
      error: { code: "FORBIDDEN", message: "Admin only" },
    }); // signed-out 403 — S020 class [S031 fold: A applied]
    const w = await loadWorld();
    const member = await createUser(w.company.id); // role member
    asUser(member);
    r = await readJson(
      await call({
        projectId: w.project.publicId,
        modelId: w.model.id,
        modelName: "m",
      }),
    );
    expect(r.status).toBe(403);
    expect(r.body).toEqual({
      error: { code: "FORBIDDEN", message: "Admin only" },
    }); // [S031 fold: A applied]
    const otherCo = await createCompany();
    const otherAdmin = await createUser(otherCo.id, { role: "admin" } as never);
    asUser(otherAdmin);
    r = await readJson(
      await call({
        projectId: w.project.publicId,
        modelId: w.model.id,
        modelName: "m",
      }),
    );
    expect(r.status).toBe(404);
    expect(r.body).toEqual({
      error: { code: "NOT_FOUND", message: "Project not found" },
    }); // [S031 fold: A applied]
  });

  it("S3 list empty → 404 'No results found'; unknown modelId PROCEEDS (no 404)", async () => {
    const w = await loadWorld();
    asUser(w.admin);
    h.sdkSend.mockResolvedValue({ Contents: [] });
    let r = await readJson(
      await call({
        projectId: w.project.publicId,
        modelId: w.model.id,
        modelName: "m",
      }),
    );
    expect(r.status).toBe(404);
    expect(r.body).toEqual({
      error: { code: "NOT_FOUND", message: "No results found" },
    }); // [S031 fold: A applied]
    // unknown modelId: empty class config, still runs the loop (YQ-5)
    seedS3Results([
      detFile(`${w.project.dataUrl}/yolo-output/m/page_0001.json`, [DET]),
    ]);
    r = await readJson(
      await call({
        projectId: w.project.publicId,
        modelId: 999999,
        modelName: "m",
      }),
    );
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    const [inserted] = await db
      .select({ data: annotationsTable.data })
      .from(annotationsTable)
      .where(
        and(
          eq(annotationsTable.projectId, w.project.id),
          eq(annotationsTable.source, "yolo"),
        ),
      );
    expect((inserted.data as Record<string, unknown>).csiCodes).toEqual([]); // empty fallback pinned
  });

  it("YQ-5 file-loop quirks: manifest/non-json/page_0 skipped; parse-error continues; fallback chains", async () => {
    const w = await loadWorld();
    asUser(w.admin);
    const p = `${w.project.dataUrl}/yolo-output/m`;
    h.sdkSend.mockImplementation(async (cmd: any) => {
      if (cmd.__t === "list") {
        return {
          Contents: [
            { Key: `${p}/page_0001.json` },
            { Key: `${p}/_manifest.json` },
            { Key: `${p}/notes.txt` },
            { Key: `${p}/other.json` }, // no page_N → pageNumber 0 → skipped
            { Key: `${p}/page_0002.json` }, // malformed JSON → continue
            { Key: `${p}/page_0003.json` }, // bbox + class_name fallbacks
          ],
        };
      }
      const key = (cmd.input as any).Key as string;
      const bodies: Record<string, string> = {
        [`${p}/page_0001.json`]: JSON.stringify({ detections: [DET] }),
        [`${p}/other.json`]: JSON.stringify({ detections: [DET] }),
        [`${p}/page_0002.json`]: "{corrupt",
        [`${p}/page_0003.json`]: JSON.stringify({
          detections: [
            { class_id: 7, confidence: 0.5, bbox: [0.5, 0.5, 0.6, 0.6] },
          ],
        }),
      };
      return { Body: { transformToString: async () => bodies[key] ?? "" } };
    });
    const { body } = await readJson(
      await call({
        projectId: w.project.publicId,
        modelId: w.model.id,
        modelName: "m",
      }),
    );
    expect(body.filesProcessed).toBe(2); // page_0001 + page_0003 (0002 parse-fail, other page-0, manifest/txt skipped)
    expect(body.detectionsLoaded).toBe(2);
    const inserts = await db
      .select({
        name: annotationsTable.name,
        minX: annotationsTable.minX,
        pageNumber: annotationsTable.pageNumber,
        creatorId: annotationsTable.creatorId,
      })
      .from(annotationsTable)
      .where(
        and(
          eq(annotationsTable.projectId, w.project.id),
          eq(annotationsTable.source, "yolo"),
        ),
      );
    expect(inserts).toHaveLength(2);
    const fallback = inserts.find((row) => row.pageNumber === 3)!;
    expect(fallback.name).toBe("class_7"); // class_name || class_<id> fallback
    expect(fallback.minX).toBe(0.5); // bbox fallback chain used det.bbox
    expect(inserts.every((row) => row.creatorId === w.admin.id)).toBe(true);
  });

  it("zero detections → IN-BAND 200 {success:false, error} (never flips); delete-previous count surfaces", async () => {
    const w = await loadWorld();
    asUser(w.admin);
    seedS3Results([
      detFile(`${w.project.dataUrl}/yolo-output/m/page_0001.json`, []),
    ]);
    const { status, body } = await readJson(
      await call({
        projectId: w.project.publicId,
        modelId: w.model.id,
        modelName: "m",
      }),
    );
    expect(status).toBe(200);
    expect(body).toEqual({
      success: false,
      detectionsLoaded: 0,
      filesProcessed: 1,
      error: "No detections found in result files",
    });
    expect(
      await db
        .select()
        .from(annotationsTable)
        .where(eq(annotationsTable.projectId, w.project.id)),
    ).toEqual([]);
  });

  it("replacement DB error is in-band and rolls back the prior-detection delete", async () => {
    const w = await loadWorld();
    asUser(w.admin);
    await db.insert(annotationsTable).values({
      name: "old-door",
      minX: 0.1,
      minY: 0.2,
      maxX: 0.3,
      maxY: 0.4,
      pageNumber: 1,
      data: { modelId: w.model.id, canary: "survives-rollback" },
      source: "yolo",
      projectId: w.project.id,
    } as never);
    seedS3Results([
      detFile(`${w.project.dataUrl}/yolo-output/m/page_0001.json`, [
        {
          ...DET,
          bbox_normalized: ["not-a-number", 0.2, 0.3, 0.4],
        },
      ]),
    ]);
    const { status, body } = await readJson(
      await call({
        projectId: w.project.publicId,
        modelId: w.model.id,
        modelName: "m",
      }),
    );
    expect(status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.error).toContain("invalid input syntax for type");
    expect(body.error).toContain("code: 22P02");
    const remaining = await db
      .select({ data: annotationsTable.data })
      .from(annotationsTable)
      .where(eq(annotationsTable.projectId, w.project.id));
    expect(remaining).toHaveLength(1);
    expect((remaining[0].data as Record<string, unknown>).canary).toBe(
      "survives-rollback",
    );
  });

  it("happy + post-cascade: PI SPREAD-MERGE preserves user keys; csiCodes merged; summaries soft-fail", async () => {
    const w = await loadWorld();
    await createPage(w.project.id, 1, {
      rawText: "text",
      pageIntelligence: {
        parsedRegions: [{ id: "user-region" }],
        textRegions: [{ t: 1 }],
      } as never,
    });
    asUser(w.admin);
    // Seed two prior detections for this exact model; the replacement transaction deletes both
    // before inserting the newly loaded result.
    await db.insert(annotationsTable).values({
      name: "door",
      minX: 0.1,
      minY: 0.2,
      maxX: 0.3,
      maxY: 0.4,
      pageNumber: 1,
      threshold: 0.9,
      data: { modelId: w.model.id, confidence: 0.9, modelName: "m" },
      source: "yolo",
      projectId: w.project.id,
    } as never);
    await db.insert(annotationsTable).values({
      name: "door-old-2",
      minX: 0.2,
      minY: 0.2,
      maxX: 0.4,
      maxY: 0.4,
      pageNumber: 1,
      threshold: 0.8,
      data: { modelId: w.model.id, confidence: 0.8, modelName: "m" },
      source: "yolo",
      projectId: w.project.id,
    } as never);
    seedS3Results([
      detFile(`${w.project.dataUrl}/yolo-output/m/page_0001.json`, [DET]),
    ]);
    h.runHeuristicEngine.mockReturnValue([{ rule: "r1" }]); // triggers PI write path
    h.computeProjectSummaries.mockRejectedValue(new Error("summaries down")); // must not break 200
    const { status, body } = await readJson(
      await call({
        projectId: w.project.publicId,
        modelId: w.model.id,
        modelName: "m",
      }),
    );
    expect(status).toBe(200);
    expect(body).toEqual({
      success: true,
      detectionsLoaded: 1,
      deletedPrevious: 2,
      filesProcessed: 1,
    });
    const [pageRow] = await db
      .select({ pi: pagesTable.pageIntelligence, csi: pagesTable.csiCodes })
      .from(pagesTable)
      .where(
        and(
          eq(pagesTable.projectId, w.project.id),
          eq(pagesTable.pageNumber, 1),
        ),
      );
    const pi = pageRow.pi as Record<string, unknown>;
    expect(pi.parsedRegions).toEqual([{ id: "user-region" }]); // G3-correct spread-merge: user keys survive
    expect(pi.heuristicInferences).toEqual([{ rule: "r1" }]);
    expect(
      (pageRow.csi as Array<{ code: string }>).map((c) => c.code),
    ).toContain("08 11 00"); // model classCsiCodes merged
    expect(h.computeProjectSummaries).toHaveBeenCalledWith(
      w.project.id,
      expect.anything(),
    );
    // [zones T2] post-load enrichment persists pageZones; model "m" is not yolo_medium ⇒ fixed fallback.
    expect(pi.pageZones).toEqual({ titleBlock: FIXED_TITLE_BLOCK_ZONE, drawings: [], tables: [], legends: [], source: "fixed-fallback" });
  });

  it("[zones T2] a yolo_medium title_block becomes the page's detector zones; a custom model's title_block does not", async () => {
    const w = await loadWorld();
    await createPage(w.project.id, 1, { rawText: "text", pageIntelligence: { parsedRegions: [] } as never });
    asUser(w.admin);
    // A previously loaded CUSTOM model claims a title block top-left — must not win the zone.
    await db.insert(annotationsTable).values({
      name: "title_block", minX: 0, minY: 0, maxX: 0.3, maxY: 0.1, pageNumber: 1, threshold: 0.9,
      data: { modelId: w.model.id + 7, confidence: 0.99, modelName: "acme_custom" }, source: "yolo", projectId: w.project.id,
    } as never);
    seedS3Results([
      detFile(`${w.project.dataUrl}/yolo-output/yolo_medium/page_0001.json`, [
        { ...DET, class_name: "title_block", confidence: 0.6, bbox_normalized: [0.88, 0.02, 0.99, 0.98] },
        { ...DET, class_name: "tables", confidence: 0.7, bbox_normalized: [0.1, 0.1, 0.3, 0.3] },
      ]),
    ]);
    const { status, body } = await readJson(
      await call({ projectId: w.project.publicId, modelId: w.model.id, modelName: "yolo_medium" }),
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    const [pageRow] = await db
      .select({ pi: pagesTable.pageIntelligence })
      .from(pagesTable)
      .where(and(eq(pagesTable.projectId, w.project.id), eq(pagesTable.pageNumber, 1)));
    const pi = pageRow.pi as Record<string, unknown>;
    expect(pi.parsedRegions).toEqual([]); // spread-merge still holds
    expect(pi.pageZones).toEqual({
      titleBlock: [0.88, 0.02, 0.99, 0.98], drawings: [], tables: [[0.1, 0.1, 0.3, 0.3]], legends: [], source: "detector",
    });
  });

  it("[fix 2026-10-22] a re-registered model (new id, same name) REPLACES its old rows; other models and other projects survive", async () => {
    const w = await loadWorld();
    const other = await createProject(w.company.id, w.admin.id);
    const row = (projectId: number, data: Record<string, unknown>) => ({
      name: "door", minX: 0.1, minY: 0.2, maxX: 0.3, maxY: 0.4, pageNumber: 1, threshold: 0.9,
      data, source: "yolo", projectId,
    });
    await db.insert(annotationsTable).values([
      row(w.project.id, { modelId: w.model.id + 100000, modelName: "m" }), // old id, same S3 name
      row(w.project.id, { modelId: w.model.id + 100001, modelName: "other" }), // a different model
      row(other.id, { modelId: w.model.id + 100000, modelName: "m" }), // another project
    ] as never);
    seedS3Results([detFile(`${w.project.dataUrl}/yolo-output/m/page_0001.json`, [DET])]);
    asUser(w.admin);
    const { status, body } = await readJson(
      await call({ projectId: w.project.publicId, modelId: w.model.id, modelName: "m" }),
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({ success: true, detectionsLoaded: 1, deletedPrevious: 1 });
    const left = await db
      .select({ projectId: annotationsTable.projectId, data: annotationsTable.data })
      .from(annotationsTable)
      .where(eq(annotationsTable.source, "yolo"));
    const mine = left.filter((r) => r.projectId === w.project.id).map((r) => (r.data as Record<string, unknown>).modelName);
    expect(mine.sort()).toEqual(["m", "other"]);
    expect(left.filter((r) => r.projectId === other.id)).toHaveLength(1);
  });

  it("[fix 2026-10-23 page-permanent-delete] a results file whose page has NO row is skipped (a deleted page's leftover JSON never re-imports); a project with no page rows at all still loads every file", async () => {
    const w = await loadWorld();
    asUser(w.admin);
    const p = `${w.project.dataUrl}/yolo-output/m`;
    const files = [detFile(`${p}/page_0001.json`, [DET]), detFile(`${p}/page_0003.json`, [DET])];
    const load = async () => readJson(await call({ projectId: w.project.publicId, modelId: w.model.id, modelName: "m" }));
    const yoloPages = async () =>
      (await db.select({ n: annotationsTable.pageNumber }).from(annotationsTable)
        .where(and(eq(annotationsTable.projectId, w.project.id), eq(annotationsTable.source, "yolo"))).orderBy(annotationsTable.pageNumber)).map((x) => x.n);
    // legacy shape (no page rows): unchanged, both files load
    seedS3Results(files);
    let r = await load();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true, detectionsLoaded: 2, deletedPrevious: 0, filesProcessed: 2 });
    expect(await yoloPages()).toEqual([1, 3]);
    // page 1 has a row; page 3 was permanently deleted (row gone, S3 file left behind) → skipped, and the
    // replacement load drops its old rows instead of re-importing them
    await createPage(w.project.id, 1);
    seedS3Results(files);
    r = await load();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true, detectionsLoaded: 1, deletedPrevious: 2, filesProcessed: 1 }); // response shape unchanged (frozen)
    expect(await yoloPages()).toEqual([1]);
  });

  // ── yolo.load observe warn-net (rides commit U7-B) [refactor jul23 P4.1 U7] ──
  // Log-mode contract (spec Verdict 2 / RD-U7d): valid detections → zero [shape-registry]
  // warns; a malformed detection STILL persists (log+skip, gate:false — a throw would
  // poison the whole load) + exactly ONE aggregated warn {sink:yolo.load, kind:yolo-detection}.
  // det.class_id → data.classId; a string violates zYoloDetectionData.classId (int) while the
  // varchar `name` col takes det.class_name ("door") and the row still inserts. Scoped logger
  // spy restored per-test (the file-level beforeEach re-seeds every default before the next).
  describe("yolo.load observe warn-net [U7]", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warnSpy = vi.spyOn(logger, "warn");
    });
    afterEach(() => warnSpy.mockRestore());

    it("valid detections → rows persist with ZERO shape-registry warns", async () => {
      const w = await loadWorld();
      asUser(w.admin);
      seedS3Results([
        detFile(`${w.project.dataUrl}/yolo-output/m/page_0001.json`, [DET]),
      ]);
      const { status, body } = await readJson(
        await call({ projectId: w.project.publicId, modelId: w.model.id, modelName: "m" }),
      );
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      const rows = await db
        .select()
        .from(annotationsTable)
        .where(
          and(
            eq(annotationsTable.projectId, w.project.id),
            eq(annotationsTable.source, "yolo"),
          ),
        );
      expect(rows.length).toBeGreaterThan(0);
      expect(shapeRegistryWarns(warnSpy)).toHaveLength(0);
    });

    it("MALFORMED detection (classId string) → row STILL persists (log-only) + ONE warn {sink:yolo.load, kind:yolo-detection}", async () => {
      const w = await loadWorld();
      asUser(w.admin);
      seedS3Results([
        detFile(`${w.project.dataUrl}/yolo-output/m/page_0001.json`, [
          { ...DET, class_id: "x" }, // classId string → violates zYoloDetectionData; name still "door"
        ]),
      ]);
      const { status, body } = await readJson(
        await call({ projectId: w.project.publicId, modelId: w.model.id, modelName: "m" }),
      );
      expect(status).toBe(200);
      expect(body.success).toBe(true); // ← log-only: nothing blocked
      const rows = await db
        .select({ data: annotationsTable.data })
        .from(annotationsTable)
        .where(
          and(
            eq(annotationsTable.projectId, w.project.id),
            eq(annotationsTable.source, "yolo"),
          ),
        );
      expect(rows).toHaveLength(1);
      expect((rows[0].data as Record<string, unknown>).classId).toBe("x"); // persisted, violations and all
      const calls = shapeRegistryWarns(warnSpy);
      expect(calls).toHaveLength(1);
      const ctx = calls[0][1] as Record<string, unknown>;
      expect(ctx.sink).toBe("yolo.load");
      expect(ctx.kind).toBe("yolo-detection");
    });
  });
});

// ─── [2026-10-23] root gate on the REAL run/load routes ─────────────────────
describe.skipIf(!dbUp)("POST /api/yolo/run + /api/yolo/load — root only (services/yolo-root-gate.ts)", () => {
  const ROOT_ONLY = { error: { code: "FORBIDDEN", message: "Root admin only" } };
  const run = (b: unknown) => runPOST(makeReq("/api/yolo/run", { body: b }));
  const load = (b: unknown) => loadPOST(makeReq("/api/yolo/load", { body: b }));

  async function gateWorld() {
    const company = await createCompany();
    const member = await createUser(company.id, { canRunModels: true } as never);
    const admin = await createUser(company.id, { canRunModels: true, role: "admin" } as never);
    const root = await createUser(company.id, { canRunModels: true, isRootAdmin: true, role: "admin" } as never);
    const project = await createProject(company.id, admin.id, { numPages: 5 } as never);
    const model = await createModel(company.id);
    return { company, member, admin, root, project, model };
  }

  it("run: signed-out 401; member and company admin (canRunModels) 403 'Root admin only' before any gate or side effect; root proceeds", async () => {
    const w = await gateWorld();
    const body = { projectId: w.project.publicId, modelId: w.model.id };
    let r = await readJson(await run(body));
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } });
    for (const actor of [w.member, w.admin]) {
      asUser(actor);
      r = await readJson(await run(body));
      expect(r.status).toBe(403);
      expect(r.body).toEqual(ROOT_ONLY);
    }
    expect(h.getToggles).not.toHaveBeenCalled();
    expect(h.checkYoloQuota).not.toHaveBeenCalled();
    expect(h.uploadToS3).not.toHaveBeenCalled();
    expect(h.startYoloJob).not.toHaveBeenCalled();
    expect(await db.select().from(processingJobs).where(eq(processingJobs.projectId, w.project.id))).toEqual([]);

    asUser(w.root);
    r = await readJson(await run(body));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ jobName: "job-abc", status: "running" });
    expect(h.startYoloJob).toHaveBeenCalledTimes(1);
  });

  it("load: signed-out 403 (never 401, YQ-2), member and company admin 403 'Root admin only' before S3; root reaches the loader", async () => {
    const w = await gateWorld();
    const body = { projectId: w.project.publicId, modelId: w.model.id, modelName: "m" };
    h.sdkSend.mockResolvedValue({ Contents: [] });
    let r = await readJson(await load(body));
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ROOT_ONLY);
    for (const actor of [w.member, w.admin]) {
      asUser(actor);
      r = await readJson(await load(body));
      expect(r.status).toBe(403);
      expect(r.body).toEqual(ROOT_ONLY);
    }
    expect(h.sdkSend).not.toHaveBeenCalled();

    asUser(w.root);
    r = await readJson(await load(body));
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: { code: "NOT_FOUND", message: "No results found" } }); // reached the S3 listing
  });

  it("the demo preflight still answers first: a demo target is the same 403 for signed-out and root alike", async () => {
    const w = await gateWorld();
    const demo = await createProject(w.company.id, w.admin.id, { numPages: 5, isDemo: true } as never);
    const statuses: number[] = [];
    for (const actor of [null, w.root]) {
      actor ? asUser(actor) : signedOut();
      statuses.push((await run({ projectId: demo.publicId, modelId: w.model.id })).status);
      statuses.push((await load({ projectId: demo.publicId, modelId: w.model.id, modelName: "m" })).status);
    }
    expect(statuses).toEqual([403, 403, 403, 403]);
    expect(h.startYoloJob).not.toHaveBeenCalled();
    expect(h.sdkSend).not.toHaveBeenCalled();
  });
});
