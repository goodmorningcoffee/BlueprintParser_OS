"use client";

// [TP-3 WP-3.M] The open item (PLAN §3.1 ItemDetail): KindBar · EvidenceStrip · StepTabs · the step body ·
// AcceptBar. Mounted by TablesWorkspacePanel below the inbox while an item is selected.
//   • The item's draft is created here on open, bound to the item's page (K29). Saving over an existing region
//     carries the revision the user started from (`data.links.revision` from the page window), so a region
//     changed meanwhile answers 409 instead of being overwritten.
//   • useEngineParse runs the instant parse once (stale answers dropped by stamp) and prefetches the NEXT item
//     of the inbox's visible order at `instant` (C3-m8), so "Accept & next" opens it already parsed.
//   • ⏎ on the detail itself is "Accept & next" (onKeyDown on this section, never on `window`; Enter on a
//     button or in a field keeps its native meaning; §1.6 rule 14).
// The Structure step (source switcher, corrections, preview grid, paragraphs) is WP-3.N; until it mounts, the
// step body is a read-only summary of the fused result. Tags and References are TP-4.

import { useEffect, type KeyboardEvent } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { isEditableKeyboardTarget } from "@/lib/keyboard-target";
import type { ParseResult } from "@/lib/parse-engine/types";
import { draftFor, useEngineParse } from "@/queries/useEngineParse";
import { readPageIntelligence } from "@/queries/usePageWindow";
import { useSessionStore } from "@/stores/sessionStore";
import { useTablesWorkspaceStore, type WorkspaceItemRef } from "@/stores/tablesWorkspaceStore";
import AcceptBar, { LastAcceptLine, useAcceptFlow } from "./AcceptBar";
import EvidenceStrip from "./EvidenceStrip";
import KindBar from "./KindBar";
import StepTabs, { stepsFor } from "./StepTabs";
import { KIND_LABELS } from "./WorkspaceHeader";

/** The revision a saved region is at (`data.links.revision`), when the page window holds it. */
function regionRevision(pi: unknown, regionId: string | undefined): number | undefined {
  if (!regionId || !pi || typeof pi !== "object") return undefined;
  const regions = (pi as { parsedRegions?: unknown }).parsedRegions;
  if (!Array.isArray(regions)) return undefined;
  const region = regions.find((r) => !!r && typeof r === "object" && (r as { id?: unknown }).id === regionId) as
    { data?: { links?: { revision?: unknown } } } | undefined;
  const rev = region?.data?.links?.revision;
  return typeof rev === "number" ? rev : undefined;
}

function freshDraft(qc: QueryClient, publicId: string, item: WorkspaceItemRef) {
  return draftFor(item, regionRevision(readPageIntelligence(qc, publicId, item.page), item.regionId));
}

export function resultSummary(result: ParseResult): string {
  const m = result.model;
  if ("paragraphs" in m) {
    const n = m.paragraphs.length;
    return `${n} paragraph${n === 1 ? "" : "s"} in ${m.blocks.length} block${m.blocks.length === 1 ? "" : "s"}`;
  }
  const body = m.rows.filter((r) => r.role !== "header").length;
  return `${body} row${body === 1 ? "" : "s"} × ${m.cols.length} column${m.cols.length === 1 ? "" : "s"}${m.headerRows ? ` · ${m.headerRows} header row${m.headerRows === 1 ? "" : "s"}` : ""}`;
}

function StepBody({ step, result }: { step: string; result: ParseResult | null }) {
  if (step === "tags" || step === "refs") {
    return (
      <p className="px-2 py-2 text-[10px] text-[var(--muted)]">
        {step === "tags" ? "Tag review" : "References"} arrives in a later release. Accept maps the tags with the defaults.
      </p>
    );
  }
  if (!result) return null;
  const flags = result.model.quality.flags;
  return (
    <div aria-label="Result" className="px-2 py-2 text-[11px] text-[var(--fg)]">
      <p>{resultSummary(result)}</p>
      <p className="text-[10px] text-[var(--muted)]">
        Agreement {Math.round(result.model.quality.agreement * 100)}% · confidence {Math.round(result.model.quality.conf * 100)}%
        {flags.length > 0 ? ` · ${flags.join(", ")}` : ""}
      </p>
    </div>
  );
}

export default function ItemDetail() {
  const qc = useQueryClient();
  const publicId = useSessionStore((s) => s.publicId);
  const isDemo = useSessionStore((s) => s.isDemo);
  const selectedKey = useTablesWorkspaceStore((s) => s.selectedKey);
  const queue = useTablesWorkspaceStore((s) => s.queue);
  const step = useTablesWorkspaceStore((s) => s.step);
  const draft = useTablesWorkspaceStore((s) => (selectedKey ? s.drafts[selectedKey] : undefined));
  const at = queue.findIndex((q) => q.id === selectedKey);
  const item: WorkspaceItemRef | null = at >= 0 ? queue[at] : null;
  const nextItem = at >= 0 && at + 1 < queue.length ? queue[at + 1] : null;
  const result = draft?.result ?? null;
  const itemTitle = item && "title" in item && typeof item.title === "string" ? item.title : null;
  const title = result?.model.title?.text || itemTitle || (item ? `Untitled ${KIND_LABELS[item.kind].replace(/s$/, "").toLowerCase()}` : "");

  // Open: create the item's draft once per opening (a draft restored from storage keeps its ops and parts). A
  // commit discards the draft and is not followed by a new one, so a committed op list is never re-applied.
  const itemKey = item?.id ?? null;
  useEffect(() => {
    const target = useTablesWorkspaceStore.getState().queue.find((q) => q.id === itemKey);
    if (!target || useTablesWorkspaceStore.getState().drafts[target.id]) return;
    useTablesWorkspaceStore.getState().putDraft(target.id, freshDraft(qc, publicId, target));
  }, [itemKey, qc, publicId]);

  const parse = useEngineParse(publicId, item, nextItem, !!item);
  const flow = useAcceptFlow(publicId, isDemo, item, title);

  if (!item) {
    return (
      <section aria-label="Item detail" className="border-t border-[var(--border)] px-2 py-2 text-[10px] text-[var(--muted)]">
        <p>This item is not in the current view. Change the filter or the scope to see it.</p>
        <LastAcceptLine last={flow.last} />
      </section>
    );
  }

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Enter" || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.target !== e.currentTarget || isEditableKeyboardTarget(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    if (flow.canAccept && !parse.busy) void flow.accept(true);
  };

  const steps = stepsFor(result?.model);
  const active = steps.includes(step) ? step : "structure";
  return (
    <section
      aria-label="Item detail"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex flex-col max-h-[60%] min-h-0 border-t border-[var(--border)] outline-none"
    >
      <KindBar key={item.id} item={item} title={title} result={result} publicId={publicId} isDemo={isDemo} />
      <EvidenceStrip result={result} busy={parse.busy} error={parse.error} paidAllowed={!isDemo} onRun={(o) => void parse.run(o)} />
      <StepTabs model={result?.model} />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <StepBody step={active} result={result} />
      </div>
      <AcceptBar
        flow={flow}
        busy={parse.busy}
        onRun={(o) => void parse.run(o)}
        onDiscard={() => {
          useTablesWorkspaceStore.getState().discardDraft(item.id);
          useTablesWorkspaceStore.getState().putDraft(item.id, freshDraft(qc, publicId, item));
        }}
      />
    </section>
  );
}
