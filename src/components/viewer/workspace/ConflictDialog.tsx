"use client";

// [TP-3 WP-3.M] The accept hit a saved region of the same family on this sheet (IoU ≥ .8; K36). Replace is
// PRE-SELECTED and ⏎ confirms the selected choice (C3-m2), including over a region saved by a classic tool
// (WP-3.G's conflict body does not say which tool saved it, so the dialog does not either); "Keep both" is the
// secondary choice. Keys are handled on the dialog only (onKeyDown + stopPropagation, never on
// `window`; §1.6 rule 14). Esc is not taken: it stays with ProposalFocusLayer, so Cancel is a button.

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ConflictInfo } from "@/queries/useCommitStructure";
import { FOCUS_RING, wsButton } from "./WorkspaceHeader";

export type ConflictChoice = "replace" | "keep-both";

export default function ConflictDialog({
  conflict,
  onConfirm,
  onCancel,
}: {
  conflict: ConflictInfo;
  onConfirm: (choice: ConflictChoice) => void;
  onCancel: () => void;
}) {
  const [choice, setChoice] = useState<ConflictChoice>("replace");
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter" || e.altKey || e.ctrlKey || e.metaKey) return;
    // A focused Cancel keeps its own meaning; anywhere else in the dialog ⏎ confirms the selected choice.
    if (e.target instanceof HTMLElement && e.target.dataset.role === "cancel") return;
    e.preventDefault();
    e.stopPropagation();
    onConfirm(choice);
  };

  const what = conflict.title ? `"${conflict.title}"` : "a saved region";
  return (
    <div
      role="dialog"
      aria-label="Overlapping saved region"
      onKeyDown={onKeyDown}
      className="flex flex-col gap-1 rounded border border-amber-400/50 bg-amber-400/10 p-2 text-[11px]"
    >
      <p className="text-[var(--fg)]">This box overlaps {what} on this sheet.</p>
      <div role="radiogroup" aria-label="What to do" className="flex flex-col gap-0.5">
        {([["replace", "Replace it with this one"], ["keep-both", "Keep both"]] as const).map(([value, label]) => (
          <label key={value} className={`flex items-center gap-1 ${FOCUS_RING}`}>
            <input type="radio" name="ws-conflict" value={value} checked={choice === value} onChange={() => setChoice(value)} />
            {label}
          </label>
        ))}
      </div>
      <div className="flex gap-1">
        <button ref={confirmRef} type="button" onClick={() => onConfirm(choice)} className={wsButton(true)}>
          {choice === "replace" ? "Replace" : "Keep both"} ⏎
        </button>
        <button type="button" data-role="cancel" onClick={onCancel} className={wsButton(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
