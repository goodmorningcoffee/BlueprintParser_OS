// [2026-10-22] Plain-text YOLO debug report for the AI Models tab (./YoloDebugReport.tsx): instance +
// machines + timeout, the last bulk plan, the queue's per-project state, each job's SageMaker details,
// rows/leases/usage and CloudWatch lines (GET /api/admin/yolo-debug), and the client event log.
// Pure: the component gathers the inputs; everything is redacted once more at the end.

import { formatMinutes, formatUsd, type YoloInstanceOptionsResponse } from "@/lib/yolo-cost";
import type { YoloBatchSnapshot } from "./yolo-batch";
import type { YoloBulkRunPlan } from "./YoloBulkBar";
import { redactDebugText, type YoloDebugEvent } from "./yolo-debug-log";

export interface YoloDebugJobInfo {
  jobName: string;
  /** GET /api/admin/sagemaker-details, or { error }. */
  details?: Record<string, unknown> | null;
  detailsError?: string;
  /** GET /api/admin/yolo-debug, or { error }. */
  server?: Record<string, unknown> | null;
  serverError?: string;
}

export interface YoloDebugReportInput {
  now: string;
  commit: string | null;
  options: YoloInstanceOptionsResponse | null;
  machines: number | null;
  plan: YoloBulkRunPlan | null;
  snapshot: YoloBatchSnapshot | null;
  /** projectId → the row text the tab shows. */
  rowStatuses: Record<string, string>;
  projectNames: Record<string, string>;
  jobs: YoloDebugJobInfo[];
  events: readonly YoloDebugEvent[];
  keepEmail?: string | null;
}

const j = (v: unknown) => {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};

