"use client";

// [classifier-builder 2026-10-24] "Proposed tables" in the Tables panel (All Tables + Auto Parse tabs): the
// classifier's proposals from projectIntelligence.proposals, This page / All pages, filtered by verdict, grouped by
// discipline then kind. Hover a row → soft outline on the canvas; click → go to its page and FOCUS it (green
// box, other annotations dimmed, viewport fitted; Esc or Clear ends it). Actions on the focused row: Parse
// this table (prefills the Auto Parse region, records accept), Not a table (reject), Rename (kind menu, free
// name for "Other schedule"), Undo (deletes the verdict). Demo projects are read-only: no verdict buttons.
// [clf visibility 2026-10-25] No summary / no items renders a short empty state (it used to render nothing, which
// read the same as "wrong tab"); the scope defaults to All pages while the current page has no proposals.
// [shape-tags 2026-10-25] A "table NN %" chip when the recipe scored table-ness, and, on a focused proposal whose
// tag column the engine found, the column (shape class, rows, readable tags, first tags) plus the sheet and its
// trade, with ACCEPT WITH TAGS: Parse this table plus a parse hint (tableParseHintStore, keyed by project + page +
// region) that asks the Auto Parse request for the shape-centre rows and pre-selects the column's class for Map Tags.

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ProposalSummaryItem, VerdictKind } from "@/lib/classifier-engine/types";
import {
  OTHER_SCHEDULE,
  SCHEDULE_GROUP_NAMES,
  SCHEDULE_KINDS,
  type ScheduleGroup,
} from "@/lib/classifier-engine/vocabulary";
import { submitProposalVerdict, undoProposalVerdict, useProposals } from "@/queries/useProposals";
import { useProposalFocusStore, type ProposalFocusTarget } from "@/stores/proposalFocusStore";
import { useTableParseHintStore } from "@/stores/tableParseHintStore";
import { useProject, useSessionStore } from "@/stores/sessionStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import { DISCIPLINE_NAMES, extractDisciplinePrefix } from "@/lib/page-utils";
import { acceptTableParseRegion, navigateViewerPage, transitionTableParseTab } from "@/stores/viewerCommands";
import {
  buildProposalGroups,
  filterCounts,
  pct,
  type ProposalFilter,
  type ProposalScope,
} from "./proposals/proposalList";

const FILTERS: ReadonlyArray<[ProposalFilter, string]> = [
  ["unreviewed", "Unreviewed"],
  ["accepted", "Accepted"],
  ["rejected", "Rejected"],
];

const VERDICT_LABEL: Record<VerdictKind, string> = { accept: "accepted", reject: "not a table", rename: "renamed" };

/** "sheet A-601 · Architectural" from the page's drawing number, or null when the sheet is unknown. */
function sheetLabel(drawingNumber: string | null | undefined): string | null {
  if (!drawingNumber) return null;
  const prefix = extractDisciplinePrefix(drawingNumber);
  const trade = DISCIPLINE_NAMES[prefix];
  return `sheet ${drawingNumber}${trade ? ` · ${trade}` : ""}`;
}

/** "7 hexagon rows · 5 tags: K1, K2, K3 +2 more" — the "+n more" counts READABLE tags beyond the chips, not rows. */
function tagColumnLabel(item: ProposalSummaryItem): string {
  const tags = item.tags ?? [];
  const readable = item.tagCount ?? tags.length;
  const more = Math.max(0, readable - tags.length);
  const head = `${item.tagRows} ${item.tagShape ?? "shape"} rows`;
  if (!tags.length) return `${head} · no readable tags`;
  return `${head} · ${readable} tag${readable === 1 ? "" : "s"}: ${tags.join(", ")}${more ? ` +${more} more` : ""}`;
}

const FOCUS_RING = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#00E676]";

function toggleClass(on: boolean): string {
  return `px-1.5 py-0.5 rounded border text-[10px] ${FOCUS_RING} ${
    on ? "border-[#00E676]/60 text-[#00E676] bg-[#00E676]/10" : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]"
  }`;
}

