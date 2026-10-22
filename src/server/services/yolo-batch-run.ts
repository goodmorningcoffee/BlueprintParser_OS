// [2026-10-22 owner: "take full advantage of the larger GPU and its larger quota"] POST /api/yolo/run-batch
// (auth "root" — the owner wants all YOLO run/load root-only; the single-run route is unchanged here).
// ONE SageMaker processing job for up to 9 projects (lib/yolo startYoloBatchJob), but every project keeps
// its own processing_jobs row (same execution_id, its own status), so per-project Load, auto-load (bulk
// queue + running-jobs catch-up), Stuck jobs and the running-jobs view work row by row. No schema change:
// processing_jobs.execution_id has no unique index.
//
// The single run's guards hold PER PROJECT, and a project that fails one is reported as refused while the
// rest of the batch still runs:
//   • company-scoped lookup (no root bypass, YQ-1a) · writable (demo projects are read-only)
//   • known page count · page_0001.png present
//   • lease `yolo-run` keyed `${project.id}:${modelId}` (a busy project is refused, not waited on)
//   • SageMaker page-cap reservation for non-root callers (root: usage recorded after the start)
// Batch-wide: canRunModels, the SageMaker toggle (read fresh), the daily YOLO job quota counted as N
// project-runs (root exempt, as in checkYoloQuota), model access + canonical storage path.
// Start-failure semantics match yoloRun: rows + reservations are retired only when SageMaker confirms
// no job exists; otherwise the rows stay as fail-closed "outcome unknown" intents.

import { z } from "zod";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { db } from "@/lib/db";
import { modelAccess, models, processingJobs, projects } from "@/lib/db/schema";
import type { AuthSession } from "@/lib/api-utils";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { getToggles } from "@/lib/toggles";
import { checkYoloQuota } from "@/lib/quotas";
import { s3Client, S3_BUCKET, uploadToS3 } from "@/lib/s3";
import { isCanonicalModelStoragePath } from "@/lib/model-storage-authority";
import { yoloRunConfigYaml } from "@/lib/yolo-config-yaml";
import {
  MAX_YOLO_BATCH_PROJECTS,
  YoloStartRefusedError,
  createYoloJobName,
  startYoloBatchJob,
} from "@/lib/yolo";
import {
  recordComputeUsage,
  releaseReservation,
  reserveSagemakerPages,
  stampReservationJob,
} from "@/lib/compute-usage";
import { ApiError } from "@/server/api/envelope";
import { zPublicId } from "@/server/api/schemas";
import {
  assertProjectWritable,
  withProjectMutationLease,
  withProjectWrites,
  type ProjectWriteCapability,
} from "@/server/api/project-write-capability";

export const zYoloRunBatchBody = z
  .object({
    modelId: z.number().int().positive(),
    projectIds: z.array(zPublicId).min(1).max(MAX_YOLO_BATCH_PROJECTS),
  })
  .strict();
export type YoloRunBatchBody = z.infer<typeof zYoloRunBatchBody>;

export interface YoloBatchProjectOutcome {
  projectId: string;
  status: "running" | "refused";
  error?: string;
  /** The HTTP status the single run would have answered for this refusal. */
  httpStatus?: number;
}

export interface YoloRunBatchResult {
  jobName: string;
  status: "running";
  projects: YoloBatchProjectOutcome[];
}

const HTTP: Record<string, number> = {
  VALIDATION: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
};

type ProjectRow = typeof projects.$inferSelect;

interface Candidate {
  project: ProjectRow;
  capability: ProjectWriteCapability;
  pages: number;
  reservationId?: number;
}

function refusal(projectId: string, err: unknown): YoloBatchProjectOutcome {
  if (err instanceof ApiError) {
    return { projectId, status: "refused", error: err.message, httpStatus: HTTP[err.code] ?? 500 };
  }
  logger.error("[yolo-batch] project refused by an unexpected error", { projectId, error: String(err).slice(0, 300) });
  return { projectId, status: "refused", error: "Unexpected error", httpStatus: 500 };
}

