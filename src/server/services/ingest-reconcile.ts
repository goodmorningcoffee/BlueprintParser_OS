// Provider-aware reconciliation of ingest processing jobs (admin data tools, feature 1).
//
// A crashed/killed worker leaves `processing_jobs.status='running'` and its `project-processing`
// mutation lease behind forever, and project delete refuses on both. This module asks Step
// Functions (DescribeExecution) what actually happened and closes only what AWS attests:
//   • SUCCEEDED/FAILED/TIMED_OUT/ABORTED with stopDate ≥ TERMINAL_GRACE_MS old → close the job,
//     settle a still-"processing" project, and reclaim the worker lease ONLY under the ownership
//     proof below.
//   • ExecutionDoesNotExist and the row ≥ NEVER_STARTED_MIN_AGE_MS old → close as never started;
//     no lease action (nothing proves who holds one).
//   • RUNNING / unknown / any AWS error → no change (fail closed).
// Lease ownership proof (the lease carries no execution identity): (a) the project has exactly one
// ingest row and it is this row; (b) projects.jobId equals the execution name; (c) the lease was
// created inside [startDate, stopDate] (applied in TypeScript; the lease SELECT has no time
// predicate, so every active-lease WHERE stays fail-closed for check:project-security-policy).
// ⚠ Never log or persist the execution `input` (it carries the webhook secret) or the provider
// `cause` (an ECS runTask failure cause embeds the task's container overrides).

import { and, eq, isNull } from "drizzle-orm";
import {
  DescribeExecutionCommand,
  SFNClient,
  StopExecutionCommand,
} from "@aws-sdk/client-sfn";
import { db } from "@/lib/db";
import {
  processingJobs,
  projectMutationLeases,
  projects,
} from "@/lib/db/schema";
import {
  withProjectWrite,
  type ProjectWriteCapability,
} from "@/server/api/project-write-capability";

export const TERMINAL_GRACE_MS = 3 * 60_000;
export const NEVER_STARTED_MIN_AGE_MS = 15 * 60_000;
const ERROR_MAX_CHARS = 200;

export type TerminalExecutionStatus =
  | "SUCCEEDED"
  | "FAILED"
  | "TIMED_OUT"
  | "ABORTED";
const TERMINAL_STATUSES = new Set<string>([
  "SUCCEEDED",
  "FAILED",
  "TIMED_OUT",
  "ABORTED",
]);

export type ProviderView =
  | {
      state: "terminal";
      status: TerminalExecutionStatus;
      startDate: Date;
      stopDate: Date;
      error: string | null;
    }
  | { state: "running"; status: string; startDate: Date | null }
  | { state: "missing" }
  | { state: "unavailable"; reason: string };

export interface IngestJobRef {
  id: number;
  projectId: number;
  executionId: string | null;
  startedAt: Date | null;
}

export type IngestDecision =
  | { action: "close"; jobStatus: "completed" | "failed"; error: string | null }
  | { action: "close-never-started" }
  | { action: "wait"; reason: string }
  | { action: "none"; reason: string };

export interface IngestReconcileOutcome {
  jobId: number;
  projectPublicId: string;
  executionName: string | null;
  provider: ProviderView;
  decision: IngestDecision;
  changed: boolean;
  jobClosedAs?: "completed" | "failed";
  projectStatusSet?: "completed" | "error";
  leasesReclaimed: number;
  leaseRefusal?: string;
  message: string;
}

let sfnClient: SFNClient | null = null;
function sfn(): SFNClient {
  sfnClient ??= new SFNClient({ region: process.env.AWS_REGION || "us-east-1" });
  return sfnClient;
}

/** `arn:…:execution:<machine>:` for this deployment's state machine, or null when unconfigured. */
export function executionArnPrefix(): string | null {
  const machine = process.env.STEP_FUNCTION_ARN;
  if (!machine || !machine.includes(":stateMachine:")) return null;
  return `${machine.replace(":stateMachine:", ":execution:")}:`;
}

/** The execution name for an ARN owned by this deployment's state machine, else null. */
export function ownedExecutionName(executionArn: string | null): string | null {
  const prefix = executionArnPrefix();
  if (!prefix || !executionArn || !executionArn.startsWith(prefix)) return null;
  const name = executionArn.slice(prefix.length);
  return name && !name.includes(":") ? name : null;
}

function errorName(error: unknown): string {
  if (error && typeof error === "object" && "name" in error) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string" && name) return name.slice(0, 80);
  }
  return "Error";
}

