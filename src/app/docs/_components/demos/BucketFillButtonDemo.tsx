"use client";

import { useState } from "react";

type ButtonState = "disabled" | "idle" | "active" | "barrier";

/** Tri-state Bucket Fill button mirroring AreaTab.tsx:325-369. Click
 *  to cycle through the states so readers can see the styling difference. */
export function BucketFillButtonDemo() {
  const [state, setState] = useState<ButtonState>("disabled");
  const next: Record<ButtonState, ButtonState> = {
    disabled: "idle",
    idle: "active",
    active: "barrier",
    barrier: "disabled",
  };

  const className = (() => {
    switch (state) {
      case "disabled":
        return "border-[var(--border)] text-[var(--muted)]/40 cursor-not-allowed";
      case "idle":
        return "border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] hover:border-[var(--accent)]";
      case "active":
        return "border-cyan-400/60 text-cyan-300 bg-cyan-400/10";
      case "barrier":
        return "border-red-400/60 text-red-300 bg-red-400/10";
    }
  })();

  const hint = (() => {
    switch (state) {
      case "disabled":
        return "No active area item — bucket fill is locked until you pick a target.";
      case "idle":
        return "Ready. Click to arm, then click inside a room.";
      case "active":
        return "Armed. Click inside a room; AI traces the boundary.";
      case "barrier":
        return "Barrier mode: draw lines across doorways to seal an open room.";
    }
  })();

  return (
    <div className="space-y-3 max-w-md">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setState(next[state])}
          className={`flex items-center gap-1.5 text-[11px] px-2 py-1 rounded border transition-colors ${className}`}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M16 2v5h5" />
            <path d="M21 6v6.5c0 .8-.7 1.5-1.5 1.5h-2l-3.5 4-3.5-4h-2C7.7 14 7 13.3 7 12.5V6c0-.8.7-1.5 1.5-1.5H19l2 1.5Z" />
          </svg>
          Bucket Fill
        </button>
        {state === "barrier" && (
          <span className="text-[10px] text-red-300">barriers: 2</span>
        )}
        <span className="text-[10px] text-[var(--muted)] font-mono ml-auto">state = &quot;{state}&quot;</span>
      </div>
      <div className="text-[11px] text-[var(--muted)] leading-relaxed">{hint}</div>
      <div className="text-[10px] text-[var(--muted)]/70 italic">
        (Click the button to cycle through states.)
      </div>
    </div>
  );
}