/** Hold the `yolo-run` lease of every candidate (ascending project id) around `fn`; a busy one is refused. */
async function withRunLeases<T>(
  candidates: readonly Candidate[],
  modelId: number,
  refuse: (c: Candidate, err: unknown) => void,
  fn: (held: Candidate[]) => Promise<T>,
  index = 0,
  held: Candidate[] = [],
): Promise<T> {
  if (index >= candidates.length) return fn(held);
  const c = candidates[index];
  let entered = false;
  try {
    return await withProjectMutationLease(
      c.capability,
      { kind: "yolo-run", idempotencyKey: `${c.project.id}:${modelId}` },
      async () => {
        entered = true;
        return withRunLeases(candidates, modelId, refuse, fn, index + 1, [...held, c]);
      },
    );
  } catch (err) {
    if (entered) throw err;
    refuse(c, err);
    return withRunLeases(candidates, modelId, refuse, fn, index + 1, held);
  }
}

async function resolveModel(modelId: number, session: AuthSession) {
  const [model] = await db.select().from(models).where(eq(models.id, modelId)).limit(1);
  if (!model) throw new ApiError("NOT_FOUND", "Model not found");
  const companyId = session.user.companyId;
  if (model.companyId !== companyId) {
    const [access] = await db
      .select()
      .from(modelAccess)
      .where(
        and(
          eq(modelAccess.modelId, modelId),
          eq(modelAccess.companyId, companyId),
          eq(modelAccess.enabled, true),
          or(isNull(modelAccess.userId), eq(modelAccess.userId, session.user.dbId)),
        ),
      )
      .limit(1);
    if (!access) throw new ApiError("NOT_FOUND", "Model not found"); // same message — no existence leak
  }
  return model;
}

