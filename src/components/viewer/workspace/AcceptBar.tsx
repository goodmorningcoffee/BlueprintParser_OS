"use client";

// [TP-3 WP-3.M] The AcceptBar (PLAN §3.1, §3.3 A step 4): [Accept] [Accept & next ⏎] [Discard draft], the tag
// summary of the last accept ("Mapped 14 tags · 212 hits · 3 with none · Review ▸", C3-M2), and the three ways
// an accept can come back: ConflictDialog (Replace pre-selected, ⏎ confirms; C3-m2), RebaseNote (one-click
// confirm; C3-m1) and the paid re-run offer when a paid crop the parse used is no longer cached.
// `useAcceptFlow` owns that state; ItemDetail holds it so ⏎ on the detail and the bar's buttons share one flow,
// and so the last summary stays on screen after "Accept & next" moves to the next item.

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ParseOptions } from "@/queries/useEngineParse";
import {
  buildCommitBody,
  commitStructure,
  type CommitRequestBody,
  type ConflictInfo,
  type TagSummary,
} from "@/queries/useCommitStructure";
import { useTablesWorkspaceStore, type WorkspaceItemRef } from "@/stores/tablesWorkspaceStore";
import { deepLink, next } from "@/stores/workspaceCommands";
import ConflictDialog from "./ConflictDialog";
import RebaseNote from "./RebaseNote";
import { wsButton } from "./WorkspaceHeader";

export type AcceptPhase =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "conflict"; conflict: ConflictInfo; andNext: boolean }
  | { kind: "rebased"; changedRows: number; evidenceHash: string | null; andNext: boolean }
  | { kind: "paid-expired"; message: string }
  | { kind: "error"; message: string };

const IDLE: AcceptPhase = { kind: "idle" };

export interface LastAccept { itemKey: string; regionId: string; title: string; tagSummary: TagSummary | null }

export interface AcceptFlow {
  phase: AcceptPhase;
  last: LastAccept | null;
  canAccept: boolean;
  accept: (andNext: boolean, extra?: Partial<Pick<CommitRequestBody, "onConflict" | "acceptRebased" | "regionId" | "revision" | "evidenceHash">>) => Promise<void>;
  resolveConflict: (choice: "replace" | "keep-both") => Promise<void>;
  confirmRebase: () => Promise<void>;
  dismiss: () => void;
}

/** "Mapped 14 tags · 212 hits · 3 with none" (exported for tests). */
export function tagSummaryText(t: TagSummary): string {
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  return `Mapped ${plural(t.tags, "tag")} · ${plural(t.hits, "hit")} · ${t.withNone} with none`;
}

export function useAcceptFlow(publicId: string, isDemo: boolean, item: WorkspaceItemRef | null, title: string): AcceptFlow {
  const qc = useQueryClient();
  const draft = useTablesWorkspaceStore((s) => (item ? s.drafts[item.id] : undefined));
  // The phase belongs to the item it was set for: opening another item shows that item's (idle) phase.
  const [held, setHeld] = useState<{ key: string | null; phase: AcceptPhase }>({ key: null, phase: IDLE });
  const [last, setLast] = useState<LastAccept | null>(null);
  const openedAt = useRef<number>(0); // set when the item opens (below)
  const itemKey = item?.id ?? null;
  const phase = held.key === itemKey ? held.phase : IDLE;
  useEffect(() => {
    openedAt.current = Date.now();
  }, [itemKey]);

  const accept = useCallback<AcceptFlow["accept"]>(async (andNext, extra = {}) => {
    const current = item ? useTablesWorkspaceStore.getState().drafts[item.id] : undefined;
    if (!item || !current?.result || isDemo) return;
    const setPhase = (p: AcceptPhase) => setHeld({ key: item.id, phase: p });
    setPhase({ kind: "saving" });
    let body: CommitRequestBody;
    try {
      body = buildCommitBody(item, current, { ...extra, secondsToAccept: Math.round((Date.now() - openedAt.current) / 1000) });
    } catch (e) {
      setPhase({ kind: "error", message: e instanceof Error ? e.message : "Nothing to accept" });
      return;
    }
    let outcome;
    try {
      outcome = await commitStructure(qc, { publicId, isDemo, itemKey: item.id }, body);
    } catch (e) {
      setPhase({ kind: "error", message: e instanceof Error ? e.message : "Could not save" });
      return;
    }
    switch (outcome.status) {
      case "committed":
        setLast({ itemKey: item.id, regionId: outcome.regionId, title, tagSummary: outcome.tagSummary });
        setPhase({ kind: "idle" });
        if (andNext) next();
        return;
      case "conflict":
        setPhase({ kind: "conflict", conflict: outcome.conflict, andNext });
        return;
      case "rebased": {
        // Show the rebased model in the preview before the user confirms it (the ops already landed on it).
        const d = useTablesWorkspaceStore.getState().drafts[item.id];
        if (d?.result) {
          const evidenceHash = outcome.evidenceHash ?? d.result.stamp.evidenceHash;
          useTablesWorkspaceStore.getState().putDraft(item.id, {
            ...d, result: { ...d.result, model: outcome.model, stamp: { ...d.result.stamp, evidenceHash } },
          });
        }
        setPhase({ kind: "rebased", changedRows: outcome.changedRows, evidenceHash: outcome.evidenceHash, andNext });
        return;
      }
      case "paid-expired":
        setPhase({ kind: "paid-expired", message: outcome.message });
        return;
      default:
        setPhase({ kind: "error", message: outcome.message });
    }
  }, [item, isDemo, publicId, qc, title]);

  const resolveConflict = useCallback(async (choice: "replace" | "keep-both") => {
    if (phase.kind !== "conflict") return;
    const { conflict, andNext } = phase;
    await accept(andNext, choice === "replace"
      ? { onConflict: "replace", regionId: conflict.regionId, ...(conflict.revision !== undefined ? { revision: conflict.revision } : {}) }
      : { onConflict: "keep-both" });
  }, [accept, phase]);

  const confirmRebase = useCallback(async () => {
    if (phase.kind !== "rebased") return;
    await accept(phase.andNext, { acceptRebased: true, ...(phase.evidenceHash ? { evidenceHash: phase.evidenceHash } : {}) });
  }, [accept, phase]);

  return {
    phase,
    last,
    canAccept: !!draft?.result && !isDemo && phase.kind !== "saving",
    accept,
    resolveConflict,
    confirmRebase,
    dismiss: () => setHeld({ key: itemKey, phase: IDLE }),
  };
}

