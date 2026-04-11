"use client";

import { useState } from "react";
import { BP_TOOLS, TOOL_GROUPS, ACTION_TOOL_NAMES } from "../constants";

/** Renders all 20 tools from src/lib/llm/tools.ts BP_TOOLS as cards. Data
 *  is sourced live from the real tool definitions so if tools.ts changes,
 *  the docs follow automatically. Click a group tab to filter. */
export function ToolCardGrid() {
  const [activeGroup, setActiveGroup] = useState<string>("all");

  // Build name -> tool def lookup
  const toolByName = new Map(BP_TOOLS.map((t) => [t.name, t]));

  // Determine visible names
  const visibleNames: string[] = (() => {
    if (activeGroup === "all") return BP_TOOLS.map((t) => t.name);
    const group = TOOL_GROUPS.find((g) => g.id === activeGroup);
    return group ? [...group.tools] : [];
  })();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1 items-center text-xs">
        <button
          onClick={() => setActiveGroup("all")}
          className={`px-3 py-1 rounded border ${
            activeGroup === "all"
              ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/10"
              : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]"
          }`}
        >
          All ({BP_TOOLS.length})
        </button>
        {TOOL_GROUPS.map((g) => (
          <button
            key={g.id}
            onClick={() => setActiveGroup(g.id)}
            className={`px-3 py-1 rounded border ${
              activeGroup === g.id
                ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/10"
                : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]"
            }`}
          >
            {g.label} ({g.tools.length})
          </button>
        ))}
      </div>

      {activeGroup !== "all" && (() => {
        const g = TOOL_GROUPS.find((x) => x.id === activeGroup);
        return g ? (
          <div className="text-[12px] text-[var(--muted)] italic">{g.description}</div>
        ) : null;
      })()}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {visibleNames.map((name) => {
          const tool = toolByName.get(name);
          if (!tool) return null;
          const params = (tool.input_schema?.properties ?? {}) as Record<string, { type?: string; description?: string }>;
          const required = (tool.input_schema?.required ?? []) as string[];
          const isAction = ACTION_TOOL_NAMES.has(name);
          return (
            <div
              key={name}
              className={`rounded border p-3 ${
                isAction
                  ? "border-amber-400/40 bg-amber-500/5"
                  : "border-[var(--border)] bg-[var(--surface)]/30"
              }`}
            >
              <div className="flex items-start justify-between gap-2 mb-1">
                <code className="font-mono font-bold text-[13px] text-[var(--accent)]">
                  {name}
                </code>
                {isAction && (
                  <span className="text-[9px] uppercase tracking-wider text-amber-400 border border-amber-400/50 px-1.5 py-0.5 rounded">
                    action
                  </span>
                )}
              </div>
              <p className="text-[12px] text-[var(--fg)]/80 leading-snug mb-2">{tool.description}</p>
              {Object.keys(params).length > 0 && (
                <ul className="space-y-0.5 text-[11px] font-mono">
                  {Object.entries(params).map(([pName, pMeta]) => (
                    <li key={pName}>
                      <span className="text-[var(--fg)]/90">{pName}</span>
                      <span className="text-[var(--muted)]">: {pMeta.type || "any"}</span>
                      {required.includes(pName) && <span className="text-red-400/70"> *</span>}
                    </li>
                  ))}
                </ul>
              )}
              {Object.keys(params).length === 0 && (
                <div className="text-[11px] text-[var(--muted)] italic">(no parameters)</div>
              )}
            </div>
          );
        })}
      </div>

      <div className="text-[10px] text-[var(--muted)] italic">
        Data is read live from <code className="font-mono">BP_TOOLS</code> in <code className="font-mono">src/lib/llm/tools.ts</code>. Total: {BP_TOOLS.length} tools.
      </div>
    </div>
  );
}