export async function yoloRunBatch(body: YoloRunBatchBody, session: AuthSession): Promise<YoloRunBatchResult> {
  if (!session.user.canRunModels) {
    throw new ApiError("FORBIDDEN", "You don't have permission to run models. Ask your admin to enable it.");
  }
  const toggles = await getToggles(true);
  if (!toggles.sagemakerEnabled) {
    throw new ApiError("FORBIDDEN", "SageMaker is disabled by admin. Enable it in Admin > Toggles.");
  }
  const requested = [...new Set(body.projectIds)];
  if (toggles.quotaEnabled) {
    // A batch is N project-runs against the daily job quota (root exempt inside checkYoloQuota).
    const quota = await checkYoloQuota(session.user.companyId, session.user.isRootAdmin, session.user.dbId);
    if (!quota.allowed) throw new ApiError("RATE_LIMITED", quota.message as string);
    if (typeof quota.limit === "number" && typeof quota.current === "number" && quota.current + requested.length > quota.limit) {
      throw new ApiError(
        "RATE_LIMITED",
        `Daily YOLO job limit reached (${quota.limit}/day): this batch needs ${requested.length}, ${Math.max(0, quota.limit - quota.current)} left`,
      );
    }
  }

  const model = await resolveModel(body.modelId, session);
  // A model path is a server-write capability (as in yoloRun): never redirect config.yaml or the
  // SageMaker model input through a legacy/corrupt row.
  if (!isCanonicalModelStoragePath(model.name, model.s3Path)) {
    throw new ApiError("CONFLICT", "Model storage path requires reconciliation");
  }
  const outcomes = new Map<string, YoloBatchProjectOutcome>();
  const refuse = (projectId: string, err: unknown) => outcomes.set(projectId, refusal(projectId, err));

  const rows = await db
    .select()
    .from(projects)
    .where(and(inArray(projects.publicId, requested), eq(projects.companyId, session.user.companyId)));
  const byPublicId = new Map(rows.map((p) => [p.publicId, p]));
  const candidates: Candidate[] = [];
  for (const projectId of requested) {
    const project = byPublicId.get(projectId);
    try {
      if (!project) throw new ApiError("NOT_FOUND", "Project not found");
      const capability = assertProjectWritable(project);
      const pages = project.numPages ?? 0;
      if (pages <= 0) {
        throw new ApiError("VALIDATION", "Project page count is unknown. Reprocess the project before running models.");
      }
      try {
        await s3Client.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: `${project.dataUrl}/pages/page_0001.png` }));
      } catch {
        throw new ApiError(
          "VALIDATION",
          "Page images not found. The project needs to be processed first (or reprocessed if it was uploaded before the image pipeline was added).",
        );
      }
      candidates.push({ project, capability, pages });
    } catch (err) {
      refuse(projectId, err);
    }
  }
  const firstRefusal = () => {
    const first = [...outcomes.values()][0];
    const code = Object.entries(HTTP).find(([, status]) => status === first?.httpStatus)?.[0] ?? "VALIDATION";
    return new ApiError(code as "VALIDATION", first?.error ?? "No project in this batch can run");
  };
  if (candidates.length === 0) throw firstRefusal();

  await uploadToS3(`${model.s3Path}/config.yaml`, Buffer.from(yoloRunConfigYaml(model.config)), "text/yaml");

  candidates.sort((a, b) => a.project.id - b.project.id);
  const jobName = await withRunLeases(candidates, model.id, (c, err) => refuse(c.project.publicId, err), async (held) => {
    // Page-cap reservations (root bypasses the cap; its usage is recorded after the start).
    const running: Candidate[] = [];
    for (const c of held) {
      if (session.user.isRootAdmin) {
        running.push(c);
        continue;
      }
      const cap = await reserveSagemakerPages(session.user.companyId, session.user.dbId, c.project.id, c.pages);
      if (!cap.allowed) {
        audit("yolo_cap_hit", {
          userId: session.user.dbId,
          companyId: session.user.companyId,
          details: { projectId: c.project.publicId, capHit: cap.capHit, pagesToCharge: c.pages, batch: true },
        });
        refuse(c.project.publicId, new ApiError("RATE_LIMITED", cap.message as string));
        continue;
      }
      c.reservationId = cap.reservationId;
      running.push(c);
    }
    const releaseAll = async () => {
      for (const c of running) {
        if (c.reservationId === undefined) continue;
        await releaseReservation(c.reservationId).catch((e) => logger.error("compute_usage reservation rollback failed:", e));
      }
    };
    if (running.length === 0) throw firstRefusal();

    const name = createYoloJobName(model.name);
    const batchPages = running.reduce((sum, c) => sum + c.pages, 0);
    let rowIds: number[];
    try {
      rowIds = await withProjectWrites(
        running.map((c) => c.capability),
        async (tx) => {
          const inserted = await tx
            .insert(processingJobs)
            .values(
              running.map((c) => ({
                projectId: c.project.id,
                executionId: name,
                status: "running" as const,
                modelConfig: { modelId: model.id, modelName: model.name, batchPages, batchProjects: running.length },
              })),
            )
            .returning({ id: processingJobs.id });
          if (inserted.length !== running.length) throw new Error("Failed to create YOLO job intents");
          return inserted.map((r) => r.id);
        },
      );
    } catch (err) {
      await releaseAll();
      throw err;
    }

    try {
      // Slot order = `running` order; each project's S3 input/output is its own.
      await startYoloBatchJob(running.map((c) => c.project.dataUrl), model.s3Path, model.name, name);
    } catch (err) {
      const refused = err instanceof YoloStartRefusedError && err.confirmedAbsent;
      const retired = await withProjectWrites(running.map((c) => c.capability), async (tx) => {
        if (refused) await tx.delete(processingJobs).where(inArray(processingJobs.id, rowIds));
        else await tx.update(processingJobs).set({ error: "SageMaker start outcome unknown" }).where(inArray(processingJobs.id, rowIds));
        return refused;
      }).catch((jobError) => {
        logger.error("YOLO batch job intent uncertainty update failed:", jobError);
        return false;
      });
      if (retired) await releaseAll();
      logger.error("YOLO batch job start failed:", err);
      throw err instanceof ApiError ? err : new ApiError("INTERNAL", "Failed to start SageMaker job");
    }

    for (const c of running) {
      try {
        if (c.reservationId !== undefined) await stampReservationJob(c.reservationId, name);
        else {
          await recordComputeUsage({
            companyId: session.user.companyId,
            userId: session.user.dbId,
            projectId: c.project.id,
            resource: "sagemaker",
            pages: c.pages,
            jobId: name,
          });
        }
      } catch (usageErr) {
        logger.error("compute_usage persist failed (job already started):", usageErr);
      }
      outcomes.set(c.project.publicId, { projectId: c.project.publicId, status: "running" });
    }
    audit("yolo_job_started", {
      userId: session.user.dbId,
      companyId: session.user.companyId,
      details: { batch: true, modelId: model.id, jobName: name, pages: batchPages, projectIds: running.map((c) => c.project.publicId) },
    });
    return name;
  });

  return {
    jobName,
    status: "running",
    projects: requested.map((projectId) => outcomes.get(projectId) ?? { projectId, status: "refused", error: "Not started", httpStatus: 409 }),
  };
}
