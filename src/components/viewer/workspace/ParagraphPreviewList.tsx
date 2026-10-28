"use client";

// [TP-3 WP-3.N] The notes / spec preview (PLAN §3.1, §3.3 C): each paragraph with its address,
//   "A-101 › GENERAL NOTES › 4 · PROVIDE … (3 lines)"   (spec: "08 71 00 › 2.3.A · …")
// grouped under its block header, AFTER the draft's ops (StructureStep applies them locally; nothing fetches).
// With "Split/merge ¶" on, each paragraph lists its visual lines (`paragraphLines`, the numbering WP-3.D's
// `mark-block-header` uses) and:
//   • a click on line n ≥ 1 splits the paragraph before it (`split-paragraph`);
//   • shift-click on a paragraph merges the NEXT paragraph of its block into it (`merge-paragraph` on the next one;
//     the op joins a paragraph to its previous one); "Merge ↑" joins this one to the one above;
//   • the key badge rekeys it (`set-paragraph-key`; an empty key = an unnumbered lead-in, K35);
//   • "Header" on a line makes it the header of a new block (`mark-block-header`).
// The address is computed here from the page's CURRENT drawing number (C2-M8), never stored.

import { useState, type MouseEvent } from "react";
import { paragraphLines } from "@/lib/parse-engine/ops";
import { formatParagraphAddress, paragraphAddress } from "@/lib/parse-engine/paragraphs/address";
import type { BboxMinMax, CorrectionOp, Paragraph, ParagraphBlock, StructureParagraphDoc } from "@/lib/parse-engine/types";
import { InlineField } from "./StructurePreviewGrid";
import { FOCUS_RING, wsButton } from "./WorkspaceHeader";

/** Paragraph text shortened for the list. */
export const PREVIEW_CHARS = 90;

export function shortText(text: string, max = PREVIEW_CHARS): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** "A-101 › GENERAL NOTES › 4" for one paragraph (spec: "<section> › 2.3.A"). */
export function addressText(doc: StructureParagraphDoc, p: Paragraph, block: ParagraphBlock | undefined, page: number, drawingNumber: string | null, regionId: string): string {
  const a = paragraphAddress({ planset: "", page, drawingNumber, regionId, blockHeader: block?.header ?? null, keyPath: p.keyPath, targetId: p.id });
  return formatParagraphAddress(a, { sheetLabel: drawingNumber, specSection: doc.kind === "spec" ? doc.spec?.section ?? null : null });
}

type Line = { p: string; line: number; text: string; b: BboxMinMax; index: number };

