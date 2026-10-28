"use client";

// [TP-3 WP-3.M] Split and continued schedules (C3-M3, C2-M10; PLAN §3.3 A2). One table printed in two blocks is
// saved as ONE table: the later blocks are the request's `parts` (≤ 4, same page; R11 fits the columns on the
// first block and drops a repeated header). Three ways in:
//   "+ Add continuation box"  arms the canvas box capture (`correction = "draw-continuation"`, WP-3.O's
//                             BoxDrawCapture); the drawn box comes back through `addContinuationPart`;
//   "Merge with ▸"            another inbox item of the same kind on this sheet becomes a part;
//   "Continues from ▸"        the table continues a saved region on ANOTHER sheet → `links.continues`.
// Changing the parts clears the result, which re-runs the parse with them (useEngineParse).

import { useState } from "react";
import { PARSE_ENGINE_CAPS, type BboxMinMax } from "@/lib/parse-engine/types";
import { useWorkspaceItems } from "@/queries/useWorkspaceItems";
import { useSessionStore } from "@/stores/sessionStore";
import { useTablesWorkspaceStore, type WorkspaceItemRef } from "@/stores/tablesWorkspaceStore";
import { groupOfKind } from "@/stores/workspaceCommands";
import { wsButton } from "./WorkspaceHeader";

const sameBox = (a: readonly number[], b: readonly number[]) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);

/** Add a continuation box to an item's draft (the canvas capture and "Merge with ▸" both land here). */
export function addContinuationPart(itemKey: string, bbox: BboxMinMax): boolean {
  const store = useTablesWorkspaceStore.getState();
  const d = store.drafts[itemKey];
  if (!d) return false;
  const parts = d.parts ?? [];
  if (parts.length >= PARSE_ENGINE_CAPS.parts || sameBox(d.bbox, bbox) || parts.some((p) => sameBox(p, bbox))) return false;
  store.putDraft(itemKey, { ...d, parts: [...parts, [...bbox] as BboxMinMax], result: null });
  if (store.correction === "draw-continuation") store.setCorrection(null);
  return true;
}

export function removeContinuationPart(itemKey: string, index: number): void {
  const store = useTablesWorkspaceStore.getState();
  const d = store.drafts[itemKey];
  if (!d?.parts) return;
  const parts = d.parts.filter((_, i) => i !== index);
  store.putDraft(itemKey, { ...d, parts: parts.length > 0 ? parts : undefined, result: null });
}

export function setContinues(itemKey: string, regionId: string | null): void {
  const store = useTablesWorkspaceStore.getState();
  const d = store.drafts[itemKey];
  if (!d) return;
  const { continues: _old, ...rest } = d;
  store.putDraft(itemKey, regionId ? { ...rest, continues: regionId } : rest);
}

type Menu = "merge" | "continues" | null;

export default function ContinuationControls({ item, publicId }: { item: WorkspaceItemRef; publicId: string }) {
  const draft = useTablesWorkspaceStore((s) => s.drafts[item.id]);
  const queue = useTablesWorkspaceStore((s) => s.queue);
  const correction = useTablesWorkspaceStore((s) => s.correction);
  const drawingNumbers = useSessionStore((s) => s.pageDrawingNumbers);
  const [menu, setMenu] = useState<Menu>(null);
  const all = useWorkspaceItems(publicId, "all", item.page, menu === "continues");
  if (!draft) return null;
  const parts = draft.parts ?? [];
  const full = parts.length >= PARSE_ENGINE_CAPS.parts;
  const group = groupOfKind(item.kind);
  const mergeable = queue.filter((q) => q.id !== item.id && q.page === item.page && groupOfKind(q.kind) === group &&
    !sameBox(q.b, draft.bbox) && !parts.some((p) => sameBox(p, q.b)));
  const continuable = (all.data ? [...all.data.items, ...all.data.lowConfidence] : []).filter((i) =>
    !!i.regionId && i.page !== item.page && groupOfKind(i.kind) === group);
  const sheet = (page: number) => drawingNumbers[page] || `Page ${page}`;

  return (
    <div aria-label="Continuation" className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          disabled={full}
          aria-pressed={correction === "draw-continuation"}
          onClick={() => useTablesWorkspaceStore.getState().setCorrection(correction === "draw-continuation" ? null : "draw-continuation")}
          className={`${wsButton(correction === "draw-continuation")} disabled:opacity-50`}
        >
          + Add continuation box
        </button>
        <button type="button" disabled={full || mergeable.length === 0} aria-expanded={menu === "merge"}
          onClick={() => setMenu(menu === "merge" ? null : "merge")} className={`${wsButton(false)} disabled:opacity-50`}>
          Merge with ▸
        </button>
        <button type="button" aria-expanded={menu === "continues"} onClick={() => setMenu(menu === "continues" ? null : "continues")} className={wsButton(!!draft.continues)}>
          Continues from ▸
        </button>
      </div>
      {parts.length > 0 ? (
        <ul aria-label="Continuation boxes" className="flex flex-wrap gap-1 text-[10px] text-[var(--muted)]">
          {parts.map((p, i) => (
            <li key={p.join(",")} className="flex items-center gap-0.5 px-1 rounded bg-[var(--border)]/40">
              Part {i + 2}
              <button type="button" aria-label={`Remove part ${i + 2}`} onClick={() => removeContinuationPart(item.id, i)} className="hover:text-[var(--fg)]">×</button>
            </li>
          ))}
        </ul>
      ) : null}
      {menu === "merge" ? (
        <ul role="menu" aria-label="Merge with" className="flex flex-col gap-0.5 text-[10px]">
          {mergeable.map((q) => (
            <li key={q.id}>
              <button type="button" role="menuitem" className="underline text-[var(--muted)] hover:text-[var(--fg)]"
                onClick={() => { addContinuationPart(item.id, q.b); setMenu(null); }}>
                {("title" in q && typeof q.title === "string" && q.title) || q.id}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {menu === "continues" ? (
        <ul role="menu" aria-label="Continues from" className="flex flex-col gap-0.5 text-[10px]">
          {all.isLoading ? <li className="text-[var(--muted)]">Loading…</li> : null}
          {!all.isLoading && continuable.length === 0 ? <li className="text-[var(--muted)]">No saved table on another sheet.</li> : null}
          {continuable.map((i) => (
            <li key={i.id}>
              <button type="button" role="menuitem"
                className="underline text-[var(--muted)] hover:text-[var(--fg)]"
                onClick={() => { setContinues(item.id, i.regionId ?? null); setMenu(null); }}>
                {sheet(i.page)} › {i.title || i.regionId}{draft.continues === i.regionId ? " ✓" : ""}
              </button>
            </li>
          ))}
          {draft.continues ? (
            <li>
              <button type="button" role="menuitem" className="underline text-[var(--muted)] hover:text-[var(--fg)]"
                onClick={() => { setContinues(item.id, null); setMenu(null); }}>
                Does not continue another sheet
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
      {draft.continues ? <p className="text-[10px] text-[var(--muted)]">Continues {draft.continues}</p> : null}
    </div>
  );
}
