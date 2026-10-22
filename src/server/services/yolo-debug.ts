// [2026-10-22 owner: "add a debug statement printer I can copy and paste from the /admin AI Models tab"]
// GET /api/admin/yolo-debug?jobName=… (auth "root") — the server half of the AI Models debug report
// (src/app/admin/tabs/YoloDebugReport.tsx): for one SageMaker job name,
//   • every processing_jobs row under it (a batched job has one per project), with the project's
//     active mutation leases and the compute_usage rows stamped with the job,
//   • the YOLO image digest the app launches (account id redacted),
//   • the last ~100 CloudWatch lines of the job (/aws/sagemaker/ProcessingJobs) through Logs Insights —
//     the web task role holds logs:StartQuery/GetQueryResults on "*" (iam.tf
//     beaver_ecs_task_observability); a refusal is reported with the CLI command the owner can run.
// Read-only. Never throws past input validation: each part degrades to an explanation.

import { z } from "zod";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import {
  CloudWatchLogsClient,
  GetQueryResultsCommand,
  StartQueryCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { db } from "@/lib/db";
import { computeUsage, processingJobs, projectMutationLeases, projects } from "@/lib/db/schema";
import type { AuthSession } from "@/lib/api-utils";

export const SAGEMAKER_PROCESSING_LOG_GROUP = "/aws/sagemaker/ProcessingJobs";
const LOG_LINES = 100;
const QUERY_WAIT_MS = 12_000;

export const zYoloDebugQuery = z.object({
  jobName: z.string().regex(/^[a-zA-Z0-9](-*[a-zA-Z0-9]){0,62}$/u, "jobName must be a SageMaker job name"),
});

export interface YoloDebugLogs {
  readable: boolean;
  lines?: string[];
  reason?: string;
  command: string;
}

let client: CloudWatchLogsClient | null = null;
const logsClient = () => (client ??= new CloudWatchLogsClient({ region: process.env.AWS_REGION || "us-east-1" }));

export function yoloLogsCommand(jobName: string): string {
  return `aws logs tail ${SAGEMAKER_PROCESSING_LOG_GROUP} --log-stream-name-prefix ${jobName} --since 1d`;
}

/** Last LOG_LINES lines of the job's log streams, oldest first; or why they cannot be read. */
export async function readYoloJobLogs(
  jobName: string,
  startedAt: Date | null,
  deps: { send?: (cmd: unknown) => Promise<any>; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<YoloDebugLogs> {
  const command = yoloLogsCommand(jobName);
  const send = deps.send ?? ((cmd: unknown) => logsClient().send(cmd as StartQueryCommand));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  try {
    const endSec = Math.floor(now() / 1000);
    const startSec = startedAt ? Math.floor(startedAt.getTime() / 1000) - 600 : endSec - 86_400;
    const { queryId } = await send(
      new StartQueryCommand({
        logGroupName: SAGEMAKER_PROCESSING_LOG_GROUP,
        startTime: Math.max(startSec, endSec - 30 * 86_400),
        endTime: endSec,
        queryString: `fields @timestamp, @message | filter @logStream like "${jobName}/" | sort @timestamp desc | limit ${LOG_LINES}`,
        limit: LOG_LINES,
      }),
    );
    if (!queryId) return { readable: false, reason: "CloudWatch returned no query id", command };
    const deadline = now() + QUERY_WAIT_MS;
    while (now() < deadline) {
      await sleep(500);
      const r = await send(new GetQueryResultsCommand({ queryId }));
      if (r.status === "Complete") {
        const rows: Array<Array<{ field?: string; value?: string }>> = r.results ?? [];
        const lines = rows
          .map((fields) => {
            const get = (f: string) => fields.find((x) => x.field === f)?.value ?? "";
            return `${get("@timestamp")} ${get("@message").replace(/\s+$/u, "")}`;
          })
          .reverse();
        return { readable: true, lines, command };
      }
      if (r.status === "Failed" || r.status === "Cancelled" || r.status === "Timeout") {
        return { readable: false, reason: `Logs Insights query ${r.status}`, command };
      }
    }
    return { readable: false, reason: `Logs Insights query still running after ${QUERY_WAIT_MS / 1000} s`, command };
  } catch (err) {
    const name = (err as { name?: string })?.name ?? "Error";
    const reason =
      name === "AccessDeniedException"
        ? "not readable by the app role"
        : name === "ResourceNotFoundException"
          ? `log group ${SAGEMAKER_PROCESSING_LOG_GROUP} does not exist yet`
          : `${name}: ${String((err as Error)?.message ?? err).slice(0, 200)}`;
    return { readable: false, reason, command };
  }
}

/** The digest only: the repository host carries the account id. */
export function yoloImageDigest(image = process.env.YOLO_ECR_IMAGE): string | null {
  const m = /@(sha256:[0-9a-f]{64})$/u.exec(image ?? "");
  return m ? m[1] : null;
}

export async function getYoloDebug(query: z.infer<typeof zYoloDebugQuery>, session: AuthSession): Promise<unknown> {
  const { jobName } = query;
  const rows = await db
    .select({
      rowId: processingJobs.id,
      projectId: processingJobs.projectId,
      projectPublicId: projects.publicId,
      projectName: projects.name,
      status: processingJobs.status,
      error: processingJobs.error,
      modelConfig: processingJobs.modelConfig,
      startedAt: processingJobs.startedAt,
      completedAt: processingJobs.completedAt,
    })
    .from(processingJobs)
    .innerJoin(projects, eq(projects.id, processingJobs.projectId))
    .where(and(eq(processingJobs.executionId, jobName), isNotNull(processingJobs.modelConfig)));
  const projectIds = [...new Set(rows.map((r) => r.projectId))];

  const leases = projectIds.length
    ? await db
        .select({
          projectId: projectMutationLeases.projectId,
          kind: projectMutationLeases.kind,
          status: projectMutationLeases.status,
          createdAt: projectMutationLeases.createdAt,
          expiresAt: projectMutationLeases.expiresAt,
        })
        .from(projectMutationLeases)
        .where(and(inArray(projectMutationLeases.projectId, projectIds), eq(projectMutationLeases.status, "active")))
    : [];
  const usage = await db
    .select({ projectId: computeUsage.projectId, pages: computeUsage.pages, createdAt: computeUsage.createdAt })
    .from(computeUsage)
    .where(and(eq(computeUsage.resource, "sagemaker"), eq(computeUsage.jobId, jobName)));

  const startedAt = rows.reduce<Date | null>((min, r) => (r.startedAt && (!min || r.startedAt < min) ? r.startedAt : min), null);
  const logs = await readYoloJobLogs(jobName, startedAt);
  const publicIdOf = new Map(rows.map((r) => [r.projectId, r.projectPublicId]));

  return {
    generatedAt: new Date().toISOString(),
    viewerEmail: session.user.email ?? null,
    jobName,
    yoloImageDigest: yoloImageDigest(),
    rows: rows.map((r) => ({
      projectPublicId: r.projectPublicId,
      projectName: r.projectName,
      status: r.status,
      error: r.error,
      modelConfig: r.modelConfig,
      startedAt: r.startedAt?.toISOString() ?? null,
      completedAt: r.completedAt?.toISOString() ?? null,
    })),
    leases: leases.map((l) => ({
      projectPublicId: publicIdOf.get(l.projectId) ?? null,
      kind: l.kind,
      createdAt: l.createdAt.toISOString(),
      expiresAt: l.expiresAt.toISOString(),
    })),
    computeUsage: usage.map((u) => ({
      projectPublicId: u.projectId === null ? null : (publicIdOf.get(u.projectId) ?? null),
      pages: u.pages,
      createdAt: u.createdAt.toISOString(),
    })),
    logs,
  };
}
