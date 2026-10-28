"use client";

// [TP-3 WP-3.M] What the parse had to work with (PLAN §3.1): the evidence present in the box (Textract words and
// cells, tag shapes, rulings, layout) and each method's state from the stamp (used ✓, cached, error), plus the
// three heavier reads: "Textract this crop ($)" and "Detect cells (model)" (the `thorough` budget, paid, never
// for demo projects; E-3) and "Re-scan box" (the `standard` budget: crop rulings and grid on the box).
// There is no route that re-runs the shape detector on a box, so "Re-scan shapes in box" is this standard re-read.

import type { ParseResult } from "@/lib/parse-engine/types";
import type { ParseOptions } from "@/queries/useEngineParse";
import { wsButton } from "./WorkspaceHeader";

export function evidenceChips(result: ParseResult): string[] {
  const e = result.evidence;
  const out: string[] = [`${e.words} words`];
  if (e.textractTable) out.push(`Textract ✓ ${e.textractTable.cells} cells${e.textractTable.cached === "crop" ? " (crop)" : ""}`);
  if (e.shapeColumn) out.push(`⬡ ${e.shapeColumn.n} ${e.shapeColumn.source === "yolo" ? "shapes" : "classical shapes"}`);
  if (e.rulings) out.push(`rulings ${e.rulings.h}×${e.rulings.v}`);
  if (e.layout) out.push("layout ✓");
  if (e.ocrGrid) out.push(`grid ${e.ocrGrid.rows}×${e.ocrGrid.cols}`);
  return out;
}

export default function EvidenceStrip({
  result,
  busy,
  error,
  paidAllowed,
  onRun,
}: {
  result: ParseResult | null;
  busy: boolean;
  error: string | null;
  paidAllowed: boolean;
  onRun: (opts: ParseOptions) => void;
}) {
  const failed = result?.stamp.methods.filter((m) => m.error) ?? [];
  return (
    <div aria-label="Evidence" className="flex flex-col gap-1 px-2 py-1 border-b border-[var(--border)] text-[10px] text-[var(--muted)]">
      <div className="flex flex-wrap items-center gap-1">
        {busy ? <span role="status">Parsing…</span> : null}
        {!busy && result ? evidenceChips(result).map((c) => <span key={c} className="px-1 rounded bg-[var(--border)]/40">{c}</span>) : null}
        {!busy && result ? <span className="ml-auto">{result.stamp.budget}</span> : null}
      </div>
      {failed.length > 0 ? (
        <p className="text-amber-400">{failed.map((m) => `${m.id}: ${m.error}`).join(" · ")}</p>
      ) : null}
      {error ? <p role="alert" className="text-red-400">{error}</p> : null}
      <div className="flex flex-wrap gap-1">
        <button type="button" disabled={busy} onClick={() => onRun({ budget: "standard" })} className={`${wsButton(false)} disabled:opacity-50`}>
          Re-scan box
        </button>
        {paidAllowed ? (
          <>
            <button type="button" disabled={busy} onClick={() => onRun({ budget: "thorough", paidTextract: true })} className={`${wsButton(false)} disabled:opacity-50`}>
              Textract this crop ($)
            </button>
            <button type="button" disabled={busy} onClick={() => onRun({ budget: "thorough", tatr: true })} className={`${wsButton(false)} disabled:opacity-50`}>
              Detect cells (model)
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
