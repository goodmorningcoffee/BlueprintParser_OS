"use client";

// Admin › Data tools › Stuck jobs. Lists running processing records and work-in-progress locks,
// with what AWS says about each; "Fix" closes only what AWS attests is finished. Root also gets
// Stop (hung execution), Force release (web-held locks, typed confirmation) and the list of
// unlinked YOLO billing reservations (listed only, never changed here).

import { useCallback, useEffect, useState } from "react";
import { apiErrorMessage } from "@/lib/client-persist";

interface ProviderInfo {
  state: string;
  status?: string;
  startDate?: string | null;
  stopDate?: string;
  reason?: string;
}
interface IngestRow {
  jobId: number;
  projectPublicId: string;
  projectName: string;
  projectStatus: string;
  startedAt: string | null;
  executionName: string | null;
  provider: ProviderInfo;
  fixable: boolean;
  verdict: string;
}
interface YoloRow {
  jobId: number;
  projectPublicId: string;
  projectName: string;
  startedAt: string | null;
  executionId: string | null;
  modelName: string | null;
  providerStatus: string | null;
  fixable: boolean;
  verdict: string;
}
interface LeaseRow {
  kind: string;
  tokenPrefix: string;
  projectPublicId: string;
  projectName: string;
  createdAt: string;
  heartbeatStale: boolean;
  ageMinutes: number;
  holder: "web" | "worker" | "other";
}
interface ReservationRow {
  id: number;
  companyId: number;
  projectPublicId: string | null;
  pages: number;
  createdAt: string;
}
interface StuckJobsResponse {
  generatedAt: string;
  ingest: IngestRow[];
  yolo: YoloRow[];
  leases: LeaseRow[];
  unlinkedReservations: ReservationRow[] | null;
}
interface ReconcileResponse {
  outcomes: { projectPublicId: string; changed: boolean; message: string }[];
  skipped: { projectPublicId: string; reason: string }[];
}

const cell = "px-2 py-1.5 border-b border-[var(--border)] align-top";
const btn = "px-2 py-1 text-[11px] rounded border border-[var(--border)] hover:border-[var(--accent)] disabled:opacity-40";

function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

async function call<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new Error(apiErrorMessage(json) || `HTTP ${res.status}`);
  return json as T;
}

