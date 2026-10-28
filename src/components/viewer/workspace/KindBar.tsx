"use client";

// [TP-3 WP-3.M] The item's identity (PLAN §3.1): kind · class · title, the verdicts that need no parse
// (§3.3 E: "Not a table" = verdict reject; "Table, not a schedule" = verdict accept with classId
// `not-a-schedule`; Undo = DELETE verdict, all through WP-3.F's verdict route), and the continuation controls.
// A drawn box ("+ Region") is parsed with no kind; the engine's kind heads answer with `kindSuggestion`, which
// is offered here (§3.3 F). Changing the kind re-parses the box as that kind (the request carries it).
// A verdict does not move on by itself, so its Undo stays in reach; "Next ▸" (or J) moves on.

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { STRUCTURE_KINDS, type CorrectionOp, type ParseResult, type StructureKind } from "@/lib/parse-engine/types";
import {
  recordItemVerdict,
  undoItemVerdict,
  verdictsFor,
  type ItemVerdict,
} from "@/queries/useCommitStructure";
import { useTablesWorkspaceStore, type WorkspaceItemRef } from "@/stores/tablesWorkspaceStore";
import { next } from "@/stores/workspaceCommands";
import ContinuationControls from "./ContinuationControls";
import { KIND_LABELS, wsButton } from "./WorkspaceHeader";

/** Not a schedule (classifier vocabulary `NOT_A_SCHEDULE`; repeated here so the client bundle stays lean). */
export const NOT_A_SCHEDULE_CLASS = "not-a-schedule";

const kindName = (k: StructureKind) => KIND_LABELS[k].replace(/s$/, "");

export default function KindBar({
  item,
  title,
  result,
  publicId,
  isDemo,
}: {
  item: WorkspaceItemRef;
  title: string;
  result: ParseResult | null;
  publicId: string;
  isDemo: boolean;
}) {
  const qc = useQueryClient();
  const draft = useTablesWorkspaceStore((s) => s.drafts[item.id]);
  const [recorded, setRecorded] = useState<ItemVerdict["verdict"] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const allowed = verdictsFor(item);
  const kind = draft?.kind ?? item.kind;
  const suggestion = result?.kindSuggestion;

  // Clearing the result re-runs the instant parse for the new kind (useEngineParse), so no explicit run here.
  // A kind the USER picks over the item's own is also recorded as a `set-kind` op, so the label keeps the
  // correction (taking the engine's own suggestion for a drawn box is not a correction).
  const setKind = (k: StructureKind, opts: { classId?: string | null; byUser: boolean }) => {
    const d = useTablesWorkspaceStore.getState().drafts[item.id];
    if (!d || (d.kind === k && !opts.classId)) return;
    const ops: CorrectionOp[] = d.ops.filter((o) => o.op !== "set-kind");
    if (opts.byUser && k !== item.kind) ops.push({ op: "set-kind", kind: k });
    // The class rides on the commit's set-kind op (WP-3.G); a kind the user picks drops the old kind's class.
    const { classId: oldClass, ...rest } = d;
    const classId = opts.classId ?? (opts.byUser && k !== d.kind ? undefined : oldClass);
    useTablesWorkspaceStore.getState().putDraft(item.id, { ...rest, kind: k, ops, ...(classId ? { classId } : {}), result: null });
  };

  const verdict = async (v: ItemVerdict) => {
    setBusy(true);
    setMessage(null);
    try {
      await recordItemVerdict(qc, publicId, item, v);
      setRecorded(v.verdict);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not save the verdict");
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    setBusy(true);
    try {
      await undoItemVerdict(qc, publicId, item);
      setRecorded(null);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not undo");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div aria-label="Kind" className="flex flex-col gap-1 px-2 py-1.5 border-b border-[var(--border)] text-[11px]">
      <div className="flex items-center gap-1.5">
        <select
          aria-label="Kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as StructureKind, { byUser: true })}
          className="bg-transparent border border-[var(--border)] rounded px-1 text-[10px] text-[var(--fg)]"
        >
          {STRUCTURE_KINDS.map((k) => <option key={k} value={k}>{kindName(k)}</option>)}
        </select>
        {draft?.classId ? <span className="text-[10px] text-[var(--muted)]">{draft.classId}</span> : null}
        <span className="truncate flex-1 font-medium text-[var(--fg)]" title={title}>{title}</span>
      </div>
      {suggestion && suggestion.kind !== kind ? (
        <p className="text-[10px] text-[var(--muted)]">
          Looks like a {kindName(suggestion.kind).toLowerCase()} ({Math.round(suggestion.p * 100)}%){" "}
          <button type="button" className="underline hover:text-[var(--fg)]" onClick={() => setKind(suggestion.kind, { classId: suggestion.classId, byUser: false })}>
            Use
          </button>
        </p>
      ) : null}
      {!isDemo && (allowed.reject || allowed.notASchedule) ? (
        <div className="flex flex-wrap items-center gap-1">
          {recorded ? (
            <>
              <span className="text-[10px] text-[var(--muted)]">{recorded === "reject" ? "Marked not a table." : "Marked a table, not a schedule."}</span>
              <button type="button" disabled={busy} onClick={() => void undo()} className={wsButton(false)}>Undo</button>
              <button type="button" onClick={() => next()} className={wsButton(true)}>Next ▸</button>
            </>
          ) : (
            <>
              {allowed.reject ? (
                <button type="button" disabled={busy} onClick={() => void verdict({ verdict: "reject" })} className={wsButton(false)}>
                  Not a table
                </button>
              ) : null}
              {allowed.notASchedule ? (
                <button type="button" disabled={busy} onClick={() => void verdict({ verdict: "accept", classId: NOT_A_SCHEDULE_CLASS })} className={wsButton(false)}>
                  Table, not a schedule
                </button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
      {message ? <p role="alert" className="text-[10px] text-red-400">{message}</p> : null}
      {kind === "schedule" || kind === "keynote" || kind === "legend" ? (
        <ContinuationControls item={item} publicId={publicId} />
      ) : null}
    </div>
  );
}
