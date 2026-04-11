"use client";

import { useState } from "react";

/** STEP_SEQUENCE from AutoQtoTab.tsx:11 verbatim. */
const STEPS = ["select-schedule", "confirm-tags", "map-tags", "review", "done"] as const;

const LABELS: Record<(typeof STEPS)[number], string> = {
  "select-schedule": "Select Schedule",
  "confirm-tags": "Confirm Tags",
  "map-tags": "Map Tags",
  review: "Review",
  done: "Done",
};

export function AutoQtoProgressBar() {
  const [current, setCurrent] = useState(1);

  return (
    <div className="space-y-3">
      <ol className="flex items-center gap-1">
        {STEPS.map((step, i) => {
          const state = i < current ? "done" : i === current ? "active" : "pending";
          return (
            <li key={step} className="flex items-center gap-1 flex-1">
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <div
                  className={`w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold font-mono shrink-0 border ${
                    state === "done"
                      ? "bg-emerald-500/20 border-emerald-400/60 text-emerald-300"
                      : state === "active"
                      ? "bg-[var(--accent)]/20 border-[var(--accent)] text-[var(--accent)]"
                      : "border-[var(--border)] text-[var(--muted)]"
                  }`}
                >
                  {state === "done" ? "✓" : i + 1}
                </div>
                <span
                  className={`text-[11px] truncate ${
                    state === "pending" ? "text-[var(--muted)]" : "text-[var(--fg)]"
                  }`}
                >
                  {LABELS[step]}
                </span>
              </div>
              {i < STEPS.length - 1 && (
                <div
                  className={`h-px flex-1 mx-1 ${
                    i < current ? "bg-emerald-400/40" : "bg-[var(--border)]"
                  }`}
                />
              )}
            </li>
          );
        })}
      </ol>
      <div className="flex items-center gap-2">
        <button
          onClick={() => setCurrent((c) => Math.max(0, c - 1))}
          className="text-[11px] px-2 py-0.5 border border-[var(--border)] rounded text-[var(--muted)] hover:text-[var(--fg)]"
        >
          ← Back
        </button>
        <button
          onClick={() => setCurrent((c) => Math.min(STEPS.length - 1, c + 1))}
          className="text-[11px] px-2 py-0.5 border border-[var(--accent)] rounded text-[var(--accent)] hover:bg-[var(--accent)]/10"
        >
          Next →
        </button>
        <span className="text-[10px] font-mono text-[var(--muted)] ml-auto">
          step = &quot;{STEPS[current]}&quot;
        </span>
      </div>
    </div>
  );
}