export default function DataToolsStuckJobs({ isRootAdmin }: { isRootAdmin: boolean }) {
  const [data, setData] = useState<StuckJobsResponse | null>(null);
  const [companyId, setCompanyId] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);

  const companyQuery = isRootAdmin && /^\d+$/.test(companyId) ? Number(companyId) : undefined;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = companyQuery ? `?companyId=${companyQuery}` : "";
      setData(await call<StuckJobsResponse>(`/api/admin/stuck-jobs${qs}`, "GET"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load stuck jobs");
    } finally {
      setLoading(false);
    }
  }, [companyQuery]);

  useEffect(() => {
    load();
  }, [load]);

  const run = async (key: string, action: () => Promise<string[]>) => {
    setBusy(key);
    setError(null);
    try {
      const lines = await action();
      setLog((prev) => [...lines, ...prev].slice(0, 30));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(null);
    }
  };

  const reconcileLines = (r: ReconcileResponse) => [
    ...r.outcomes.map((o) => `${o.changed ? "Fixed" : "Unchanged"} ${o.projectPublicId.slice(0, 8)}: ${o.message}`),
    ...r.skipped.map((s) => `Skipped ${s.projectPublicId.slice(0, 8)}: ${s.reason}`),
  ];

  const fixIngest = (row: IngestRow) =>
    run(`ingest-${row.jobId}`, async () =>
      reconcileLines(await call<ReconcileResponse>("/api/admin/stuck-jobs/reconcile", "POST", { projectPublicId: row.projectPublicId })),
    );

  const fixAll = () =>
    run("all", async () =>
      reconcileLines(
        await call<ReconcileResponse>("/api/admin/stuck-jobs/reconcile", "POST", {
          all: true,
          ...(companyQuery ? { companyId: companyQuery } : {}),
        }),
      ),
    );

  const fixYolo = (row: YoloRow) =>
    run(`yolo-${row.jobId}`, async () => {
      // The server re-reads SageMaker; the status sent here is not trusted.
      await call("/api/admin/running-jobs", "PUT", { executionId: row.executionId, status: "Failed" });
      return [`Closed YOLO job on ${row.projectName}`];
    });

  const stop = (row: IngestRow) => {
    if (!window.confirm(`Stop the AWS run for "${row.projectName}"? Fix can close it about 3 minutes later.`)) return;
    run(`stop-${row.jobId}`, async () => {
      const r = await call<{ message: string }>("/api/admin/stuck-jobs/stop", "POST", { projectPublicId: row.projectPublicId });
      return [`${row.projectName}: ${r.message}`];
    });
  };

  const forceRelease = (row: LeaseRow) => {
    const typed = window.prompt(
      `Force-release the web-held locks on "${row.projectName}"? Only do this if nothing is running for it.\nType the project name to confirm:`,
    );
    if (typed === null) return;
    run(`lease-${row.tokenPrefix}`, async () => {
      const r = await call<{ released: { kind: string }[]; refused: { kind: string; reason: string }[] }>(
        "/api/admin/stuck-jobs/force-release",
        "POST",
        { projectPublicId: row.projectPublicId, confirmProjectName: typed },
      );
      return [
        ...r.released.map((l) => `Released ${l.kind} on ${row.projectName}`),
        ...r.refused.map((l) => `Kept ${l.kind} on ${row.projectName}: ${l.reason}`),
      ];
    });
  };

  const fixableCount = data?.ingest.filter((r) => r.fixable).length ?? 0;
  const empty = data && data.ingest.length === 0 && data.yolo.length === 0 && data.leases.length === 0;

  return (
    <section>
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <h2 className="text-lg font-semibold">Stuck jobs</h2>
        <button onClick={load} disabled={loading} className={btn}>
          {loading ? "Loading…" : "Refresh"}
        </button>
        <button
          onClick={fixAll}
          disabled={busy !== null || fixableCount === 0}
          className="px-3 py-1 text-[11px] rounded bg-[var(--accent)] text-white disabled:opacity-40"
        >
          {busy === "all" ? "Fixing…" : `Fix all finished (${fixableCount})`}
        </button>
        {isRootAdmin && (
          <input
            value={companyId}
            onChange={(e) => setCompanyId(e.target.value.trim())}
            placeholder="company id (blank = all)"
            className="px-2 py-1 text-xs w-44 bg-[var(--bg)] border border-[var(--border)] rounded"
          />
        )}
      </div>
      <p className="text-[11px] text-[var(--muted)] mb-3">
        A processing run that crashed can leave a &ldquo;job running&rdquo; record or a lock behind, and Delete then refuses.
        Fix asks AWS first and only closes runs AWS says ended more than 3 minutes ago. Delete does the same check by itself.
      </p>
      {error && <div className="mb-3 text-xs text-red-400">{error}</div>}
      {empty && <div className="text-xs text-[var(--muted)]">Nothing is stuck.</div>}

      {data && data.ingest.length > 0 && (
        <table className="w-full text-xs mb-5">
          <thead>
            <tr className="text-left text-[var(--muted)]">
              <th className={cell}>Project (processing)</th>
              <th className={cell}>Started</th>
              <th className={cell}>AWS says</th>
              <th className={cell}>Verdict</th>
              <th className={cell} />
            </tr>
          </thead>
          <tbody>
            {data.ingest.map((row) => (
              <tr key={row.jobId}>
                <td className={cell}>{row.projectName}</td>
                <td className={cell}>{when(row.startedAt)}</td>
                <td className={cell}>
                  {row.provider.status ?? row.provider.state}
                  {row.provider.stopDate ? ` (ended ${when(row.provider.stopDate)})` : ""}
                </td>
                <td className={cell}>{row.verdict}</td>
                <td className={`${cell} whitespace-nowrap space-x-1`}>
                  <button onClick={() => fixIngest(row)} disabled={!row.fixable || busy !== null} className={btn}>
                    Fix
                  </button>
                  {isRootAdmin && row.provider.state === "running" && (
                    <button onClick={() => stop(row)} disabled={busy !== null} className={btn}>
                      Stop
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {data && data.yolo.length > 0 && (
        <table className="w-full text-xs mb-5">
          <thead>
            <tr className="text-left text-[var(--muted)]">
              <th className={cell}>Project (YOLO)</th>
              <th className={cell}>Model</th>
              <th className={cell}>Started</th>
              <th className={cell}>Verdict</th>
              <th className={cell} />
            </tr>
          </thead>
          <tbody>
            {data.yolo.map((row) => (
              <tr key={row.jobId}>
                <td className={cell}>{row.projectName}</td>
                <td className={cell}>{row.modelName ?? "—"}</td>
                <td className={cell}>{when(row.startedAt)}</td>
                <td className={cell}>{row.verdict}</td>
                <td className={cell}>
                  <button onClick={() => fixYolo(row)} disabled={!row.fixable || busy !== null} className={btn}>
                    Fix
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {data && data.leases.length > 0 && (
        <table className="w-full text-xs mb-5">
          <thead>
            <tr className="text-left text-[var(--muted)]">
              <th className={cell}>Project (lock)</th>
              <th className={cell}>Kind</th>
              <th className={cell}>Held by</th>
              <th className={cell}>Age</th>
              <th className={cell} />
            </tr>
          </thead>
          <tbody>
            {data.leases.map((row) => (
              <tr key={`${row.projectPublicId}-${row.tokenPrefix}`}>
                <td className={cell}>{row.projectName}</td>
                <td className={cell}>{row.kind}</td>
                <td className={cell}>
                  {row.holder === "worker" ? "processing worker (Fix releases it)" : row.holder}
                  {row.heartbeatStale ? " · no heartbeat" : ""}
                </td>
                <td className={cell}>{row.ageMinutes} min</td>
                <td className={cell}>
                  {isRootAdmin && row.holder === "web" && (
                    <button onClick={() => forceRelease(row)} disabled={busy !== null} className={btn}>
                      Force release
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {isRootAdmin && data?.unlinkedReservations && data.unlinkedReservations.length > 0 && (
        <div className="mb-5">
          <h3 className="text-sm font-semibold mb-1">Unlinked YOLO reservations (listed only)</h3>
          <p className="text-[11px] text-[var(--muted)] mb-2">
            Page reservations whose SageMaker start never completed. They may still count against the page quota; nothing here changes them.
          </p>
          <table className="w-full text-xs">
            <tbody>
              {data.unlinkedReservations.map((r) => (
                <tr key={r.id}>
                  <td className={cell}>#{r.id}</td>
                  <td className={cell}>company {r.companyId}</td>
                  <td className={cell}>{r.projectPublicId ? r.projectPublicId.slice(0, 8) : "deleted project"}</td>
                  <td className={cell}>{r.pages} pages</td>
                  <td className={cell}>{when(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {log.length > 0 && (
        <div className="p-3 bg-[var(--surface)] border border-[var(--border)] rounded text-[11px] space-y-0.5">
          {log.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}
    </section>
  );
}
