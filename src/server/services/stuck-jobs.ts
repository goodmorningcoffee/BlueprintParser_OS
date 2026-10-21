// Admin › Data tools › Stuck jobs (admin data tools, feature 1). Thin routes under
// /api/admin/stuck-jobs delegate here.
//   GET    list running ingest + YOLO rows, active leases, live provider status (≤ 50 AWS
//          calls per request) and — root only — unlinked SageMaker compute reservations.
//   POST   reconcile  {projectPublicId} | {all:true}: provider-attested close (ingest-reconcile).
//   POST   stop       root: StopExecution on a hung ingest execution.
//   POST   force-release root: web-held leases only, authorised by typing the project name.
// Company admins see and act on their own company only; root sees all or `?companyId`.
// Demo projects are never listed or touched. Compute reservations are LISTED, never changed.

import { and, desc, eq, isNull, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  computeUsage,
  processingJobs,
  projectMutationLeases,
  projects,
} from "@/lib/db/schema";
import { audit } from "@/lib/audit";
import { getYoloJobStatus } from "@/lib/yolo";
import type { AuthSession } from "@/lib/api-utils";
import { ApiError, notFound } from "@/server/api/envelope";
import {
  assertProjectWritable,
  forceReleaseWebHeldLeases,
  isWebHeldLeaseKind,
} from "@/server/api/project-write-capability";
import { zPublicId } from "@/server/api/schemas";
import {
  decideIngestAction,
  describeIngestExecution,
  ownedExecutionName,
  reconcileIngestJob,
  stopIngestExecution,
  type IngestReconcileOutcome,
  type ProviderView,
} from "@/server/services/ingest-reconcile";
import {
  isSagemakerJobNotFound,
  YOLO_NEVER_STARTED_MIN_AGE_MS,
} from "@/server/services/running-jobs";

const MAX_PROVIDER_CALLS = 50;
const MAX_ROWS = 200;
/** Force release needs the holder gone: this process must have been up at least this long. */
export const FORCE_RELEASE_MIN_UPTIME_MS = 15 * 60_000;

export const zStuckJobsQuery = z.object({
  companyId: z.coerce.number().int().positive().optional(),
});
export const zStuckReconcileBody = z.union([
  z.object({ projectPublicId: zPublicId }).strict(),
  z.object({ all: z.literal(true), companyId: z.number().int().positive().optional() }).strict(),
]);
export const zStuckStopBody = z.object({ projectPublicId: zPublicId }).strict();
export const zStuckForceReleaseBody = z
  .object({ projectPublicId: zPublicId, confirmProjectName: z.string().min(1).max(255) })
  .strict();

/** Company scope: company admins are pinned to their own company; root may pick one or all. */
function scopeCompanyId(session: AuthSession, requested?: number): number | null {
  if (session.user.isRootAdmin) return requested ?? null;
  if (requested !== undefined && requested !== session.user.companyId) {
    throw new ApiError("FORBIDDEN", "Company admins can only use their own company");
  }
  return session.user.companyId;
}

function projectScope(companyId: number | null): SQL {
  const nonDemo = eq(projects.isDemo, false);
  return companyId === null ? nonDemo : and(nonDemo, eq(projects.companyId, companyId))!;
}

async function loadScopedProject(session: AuthSession, publicId: string) {
  const [project] = await db
    .select({
      id: projects.id,
      publicId: projects.publicId,
      name: projects.name,
      companyId: projects.companyId,
      isDemo: projects.isDemo,
      lifecycleEpoch: projects.lifecycleEpoch,
    })
    .from(projects)
    .where(and(eq(projects.publicId, publicId), projectScope(scopeCompanyId(session))))
    .limit(1);
  if (!project) throw notFound();
  return project;
}

function providerJson(view: ProviderView) {
  if (view.state === "terminal") {
    return {
      state: view.state,
      status: view.status,
      startDate: view.startDate.toISOString(),
      stopDate: view.stopDate.toISOString(),
      error: view.error,
    };
  }
  if (view.state === "running") {
    return { state: view.state, status: view.status, startDate: view.startDate?.toISOString() ?? null };
  }
  return view;
}

