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

export default function LogsMonitor() {
  const [data, setData] = useState<MonitorResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/logs/monitor`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      setData(await res.json());
      setLastRefresh(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load monitor");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

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
