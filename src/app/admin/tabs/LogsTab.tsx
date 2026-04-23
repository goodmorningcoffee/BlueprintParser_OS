"use client";

import { useState } from "react";
import LogsEngagement from "./LogsEngagement";
import LogsVisitors from "./LogsVisitors";
import LogsSecurity from "./LogsSecurity";
import LogsMonitor from "./LogsMonitor";

export type LogsSubtab = "engagement" | "visitors" | "security" | "monitor";
export type LogsRange = "1h" | "24h" | "7d" | "30d";

const SUBTABS: { id: LogsSubtab; label: string; hint: string }[] = [
  { id: "engagement", label: "Engagement", hint: "Top 10 features used — who loves BP" },
  { id: "visitors", label: "Visitors", hint: "IPs, countries, durations, ban actions" },
  { id: "security", label: "Security", hint: "Abuse events, banned IPs" },
  { id: "monitor", label: "Monitor", hint: "ECS / Lambda / RDS / budget" },
];

export default function LogsTab() {
  const [active, setActive] = useState<LogsSubtab>("engagement");
  const [range, setRange] = useState<LogsRange>("24h");

  return (
    <div className="space-y-4">
      {/* Sub-tab selector + global range */}
      <div className="flex items-center justify-between border-b border-[var(--border)] pb-2">
        <div className="flex gap-1">
          {SUBTABS.map((s) => (
            <button
              key={s.id}
              onClick={() => setActive(s.id)}
              title={s.hint}
              className={`px-3 py-1.5 text-sm font-medium rounded ${
                active === s.id
                  ? "bg-[var(--accent)]/15 text-[var(--accent)]"
                  : "text-[var(--muted)] hover:text-[var(--fg)] hover:bg-[var(--surface-2)]/50"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-[var(--muted)]">Window:</label>
          <select
            value={range}
            onChange={(e) => setRange(e.target.value as LogsRange)}
            className="text-xs px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg)] text-[var(--fg)]"
          >
            <option value="1h">Last 1 hour</option>
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
          </select>
        </div>
      </div>

      {/* Active subtab */}
      {active === "engagement" && <LogsEngagement range={range} />}
      {active === "visitors" && <LogsVisitors range={range} />}
      {active === "security" && <LogsSecurity />}
      {active === "monitor" && <LogsMonitor />}
    </div>
  );
}