function outcomeJson(outcome: IngestReconcileOutcome) {
  return {
    jobId: outcome.jobId,
    projectPublicId: outcome.projectPublicId,
    executionName: outcome.executionName,
    provider: providerJson(outcome.provider),
    action: outcome.decision.action,
    changed: outcome.changed,
    jobClosedAs: outcome.jobClosedAs ?? null,
    projectStatusSet: outcome.projectStatusSet ?? null,
    leasesReclaimed: outcome.leasesReclaimed,
    leaseRefusal: outcome.leaseRefusal ?? null,
    message: outcome.message,
  };
}

async function runningJobRows(companyId: number | null, ingestOnly: boolean, projectId?: number) {
  const filters: SQL[] = [eq(processingJobs.status, "running"), projectScope(companyId)];
  if (ingestOnly) filters.push(isNull(processingJobs.modelConfig));
  if (projectId !== undefined) filters.push(eq(processingJobs.projectId, projectId));
  return db
    .select({
      id: processingJobs.id,
      projectId: processingJobs.projectId,
      executionId: processingJobs.executionId,
      modelConfig: processingJobs.modelConfig,
      startedAt: processingJobs.startedAt,
      error: processingJobs.error,
      projectPublicId: projects.publicId,
      projectName: projects.name,
      projectStatus: projects.status,
      companyId: projects.companyId,
      lifecycleEpoch: projects.lifecycleEpoch,
      isDemo: projects.isDemo,
    })
    .from(processingJobs)
    .innerJoin(projects, eq(projects.id, processingJobs.projectId))
    .where(and(...filters))
    .orderBy(processingJobs.startedAt)
    .limit(MAX_ROWS);
}

