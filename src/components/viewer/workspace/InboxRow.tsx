"use client";

// [TP-3 WP-3.L] One inbox row (PLAN §3.1): kind icon · title · confidence · chips (⬡ shapes · Textract ✓ · n cols ·
// n ¶) · status. Hover → soft outline on the canvas (proposalFocusStore.hover); click → focus + open.
// Chips show only what the items read carries (WP-3.F): a proposal's tag rows, a classic-saved region, and the
// stale badge once WP-5.A sends it. The plan's shape / Textract / column / paragraph chips need fields the read
// does not have yet, so they are not invented here (WP-3.L verify HIGH-1).

import { useEffect } from "react";
import type { WorkspaceItem } from "@/queries/useWorkspaceItems";
import { itemScore } from "@/queries/useWorkspaceItems";
import { useProposalFocusStore } from "@/stores/proposalFocusStore";
import { useSessionStore } from "@/stores/sessionStore";
import { FOCUS_RING, KIND_LABELS } from "./WorkspaceHeader";

const KIND_ICONS: Readonly<Record<WorkspaceItem["kind"], string>> = {
  schedule: "▦",
  keynote: "◆",
  legend: "◈",
  notes: "¶",
  spec: "§",
};

const STATE_LABELS: Readonly<Record<WorkspaceItem["state"], string>> = {
  todo: "to review",
  parsed: "parsed",
  rejected: "rejected",
};

export function rowChips(item: WorkspaceItem): string[] {
  const out: string[] = [];
  if (item.tagRows) out.push(`⬡ ${item.tagRows} tags`);
  if (item.regionOrigin === "classic") out.push("classic");
  if (item.stale) out.push("stale");
  return out;
}

export default function InboxRow({
  item,
  selected,
  sheetLabel,
  onOpen,
}: {
  item: WorkspaceItem;
  selected: boolean;
  sheetLabel?: string | null;
  onOpen: (item: WorkspaceItem) => void;
}) {
  const publicId = useSessionStore((s) => s.publicId);
  const setHover = useProposalFocusStore((s) => s.setHover);
  const focusId = item.proposalId ?? item.id;
  // A click that pages the viewer unmounts the row without a mouseleave: drop this row's outline (verify LOW-2).
  useEffect(() => () => {
    const focus = useProposalFocusStore.getState();
    if (focus.hover?.proposalId === focusId) focus.setHover(null);
  }, [focusId]);
  const title = item.title?.trim() || `Untitled ${KIND_LABELS[item.kind].replace(/s$/, "").toLowerCase()}`;
  const chips = rowChips(item);
  return (
    <li>
      <button
        type="button"
        data-item-id={item.id}
        aria-current={selected ? "true" : undefined}
        onClick={() => onOpen(item)}
        onMouseEnter={() => setHover({ publicId, proposalId: focusId, pageNumber: item.page, bbox: item.b })}
        onMouseLeave={() => setHover(null)}
        className={`w-full text-left px-2 py-1 rounded border text-[11px] ${FOCUS_RING} ${
          selected ? "border-[#00E676]/60 bg-[#00E676]/10" : "border-transparent hover:border-[var(--border)]"
        }`}
      >
        <div className="flex items-center gap-1.5">
          <span aria-label={KIND_LABELS[item.kind]} className="text-[var(--muted)]">{KIND_ICONS[item.kind]}</span>
          <span className="truncate flex-1 text-[var(--fg)]">{title}</span>
          <span className="text-[10px] text-[var(--muted)] tabular-nums">{Math.round(itemScore(item) * 100)}%</span>
        </div>
        <div className="flex flex-wrap items-center gap-1 pl-4 text-[10px] text-[var(--muted)]">
          {sheetLabel ? <span>{sheetLabel}</span> : null}
          {chips.map((chip) => (
            <span key={chip} className="px-1 rounded bg-[var(--border)]/40">{chip}</span>
          ))}
          <span className="ml-auto">{STATE_LABELS[item.state]}</span>
        </div>
      </button>
    </li>
  );
}
