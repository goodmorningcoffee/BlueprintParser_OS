"use client";

// [TP-3 WP-3.M] The evidence under the box changed after it was parsed (a re-scan, a re-OCR). The server
// re-parsed it, re-applied every correction by id, and returned the result: one click (or ⏎) accepts it
// again (C3-m1). If a correction no longer landed, the server refuses instead and this note never shows.

import { useEffect, useRef, type KeyboardEvent } from "react";
import { wsButton } from "./WorkspaceHeader";

export default function RebaseNote({
  changedRows,
  onConfirm,
  onCancel,
}: {
  changedRows: number | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirmRef.current?.focus();
  }, []);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter" || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.target instanceof HTMLElement && e.target.dataset.role === "cancel") return;
    e.preventDefault();
    e.stopPropagation();
    onConfirm();
  };
  const what = changedRows === null ? "The page changed" : `${changedRows} row${changedRows === 1 ? "" : "s"} changed`;
  return (
    <div role="alert" aria-label="Re-scanned" onKeyDown={onKeyDown} className="flex flex-wrap items-center gap-1 rounded border border-sky-400/50 bg-sky-400/10 p-1.5 text-[11px]">
      <span className="flex-1 text-[var(--fg)]">{what} after re-scan</span>
      <button ref={confirmRef} type="button" onClick={onConfirm} className={wsButton(true)}>
        Accept again ⏎
      </button>
      <button type="button" data-role="cancel" onClick={onCancel} className={wsButton(false)}>
        Not now
      </button>
    </div>
  );
}
