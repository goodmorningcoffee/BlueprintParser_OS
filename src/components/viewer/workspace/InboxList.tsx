"use client";

// [TP-3 WP-3.L] The inbox list (PLAN §3.1). This sheet: rows sorted by `tableP × p`, then the low-confidence fold.
// All sheets: one collapsible group per sheet from the project-level read; expanding a sheet loads that sheet's
// detail read (which also carries its low-confidence items). Bulk "Not a table: rest of this sheet" (This sheet
// scope) rejects the To-review rows the user can SEE: the main list, plus the low-confidence fold only while it is
// open, and only proposals and text regions — the verdict route refuses the classified-table / ensemble items,
// and a reject is a negative label, so it is never recorded on an unseen row (WP-3.L verify MED-1). Two-step
// confirm; sequential; stops on the first failure.

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  bulkRejectable,
  inboxView,
  rejectItems,
  useWorkspaceItems,
  type WorkspaceItem,
} from "@/queries/useWorkspaceItems";
import { useSessionStore } from "@/stores/sessionStore";
import { useTablesWorkspaceStore } from "@/stores/tablesWorkspaceStore";
import InboxRow from "./InboxRow";
import LowConfidenceFold from "./LowConfidenceFold";
import { FOCUS_RING, wsButton } from "./WorkspaceHeader";

export function sheetLabelOf(page: number, drawingNumbers: Record<number, string | null>, names: Record<number, string>): string {
  return drawingNumbers[page] || names[page] || `Page ${page}`;
}

function groupByPage(items: readonly WorkspaceItem[]): [number, WorkspaceItem[]][] {
  const byPage = new Map<number, WorkspaceItem[]>();
  for (const item of items) byPage.set(item.page, [...(byPage.get(item.page) ?? []), item]);
  return [...byPage.entries()].sort((a, b) => a[0] - b[0]);
}

function SheetGroup({
  page,
  fallback,
  label,
  selectedKey,
  onOpen,
}: {
  page: number;
  fallback: WorkspaceItem[];
  label: string;
  selectedKey: string | null;
  onOpen: (item: WorkspaceItem) => void;
}) {
  const [open, setOpen] = useState(false);
  const publicId = useSessionStore((s) => s.publicId);
  const kinds = useTablesWorkspaceStore((s) => s.kinds);
  const filter = useTablesWorkspaceStore((s) => s.filter);
  const { data } = useWorkspaceItems(publicId, "sheet", page, open);
  const detail = data ? inboxView(data, kinds, filter) : null;
  const rows = detail ? detail.rows : fallback;
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`w-full text-left px-1 py-0.5 text-[10px] uppercase tracking-wide text-[var(--muted)] hover:text-[var(--fg)] ${FOCUS_RING}`}
      >
        {open ? "▾" : "▸"} {label} ({fallback.length})
      </button>
      {open ? (
        <ul className="space-y-0.5">
          {rows.map((item) => (
            <InboxRow key={item.id} item={item} selected={item.id === selectedKey} onOpen={onOpen} />
          ))}
          {detail ? (
            <LowConfidenceFold count={detail.low.length} holdsSelection={detail.low.some((i) => i.id === selectedKey)}>
              {detail.low.map((item) => (
                <InboxRow key={item.id} item={item} selected={item.id === selectedKey} onOpen={onOpen} />
              ))}
            </LowConfidenceFold>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}

export default function InboxList({
  rows,
  low,
  pageNumber,
  onOpen,
}: {
  rows: WorkspaceItem[];
  low: WorkspaceItem[];
  pageNumber: number;
  onOpen: (item: WorkspaceItem) => void;
}) {
  const qc = useQueryClient();
  const publicId = useSessionStore((s) => s.publicId);
  const isDemo = useSessionStore((s) => s.isDemo);
  const drawingNumbers = useSessionStore((s) => s.pageDrawingNumbers);
  const pageNames = useSessionStore((s) => s.pageNames);
  const scope = useTablesWorkspaceStore((s) => s.scope);
  const selectedKey = useTablesWorkspaceStore((s) => s.selectedKey);
  const [lowOpen, setLowOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // The visible rows of the sheet on screen (`rows`/`low` are already kind- and filter-filtered); the fold opens
  // by its toggle or because it holds the selection.
  const lowVisible = lowOpen || low.some((i) => i.id === selectedKey);
  const rest = scope !== "sheet" ? [] : [...rows, ...(lowVisible ? low : [])].filter((i) =>
    i.page === pageNumber && i.id !== selectedKey && bulkRejectable(i));

  const rejectRest = async () => {
    setBusy(true);
    setMessage(null);
    const { saved, error } = await rejectItems(qc, publicId, rest);
    setBusy(false);
    setConfirming(false);
    setMessage(error ? `Saved ${saved}, then stopped: ${error}` : `Marked ${saved} as not a table.`);
  };

  return (
    <div className="flex flex-col gap-1">
      {scope === "sheet" ? (
        <>
          <ul className="space-y-0.5" aria-label="Inbox">
            {rows.map((item) => (
              <InboxRow key={item.id} item={item} selected={item.id === selectedKey} onOpen={onOpen} />
            ))}
          </ul>
          <LowConfidenceFold count={low.length} holdsSelection={low.some((i) => i.id === selectedKey)} open={lowOpen} onToggle={setLowOpen}>
            {low.map((item) => (
              <InboxRow key={item.id} item={item} selected={item.id === selectedKey} onOpen={onOpen} />
            ))}
          </LowConfidenceFold>
        </>
      ) : (
        <ul className="space-y-1" aria-label="Inbox by sheet">
          {groupByPage([...rows, ...low]).map(([page, items]) => (
            <SheetGroup
              key={page}
              page={page}
              fallback={items}
              label={sheetLabelOf(page, drawingNumbers, pageNames)}
              selectedKey={selectedKey}
              onOpen={onOpen}
            />
          ))}
        </ul>
      )}
      {!isDemo && rest.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1 px-1 pt-1 border-t border-[var(--border)]">
          {confirming ? (
            <>
              <button type="button" disabled={busy} onClick={() => void rejectRest()} className={`${wsButton(true)} disabled:opacity-50`}>
                Confirm: {rest.length} not a table
              </button>
              <button type="button" disabled={busy} onClick={() => setConfirming(false)} className={wsButton(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirming(true)} className={wsButton(false)}>
              Not a table: rest of this sheet ({rest.length})
            </button>
          )}
        </div>
      ) : null}
      {message ? <p role="status" className="px-1 text-[10px] text-[var(--muted)]">{message}</p> : null}
    </div>
  );
}
