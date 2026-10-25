"use client";

// [clf visibility 2026-10-25] "Proposed tables" section of the View All panel: the classifier's proposals
// (projectIntelligence.proposals, every verdict state) grouped discipline → kind with counts, the same
// TreeSection / SubHeader / VisibilityEye pattern as the panel's other sections. Row click = the Tables
// list's focus behaviour (go to the page, green focus box via proposalFocusStore); the section eye draws
// ALL proposals on the current page (ProposalOutlinesLayer). A sibling of ViewAllPanel.tsx, which sits at
// its MAX_LINES ceiling; the panel owns the section's expand key, this file owns the nested ones.

import { useState } from "react";
import type { ProposalSummaryItem } from "@/lib/classifier-engine/types";
import { useProposals } from "@/queries/useProposals";
import { useProposalFocusStore } from "@/stores/proposalFocusStore";
import { useSessionStore } from "@/stores/sessionStore";
import { navigateViewerPage } from "@/stores/viewerCommands";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import TreeSection from "./TreeSection";
import VisibilityEye from "./VisibilityEye";
import { buildProposalGroups, pct } from "./proposals/proposalList";

const VERDICT_LABEL = { accept: "accepted", reject: "not a table", rename: "renamed" } as const;

export interface ViewAllProposalsSectionProps {
  isExpanded: boolean;
  onToggleExpand: () => void;
  sheetLabel: (pageNumber: number) => string;
}

export default function ViewAllProposalsSection({ isExpanded, onToggleExpand, sheetLabel }: ViewAllProposalsSectionProps) {
  const summary = useProposals();
  const publicId = useSessionStore((s) => s.publicId);
  const pageNumber = useViewerCoreStore((s) => s.pageNumber);
  const focusedId = useProposalFocusStore((s) => (s.focus && s.focus.publicId === publicId ? s.focus.proposalId : null));
  const focusProposal = useProposalFocusStore((s) => s.focusProposal);
  const outlinesVisible = useProposalFocusStore((s) => s.outlinesVisible);
  const setOutlinesVisible = useProposalFocusStore((s) => s.setOutlinesVisible);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (k: string) => setOpen((s) => ({ ...s, [k]: !s[k] }));

  const items = summary?.items ?? [];
  const onPage = items.filter((i) => i.pageNumber === pageNumber).length;
  const groups = buildProposalGroups(items, { scope: "all", pageNumber });

  const focusItem = (item: ProposalSummaryItem) => {
    if (item.pageNumber !== useViewerCoreStore.getState().pageNumber) navigateViewerPage(item.pageNumber);
    focusProposal({ publicId, proposalId: item.id, pageNumber: item.pageNumber, bbox: item.bbox });
  };

  return (
    <TreeSection
      title="Proposed tables"
      count={summary?.total ?? 0}
      isExpanded={isExpanded}
      onToggleExpand={onToggleExpand}
      badge={
        items.length > 0 ? (
          <VisibilityEye
            state={outlinesVisible ? "all-visible" : "all-hidden"}
            onClick={() => setOutlinesVisible(!outlinesVisible)}
            variant="category"
            title={outlinesVisible ? "Hide proposal outlines on the canvas" : `Draw all proposals on the current page (${onPage} here)`}
          />
        ) : undefined
      }
    >
      {items.length === 0 && (
        <div className="px-4 py-2 text-[11px] text-[var(--muted)]">
          No proposed tables yet — run Admin › Reprocess › Classifiers (or Intelligence) on this project.
        </div>
      )}
      {summary?.truncated && (
        <div className="px-4 py-1 text-[10px] text-amber-300">Showing {items.length} of {summary.total} proposals.</div>
      )}
      {groups.map((group) => {
        const gKey = `proposals-${group.key}`;
        const gOpen = !!open[gKey];
        return (
          <div key={group.key}>
            <SubHeader label={group.label} count={group.count} isOpen={gOpen} onToggle={() => toggle(gKey)} />
            {gOpen &&
              group.kinds.map((kind) => {
                const kKey = `${gKey}-${kind.key}`;
                const kOpen = !!open[kKey];
                return (
                  <div key={kind.key}>
                    <SubHeader label={kind.label} count={kind.items.length} isOpen={kOpen} onToggle={() => toggle(kKey)} indent={2} />
                    {kOpen &&
                      kind.items.map((item) => {
                        const focused = item.id === focusedId;
                        const rejected = item.verdict === "reject";
                        return (
                          <div
                            key={item.id}
                            data-proposal-row={item.id}
                            className={`flex items-center gap-2 text-[11px] py-1 hover:bg-white/5 ${focused ? "bg-[#00E676]/10" : ""}`}
                            style={{ paddingLeft: 8 + 3 * 12 }}
                          >
                            <button
                              onClick={() => focusItem(item)}
                              aria-pressed={focused}
                              className={`flex items-center gap-2 flex-1 text-left truncate ${rejected ? "text-[var(--muted)] line-through opacity-60" : "text-[var(--fg)]"}`}
                              title={`detect ${pct(item.p)} · kind ${pct(item.nameP)}`}
                            >
                              <span className="truncate">{item.displayName}</span>
                              {item.verdict && <span className="inline-block text-[9px] text-[#00E676] shrink-0">{VERDICT_LABEL[item.verdict]}</span>}
                            </button>
                            <span className="text-[10px] text-[var(--muted)] shrink-0 font-mono">{sheetLabel(item.pageNumber)}</span>
                            <span className="text-[10px] text-[var(--muted)] shrink-0 font-mono">{pct(item.p)}</span>
                          </div>
                        );
                      })}
                  </div>
                );
              })}
          </div>
        );
      })}
    </TreeSection>
  );
}

/** Same chevron + label + count row as ViewAllPanel's private SubHeader (no eye: proposals have no per-row hide). */
function SubHeader({ label, count, isOpen, onToggle, indent = 1 }: { label: string; count: number; isOpen: boolean; onToggle: () => void; indent?: number }) {
  return (
    <div className="w-full flex items-center gap-2 py-1 pr-2 hover:bg-white/5" style={{ paddingLeft: 8 + indent * 12 }}>
      <button onClick={onToggle} className="flex-1 flex items-center gap-2 text-left">
        <span className="text-[10px] text-[var(--muted)] w-3 shrink-0">{isOpen ? "▼" : "▶"}</span>
        <span className="text-[11px] text-[var(--fg)] flex-1 truncate">{label}</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--surface)] text-[var(--muted)] shrink-0">{count}</span>
      </button>
    </div>
  );
}