function RenameForm({
  initial,
  busy,
  onSave,
  onCancel,
}: {
  initial: string | null;
  busy: boolean;
  onSave: (classId: string, name?: string) => void;
  onCancel: () => void;
}) {
  const [classId, setClassId] = useState(initial ?? OTHER_SCHEDULE);
  const [name, setName] = useState("");
  const groups = Object.keys(SCHEDULE_GROUP_NAMES) as ScheduleGroup[];
  return (
    <form
      className="mt-1 space-y-1"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(classId, classId === OTHER_SCHEDULE && name.trim() ? name.trim() : undefined);
      }}
    >
      <label className="block text-[10px] text-[var(--muted)]">
        Kind
        <select
          aria-label="Schedule kind"
          value={classId}
          onChange={(e) => setClassId(e.target.value)}
          className="mt-0.5 w-full text-[11px] bg-[var(--bg)] border border-[var(--border)] rounded px-1 py-0.5"
        >
          {groups.map((g) => (
            <optgroup key={g} label={SCHEDULE_GROUP_NAMES[g]}>
              {SCHEDULE_KINDS.filter((k) => k.group === g).map((k) => (
                <option key={k.id} value={k.id}>{k.name}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      {classId === OTHER_SCHEDULE && (
        <label className="block text-[10px] text-[var(--muted)]">
          Name (optional)
          <input
            aria-label="Schedule name"
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            className="mt-0.5 w-full text-[11px] bg-[var(--bg)] border border-[var(--border)] rounded px-1 py-0.5"
          />
        </label>
      )}
      <div className="flex gap-1">
        <button type="submit" disabled={busy} className={`${toggleClass(true)} disabled:opacity-50`}>Save kind</button>
        <button type="button" onClick={onCancel} className={toggleClass(false)}>Cancel</button>
      </div>
    </form>
  );
}

export default function ProposedTablesSection() {
  const summary = useProposals();
  const { publicId, isDemo } = useProject();
  const pageNumber = useViewerCoreStore((s) => s.pageNumber);
  const pageDrawingNumbers = useSessionStore((s) => s.pageDrawingNumbers);
  const qc = useQueryClient();
  const focus = useProposalFocusStore((s) => s.focus);
  const setHover = useProposalFocusStore((s) => s.setHover);
  const focusProposal = useProposalFocusStore((s) => s.focusProposal);
  const clearFocus = useProposalFocusStore((s) => s.clearFocus);
  const [scopeChoice, setScopeChoice] = useState<ProposalScope | null>(null);
  const [filter, setFilter] = useState<ProposalFilter>("unreviewed");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!summary || summary.items.length === 0) {
    return (
      <section aria-label="Proposed tables" className="px-1 py-1 text-[10px] text-[var(--muted)]">
        No proposed tables yet — run Admin › Reprocess › Classifiers (or Intelligence) on this project.
      </section>
    );
  }
  const scope: ProposalScope = scopeChoice ?? (summary.items.some((i) => i.pageNumber === pageNumber) ? "page" : "all");
  const counts = filterCounts(summary.items, scope, pageNumber);
  const focusedId = focus && focus.publicId === publicId ? focus.proposalId : null;
  const groups = buildProposalGroups(summary.items, { scope, pageNumber, filter, keepId: focusedId });

  const targetOf = (item: ProposalSummaryItem): ProposalFocusTarget => ({
    publicId,
    proposalId: item.id,
    pageNumber: item.pageNumber,
    bbox: item.bbox,
  });

  const focusItem = (item: ProposalSummaryItem) => {
    setRenaming(null);
    setError(null);
    if (item.pageNumber !== useViewerCoreStore.getState().pageNumber) navigateViewerPage(item.pageNumber);
    focusProposal(targetOf(item));
  };

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  };

  const verdict = (item: ProposalSummaryItem, kind: VerdictKind, classId?: string, name?: string) =>
    run(() =>
      submitProposalVerdict(qc, publicId, {
        pageNumber: item.pageNumber,
        proposalId: item.id,
        verdict: kind,
        ...(classId === undefined ? {} : { classId }),
        ...(name === undefined ? {} : { name }),
      }),
    );

  const parseThis = (item: ProposalSummaryItem, withTags = false) => {
    useTableParseHintStore.getState().setHint(withTags && item.tagRows ? {
      publicId, pageNumber: item.pageNumber, bbox: [...item.bbox] as typeof item.bbox, rowSource: "shape-centres",
      ...(item.tagShape ? { tagYoloClass: { model: "yolo_primitive", className: item.tagShape } } : {}),
    } : null);
    focusItem(item);
    transitionTableParseTab("auto");
    // A fresh array each click, so re-queueing after a removal is not mistaken for a repeat.
    acceptTableParseRegion([...item.bbox] as typeof item.bbox);
    if (!isDemo && item.verdict === undefined) void verdict(item, "accept");
  };

  return (
    <section aria-label="Proposed tables" className="space-y-1">
      <div className="flex items-center justify-between px-1">
        <span className="text-[10px] text-[var(--muted)] uppercase tracking-wide">
          Proposed tables ({summary.total})
        </span>
        <div className="flex gap-1" role="group" aria-label="Scope">
          <button type="button" aria-pressed={scope === "page"} onClick={() => setScopeChoice("page")} className={toggleClass(scope === "page")}>
            This page
          </button>
          <button type="button" aria-pressed={scope === "all"} onClick={() => setScopeChoice("all")} className={toggleClass(scope === "all")}>
            All pages
          </button>
        </div>
      </div>
      <div className="flex gap-1 px-1" role="group" aria-label="Verdict filter">
        {FILTERS.map(([f, label]) => (
          <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)} className={toggleClass(filter === f)}>
            {label} ({counts[f]})
          </button>
        ))}
      </div>
      {summary.truncated && (
        <div className="text-[10px] text-amber-300 px-1">
          Showing {summary.items.length} of {summary.total} proposals.
        </div>
      )}
      {focusedId && (
        <div className="flex items-center justify-between px-1 text-[10px] text-[#00E676]">
          <span>Focused — Esc to clear</span>
          <button type="button" onClick={clearFocus} className={toggleClass(false)}>Clear</button>
        </div>
      )}
      {error && <div role="alert" className="text-[10px] text-red-400 px-1">{error}</div>}
      {groups.length === 0 && (
        <div className="text-[10px] text-[var(--muted)] px-1 py-1">
          No {filter} proposals {scope === "page" ? "on this page" : "in this project"}.
        </div>
      )}
      {groups.map((group) => (
        <div key={group.key} className="space-y-0.5">
          <div className="text-[10px] font-semibold text-[var(--fg)] px-1">{group.label} ({group.count})</div>
          {group.kinds.map((kind) => (
            <div key={kind.key} className="pl-1 space-y-0.5">
              <div className="text-[10px] text-[var(--muted)] px-1">{kind.label}</div>
              {kind.items.map((item) => {
                const focused = item.id === focusedId;
                return (
                  <div key={item.id} className={`rounded border ${focused ? "border-[#00E676]/70 bg-[#00E676]/5" : "border-[var(--border)]/50"}`}>
                    <button
                      type="button"
                      aria-pressed={focused}
                      data-proposal-row={item.id}
                      onClick={() => focusItem(item)}
                      onMouseEnter={() => setHover(targetOf(item))}
                      onMouseLeave={() => setHover(null)}
                      onFocus={() => setHover(targetOf(item))}
                      onBlur={() => setHover(null)}
                      className={`w-full text-left text-[11px] px-2 py-1 flex items-center gap-1 hover:bg-[var(--surface-hover,rgba(255,255,255,0.04))] ${FOCUS_RING}`}
                    >
                      <span className="flex-1 truncate text-[var(--fg)]">{item.displayName}</span>
                      <span className="text-[10px] text-[var(--muted)]">p.{item.pageNumber}</span>
                      <span className="text-[10px] font-mono text-[var(--muted)]" title={`detect ${pct(item.p)} · kind ${pct(item.nameP)}`}>
                        {pct(item.p)}
                      </span>
                      {item.tableP !== undefined && (
                        <span className="text-[9px] font-mono text-[var(--muted)] border border-[var(--border)] rounded px-1" title="table-ness: how table-like the box is, independent of its kind">
                          table {pct(item.tableP)}
                        </span>
                      )}
                      {item.verdict && <span className="text-[9px] text-[#00E676]">{VERDICT_LABEL[item.verdict]}</span>}
                    </button>
                    {focused && (
                      <div className="px-2 pb-1.5 space-y-1">
                        {item.tagRows ? (
                          <div className="text-[10px] text-[var(--muted)]" data-tag-column={item.id}>
                            Tag column: {tagColumnLabel(item)}
                            {sheetLabel(pageDrawingNumbers[item.pageNumber]) && <span> · {sheetLabel(pageDrawingNumbers[item.pageNumber])}</span>}
                          </div>
                        ) : null}
                        <div className="flex flex-wrap gap-1">
                          <button type="button" disabled={busy} onClick={() => parseThis(item)} className={`${toggleClass(true)} disabled:opacity-50`}>
                            Parse this table
                          </button>
                          {item.tagRows ? (
                            <button type="button" disabled={busy} onClick={() => parseThis(item, true)} className={`${toggleClass(true)} disabled:opacity-50`} title="Parse with the tag shapes as row centres and map the tags across the set">
                              Accept with tags
                            </button>
                          ) : null}
                          {!isDemo && (
                            <>
                              <button type="button" disabled={busy} onClick={() => void verdict(item, "reject")} className={`${toggleClass(false)} disabled:opacity-50`}>
                                Not a table
                              </button>
                              <button
                                type="button"
                                disabled={busy}
                                aria-expanded={renaming === item.id}
                                onClick={() => setRenaming(renaming === item.id ? null : item.id)}
                                className={`${toggleClass(false)} disabled:opacity-50`}
                              >
                                Rename
                              </button>
                              {item.verdict && (
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => void run(() => undoProposalVerdict(qc, publicId, { pageNumber: item.pageNumber, proposalId: item.id }))}
                                  className={`${toggleClass(false)} disabled:opacity-50`}
                                >
                                  Undo
                                </button>
                              )}
                            </>
                          )}
                        </div>
                        {!isDemo && renaming === item.id && (
                          <RenameForm
                            initial={item.classId}
                            busy={busy}
                            onCancel={() => setRenaming(null)}
                            onSave={(classId, name) => {
                              setRenaming(null);
                              void verdict(item, "rename", classId, name);
                            }}
                          />
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}
