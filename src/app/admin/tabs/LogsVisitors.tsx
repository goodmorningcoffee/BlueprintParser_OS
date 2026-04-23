"use client";

import { useCallback, useEffect, useState } from "react";
import type { LogsRange } from "./LogsTab";

interface VisitorRow {
  ip: string;
  country: string;
  requests: number;
  firstSeen: string | null;
  lastSeen: string | null;
  durationMs: number;
  uniquePaths: number;
  uniqueSessions: number;
  userAgent: string;
  authed: boolean;
  isManuallyBanned: boolean;
}

interface VisitorsResponse {
  range: LogsRange;
  visitors: VisitorRow[];
  retentionWarning: { daysUntilRollover: number } | null;
}

export default function LogsVisitors({ range }: { range: LogsRange }) {
  const [data, setData] = useState<VisitorsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [banModal, setBanModal] = useState<{ ip: string; country: string } | null>(null);
  const [banReason, setBanReason] = useState("");
  const [banSubmitting, setBanSubmitting] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/logs/visitors?range=${range}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const payload = (await res.json()) as VisitorsResponse;
      setData(payload);
      setLastRefresh(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load visitors");
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const copyIp = (ip: string) => {
    navigator.clipboard.writeText(ip).catch(() => {});
  };

  const submitBan = async () => {
    if (!banModal) return;
    setBanSubmitting(true);
    try {
      const res = await fetch("/api/admin/logs/ban-ip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ip: banModal.ip, reason: banReason || undefined }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      setBanModal(null);
      setBanReason("");
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ban failed");
    } finally {
      setBanSubmitting(false);
    }
  };

  const unban = async (ip: string) => {
    try {
      await fetch("/api/admin/logs/unban-ip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ip }),
      });
      await fetchData();
    } catch {
      setError("Unban failed");
    }
  };

  const downloadCsv = () => {
    if (!data) return;
    const header = "ip,country,requests,firstSeen,lastSeen,durationMs,uniquePaths,uniqueSessions,authed,userAgent\n";
    const rows = data.visitors.map((v) =>
      [v.ip, v.country, v.requests, v.firstSeen || "", v.lastSeen || "", v.durationMs, v.uniquePaths, v.uniqueSessions, v.authed, JSON.stringify(v.userAgent)].join(","),
    );
    const blob = new Blob([header + rows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `bp-visitors-${range}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const fmtDuration = (ms: number) => {
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`;
    return `${(ms / 3600_000).toFixed(1)}h`;
  };

  return (
    <div className="space-y-3">
      {data?.retentionWarning && (
        <div className="p-3 rounded bg-amber-500/10 border border-amber-500/30 text-xs text-amber-300 flex items-center justify-between">
          <span>
            ⚠ Oldest logs roll off CloudWatch in {data.retentionWarning.daysUntilRollover} day
            {data.retentionWarning.daysUntilRollover === 1 ? "" : "s"}. Download a copy if you want to keep them.
          </span>
          <button onClick={downloadCsv} className="px-2 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/30">
            Download CSV
          </button>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-[var(--fg)]">Visitors ({data?.visitors.length ?? 0})</h3>
          <p className="text-xs text-[var(--muted)]">
            Sorted by request count. Top row = most engaged visitor this window.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {lastRefresh && (
            <span className="text-[10px] text-[var(--muted)]">
              Refreshed {Math.round((Date.now() - lastRefresh.getTime()) / 1000)}s ago
            </span>
          )}
          <button onClick={downloadCsv} disabled={!data} className="text-xs px-3 py-1 rounded border border-[var(--border)] hover:border-[var(--accent)] disabled:opacity-50">
            Download CSV
          </button>
          <button onClick={fetchData} disabled={loading} className="text-xs px-3 py-1 rounded border border-[var(--border)] hover:border-[var(--accent)] disabled:opacity-50">
            {loading ? "Loading…" : "🔄 Refresh"}
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded bg-red-500/10 border border-red-500/30 text-xs text-red-400">{error}</div>
      )}

      {!error && data && (
        <div className="rounded border border-[var(--border)] overflow-auto max-h-[70vh]">
          <table className="w-full text-xs">
            <thead className="bg-[var(--surface-2)]/50 text-[var(--muted)] sticky top-0">
              <tr>
                <th className="px-2 py-2 text-left">IP</th>
                <th className="px-2 py-2 text-left">Country</th>
                <th className="px-2 py-2 text-right">Requests</th>
                <th className="px-2 py-2 text-right">Paths</th>
                <th className="px-2 py-2 text-right">Duration</th>
                <th className="px-2 py-2 text-left">Authed?</th>
                <th className="px-2 py-2 text-left">User agent</th>
                <th className="px-2 py-2 text-left">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.visitors.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-2 py-8 text-center text-[var(--muted)] italic">
                    No visitors in this window yet.
                  </td>
                </tr>
              )}
              {data.visitors.map((v) => (
                <tr key={v.ip} className="border-t border-[var(--border)] hover:bg-[var(--surface-2)]/30">
                  <td className="px-2 py-1.5 font-mono">{v.ip}</td>
                  <td className="px-2 py-1.5">{v.country}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{v.requests}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{v.uniquePaths}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{fmtDuration(v.durationMs)}</td>
                  <td className="px-2 py-1.5">
                    {v.authed ? <span className="text-emerald-400">yes</span> : <span className="text-[var(--muted)]">no</span>}
                  </td>
                  <td className="px-2 py-1.5 truncate max-w-xs" title={v.userAgent}>
                    {v.userAgent.slice(0, 50)}{v.userAgent.length > 50 ? "…" : ""}
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    <button
                      onClick={() => copyIp(v.ip)}
                      className="px-1.5 py-0.5 rounded text-[10px] text-[var(--muted)] hover:text-[var(--fg)] hover:bg-[var(--surface-2)]"
                      title="Copy IP"
                    >
                      📋
                    </button>
                    {v.isManuallyBanned ? (
                      <button
                        onClick={() => unban(v.ip)}
                        className="ml-1 px-1.5 py-0.5 rounded text-[10px] text-emerald-400 hover:bg-emerald-500/20"
                      >
                        Unban
                      </button>
                    ) : (
                      <button
                        onClick={() => setBanModal({ ip: v.ip, country: v.country })}
                        className="ml-1 px-1.5 py-0.5 rounded text-[10px] text-red-400 hover:bg-red-500/20"
                      >
                        Ban
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {banModal && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center" onClick={() => setBanModal(null)}>
          <div className="bg-[var(--bg)] rounded border border-[var(--border)] p-4 max-w-md w-full space-y-3" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-medium">Ban IP</h3>
            <div className="text-xs text-[var(--muted)]">
              IP: <span className="font-mono text-[var(--fg)]">{banModal.ip}</span> ({banModal.country})
            </div>
            <label className="block text-xs">
              Reason (optional):
              <input
                type="text"
                value={banReason}
                onChange={(e) => setBanReason(e.target.value)}
                placeholder="e.g. repeated parse-table abuse"
                className="w-full mt-1 px-2 py-1 text-xs rounded border border-[var(--border)] bg-[var(--surface-2)]"
                maxLength={500}
              />
            </label>
            <div className="flex justify-end gap-2">
              <button onClick={() => setBanModal(null)} className="text-xs px-3 py-1 rounded border border-[var(--border)]">Cancel</button>
              <button
                onClick={submitBan}
                disabled={banSubmitting}
                className="text-xs px-3 py-1 rounded bg-red-500/20 text-red-300 border border-red-500/40 hover:bg-red-500/30 disabled:opacity-50"
              >
                {banSubmitting ? "Banning…" : "Ban IP"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
