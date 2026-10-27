"use client";

// [TP-3 WP-3.L] The workspace's right panel (PLAN §3.1): header, inbox, and (WP-3.M) the item detail below the
// selected row. 420 px wide by default, resizable from its left edge with pointer capture (no window listeners).
// Keys are handled HERE, on the panel, never on `window` (§1.6 rule 14): J / K move through the inbox's visible
// order, Enter opens the selected item. Typing in a field is never hijacked, and handled keys stop propagating.
// Esc stays owned by ProposalFocusLayer.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { isEditableKeyboardTarget } from "@/lib/keyboard-target";
import { EMPTY_ITEMS, inboxView, useWorkspaceItems, type WorkspaceItem } from "@/queries/useWorkspaceItems";
import { useSessionStore } from "@/stores/sessionStore";
import { useTablesWorkspaceStore } from "@/stores/tablesWorkspaceStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import { next, openItem, prev } from "@/stores/workspaceCommands";
import EmptyState, { type EmptyReason } from "./EmptyState";
import InboxList from "./InboxList";
import WorkspaceHeader from "./WorkspaceHeader";

export const PANEL_WIDTH = { initial: 420, min: 320, max: 720 } as const;

function emptyReason(error: boolean, total: number, todo: number, filter: string): EmptyReason {
  if (error) return "error";
  if (total === 0) return "none";
  if (filter === "todo" && todo === 0) return "reviewed";
  return "filtered";
}

export default function TablesWorkspacePanel() {
  const publicId = useSessionStore((s) => s.publicId);
  const pageNumber = useViewerCoreStore((s) => s.pageNumber);
  const scope = useTablesWorkspaceStore((s) => s.scope);
  const filter = useTablesWorkspaceStore((s) => s.filter);
  const kinds = useTablesWorkspaceStore((s) => s.kinds);
  const selectedKey = useTablesWorkspaceStore((s) => s.selectedKey);
  const { data, isLoading, error } = useWorkspaceItems(publicId, scope, pageNumber);
  const items = data ?? EMPTY_ITEMS;
  const view = useMemo(() => inboxView(items, kinds, filter), [items, kinds, filter]);
  const [width, setWidth] = useState<number>(PANEL_WIDTH.initial);
  const drag = useRef<{ x: number; width: number } | null>(null);

  // The visible order (main rows, then the fold) is what J / K and "Accept & next" walk. `ordered` is stable
  // between renders unless the read, the kinds or the filter change (the query cache keeps `data` identity).
  const ordered = useMemo(() => [...view.rows, ...view.low], [view]);
  useEffect(() => {
    useTablesWorkspaceStore.getState().setQueue(ordered);
  }, [ordered]);

  const onOpen = (item: WorkspaceItem) => {
    openItem(item);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey || isEditableKeyboardTarget(e.target)) return;
    const key = e.key.toLowerCase();
    if (key === "j") next();
    else if (key === "k") prev();
    else if (e.key === "Enter") {
      const target = ordered.find((i) => i.id === selectedKey);
      if (!target) return;
      openItem(target);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const onResizeDown = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = { x: e.clientX, width };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onResizeMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const nextWidth = drag.current.width + (drag.current.x - e.clientX);
    setWidth(Math.max(PANEL_WIDTH.min, Math.min(PANEL_WIDTH.max, nextWidth)));
  };
  const onResizeUp = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  const showEmpty = !isLoading && view.rows.length === 0 && view.low.length === 0;
  return (
    <aside
      aria-label="Tables and notes workspace"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      style={{ width }}
      className="relative flex flex-col h-full border border-[var(--border)] bg-[var(--surface)] shadow-lg outline-none"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize workspace"
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        className="absolute left-0 top-0 h-full w-1 cursor-col-resize hover:bg-[var(--accent)]/40"
      />
      <WorkspaceHeader counts={data ? view.counts : null} />
      <div className="flex-1 overflow-y-auto px-1 py-1">
        {isLoading ? <p className="px-2 py-3 text-[11px] text-[var(--muted)]">Loading…</p> : null}
        {showEmpty ? (
          <EmptyState reason={emptyReason(!!error, view.total, view.counts.todo, filter)} scope={scope} />
        ) : (
          <InboxList data={items} rows={view.rows} low={view.low} pageNumber={pageNumber} onOpen={onOpen} />
        )}
      </div>
    </aside>
  );
}
