"use client";

// [2026-10-24 master Reprocess tab] The one progress console. Every stage of a plan appends to the
// same log (lines come from reprocess-client.ts's formatReprocessEvent for the NDJSON scopes and from
// the cleanup result for the annotation stages), with a stage strip above it like the old Overview
// "Re-run All" card had. Lines keep their meaning by prefix: "---" = stage header, "  ERROR" / "  WARNING"
// = the server's per-project lines (they are no longer dropped anywhere).

import { useState } from "react";

interface ReprocessConsoleProps {
  log: string[];
  running: boolean;
  /** Labels of the stages in run order; `stageIndex` is the one running (-1 = none). */
  stages: string[];
  stageIndex: number;
}

function lineClass(line: string): string {
  if (line.startsWith("---")) return "text-cyan-400 font-semibold";
  if (line.startsWith("  ERROR") || line.startsWith("Error") || line.startsWith("Failed")) return "text-red-400";
  if (line.startsWith("  WARNING")) return "text-amber-400";
  return "";
}

export default function ReprocessConsole({ log, running, stages, stageIndex }: ReprocessConsoleProps) {
  const [copied, setCopied] = useState(false);
  if (log.length === 0 && !running) return null;
  const finished = !running && log.length > 0;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(log.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable (http, permissions) — nothing to do */ }
  };

  return (
    <div className="space-y-2" data-testid="reprocess-console">
      {stages.length > 0 && (
        <div className="flex gap-1 items-center flex-wrap">
          {stages.map((label, i) => (
            <div key={`${label}-${i}`} className="flex items-center gap-1">
              <div
                className={`w-2 h-2 rounded-full ${
                  i < stageIndex || finished ? "bg-emerald-400" : i === stageIndex ? "bg-cyan-400 animate-pulse" : "bg-[var(--border)]"
                }`}
              />
              <span className={`text-[9px] ${i === stageIndex && running ? "text-cyan-400" : "text-[var(--muted)]"}`}>{label}</span>
              {i < stages.length - 1 && <span className="text-[var(--border)] text-[9px] mx-0.5">&rarr;</span>}
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-[var(--muted)]">
          {running ? `Running stage ${stageIndex + 1}/${stages.length}: ${stages[stageIndex] ?? ""}` : `${log.length} log line${log.length === 1 ? "" : "s"}`}
        </span>
        <button onClick={copy} className="text-[10px] text-[var(--accent)] hover:underline">
          {copied ? "Copied" : "Copy log"}
        </button>
      </div>
      <div className="max-h-72 overflow-y-auto bg-[var(--bg)] rounded p-2 text-[10px] font-mono text-[var(--muted)] border border-[var(--border)]">
        {log.map((line, i) => (
          <div key={i} className={lineClass(line)}>{line}</div>
        ))}
      </div>
    </div>
  );
}