/** Ask Step Functions about one execution. Never throws; never returns `input` or `cause`. */
export async function describeIngestExecution(
  executionArn: string | null,
): Promise<ProviderView> {
  if (!ownedExecutionName(executionArn)) {
    return {
      state: "unavailable",
      reason: "execution is not from this deployment's state machine",
    };
  }
  try {
    const out = await sfn().send(
      new DescribeExecutionCommand({ executionArn: executionArn! }),
    );
    const status = typeof out.status === "string" ? out.status : "UNKNOWN";
    const startDate = out.startDate instanceof Date ? out.startDate : null;
    const stopDate = out.stopDate instanceof Date ? out.stopDate : null;
    if (TERMINAL_STATUSES.has(status)) {
      if (!startDate || !stopDate) {
        return { state: "unavailable", reason: `AWS reported ${status} without dates` };
      }
      return {
        state: "terminal",
        status: status as TerminalExecutionStatus,
        startDate,
        stopDate,
        error: typeof out.error === "string" ? out.error.slice(0, 120) : null,
      };
    }
    return { state: "running", status, startDate };
  } catch (error) {
    const name = errorName(error);
    if (name === "ExecutionDoesNotExist") return { state: "missing" };
    if (name === "AccessDeniedException") {
      return {
        state: "unavailable",
        reason:
          "AWS refused DescribeExecution (AccessDeniedException): the web task role needs states:DescribeExecution",
      };
    }
    return { state: "unavailable", reason: `AWS lookup failed (${name})` };
  }
}

/** Root-only operator stop of a hung execution; the next reconcile closes it after the grace. */
export async function stopIngestExecution(
  executionArn: string | null,
): Promise<{ stopped: boolean; reason?: string }> {
  if (!ownedExecutionName(executionArn)) {
    return { stopped: false, reason: "execution is not from this deployment's state machine" };
  }
  try {
    await sfn().send(
      new StopExecutionCommand({
        executionArn: executionArn!,
        error: "OperatorStopped",
        cause: "Stopped by a root admin from Admin > Data tools > Stuck jobs",
      }),
    );
    return { stopped: true };
  } catch (error) {
    return { stopped: false, reason: `AWS StopExecution failed (${errorName(error)})` };
  }
}

/** Pure decision table (tested exhaustively). */
export function decideIngestAction(
  job: Pick<IngestJobRef, "startedAt">,
  provider: ProviderView,
  nowMs: number,
): IngestDecision {
  if (provider.state === "terminal") {
    const sinceStop = nowMs - provider.stopDate.getTime();
    if (sinceStop < TERMINAL_GRACE_MS) {
      return {
        action: "wait",
        reason: `AWS ${provider.status} at ${provider.stopDate.toISOString()}; closing after a ${TERMINAL_GRACE_MS / 60_000}-minute grace`,
      };
    }
    if (provider.status === "SUCCEEDED") {
      return { action: "close", jobStatus: "completed", error: null };
    }
    const detail = provider.error ? `: ${provider.error}` : "";
    return {
      action: "close",
      jobStatus: "failed",
      error: `AWS execution ${provider.status}${detail}`.slice(0, ERROR_MAX_CHARS),
    };
  }
  if (provider.state === "missing") {
    const age = job.startedAt ? nowMs - job.startedAt.getTime() : Infinity;
    if (age >= NEVER_STARTED_MIN_AGE_MS) return { action: "close-never-started" };
    return { action: "wait", reason: "AWS has no such execution yet; the row is too young to close" };
  }
  if (provider.state === "running") {
    const since = provider.startDate ? ` since ${provider.startDate.toISOString()}` : "";
    return { action: "none", reason: `still ${provider.status} on AWS${since}` };
  }
  return { action: "none", reason: provider.reason };
}

function describeOutcome(outcome: Omit<IngestReconcileOutcome, "message">): string {
  if (!outcome.changed) {
    return "reason" in outcome.decision ? outcome.decision.reason : "no change";
  }
  const parts = [`job closed as ${outcome.jobClosedAs}`];
  if (outcome.projectStatusSet) parts.push(`project marked ${outcome.projectStatusSet}`);
  if (outcome.leasesReclaimed > 0) parts.push(`${outcome.leasesReclaimed} worker lease released`);
  if (outcome.leaseRefusal) parts.push(`lease kept: ${outcome.leaseRefusal}`);
  return parts.join("; ");
}

/**
 * Reconcile ONE ingest job. The AWS lookup happens before (never inside) the project transaction.
 * Idempotent: a job already closed by the webhook or a concurrent reconcile is left alone.
 */
