// [evidence T4 2026-10-24] FIRST CONSUMER of the evidence layer: the LLM page context.
// Reads the persisted summary (storedPageEvidence) — never re-derives overlaps — and tells the model
// two things it could not see before: where text was located but NOT read (yolo_text holes, by zone),
// and the Textract TABLES grids on the page (bbox, rows × cols, zone). Compact by design: counts plus
// at most EVIDENCE_CONTEXT_TABLES tables, so it costs a few hundred characters per page.

import type { ContextSection } from "@/lib/context-builder";
import { storedPageEvidence } from "./page-evidence";

/** Textract tables listed in the LLM section; the rest are counted. */
export const EVIDENCE_CONTEXT_TABLES = 8;
/** Just ahead of ENSEMBLE TABLE REGIONS (5.3): raw OCR grids before the reducer's verdict on them. */
export const EVIDENCE_CONTEXT_PRIORITY = 5.2;

const fmtBox = (b: readonly number[]) => b.map((v) => v.toFixed(2)).join(", ");

export function buildEvidenceContextSection(
  pageIntelligence: unknown,
  pageNumber: number,
): { section: ContextSection; summaryLine: string } | null {
  const ev = storedPageEvidence(pageIntelligence);
  // Nothing the model cannot already see (no unread spots, no grids) → no section: it sits at 5.2,
  // ahead of note blocks / regions / raw OCR, and must not spend their budget on a coverage line.
  const hasHoles = !!ev && ev.channels.yoloText && ev.counts.holes > 0;
  if (!ev || (!hasHoles && ev.tables.length === 0)) return null;
  const lines: string[] = [];
  const c = ev.counts;
  if (ev.channels.ocr) {
    const located = c.ocrWords > 0 ? Math.round((c.both / c.ocrWords) * 100) : 0;
    lines.push(
      ev.channels.yoloText
        ? `Text: ${c.ocrWords} OCR words (${located}% also located by the text detector).`
        : `Text: ${c.ocrWords} OCR words (no text-detector boxes on this page).`,
    );
  }
  if (hasHoles) {
    const byZone = Object.entries(ev.holesByZone)
      .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
      .map(([zone, n]) => `${zone} ${n}`)
      .join(", ");
    lines.push(`Unread text: ${c.holes} spot(s) where the detector found text the OCR did not read (${byZone}). Their content is unknown — do not guess it.`);
  }
  if (ev.tables.length > 0) {
    lines.push(`OCR table grids: ${c.tables}`);
    for (const t of ev.tables.slice(0, EVIDENCE_CONTEXT_TABLES)) {
      lines.push(`  [${fmtBox(t.bbox)}] ${t.rows} rows × ${t.cols} cols, ${t.cells} cells (zone: ${t.zone})`);
    }
    if (ev.tables.length > EVIDENCE_CONTEXT_TABLES) lines.push(`  ... (+${ev.tables.length - EVIDENCE_CONTEXT_TABLES} more)`);
  }
  const parts = [hasHoles ? `${c.holes} unread text spot(s)` : "", c.tables > 0 ? `${c.tables} OCR table grid(s)` : ""]
    .filter(Boolean);
  return {
    section: { header: `PAGE EVIDENCE — Page ${pageNumber}`, content: lines.join("\n") + "\n", priority: EVIDENCE_CONTEXT_PRIORITY },
    summaryLine: `Page evidence on Page ${pageNumber}${parts.length ? `: ${parts.join(", ")}` : ""}`,
  };
}
