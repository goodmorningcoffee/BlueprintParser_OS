"use client";

import { useCallback, useEffect, useState } from "react";
import type { LogsRange } from "./LogsTab";

interface EngagementRow {
  feature: string;
  method: string;
  path: string;
  hits: number;
  uniqueUsers: number;
}

interface EngagementResponse {
  range: LogsRange;
  top10: EngagementRow[];
  unmappedHits: number;
  totalMappedRoutes: number;
}

export default function LogsEngagement({ range }: { range: LogsRange }) {
  const [data, setData] = useState<EngagementResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/logs/engagement?range=${range}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const payload = (await res.json()) as EngagementResponse;
      setData(payload);
      setLastRefresh(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load engagement data");
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const maxHits = Math.max(...(data?.top10.map((r) => r.hits) || [1]), 1);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-[var(--fg)]">Top 10 features pressed</h3>
          <p className="text-xs text-[var(--muted)]">
            What people are actually using. Unmapped routes (auto-fetches, navigation) are hidden.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {lastRefresh && (
            <span className="text-[10px] text-[var(--muted)]">
              Refreshed {Math.round((Date.now() - lastRefresh.getTime()) / 1000)}s ago
            </span>
          )}
          <button
            onClick={fetchData}
            disabled={loading}
            className="text-xs px-3 py-1 rounded border border-[var(--border)] hover:border-[var(--accent)] disabled:opacity-50"
          >
            {loading ? "Loading…" : "🔄 Refresh"}
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded bg-red-500/10 border border-red-500/30 text-xs text-red-400">
          {error}
        </div>
      )}

      {!error && data && (
        <>
          <div className="rounded border border-[var(--border)] overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-[var(--surface-2)]/50 text-[var(--muted)] text-xs">
                <tr>
                  <th className="px-3 py-2 text-left w-10">#</th>
                  <th className="px-3 py-2 text-left">Feature</th>
                  <th className="px-3 py-2 text-right w-24">Hits</th>
                  <th className="px-3 py-2 text-right w-24">Unique users</th>
                  <th className="px-3 py-2 w-1/3"></th>
                </tr>
              </thead>
              <tbody>
                {data.top10.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-8 text-center text-xs text-[var(--muted)] italic">
                      No feature hits in this window yet.
                    </td>
                  </tr>
                )}
                {data.top10.map((r, i) => (
                  <tr key={`${r.method}-${r.path}`} className="border-t border-[var(--border)]">
                    <td className="px-3 py-2 text-[var(--muted)]">{i + 1}</td>
                    <td className="px-3 py-2">
                      <div className="text-[var(--fg)]">{r.feature}</div>
                      <div className="text-[10px] text-[var(--muted)] font-mono">
                        {r.method} {r.path}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right font-mono">{r.hits.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right font-mono">{r.uniqueUsers.toLocaleString()}</td>
                    <td className="px-3 py-2">
                      <div className="h-2 bg-[var(--surface-2)] rounded overflow-hidden">
                        <div
                          className="h-full bg-[var(--accent)]/60"
                          style={{ width: `${(r.hits / maxHits) * 100}%` }}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="text-[10px] text-[var(--muted)] text-right">
            {data.totalMappedRoutes} mapped routes · {data.unmappedHits.toLocaleString()} unmapped hits excluded
          </div>
        </>
      )}
    </div>
  );
}