export async function listStuckJobs(
  session: AuthSession,
  query: z.infer<typeof zStuckJobsQuery>,
): Promise<unknown> {
  const companyId = scopeCompanyId(session, query.companyId);
  const nowMs = Date.now();
  const jobs = await runningJobRows(companyId, false);
  let providerCalls = 0;

  const ingest = [];
  const yolo = [];
  for (const job of jobs) {
    const base = {
      jobId: job.id,
      projectPublicId: job.projectPublicId,
      projectName: job.projectName,
      projectStatus: job.projectStatus,
      companyId: job.companyId,
      startedAt: job.startedAt?.toISOString() ?? null,
      error: job.error,
    };
    if (job.modelConfig === null) {
      const owned = ownedExecutionName(job.executionId) !== null;
      let provider: ProviderView = {
        state: "unavailable",
        reason: owned ? "AWS lookup budget for this request is used up" : "execution is not from this deployment's state machine",
      };
      if (owned && providerCalls < MAX_PROVIDER_CALLS) {
        providerCalls++;
        provider = await describeIngestExecution(job.executionId);
      }
      const decision = decideIngestAction(job, provider, nowMs);
      ingest.push({
        ...base,
        executionName: ownedExecutionName(job.executionId),
        provider: providerJson(provider),
        fixable: decision.action === "close" || decision.action === "close-never-started",
        verdict: "reason" in decision ? decision.reason : decision.action === "close" ? `Fix closes it as ${decision.jobStatus}` : "Fix closes it as never started",
      });
    } else {
      let providerStatus: string | null = null;
      let verdict = "AWS lookup budget for this request is used up";
      if (job.executionId && providerCalls < MAX_PROVIDER_CALLS) {
        providerCalls++;
        try {
          providerStatus = (await getYoloJobStatus(job.executionId)).status;
          verdict = `SageMaker reports ${providerStatus}`;
        } catch (error) {
          const ageMs = job.startedAt ? nowMs - job.startedAt.getTime() : Infinity;
          if (isSagemakerJobNotFound(error)) {
            providerStatus = "NotFound";
            verdict = ageMs >= YOLO_NEVER_STARTED_MIN_AGE_MS ? "SageMaker never accepted it; Fix closes it as failed" : "SageMaker has no such job yet";
          } else {
            verdict = "SageMaker lookup failed";
          }
        }
      }
      const modelConfig = job.modelConfig as { modelName?: unknown } | null;
      yolo.push({
        ...base,
        executionId: job.executionId,
        modelName: typeof modelConfig?.modelName === "string" ? modelConfig.modelName : null,
        providerStatus,
        fixable: providerStatus === "Completed" || providerStatus === "Failed" || providerStatus === "Stopped" || verdict.startsWith("SageMaker never accepted"),
        verdict,
      });
    }
  }

  const leaseRows = await db
    .select({
      token: projectMutationLeases.token,
      kind: projectMutationLeases.kind,
      createdAt: projectMutationLeases.createdAt,
      heartbeatAt: projectMutationLeases.heartbeatAt,
      expiresAt: projectMutationLeases.expiresAt,
      projectPublicId: projects.publicId,
      projectName: projects.name,
      companyId: projects.companyId,
    })
    .from(projectMutationLeases)
    .innerJoin(projects, eq(projects.id, projectMutationLeases.projectId))
    .where(and(eq(projectMutationLeases.status, "active"), projectScope(companyId)))
    .orderBy(projectMutationLeases.createdAt)
    .limit(MAX_ROWS);
  const leases = leaseRows.map((lease) => ({
    kind: lease.kind,
    tokenPrefix: lease.token.slice(0, 8),
    projectPublicId: lease.projectPublicId,
    projectName: lease.projectName,
    companyId: lease.companyId,
    createdAt: lease.createdAt.toISOString(),
    heartbeatAt: lease.heartbeatAt.toISOString(),
    heartbeatStale: lease.expiresAt.getTime() < nowMs,
    ageMinutes: Math.floor((nowMs - lease.createdAt.getTime()) / 60_000),
    holder: isWebHeldLeaseKind(lease.kind) ? "web" : lease.kind === "project-processing" ? "worker" : "other",
  }));

  let unlinkedReservations: unknown[] | null = null;
  if (session.user.isRootAdmin) {
    const reservationScope: SQL[] = [eq(computeUsage.resource, "sagemaker"), isNull(computeUsage.jobId)];
    if (companyId !== null) reservationScope.push(eq(computeUsage.companyId, companyId));
    const rows = await db
      .select({
        id: computeUsage.id,
        companyId: computeUsage.companyId,
        projectId: computeUsage.projectId,
        projectPublicId: projects.publicId,
        pages: computeUsage.pages,
        createdAt: computeUsage.createdAt,
      })
      .from(computeUsage)
      .leftJoin(projects, eq(projects.id, computeUsage.projectId))
      .where(and(...reservationScope))
      .orderBy(desc(computeUsage.createdAt))
      .limit(MAX_ROWS);
    unlinkedReservations = rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
  }

  return {
    generatedAt: new Date(nowMs).toISOString(),
    scope: { companyId, root: session.user.isRootAdmin },
    providerCalls,
    ingest,
    yolo,
    leases,
    unlinkedReservations,
  };
}