export function buildYoloDebugReport(input: YoloDebugReportInput): string {
  const out: string[] = [];
  const name = (id: string) => input.projectNames[id] ?? id;
  out.push("=== BlueprintParser YOLO debug report ===");
  out.push(`generated: ${input.now}`);
  out.push(`app commit: ${input.commit ?? "unknown (the build does not stamp a commit)"}`);
  const image = input.jobs.map((x) => x.server?.yoloImageDigest).find((d) => typeof d === "string");
  out.push(`yolo image digest: ${image ?? "unknown (no job queried)"}`);

  out.push("", "--- instance ---");
  const o = input.options;
  if (!o) {
    out.push("instance options: not loaded (root only; GET /api/admin/yolo-instance/options failed or not yet read)");
  } else {
    const opt = o.catalog.options.find((x) => x.type === o.instanceType);
    out.push(
      `instance: ${o.instanceType}${o.valid ? "" : " (stored value invalid → default)"} · ` +
        (opt
          ? `${opt.gpu ?? "CPU"} · GPUs ${opt.gpus} · quota ${opt.quota ?? "unknown"} · ${formatUsd(opt.usdPerHour)}/h (${opt.priceSource})`
          : "not in the catalog"),
    );
    out.push(
      `machines at once: ${input.machines ?? "n/a"} · timeout: ${formatMinutes(o.maxRuntimeSeconds)} (${o.maxRuntimeSeconds} s) · ` +
        `quotaStatus ${o.catalog.quotaStatus} · priceStatus ${o.catalog.priceStatus} · catalog checked ${o.catalog.checkedAt}`,
    );
    const stats = o.runStats.filter((s) => s.instanceType === o.instanceType);
    out.push(`run timing on this instance: ${stats.length ? stats.map((s) => `model ${s.modelId ?? "*"}: ${s.startupSeconds} s + ${s.secondsPerPage} s/page (${s.runs} runs)`).join("; ") : "no history (defaults)"}`);
  }

  out.push("", "--- last bulk plan ---");
  const p = input.plan;
  if (!p) out.push("none this session");
  else {
    out.push(`at ${p.at} · model ${p.modelName} (#${p.modelId}) · ${p.instanceType ?? "?"} · machines ${p.machines} · GPUs/machine ${p.gpusPerMachine ?? "?"}`);
    if (p.estimate) out.push(`estimate: ${p.estimate}`);
    if (!p.chunks) out.push("mode: per-project jobs (no batch plan)");
    else {
      p.chunks.forEach((c, i) => {
        out.push(
          `job ${i + 1}: ${c.projectIds.length} project(s) · ${c.pages} pages · est ${Math.round(c.seconds)} s${c.overBudget ? " · OVER 80% OF TIMEOUT" : ""}: ` +
            c.projectIds.map(name).join(", "),
        );
      });
    }
  }

  out.push("", "--- queue (per project) ---");
  const s = input.snapshot;
  if (!s) out.push("no bulk queue this session");
  else {
    out.push(`${s.mode} ${s.modelName}: finished=${s.finished} stopped=${s.stopped} pausedForQuota=${s.pausedForQuota}${s.haltReason ? ` halt="${s.haltReason}"` : ""}`);
    for (const item of s.items) {
      out.push(
        `${item.projectName} [${item.projectId}]: ${item.phase}${item.jobName ? ` · job ${item.jobName}` : ""}` +
          `${item.message ? ` · "${item.message}"` : ""} · row "${input.rowStatuses[item.projectId] ?? ""}"`,
      );
    }
  }

  out.push("", "--- jobs ---");
  if (input.jobs.length === 0) out.push("no job names known (start a run, or reload the tab to resume running jobs)");
  for (const job of input.jobs) {
    out.push(`job ${job.jobName}`);
    const d = job.details;
    if (d) {
      out.push(
        `  sagemaker: status ${d.status ?? "?"} · failureReason ${d.failureReason ?? "none"} · exitMessage ${d.exitMessage ?? "none"}`,
        `  times: created ${d.creationTime ?? "?"} · start ${d.startTime ?? "?"} · end ${d.endTime ?? "?"} · ${d.durationSeconds ?? "?"} s · stop after ${d.stoppingConditionSeconds ?? "?"} s`,
        `  instance: ${d.instanceType ?? "?"} × ${d.instanceCount ?? "?"} · volume ${d.volumeSizeGB ?? "?"} GB`,
        `  inputs: ${j(d.inputs)}`,
        `  outputs: ${j(d.outputs)}`,
      );
    } else out.push(`  sagemaker details: ${job.detailsError ?? "not read"}`);
    const srv = job.server;
    if (srv) {
      const rows = Array.isArray(srv.rows) ? (srv.rows as Array<Record<string, unknown>>) : [];
      for (const r of rows) {
        out.push(`  row ${r.projectName} [${r.projectPublicId}]: ${r.status}${r.error ? ` · error "${r.error}"` : ""} · started ${r.startedAt} · completed ${r.completedAt ?? "-"} · ${j(r.modelConfig)}`);
      }
      const leases = Array.isArray(srv.leases) ? (srv.leases as Array<Record<string, unknown>>) : [];
      out.push(`  active leases: ${leases.length ? leases.map((l) => `${l.kind}@${l.projectPublicId} (expires ${l.expiresAt})`).join("; ") : "none"}`);
      const usage = Array.isArray(srv.computeUsage) ? (srv.computeUsage as Array<Record<string, unknown>>) : [];
      out.push(`  compute_usage stamped with this job: ${usage.length ? usage.map((u) => `${u.projectPublicId}: ${u.pages} pages`).join("; ") : "none"}`);
      const logs = srv.logs as { readable?: boolean; lines?: string[]; reason?: string; command?: string } | undefined;
      if (logs?.readable) {
        out.push(`  CloudWatch logs (last ${logs.lines?.length ?? 0} lines):`);
        for (const line of logs.lines ?? []) out.push(`    ${line}`);
      } else {
        out.push(`  CloudWatch logs: ${logs?.reason ?? "not read"} (owner can run: ${logs?.command ?? `aws logs tail /aws/sagemaker/ProcessingJobs --log-stream-name-prefix ${job.jobName}`} )`);
      }
    } else out.push(`  server debug: ${job.serverError ?? "not read"}`);
  }

  out.push("", `--- event log (${input.events.length} events, oldest first) ---`);
  for (const e of input.events) out.push(`${e.t} [${e.kind}] ${e.msg}${e.data === undefined ? "" : ` ${j(e.data)}`}`);
  out.push("=== end ===");
  return redactDebugText(out.join("\n"), input.keepEmail);
}

/** Job names worth describing: the queue's, then the tab's "Running: <job>" rows; newest first, bounded. */
export function debugJobNames(snapshot: YoloBatchSnapshot | null, rowStatuses: Record<string, string>, limit = 10): string[] {
  const names: string[] = [];
  const add = (n: string | undefined) => {
    if (n && !names.includes(n)) names.push(n);
  };
  for (const item of [...(snapshot?.items ?? [])].reverse()) add(item.jobName);
  for (const text of Object.values(rowStatuses)) add(/^Running: (\S+)/u.exec(text)?.[1]);
  return names.slice(0, limit);
}
