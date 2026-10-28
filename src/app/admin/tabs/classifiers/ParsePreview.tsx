"use client";

// [TP-3 WP-3.P] Root-only parse preview inside the Classifiers Preview pane: the draft's proposals that
// target a structure (a schedule, keynote, legend or notes block: `proposalInboxKind`, the inbox's own rule;
// whole-page units are skipped) are parsed by the parse engine at `instant`
// (POST /api/admin/classifiers/parse-preview: compute only, nothing written, no cache), and each one renders
// read-only under its proposal: the StructurePreviewGrid for a table, the paragraph list for notes / specs.

import type { ReactNode } from "react";
import type { ClassifierProposal } from "@/lib/classifier-engine";
import { isPageUnitBox, proposalInboxKind } from "@/lib/parse-engine/inbox-derive";
import type { BboxMinMax, ParseResult, StructureKind, StructureModel, StructureParagraphDoc } from "@/lib/parse-engine/types";
import ParagraphPreviewList from "@/components/viewer/workspace/ParagraphPreviewList";
import StructurePreviewGrid from "@/components/viewer/workspace/StructurePreviewGrid";

export const PARSE_PREVIEW_URL = "/api/admin/classifiers/parse-preview";
/** The route's cap (ADMIN_PARSE_PREVIEW_MAX_ITEMS); the rest are listed as not parsed. */
export const PARSE_PREVIEW_MAX = 40;

export interface ParsePreviewRequestItem { page: number; bbox: BboxMinMax; kind: StructureKind; proposalId: string }
export interface ParsePreviewItem {
  proposalId: string | null; page: number; kind: StructureKind; drawingNumber: string | null;
  result?: ParseResult; error?: "page-not-found" | "engine-unavailable" | "failed";
}

/** The parse requests for a dry run's proposals, in page order (structure targets only; capped). */
export function parsePreviewItems(pages: ReadonlyArray<{ pageNumber: number; proposals: readonly ClassifierProposal[] }>): { items: ParsePreviewRequestItem[]; dropped: number } {
  const all: ParsePreviewRequestItem[] = [];
  for (const pg of pages) {
    for (const p of pg.proposals) {
      const kind = proposalInboxKind(p.target, p.classId);
      if (!kind || isPageUnitBox(p.bbox)) continue;
      all.push({ page: pg.pageNumber, bbox: [p.bbox[0], p.bbox[1], p.bbox[2], p.bbox[3]], kind, proposalId: p.id });
    }
  }
  return { items: all.slice(0, PARSE_PREVIEW_MAX), dropped: Math.max(0, all.length - PARSE_PREVIEW_MAX) };
}

const isParagraphDoc = (m: StructureModel): m is StructureParagraphDoc => m.kind === "notes" || m.kind === "spec";

const ERROR_TEXT: Record<NonNullable<ParsePreviewItem["error"]>, string> = {
  "page-not-found": "page not found",
  "engine-unavailable": "the parse engine is not available",
  failed: "the parse failed on this box (see the server log)",
};

/** One proposal's parse, read-only. */
export function ParsePreview({ item }: { item: ParsePreviewItem }) {
  if (item.error || !item.result) {
    return <p className="text-[10px] text-red-400">parse: {item.error ? ERROR_TEXT[item.error] : "no result"}</p>;
  }
  const { model, words } = item.result;
  const label = `Parse preview ${item.proposalId ?? `page ${item.page}`}`;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  let summary: string;
  let body: ReactNode;
  if (isParagraphDoc(model)) {
    summary = `${plural(model.paragraphs.length, "paragraph")} · ${plural(model.blocks.length, "block")}`;
    body = <ParagraphPreviewList doc={model} words={words} page={item.page} drawingNumber={item.drawingNumber} regionId={item.proposalId ?? `p${item.page}`} editing={false} />;
  } else {
    summary = `${model.rows.length} rows × ${model.cols.length} columns · ${plural(model.headerRows, "header row")}`;
    body = <StructurePreviewGrid model={model} label={label} />;
  }
  return (
    <div className="mt-1 space-y-1" data-testid="parse-preview">
      <p className="text-[10px] text-[var(--muted)]">
        parse ({model.kind}{model.title ? ` · "${model.title.text}"` : ""}): {summary} · conf {Math.round(model.quality.conf * 100)}%
        {model.quality.flags.length ? ` · ${model.quality.flags.join(", ")}` : ""}
      </p>
      {body}
    </div>
  );
}