export async function reconcileStuckJobs(
  session: AuthSession,
  body: z.infer<typeof zStuckReconcileBody>,
): Promise<unknown> {
  let targets;
  if ("projectPublicId" in body) {
    const project = await loadScopedProject(session, body.projectPublicId);
    targets = await runningJobRows(scopeCompanyId(session), true, project.id);
  } else {
    targets = await runningJobRows(scopeCompanyId(session, body.companyId), true);
  }
  const outcomes = [];
  const skipped = [];
  let providerCalls = 0;
  for (const job of targets) {
    if (!ownedExecutionName(job.executionId)) {
      skipped.push({ jobId: job.id, projectPublicId: job.projectPublicId, reason: "execution is not from this deployment's state machine" });
      continue;
    }
    if (providerCalls >= MAX_PROVIDER_CALLS) {
      skipped.push({ jobId: job.id, projectPublicId: job.projectPublicId, reason: "AWS lookup budget for this request is used up; run again" });
      continue;
    }
    providerCalls++;
    const capability = assertProjectWritable({
      id: job.projectId,
      publicId: job.projectPublicId,
      companyId: job.companyId,
      isDemo: job.isDemo,
      lifecycleEpoch: job.lifecycleEpoch,
    });
    try {
      outcomes.push(outcomeJson(await reconcileIngestJob(job, job.projectPublicId, capability)));
    } catch (error) {
      skipped.push({
        jobId: job.id,
        projectPublicId: job.projectPublicId,
        reason: error instanceof ApiError ? error.message : "reconcile failed; try again",
      });
    }
  }
  const changed = outcomes.filter((outcome) => outcome.changed);
  if (changed.length > 0) {
    audit("admin.stuck_jobs.reconcile", {
      userId: session.user.dbId,
      companyId: session.user.companyId,
      details: {
        closed: changed.map((outcome) => ({
          jobId: outcome.jobId,
          projectPublicId: outcome.projectPublicId,
          as: outcome.jobClosedAs,
          leasesReclaimed: outcome.leasesReclaimed,
        })),
      },
    });
  }
  return { outcomes, skipped };
}

export async function stopStuckExecution(
  session: AuthSession,
  body: z.infer<typeof zStuckStopBody>,
): Promise<unknown> {
  if (!session.user.isRootAdmin) throw new ApiError("FORBIDDEN", "Root only");
  const project = await loadScopedProject(session, body.projectPublicId);
  const [job] = await runningJobRows(null, true, project.id);
  if (!job) throw new ApiError("NOT_FOUND", "No running ingest job for this project");
  const provider = await describeIngestExecution(job.executionId);
  if (provider.state !== "running") {
    throw new ApiError("CONFLICT", provider.state === "unavailable" ? provider.reason : `Execution is not running (${provider.state})`);
  }
  const result = await stopIngestExecution(job.executionId);
  if (!result.stopped) throw new ApiError("CONFLICT", result.reason ?? "StopExecution failed");
  audit("admin.stuck_jobs.stop", {
    userId: session.user.dbId,
    companyId: session.user.companyId,
    details: { projectPublicId: project.publicId, jobId: job.id, executionName: ownedExecutionName(job.executionId) },
  });
  return { stopped: true, message: "Stop requested; Fix closes the job once AWS reports it stopped (3-minute grace)" };
}

export async function forceReleaseStuckLeases(
  session: AuthSession,
  body: z.infer<typeof zStuckForceReleaseBody>,
): Promise<unknown> {
  if (!session.user.isRootAdmin) throw new ApiError("FORBIDDEN", "Root only");
  const project = await loadScopedProject(session, body.projectPublicId);
  if (body.confirmProjectName.trim() !== project.name.trim()) {
    throw new ApiError("VALIDATION", "Type the project name exactly to confirm");
  }
  const uptimeMs = process.uptime() * 1000;
  if (uptimeMs < FORCE_RELEASE_MIN_UPTIME_MS) {
    throw new ApiError("CONFLICT", "This server started less than 15 minutes ago; retry later so in-flight work cannot be cut off");
  }
  const heldBefore = new Date(Date.now() - uptimeMs);
  const result = await forceReleaseWebHeldLeases(assertProjectWritable(project), heldBefore);
  const nowMs = Date.now();
  const summarize = (lease: { kind: string; tokenPrefix: string; createdAt: Date }) => ({
    kind: lease.kind,
    tokenPrefix: lease.tokenPrefix,
    ageMinutes: Math.floor((nowMs - lease.createdAt.getTime()) / 60_000),
  });
  audit("admin.stuck_jobs.force_release", {
    userId: session.user.dbId,
    companyId: session.user.companyId,
    details: {
      projectPublicId: project.publicId,
      released: result.released.map(summarize),
      refused: result.refused.map((lease) => ({ ...summarize(lease), reason: lease.reason })),
      uptimeMinutes: Math.floor(uptimeMs / 60_000),
    },
  });
  return {
    released: result.released.map(summarize),
    refused: result.refused.map((lease) => ({ ...summarize(lease), reason: lease.reason })),
  };
}

