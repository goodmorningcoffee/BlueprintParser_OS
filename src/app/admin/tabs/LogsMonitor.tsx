"use client";

import { useCallback, useEffect, useState } from "react";

interface DataPoint { t: string; v: number }

interface MonitorResponse {
  ecs: {
    cpuNow: number; cpuLast60m: DataPoint[];
    memNow: number; memLast60m: DataPoint[];
  };
  lambda: {
    invocationsLast60m: number;
    invocationsSeries: DataPoint[];
    throttlesLast60m: number;
  };
  alarms: Array<{ name: string; state: "OK" | "ALARM" | "INSUFFICIENT_DATA"; reason: string }>;
  budget: { name: string; limitUsd: number; spentUsd: number; forecastUsd: number; percentUsed: number } | null;
  recommendations: string[];
  fetchedAt: string;
}

function Sparkline({ data, color = "var(--accent)" }: { data: DataPoint[]; color?: string }) {
  if (!data.length) return <div className="text-[10px] text-[var(--muted)] italic">No data</div>;
  const max = Math.max(...data.map((d) => d.v), 1);
  const W = 200, H = 40;
  const pts = data.map((d, i) => {
    const x = (i / Math.max(data.length - 1, 1)) * W;
    const y = H - (d.v / max) * H;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg width={W} height={H} className="overflow-visible">
      <polyline fill="none" stroke={color} strokeWidth="1.5" points={pts.join(" ")} />
    </svg>
  );
}

interface ToolUsageRow { feature: string; hits: number; uniqueUsers: number }

export default function LogsMonitor() {
  const [data, setData] = useState<MonitorResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [toolUsage, setToolUsage] = useState<ToolUsageRow[]>([]);
  const [showUnused, setShowUnused] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Parallel fetch: monitor (critical) + tool usage (non-critical, silent-fail).
      // Tool usage hits the existing engagement endpoint with ?all=1 for the
      // zero-filled mapped-features view.
      const [monitorRes, toolRes] = await Promise.all([
        fetch(`/api/admin/logs/monitor`),
        fetch(`/api/admin/logs/engagement?range=24h&all=1`).catch(() => null),
      ]);
      if (!monitorRes.ok) {
        const err = await monitorRes.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${monitorRes.status}`);
      }
      setData(await monitorRes.json());
      setLastRefresh(new Date());

      if (toolRes && toolRes.ok) {
        const toolData = await toolRes.json();
        setToolUsage(toolData.allMapped ?? []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load monitor");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const usedTools = toolUsage.filter((t) => t.hits > 0);
  const unusedTools = toolUsage.filter((t) => t.hits === 0);
  const maxHits = Math.max(...usedTools.map((t) => t.hits), 1);

  const alarmColor = (state: string) =>
    state === "ALARM" ? "bg-red-500/20 text-red-300 border-red-500/40"
    : state === "OK" ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
    : "bg-[var(--surface-2)] text-[var(--muted)] border-[var(--border)]";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-[var(--fg)]">Infrastructure health</h3>
          <p className="text-xs text-[var(--muted)]">
            Last hour of ECS / Lambda metrics + alarm state + budget.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {lastRefresh && (
            <span className="text-[10px] text-[var(--muted)]">
              Refreshed {Math.round((Date.now() - lastRefresh.getTime()) / 1000)}s ago
            </span>
          )}
          <button onClick={fetchData} disabled={loading} className="text-xs px-3 py-1 rounded border border-[var(--border)] hover:border-[var(--accent)] disabled:opacity-50">
            {loading ? "Loading…" : "🔄 Refresh"}
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded bg-red-500/10 border border-red-500/30 text-xs text-red-400">{error}</div>
      )}

      {!error && data && (
        <>
          {/* Recommendations banner */}
          {data.recommendations.length > 0 && (
            <div className="p-3 rounded bg-amber-500/10 border border-amber-500/30 text-xs text-amber-300 space-y-1">
              <div className="font-medium">💡 Recommendations</div>
              <ul className="list-disc list-inside space-y-0.5 text-amber-200/90">
                {data.recommendations.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            </div>
          )}

          {/* Metric cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="rounded border border-[var(--border)] p-3">
              <div className="text-[10px] text-[var(--muted)] uppercase">ECS CPU (last 60m)</div>
              <div className="text-lg font-mono mt-1">{data.ecs.cpuNow.toFixed(1)}%</div>
              <Sparkline data={data.ecs.cpuLast60m} />
            </div>
            <div className="rounded border border-[var(--border)] p-3">
              <div className="text-[10px] text-[var(--muted)] uppercase">ECS Memory</div>
              <div className="text-lg font-mono mt-1">{data.ecs.memNow.toFixed(1)}%</div>
              <Sparkline data={data.ecs.memLast60m} />
            </div>
            <div className="rounded border border-[var(--border)] p-3">
              <div className="text-[10px] text-[var(--muted)] uppercase">Lambda (60m)</div>
              <div className="text-lg font-mono mt-1">{data.lambda.invocationsLast60m.toFixed(0)}</div>
              <div className="text-[10px] text-[var(--muted)]">invocations · {data.lambda.throttlesLast60m} throttled</div>
              <Sparkline data={data.lambda.invocationsSeries} />
            </div>
            {data.budget && (
              <div className="rounded border border-[var(--border)] p-3">
                <div className="text-[10px] text-[var(--muted)] uppercase">Budget (mo.)</div>
                <div className="text-lg font-mono mt-1">${data.budget.spentUsd.toFixed(2)} / ${data.budget.limitUsd.toFixed(0)}</div>
                <div className="h-2 bg-[var(--surface-2)] rounded mt-2 overflow-hidden">
                  <div
                    className={`h-full ${data.budget.percentUsed > 80 ? "bg-red-500" : data.budget.percentUsed > 50 ? "bg-amber-500" : "bg-emerald-500"}`}
                    style={{ width: `${Math.min(100, data.budget.percentUsed)}%` }}
                  />
                </div>
                <div className="text-[10px] text-[var(--muted)] mt-1">Forecast: ${data.budget.forecastUsd.toFixed(0)}</div>
              </div>
            )}
          </div>

          {/* Tool usage (last 24h) */}
          {toolUsage.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <div>
                  <div className="text-xs text-[var(--muted)]">Tool usage — last 24h</div>
                  <div className="text-[10px] text-[var(--muted)]/80">
                    {usedTools.length} of {toolUsage.length} tools used. Every mapped API call is logged via CloudWatch.
                  </div>
                </div>
                {unusedTools.length > 0 && (
                  <button
                    onClick={() => setShowUnused((v) => !v)}
                    className="text-[10px] px-2 py-0.5 rounded border border-[var(--border)] hover:border-[var(--accent)] text-[var(--muted)] hover:text-[var(--fg)]"
                  >
                    {showUnused ? "Hide" : "Show"} unused ({unusedTools.length})
                  </button>
                )}
              </div>
              <div className="rounded border border-[var(--border)] overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-[var(--surface-2)]/50 text-[var(--muted)] text-[10px]">
                    <tr>
                      <th className="px-2 py-1.5 text-left">Tool</th>
                      <th className="px-2 py-1.5 text-right w-20">Calls</th>
                      <th className="px-2 py-1.5 text-right w-20">Users</th>
                      <th className="px-2 py-1.5 w-1/3"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {usedTools.map((t) => (
                      <tr key={t.feature} className="border-t border-[var(--border)]">
                        <td className="px-2 py-1 text-[var(--fg)]">{t.feature}</td>
                        <td className="px-2 py-1 text-right font-mono">{t.hits.toLocaleString()}</td>
                        <td className="px-2 py-1 text-right font-mono">{t.uniqueUsers.toLocaleString()}</td>
                        <td className="px-2 py-1">
                          <div className="h-1.5 bg-[var(--surface-2)] rounded overflow-hidden">
                            <div
                              className="h-full bg-[var(--accent)]/60"
                              style={{ width: `${(t.hits / maxHits) * 100}%` }}
                            />
                          </div>
                        </td>
                      </tr>
                    ))}
                    {showUnused && unusedTools.map((t) => (
                      <tr key={t.feature} className="border-t border-[var(--border)] opacity-50">
                        <td className="px-2 py-1 text-[var(--muted)]">{t.feature}</td>
                        <td className="px-2 py-1 text-right font-mono text-[var(--muted)]">0</td>
                        <td className="px-2 py-1 text-right font-mono text-[var(--muted)]">0</td>
                        <td className="px-2 py-1"></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Alarms row */}
          <div>
            <div className="text-xs text-[var(--muted)] mb-2">CloudWatch alarms</div>
            <div className="flex flex-wrap gap-2">
              {data.alarms.length === 0 ? (
                <span className="text-xs text-[var(--muted)] italic">No alarms configured</span>
              ) : (
                data.alarms.map((a) => (
                  <div
                    key={a.name}
                    className={`px-2 py-1 rounded border text-xs ${alarmColor(a.state)}`}
                    title={a.reason}
                  >
                    <span className="font-medium">{a.name.replace("blueprintparser-", "")}</span>
                    <span className="ml-2 font-mono text-[10px]">{a.state}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