export async function reconcileIngestJob(
  job: IngestJobRef,
  projectPublicId: string,
  capability: ProjectWriteCapability,
  nowMs: number = Date.now(),
): Promise<IngestReconcileOutcome> {
  const executionName = ownedExecutionName(job.executionId);
  const provider = await describeIngestExecution(job.executionId);
  const decision = decideIngestAction(job, provider, nowMs);
  const base = {
    jobId: job.id,
    projectPublicId,
    executionName,
    provider,
    decision,
    changed: false,
    leasesReclaimed: 0,
  };
  if (decision.action !== "close" && decision.action !== "close-never-started") {
    return { ...base, message: describeOutcome(base) };
  }

  const result = await withProjectWrite(capability, job.projectId, async (tx) => {
    const [live] = await tx
      .select({ id: processingJobs.id })
      .from(processingJobs)
      .where(
        and(
          eq(processingJobs.id, job.id),
          eq(processingJobs.projectId, job.projectId),
          eq(processingJobs.status, "running"),
          isNull(processingJobs.modelConfig),
        ),
      )
      .limit(1);
    if (!live) {
      return { ...base, decision: { action: "none", reason: "job already closed" } as IngestDecision };
    }

    const jobStatus = decision.action === "close" ? decision.jobStatus : "failed";
    const jobError =
      decision.action === "close" ? decision.error : "Step Functions execution never started";
    await tx
      .update(processingJobs)
      .set({ status: jobStatus, completedAt: new Date(), error: jobError })
      .where(and(eq(processingJobs.id, job.id), eq(processingJobs.status, "running")));

    const [project] = await tx
      .select({ status: projects.status, jobId: projects.jobId })
      .from(projects)
      .where(eq(projects.id, job.projectId))
      .limit(1);
    let projectStatusSet: "completed" | "error" | undefined;
    if (project?.status === "processing") {
      projectStatusSet = jobStatus === "completed" ? "completed" : "error";
      await tx
        .update(projects)
        .set({
          status: projectStatusSet,
          updatedAt: new Date(),
          ...(jobError ? { processingError: jobError } : {}),
        })
        .where(eq(projects.id, job.projectId));
    }

    // Lease reclaim — only for a provider-terminal close, and only under all three ownership
    // proofs. The SELECT has no time predicate (expiry is diagnostic only); proof (c), the
    // [startDate, stopDate] window, is applied in TypeScript and the row is deleted by token.
    let leasesReclaimed = 0;
    let leaseRefusal: string | undefined;
    if (decision.action === "close" && provider.state === "terminal") {
      const workerLeases = await tx
        .select({
          token: projectMutationLeases.token,
          createdAt: projectMutationLeases.createdAt,
          lifecycleEpoch: projectMutationLeases.lifecycleEpoch,
        })
        .from(projectMutationLeases)
        .where(
          and(
            eq(projectMutationLeases.projectId, job.projectId),
            eq(projectMutationLeases.kind, "project-processing"),
            eq(projectMutationLeases.status, "active"),
          ),
        );
      if (workerLeases.length > 0) {
        const ingestRows = await tx
          .select({ id: processingJobs.id })
          .from(processingJobs)
          .where(
            and(
              eq(processingJobs.projectId, job.projectId),
              isNull(processingJobs.modelConfig),
            ),
          );
        const start = provider.startDate.getTime();
        const stop = provider.stopDate.getTime();
        const owned = workerLeases.filter((lease) => {
          const created = lease.createdAt.getTime();
          return (
            created >= start &&
            created <= stop &&
            lease.lifecycleEpoch === capability.lifecycleEpoch
          );
        });
        if (ingestRows.length !== 1 || ingestRows[0].id !== job.id) {
          leaseRefusal = `project has ${ingestRows.length} ingest jobs, so the lease cannot be tied to this execution`;
        } else if (!executionName || project?.jobId !== executionName) {
          leaseRefusal = "the project's current job id is not this execution";
        } else {
          for (const lease of owned) {
            await tx
              .delete(projectMutationLeases)
              .where(
                and(
                  eq(projectMutationLeases.token, lease.token),
                  eq(projectMutationLeases.projectId, job.projectId),
                ),
              );
          }
          leasesReclaimed = owned.length;
          if (owned.length < workerLeases.length) {
            leaseRefusal = "a worker lease was created outside this execution's run window or lifecycle generation";
          }
        }
      }
    }
    return {
      ...base,
      changed: true,
      jobClosedAs: jobStatus,
      projectStatusSet,
      leasesReclaimed,
      leaseRefusal,
    };
  });
  return { ...result, message: describeOutcome(result) };
}

/**
 * Best-effort pre-delete reconcile of every running ingest job of one project. Never throws: an
 * AWS or DB failure here leaves the delete's own fail-closed refusal in charge.
 */
export async function reconcileProjectIngestJobs(
  projectId: number,
  capability: ProjectWriteCapability,
): Promise<IngestReconcileOutcome[]> {
  try {
    const jobs = await db
      .select({
        id: processingJobs.id,
        projectId: processingJobs.projectId,
        executionId: processingJobs.executionId,
        startedAt: processingJobs.startedAt,
      })
      .from(processingJobs)
      .where(
        and(
          eq(processingJobs.projectId, projectId),
          eq(processingJobs.status, "running"),
          isNull(processingJobs.modelConfig),
        ),
      )
      .limit(5);
    const outcomes: IngestReconcileOutcome[] = [];
    for (const job of jobs) {
      if (!ownedExecutionName(job.executionId)) continue;
      outcomes.push(await reconcileIngestJob(job, capability.publicId, capability));
    }
    return outcomes;
  } catch {
    return [];
  }
}