/** The last accept's line; it stays after "Accept & next" and after the accepted item leaves the view. */
export function LastAcceptLine({ last }: { last: LastAccept | null }) {
  if (!last) return null;
  return (
    <p role="status" aria-label="Last accept" className="flex flex-wrap items-center gap-1 text-[10px] text-[var(--muted)]">
      <span className="truncate">Saved {last.title}</span>
      {last.tagSummary ? (
        <>
          <span>· {tagSummaryText(last.tagSummary)}</span>
          <button type="button" className="underline hover:text-[var(--fg)]" onClick={() => deepLink(last.regionId, "tags")}>
            Review ▸
          </button>
        </>
      ) : null}
    </p>
  );
}

export default function AcceptBar({
  flow,
  busy,
  onRun,
  onDiscard,
}: {
  flow: AcceptFlow;
  busy: boolean;
  onRun: (opts: ParseOptions) => void;
  onDiscard: () => void;
}) {
  const { phase, last } = flow;
  const disabled = !flow.canAccept || busy;
  return (
    <div className="flex flex-col gap-1 border-t border-[var(--border)] px-2 py-1.5" aria-label="Accept">
      {phase.kind === "conflict" ? (
        <ConflictDialog conflict={phase.conflict} onConfirm={(c) => void flow.resolveConflict(c)} onCancel={flow.dismiss} />
      ) : null}
      {phase.kind === "rebased" ? (
        <RebaseNote changedRows={phase.changedRows} onConfirm={() => void flow.confirmRebase()} onCancel={flow.dismiss} />
      ) : null}
      {phase.kind === "paid-expired" ? (
        <div role="alert" className="flex flex-wrap items-center gap-1 text-[10px] text-[var(--fg)]">
          <span className="flex-1">{phase.message}</span>
          <button type="button" className={wsButton(true)} onClick={() => { flow.dismiss(); onRun({ budget: "thorough", paidTextract: true }); }}>
            Textract this crop again ($)
          </button>
        </div>
      ) : null}
      {phase.kind === "error" ? <p role="alert" className="text-[10px] text-red-400">{phase.message}</p> : null}
      <div className="flex flex-wrap items-center gap-1">
        <button type="button" disabled={disabled} onClick={() => void flow.accept(false)} className={`${wsButton(false)} disabled:opacity-50`}>
          Accept
        </button>
        <button type="button" disabled={disabled} onClick={() => void flow.accept(true)} className={`${wsButton(true)} disabled:opacity-50`}>
          Accept &amp; next ⏎
        </button>
        <button type="button" disabled={phase.kind === "saving"} onClick={onDiscard} className={`${wsButton(false)} ml-auto disabled:opacity-50`}>
          Discard draft
        </button>
      </div>
      {phase.kind === "saving" ? <p role="status" className="text-[10px] text-[var(--muted)]">Saving…</p> : null}
      <LastAcceptLine last={last} />
    </div>
  );
}
