"use client";

// [TP-3 WP-3.L] "Low confidence (n) ▸": items below the server's threshold, folded under the main list so noise
// never pushes a real table off the first screen (C3-m7). Collapsed by default; opening it is per panel mount.

import { useState, type ReactNode } from "react";
import { FOCUS_RING } from "./WorkspaceHeader";

// The owner may control the toggle (`open` + `onToggle`) when it needs to know what is on screen: the bulk
// "Not a table" acts only on rows the user can see (WP-3.L verify MED-1).
export default function LowConfidenceFold({
  count,
  holdsSelection = false,
  open: controlled,
  onToggle,
  children,
}: {
  count: number;
  holdsSelection?: boolean;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  children: ReactNode;
}) {
  const [local, setLocal] = useState(false);
  const toggled = controlled ?? local;
  const setOpen = (fn: (v: boolean) => boolean) => {
    const nextOpen = fn(toggled);
    if (controlled === undefined) setLocal(nextOpen);
    onToggle?.(nextOpen);
  };
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
