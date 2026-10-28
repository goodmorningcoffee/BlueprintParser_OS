"use client";

// [TP-3 WP-3.M] "Accept all Notes/Specs ≥ agreement x" (C3-M5b; PLAN §3.3 C "Bulk"). Shown under the inbox while
// the Notes/Specs chips are on. It takes the To-review notes and spec items the inbox shows (This sheet: the
// sheet on screen; All sheets: every sheet in the read), parses each at `instant`, and commits the ones whose
// fused agreement is at least x, ONE AT A TIME, stopping at the first item that does not commit cleanly (a
// conflict, a rebase, a refused parse). Items with corrections pending are left for their own review.
// Two steps: open the dialog (choose x), then confirm with the count in the button.

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { bulkAcceptItems, type BulkAcceptReport } from "@/queries/useCommitStructure";
import type { WorkspaceItem } from "@/queries/useWorkspaceItems";
import { useSessionStore } from "@/stores/sessionStore";
import { useTablesWorkspaceStore } from "@/stores/tablesWorkspaceStore";
import { wsButton } from "./WorkspaceHeader";

export const DEFAULT_MIN_AGREEMENT = 0.8;

/** The items a bulk accept may take from the inbox's visible order (exported for tests). */
export function bulkAcceptable(items: readonly WorkspaceItem[], scope: "sheet" | "all", pageNumber: number): WorkspaceItem[] {
  return items.filter((i) => (i.kind === "notes" || i.kind === "spec") && i.state === "todo" &&
    (scope === "all" || i.page === pageNumber));
}

function reportText(r: BulkAcceptReport, total: number): string {
  const head = `Accepted ${r.saved} of ${total}`;
  const skipped = r.skipped > 0 ? ` · ${r.skipped} left for review` : "";
  const name = r.stopped ? (r.stopped.item as Partial<WorkspaceItem>).title || r.stopped.item.id : "";
  const stopped = r.stopped ? ` · stopped at "${name}": ${r.stopped.reason}` : "";
  return `${head}${skipped}${stopped}.`;
}

export default function BulkAcceptDialog({ items, pageNumber }: { items: readonly WorkspaceItem[]; pageNumber: number }) {
  const qc = useQueryClient();
  const publicId = useSessionStore((s) => s.publicId);
  const isDemo = useSessionStore((s) => s.isDemo);
  const scope = useTablesWorkspaceStore((s) => s.scope);
  const kinds = useTablesWorkspaceStore((s) => s.kinds);
  const [open, setOpen] = useState(false);
  const [minAgreement, setMinAgreement] = useState(DEFAULT_MIN_AGREEMENT);
  const [progress, setProgress] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const targets = bulkAcceptable(items, scope, pageNumber);
  if (isDemo || !(kinds.includes("notes") || kinds.includes("spec"))) return null;
  if (targets.length === 0 && !message) return null;

  const run = async () => {
    setProgress(0);
    setMessage(null);
    const report = await bulkAcceptItems(qc, { publicId, isDemo }, targets, minAgreement, setProgress);
    setProgress(null);
    setOpen(false);
    setMessage(reportText(report, targets.length));
  };

  const where = scope === "all" ? "all sheets" : "this sheet";
  return (
    <div className="flex flex-col gap-1 px-1 pt-1 border-t border-[var(--border)] text-[10px]">
      {open ? (
        <div role="dialog" aria-label="Accept all notes and specs" className="flex flex-col gap-1 rounded border border-[var(--border)] p-1.5">
          <label className="flex items-center gap-1 text-[var(--muted)]">
            Agreement at least
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={minAgreement}
              onChange={(e) => setMinAgreement(Math.max(0, Math.min(1, Number(e.target.value) || 0)))}
              className="w-14 bg-transparent border border-[var(--border)] rounded px-1 text-[var(--fg)]"
            />
          </label>
          <div className="flex gap-1">
            <button type="button" disabled={progress !== null || targets.length === 0} onClick={() => void run()} className={`${wsButton(true)} disabled:opacity-50`}>
              Accept {targets.length} on {where}
            </button>
            <button type="button" disabled={progress !== null} onClick={() => setOpen(false)} className={wsButton(false)}>
              Cancel
            </button>
          </div>
          {progress !== null ? <p role="status" className="text-[var(--muted)]">Working… {progress} / {targets.length}</p> : null}
        </div>
      ) : targets.length > 0 ? (
        <button type="button" onClick={() => setOpen(true)} className={`${wsButton(false)} self-start`}>
          Accept all Notes/Specs ≥ agreement… ({targets.length})
        </button>
      ) : null}
      {message ? <p role="status" className="text-[var(--muted)]">{message}</p> : null}
    </div>
  );
}
