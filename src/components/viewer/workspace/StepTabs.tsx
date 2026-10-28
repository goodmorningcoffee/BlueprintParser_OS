"use client";

// [TP-3 WP-3.M] [1 Structure] [2 Tags]* [3 References]* [Accept] (PLAN §3.1). Tags and References show whenever
// they apply, and BOTH can show (C3-M4, §1.1 row 21): a model with keys is a keyed item, so a keyed notes block
// gets a Tags tab (its keys may appear as tags on the plan) and a References tab ("SEE NOTE 4" points at it).
//   Tags        a table with a tag column or keyed rows; a notes/spec block with keyed paragraphs
//   References  a keynote or legend with keyed rows; a notes/spec block with keyed paragraphs; a schedule
//               carrying its own NOTES block (footnotes)
// The Tags and References steps themselves land in TP-4; in TP-3, Accept maps tags with the defaults.

import type { KeyboardEvent } from "react";
import type { StructureModel } from "@/lib/parse-engine/types";
import { useTablesWorkspaceStore, type WorkspaceStep } from "@/stores/tablesWorkspaceStore";
import { FOCUS_RING } from "./WorkspaceHeader";

export function stepsFor(model: StructureModel | null | undefined): WorkspaceStep[] {
  const steps: WorkspaceStep[] = ["structure"];
  if (!model) return [...steps, "accept"];
  let tags = false;
  let refs = false;
  if ("paragraphs" in model) {
    const keyed = model.paragraphs.some((p) => !!p.key);
    tags = keyed;
    refs = keyed;
  } else {
    const keyedRows = model.rows.some((r) => r.role === "body" && !!r.key);
    tags = !!model.tag || keyedRows;
    refs = ((model.kind === "keynote" || model.kind === "legend") && (keyedRows || !!model.tag)) ||
      (!!model.notes && model.notes.paragraphs.length > 0);
  }
  if (tags) steps.push("tags");
  if (refs) steps.push("refs");
  steps.push("accept");
  return steps;
}

const LABELS: Readonly<Record<WorkspaceStep, string>> = {
  structure: "Structure",
  tags: "Tags",
  refs: "References",
  accept: "Accept",
};

export default function StepTabs({ model }: { model: StructureModel | null | undefined }) {
  const step = useTablesWorkspaceStore((s) => s.step);
  const setStep = useTablesWorkspaceStore((s) => s.setStep);
  const steps = stepsFor(model);
  const active = steps.includes(step) ? step : "structure";
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const at = steps.indexOf(active);
    const to = steps[Math.max(0, Math.min(steps.length - 1, at + (e.key === "ArrowRight" ? 1 : -1)))];
    e.preventDefault();
    e.stopPropagation();
    setStep(to);
  };
  return (
    <div role="tablist" aria-label="Steps" onKeyDown={onKeyDown} className="flex gap-1 px-2 py-1 border-b border-[var(--border)]">
      {steps.map((s, i) => (
        <button
          key={s}
          type="button"
          role="tab"
          aria-selected={s === active}
          tabIndex={s === active ? 0 : -1}
          onClick={() => setStep(s)}
          className={`px-1.5 py-0.5 rounded text-[10px] ${FOCUS_RING} ${
            s === active ? "bg-[#00E676]/15 text-[#00E676]" : "text-[var(--muted)] hover:text-[var(--fg)]"
          }`}
        >
          {s === "accept" ? LABELS[s] : `${i + 1} ${LABELS[s]}`}
        </button>
      ))}
    </div>
  );
}
