"use client";

// [TP-3 WP-3.L] "Low confidence (n) ▸": items below the server's threshold, folded under the main list so noise
// never pushes a real table off the first screen (C3-m7). Collapsed by default; opening it is per panel mount.

import { useState, type ReactNode } from "react";
import { FOCUS_RING } from "./WorkspaceHeader";

export default function LowConfidenceFold({ count, holdsSelection = false, children }: { count: number; holdsSelection?: boolean; children: ReactNode }) {
  const [toggled, setOpen] = useState(false);
  const open = toggled || holdsSelection;
  if (count === 0) return null;
  return (
    <div className="mt-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`w-full text-left px-2 py-0.5 text-[10px] text-[var(--muted)] hover:text-[var(--fg)] ${FOCUS_RING}`}
      >
        Low confidence ({count}) {open ? "▾" : "▸"}
      </button>
      {open ? <ul className="space-y-0.5">{children}</ul> : null}
    </div>
  );
}
