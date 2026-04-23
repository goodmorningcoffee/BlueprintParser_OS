"use client";

import { useCallback, useEffect, useState } from "react";

interface AbuseEvent {
  id: number;
  eventType: string;
  ip: string;
  country: string | null;
  path: string | null;
  userAgent: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
  seenAt: string | null;
}

interface ManualBan {
  id: number;
  ip: string;
  reason: string | null;
  bannedByUserId: number | null;
  bannedUntil: string | null;
  createdAt: string;
}

interface SecurityResponse {
  abuseEvents: AbuseEvent[];
  manualBans: ManualBan[];
  violationStats: { last24h: number; last7d: number; byType: Record<string, number> };
}

const EVENT_COLORS: Record<string, string> = {
  RATE_LIMIT_BREACH: "bg-amber-500/20 text-amber-300",
  IP_BANNED_AUTO: "bg-red-500/20 text-red-300",
  FAILED_LOGIN: "bg-amber-500/20 text-amber-300",
  SCAN_404_BURST: "bg-red-500/20 text-red-300",
  DEPRECATED_ROUTE: "bg-blue-500/20 text-blue-300",
  MANUAL_BAN: "bg-red-500/20 text-red-300",
  MANUAL_UNBAN: "bg-[var(--surface-2)] text-[var(--muted)]",
};

export default function LogsSecurity() {
  const [data, setData] = useState<SecurityResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/logs/security`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      setData(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load security");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

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

  const events = data?.abuseEvents.filter((e) => {
    if (!filter) return true;
    const f = filter.toLowerCase();
    return (
      e.ip.includes(f) ||
      e.eventType.toLowerCase().includes(f) ||
      (e.path?.toLowerCase().includes(f) ?? false)
    );
  }) ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-[var(--fg)]">Security signals</h3>
          <p className="text-xs text-[var(--muted)]">
            Abuse events, banned IPs, probe attempts. Refresh to re-query.
          </p>
        </div>
        <button onClick={fetchData} disabled={loading} className="text-xs px-3 py-1 rounded border border-[var(--border)] hover:border-[var(--accent)] disabled:opacity-50">
          {loading ? "Loading…" : "🔄 Refresh"}
        </button>
      </div>

      {error && (
        <div className="p-3 rounded bg-red-500/10 border border-red-500/30 text-xs text-red-400">{error}</div>
      )}

      {!error && data && (
        <>
          {/* Stats row */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="rounded border border-[var(--border)] p-3">
              <div className="text-[10px] text-[var(--muted)] uppercase">Last 24h</div>
              <div className="text-lg font-mono mt-1">{data.violationStats.last24h}</div>
              <div className="text-[10px] text-[var(--muted)]">abuse events</div>
            </div>
            <div className="rounded border border-[var(--border)] p-3">
              <div className="text-[10px] text-[var(--muted)] uppercase">Last 7d</div>
              <div className="text-lg font-mono mt-1">{data.violationStats.last7d}</div>
              <div className="text-[10px] text-[var(--muted)]">abuse events</div>
            </div>
            <div className="rounded border border-[var(--border)] p-3">
              <div className="text-[10px] text-[var(--muted)] uppercase">Manual bans</div>
              <div className="text-lg font-mono mt-1">{data.manualBans.length}</div>
              <div className="text-[10px] text-[var(--muted)]">active</div>
            </div>
            <div className="rounded border border-[var(--border)] p-3">
              <div className="text-[10px] text-[var(--muted)] uppercase">Top type (7d)</div>
              <div className="text-sm font-mono mt-1 truncate">
                {Object.entries(data.violationStats.byType).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "—"}
              </div>
              <div className="text-[10px] text-[var(--muted)]">
                {Object.entries(data.violationStats.byType).sort((a, b) => b[1] - a[1])[0]?.[1] ?? 0} events
              </div>
            </div>
          </div>

          {/* Manual bans table */}
          {data.manualBans.length > 0 && (
            <div>
              <div className="text-xs text-[var(--muted)] mb-2">Active manual bans</div>
              <div className="rounded border border-[var(--border)] overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-[var(--surface-2)]/50 text-[var(--muted)]">
                    <tr>
                      <th className="px-2 py-1.5 text-left">IP</th>
                      <th className="px-2 py-1.5 text-left">Reason</th>
                      <th className="px-2 py-1.5 text-left">Banned at</th>
                      <th className="px-2 py-1.5 text-left">Expires</th>
                      <th className="px-2 py-1.5"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.manualBans.map((b) => (
                      <tr key={b.id} className="border-t border-[var(--border)]">
                        <td className="px-2 py-1.5 font-mono">{b.ip}</td>
                        <td className="px-2 py-1.5 text-[var(--muted)]">{b.reason || "—"}</td>
                        <td className="px-2 py-1.5 text-[var(--muted)]">{new Date(b.createdAt).toLocaleString()}</td>
                        <td className="px-2 py-1.5 text-[var(--muted)]">{b.bannedUntil ? new Date(b.bannedUntil).toLocaleString() : "permanent"}</td>
                        <td className="px-2 py-1.5 text-right">
                          <button onClick={() => unban(b.ip)} className="text-[10px] px-1.5 py-0.5 rounded text-emerald-400 hover:bg-emerald-500/20">Unban</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Events table */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs text-[var(--muted)]">Recent abuse events ({events.length})</div>
              <input
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter by IP, type, path"
                className="text-xs px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg)] w-64"
              />
            </div>
            <div className="rounded border border-[var(--border)] overflow-auto max-h-[50vh]">
              <table className="w-full text-xs">
                <thead className="bg-[var(--surface-2)]/50 text-[var(--muted)] sticky top-0">
                  <tr>
                    <th className="px-2 py-1.5 text-left">Time</th>
                    <th className="px-2 py-1.5 text-left">Type</th>
                    <th className="px-2 py-1.5 text-left">IP</th>
                    <th className="px-2 py-1.5 text-left">Country</th>
                    <th className="px-2 py-1.5 text-left">Path</th>
                    <th className="px-2 py-1.5 text-left">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {events.length === 0 && (
                    <tr><td colSpan={6} className="px-2 py-8 text-center text-[var(--muted)] italic">No events match.</td></tr>
                  )}
                  {events.map((e) => (
                    <tr key={e.id} className="border-t border-[var(--border)]">
                      <td className="px-2 py-1.5 text-[var(--muted)] whitespace-nowrap">{new Date(e.createdAt).toLocaleString()}</td>
                      <td className="px-2 py-1.5">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] ${EVENT_COLORS[e.eventType] || "bg-[var(--surface-2)]"}`}>
                          {e.eventType}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 font-mono">{e.ip}</td>
                      <td className="px-2 py-1.5">{e.country || "??"}</td>
                      <td className="px-2 py-1.5 text-[var(--muted)] truncate max-w-xs" title={e.path || ""}>{e.path || "—"}</td>
                      <td className="px-2 py-1.5 text-[var(--muted)] truncate max-w-xs" title={JSON.stringify(e.details)}>
                        {e.details ? JSON.stringify(e.details).slice(0, 80) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