export default function ParagraphPreviewList({
  doc,
  words,
  page,
  drawingNumber,
  regionId,
  editing,
  emit,
}: {
  doc: StructureParagraphDoc;
  words: { t: string; b: BboxMinMax }[];
  page: number;
  drawingNumber: string | null;
  regionId: string;
  editing: boolean;
  /** Absent → read-only. */
  emit?: (op: CorrectionOp) => void;
}) {
  const [rekey, setRekey] = useState<string | null>(null);
  const lines: Line[] = paragraphLines(doc, words).map((l, index) => ({ ...l, index }));
  const linesOf = (id: string) => lines.filter((l) => l.p === id);
  const blocks = new Map(doc.blocks.map((b) => [b.id, b]));
  const canEdit = editing && !!emit;
  const order = doc.blocks.map((b) => b.id);
  for (const p of doc.paragraphs) if (!order.includes(p.blockId)) order.push(p.blockId);

  const onRowClick = (e: MouseEvent<HTMLElement>, i: number) => {
    if (!canEdit || !e.shiftKey) return;
    const p = doc.paragraphs[i];
    const nextP = doc.paragraphs[i + 1];
    e.preventDefault();
    if (nextP && nextP.blockId === p.blockId) emit!({ op: "merge-paragraph", p: nextP.id });
  };

  return (
    <div aria-label="Paragraphs" className="flex flex-col gap-1 px-2 py-1">
      {order.map((blockId) => {
        const block = blocks.get(blockId);
        const paras = doc.paragraphs.map((p, i) => ({ p, i })).filter(({ p }) => p.blockId === blockId);
        if (!block && paras.length === 0) return null;
        return (
          <section key={blockId} aria-label={block?.header ?? "Untitled block"} className="flex flex-col gap-0.5">
            <h4 className="text-[10px] font-semibold text-[var(--muted)]">{block?.header ?? "(no block header)"}</h4>
            <ol className="flex flex-col gap-0.5">
              {paras.map(({ p, i }) => {
                const prev = doc.paragraphs[i - 1];
                const canMergeUp = canEdit && !!prev && prev.blockId === p.blockId;
                const own = linesOf(p.id);
                return (
                  <li key={p.id} data-paragraph={p.id} onClick={(e) => onRowClick(e, i)} className="text-[10px] text-[var(--fg)] rounded px-1 hover:bg-[var(--border)]/30">
                    <div className="flex items-start gap-1">
                      {rekey === p.id ? (
                        <span className="w-16 shrink-0">
                          <InlineField
                            value={p.key ?? ""}
                            label={`Key of paragraph ${p.id}`}
                            onSave={(v) => {
                              setRekey(null);
                              const key = v.trim() || null;
                              if (key !== p.key) emit?.({ op: "set-paragraph-key", p: p.id, key });
                            }}
                            onCancel={() => setRekey(null)}
                          />
                        </span>
                      ) : (
                        <button
                          type="button"
                          aria-label={`Key ${p.key ?? "none"}: rekey`}
                          disabled={!canEdit}
                          onClick={(e) => {
                            e.stopPropagation();
                            setRekey(p.id);
                          }}
                          className={`shrink-0 px-1 rounded bg-[var(--border)]/50 text-[var(--fg)] disabled:cursor-default ${FOCUS_RING}`}
                        >
                          {p.key ?? "¶"}
                        </button>
                      )}
                      <span className="flex-1 min-w-0">
                        <span className="text-[var(--muted)]">{addressText(doc, p, block, page, drawingNumber, regionId)}</span>
                        {" · "}
                        {shortText(p.text)}
                        <span className="text-[var(--muted)]"> ({p.lineCount} line{p.lineCount === 1 ? "" : "s"})</span>
                      </span>
                      {canEdit ? (
                        <button
                          type="button"
                          disabled={!canMergeUp}
                          onClick={(e) => {
                            e.stopPropagation();
                            emit!({ op: "merge-paragraph", p: p.id });
                          }}
                          className={`${wsButton(false)} shrink-0 disabled:opacity-40`}
                        >
                          Merge ↑
                        </button>
                      ) : null}
                    </div>
                    {canEdit && own.length > 0 ? (
                      <ul aria-label={`Lines of ${p.id}`} className="ml-6 flex flex-col">
                        {own.map((l) => (
                          <li key={l.index} className="flex items-center gap-1">
                            <button
                              type="button"
                              disabled={l.line === 0}
                              title={l.line === 0 ? "First line" : "Split the paragraph before this line"}
                              onClick={(e) => {
                                if (e.shiftKey) return; // shift-click is the paragraph's merge-with-next
                                e.stopPropagation();
                                emit!({ op: "split-paragraph", p: p.id, atLine: l.line });
                              }}
                              className={`flex-1 min-w-0 text-left truncate text-[var(--muted)] hover:text-[var(--fg)] disabled:cursor-default ${FOCUS_RING}`}
                            >
                              {l.line === 0 ? "" : "✂ "}
                              {l.text}
                            </button>
                            <button
                              type="button"
                              aria-label={`Mark line ${l.index + 1} as a block header`}
                              onClick={(e) => {
                                e.stopPropagation();
                                emit!({ op: "mark-block-header", lineIndex: l.index });
                              }}
                              className={`${wsButton(false)} shrink-0`}
                            >
                              Header
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </section>
        );
      })}
    </div>
  );
}
