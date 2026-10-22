"use client";

// [2026-10-22 owner: "add a debug statement printer I can copy and paste from the /admin AI Models tab that
// gives you insight into what goes wrong"] Root-only "Debug report" section. "Build report" gathers the
// instance options, the last bulk plan + queue, each known job's SageMaker details
// (/api/admin/sagemaker-details) and server view (/api/admin/yolo-debug: rows, leases, usage, CloudWatch)
// and the client event log (./yolo-debug-log) into one redacted plain-text block. Copy uses the
// clipboard and falls back to selecting the textarea (the clipboard can be blocked).

import { useRef, useState, useSyncExternalStore } from "react";
import { apiErrorMessage } from "@/lib/client-persist";
import { readYoloBulkDebugState } from "./YoloBulkBar";
import { readYoloOptions } from "./yolo-options-store";
import { bulkMachineBounds } from "./yolo-bulk-concurrency";
import { clearYoloDebugLog, logYoloDebug, readYoloDebugEvents, subscribeYoloDebug } from "./yolo-debug-log";
import { buildYoloDebugReport, debugJobNames, type YoloDebugJobInfo } from "./yolo-debug-report";

const btn = "px-2.5 py-1 rounded border border-[var(--border)] hover:border-[var(--accent)] disabled:opacity-40";

async function getJson(url: string): Promise<{ body: Record<string, unknown> | null; error?: string }> {
  try {
    const res = await fetch(url);
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      logYoloDebug("http", `GET ${url} → ${res.status}`, body);
      return { body: null, error: `HTTP ${res.status}: ${apiErrorMessage(body) || "no message"}` };
    }
    return { body };
  } catch (err) {
    return { body: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface YoloDebugReportProps {
  /** The tab's row texts per project (model id → text), as rendered. */
  rowStatus: (projectId: string) => string;
  projects: Array<{ id: string; name: string }>;
}

export default function YoloDebugReport({ rowStatus, projects }: YoloDebugReportProps) {
  const eventCount = useSyncExternalStore(subscribeYoloDebug, () => readYoloDebugEvents().length, () => 0);
  const [report, setReport] = useState("");
  const [building, setBuilding] = useState(false);
  const [note, setNote] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);

  async function build() {
    setBuilding(true);
    setNote("");
    try {
      const { snapshot, plan } = readYoloBulkDebugState();
      const rowStatuses: Record<string, string> = {};
      for (const p of projects) rowStatuses[p.id] = rowStatus(p.id);
      const jobs: YoloDebugJobInfo[] = [];
      for (const jobName of debugJobNames(snapshot, rowStatuses)) {
        const q = encodeURIComponent(jobName);
        const [details, server] = await Promise.all([
          getJson(`/api/admin/sagemaker-details?jobName=${q}`),
          getJson(`/api/admin/yolo-debug?jobName=${q}`),
        ]);
        jobs.push({ jobName, details: details.body, detailsError: details.error, server: server.body, serverError: server.error });
      }
      const options = readYoloOptions();
      const keepEmail = jobs.map((x) => x.server?.viewerEmail).find((e): e is string => typeof e === "string") ?? null;
      setReport(
        buildYoloDebugReport({
          now: new Date().toISOString(),
          commit: null, // the build does not stamp a commit yet
          options,
          machines: plan?.machines ?? (options ? bulkMachineBounds(options).defaultValue : null),
          plan,
          snapshot,
          rowStatuses,
          projectNames: Object.fromEntries(projects.map((p) => [p.id, p.name])),
          jobs,
          events: readYoloDebugEvents(),
          keepEmail,
        }),
      );
    } finally {
      setBuilding(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(report);
      setNote("Copied.");
    } catch {
      area.current?.focus();
      area.current?.select();
      setNote("The clipboard is blocked here — the report is selected; press Ctrl/Cmd+C.");
    }
  }

  return (
    <details className="mb-3 p-3 bg-[var(--surface)] border border-[var(--border)] rounded text-xs" data-testid="yolo-debug-report">
      <summary className="cursor-pointer font-medium text-sm">Debug report ({eventCount} events logged this session)</summary>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" className={btn} onClick={() => void build()} disabled={building}>
          {building ? "Building…" : "Build report"}
        </button>
        <button type="button" className={btn} onClick={() => void copy()} disabled={!report}>
          Copy
        </button>
        <button
          type="button"
          className={btn}
          onClick={() => {
            clearYoloDebugLog();
            setReport("");
            setNote("Cleared.");
          }}
        >
          Clear
        </button>
        <span className="text-[var(--muted)]">
          Plain text for pasting into a chat: instance, plan, queue, each job&apos;s SageMaker status and logs, and every
          request that failed. Secrets and other people&apos;s emails are redacted.
        </span>
      </div>
      {note && <div className="mt-1 text-[var(--muted)]">{note}</div>}
      {report && (
        <textarea
          ref={area}
          aria-label="Debug report text"
          readOnly
          value={report}
          className="mt-2 w-full h-64 font-mono text-[11px] p-2 bg-[var(--bg)] border border-[var(--border)] rounded"
        />
      )}
    </details>
  );
}
