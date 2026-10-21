/**
 * csi-detect.ts — the CSI detection entry point every caller imports (SERVER-ONLY: loads the KB).
 *
 * [csi-v2 S6] An ADAPTER over the v2 tagger (`detectCsiV2`, csi-page.ts) with the legacy signature,
 * so the ~15 callers need no change: `detectCsiCodes(rawText, words?, config?, db?)` and
 * `detectCsiFromGrid(headers, rows, config?, db?)`. Spec: PLAN §7, IMPLEMENTATION §II S6, v1 §7.
 * The legacy 3-tier engine lives on, byte-identical, in `csi-detect-legacy.ts` (eval baseline only).
 *
 * Input selection (PLAN §6.1):
 *   - 2nd argument an OBJECT `{lines?, words?, context?}` (the three page-level callers pass
 *     `{lines: textractData.lines, context: {drawingNumber}}`; spec-parse passes `{context: {pageKind:
 *     'spec'}}`) → Textract lines when given, else words, else `rawText`;
 *   - 2nd argument an ARRAY of Textract words (legacy shape) → lines REBUILT from the words: aligned
 *     to `rawText`'s lines by character (rawText = the Textract lines joined by '\n', so this
 *     reproduces Textract's own segmentation), or — if the words do not spell `rawText` — grouped
 *     geometrically into rows;
 *   - nothing → `rawText` as free text (sentence / line units).
 *   `context.discipline` defaults to the drawing number's prefix ("A-101" → "A"); prefixes outside
 *   the matcher's discipline table are ignored by it (J19).
 *
 * Output: `CsiCode` rows — spaced codes ('NN NN NN[.NN]'), the 2018 title as description (E8),
 * trade, division 'NN 00 00', `confidence`, `level`, and `triggers` (one per owned span, with the
 * union `bbox`, per-word `bboxes`, tier from the code's confidence) WHEN the input carried geometry.
 * Contracts kept from the legacy engine: `rawText` under 10 characters → []; no geometry → the
 * `triggers` key is absent; geometry given (words/lines, even empty) → `triggers` is an array.
 *
 * `config`: `{tau, maxCodesPerPage}` (csi-v2-config.ts); missing fields take the defaults.
 * `db`: the company's CSI bundle from `getCompanyCsiContext`. The builtin bundle (or none) → the
 * builtin KB; a custom bundle → the builtin result UNCHANGED plus the codes the per-tenant overlay
 * (csi-kb-overlay.ts, memoised per bundle) adds — see `run`.
 *
 * Never throws for a missing/stale KB: the failure is logged ONCE and every call returns [] (the
 * legacy engine likewise degraded to zero results when its TSV was missing). The image build runs
 * `scripts/verify-csi-kb.mjs`, so a deployed container always has a verified KB.
 */

import type { BboxLTWH, CsiCode, TextractLine, TextractWord } from "@/types";
import { type CsiDatabase, loadBuiltinCsiDatabase } from "@/lib/csi-database";
import { loadCsiKb } from "@/lib/csi-kb";
import type { LoadedKb } from "@/lib/csi-kb-types";
import { csiOverlayFor } from "@/lib/csi-kb-overlay";
import { detectCsiV2, resolveV2Config, type Context, type V2Cell, type V2Code, type V2Input } from "@/lib/csi-page";
import type { CsiV2Config } from "@/lib/csi-v2-config";
import { extractDisciplinePrefix } from "@/lib/page-utils";
import { logger } from "@/lib/logger";

export type { CsiV2Config } from "@/lib/csi-v2-config";
// Re-export shared CSI utilities (client-safe), as the legacy module did.
export { normalizeCsiCode, normalizeCsiCodes } from "@/lib/csi-utils";

/** Page context as callers hold it (`drawingNumber` is nullable on a page row). */
export interface CsiDetectContext extends Omit<Context, "drawingNumber"> { drawingNumber?: string | null }
/** The object form of `detectCsiCodes`'s 2nd argument. */
export interface CsiPageInput { lines?: TextractLine[]; words?: TextractWord[]; context?: CsiDetectContext }

/** Below this many characters of `rawText` nothing is detected (legacy contract). */
export const CSI_MIN_TEXT_CHARS = 10;

// ── KB resolution ───────────────────────────────────────────────────────────
let kbFailureLogged = false;

function builtinKb(): LoadedKb | null {
  try {
    return loadCsiKb();
  } catch (err) {
    if (!kbFailureLogged) {
      kbFailureLogged = true;
      logger.error("[csi-detect] CSI v2 knowledge base unavailable — CSI detection returns no codes", err);
    }
    return null;
  }
}

/** The KB a detect call runs against: builtin for no/builtin bundle, else the tenant overlay. */
export function csiKbFor(db?: CsiDatabase): LoadedKb | null {
  const base = builtinKb();
  if (!base || !db || db === loadBuiltinCsiDatabase()) return base;
  return csiOverlayFor(base, db).kb;
}

// ── words → lines (legacy 2nd-argument shape) ───────────────────────────────
function unionOf(words: readonly TextractWord[]): BboxLTWH {
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const w of words) {
    const [x, y, ww, hh] = w.bbox;
    if (x < l) l = x;
    if (y < t) t = y;
    if (x + ww > r) r = x + ww;
    if (y + hh > b) b = y + hh;
  }
  return [l, t, r - l, b - t];
}

function lineOf(words: TextractWord[]): TextractLine {
  const conf = words.reduce((a, w) => a + (w.confidence || 0), 0) / words.length;
  return { text: words.map((w) => w.text).join(" "), confidence: conf, words, bbox: unionOf(words) };
}

/** Words → lines by character alignment against `rawText` (one line per non-empty rawText line).
 *  Returns null when the words, in order, do not spell `rawText` (whitespace ignored). */
export function linesFromWordsByText(rawText: string, words: readonly TextractWord[]): TextractLine[] | null {
  const out: TextractLine[] = [];
  let j = 0;
  for (const raw of rawText.split("\n")) {
    const target = raw.replace(/\s+/g, "");
    if (!target) continue;
    const ws: TextractWord[] = [];
    let acc = "";
    while (acc.length < target.length && j < words.length) {
      const piece = (words[j].text || "").replace(/\s+/g, "");
      if (!target.startsWith(acc + piece)) return null;
      acc += piece;
      ws.push(words[j]);
      j++;
    }
    if (acc !== target || !ws.length) return null;
    out.push(lineOf(ws));
  }
  return j === words.length ? out : null;
}

/** A word joins a row when its vertical centre is within this share of the taller height. */
const ROW_CENTRE_TOL = 0.5;
/** Inside a row, a horizontal gap wider than this × the row's median word height starts a new line. */
const LINE_GAP_FACTOR = 1.2;

/** Words → lines geometrically (rows by vertical centre, split at wide gaps). Deterministic. The
 *  fallback when the words do not align with `rawText` (eval/csi/page-measure.ts "words" mode). */
export function linesFromWordsByGeometry(words: readonly TextractWord[]): TextractLine[] {
  const ok = words
    .filter((w) => typeof w.text === "string" && w.text.trim() !== "" && Array.isArray(w.bbox) && w.bbox.every((v) => Number.isFinite(v)))
    .map((w) => ({ w, yc: w.bbox[1] + w.bbox[3] / 2, h: Math.max(w.bbox[3], 1e-4) }));
  ok.sort((a, b) => a.yc - b.yc || a.w.bbox[0] - b.w.bbox[0]);
  const rows: (typeof ok)[] = [];
  let cur: typeof ok = [];
  let curYc = 0, curH = 0;
  for (const x of ok) {
    if (cur.length && Math.abs(x.yc - curYc) <= ROW_CENTRE_TOL * Math.max(x.h, curH)) {
      cur.push(x);
      curYc = (curYc * (cur.length - 1) + x.yc) / cur.length;
      curH = Math.max(curH, x.h);
    } else {
      if (cur.length) rows.push(cur);
      cur = [x]; curYc = x.yc; curH = x.h;
    }
  }
  if (cur.length) rows.push(cur);
  const out: TextractLine[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.w.bbox[0] - b.w.bbox[0] || a.yc - b.yc);
    const hs = row.map((x) => x.h).sort((a, b) => a - b);
    const gapMax = LINE_GAP_FACTOR * hs[Math.floor(hs.length / 2)];
    let seg: TextractWord[] = [];
    for (const { w } of row) {
      const prev = seg[seg.length - 1];
      if (prev && w.bbox[0] - (prev.bbox[0] + prev.bbox[2]) > gapMax) { out.push(lineOf(seg)); seg = []; }
      seg.push(w);
    }
    if (seg.length) out.push(lineOf(seg));
  }
  return out;
}

// ── adapter ─────────────────────────────────────────────────────────────────
function contextOf(c: CsiDetectContext | undefined): Context | undefined {
  if (!c) return undefined;
  const out: Context = {};
  if (c.pageKind) out.pageKind = c.pageKind;
  const dn = typeof c.drawingNumber === "string" ? c.drawingNumber.trim() : "";
  if (dn) out.drawingNumber = dn;
  const disc = c.discipline ?? (dn ? extractDisciplinePrefix(dn) : undefined);
  if (disc) out.discipline = disc;
  return Object.keys(out).length ? out : undefined;
}

/** One V2 code → the persisted `CsiCode` row (ancestors are derivable from the code and dropped).
 *  Only spans that COUNT are stored as triggers: an emitted code's `emitted:false` spans (e.g. a
 *  BY OTHERS phrase, §6.6) would otherwise be highlighted by the viewer search and counted by the
 *  sidebar's "N spans" pill. They stay on `V2Result.spans` for the eval harness. */
function toRow(c: V2Code, geometry: boolean): CsiCode {
  const row: CsiCode = {
    code: c.code, description: c.description, trade: c.trade, division: c.division,
    confidence: c.confidence, level: c.level,
  };
  if (geometry) row.triggers = (c.triggers ?? []).filter((t) => t.emitted);
  return row;
}

/**
 * A custom list only ADDS codes (PLAN §7 "tenants cannot move builtin results"). The overlay's
 * patterns compete in span ownership, so a run on the overlay KB alone CAN re-score or drop a
 * builtin code (review fix round 1: a custom phrase on 08 13 13 took a span from 08 11 13). The
 * guarantee is therefore made here, by construction: the builtin run's rows come back unchanged and
 * first; the overlay run contributes only codes the custom list names (a code holding an overlay
 * pattern) that the builtin run did not emit, in the overlay run's order, into the slots left under
 * `maxCodesPerPage`. Cost: a second engine pass for tenants with a custom list only.
 */
function run(input: V2Input, geometry: boolean, config: Partial<CsiV2Config> | undefined, db: CsiDatabase | undefined): CsiCode[] {
  const base = builtinKb();
  if (!base) return [];
  const cfg = config ?? {};
  const builtin = detectCsiV2(input, cfg, base).codes;
  if (!db || db === loadBuiltinCsiDatabase()) return builtin.map((c) => toRow(c, geometry));
  const ov = csiOverlayFor(base, db).kb;
  const firstOverlay = base.patterns.length;
  const have = new Set(builtin.map((c) => c.code));
  const room = resolveV2Config(cfg).maxCodesPerPage - builtin.length;
  const adds = room <= 0 ? [] : detectCsiV2(input, cfg, ov).codes.filter((c) => !have.has(c.code)
    && (ov.byCode.get(c.code)?.patternIds.some((id) => id >= firstOverlay) ?? false)).slice(0, room);
  return [...builtin, ...adds].map((c) => toRow(c, geometry));
}

/**
 * Detect CSI MasterFormat codes on a page / in a text (see the header for the input forms).
 * Synchronous; the company context is resolved by the caller (`getCompanyCsiContext`).
 */
export function detectCsiCodes(
  rawText: string,
  words?: TextractWord[] | CsiPageInput,
  config?: Partial<CsiV2Config>,
  db?: CsiDatabase,
): CsiCode[] {
  if (!rawText || rawText.length < CSI_MIN_TEXT_CHARS) return [];
  const page: CsiPageInput = Array.isArray(words) ? { words } : words ?? {};
  const context = contextOf(page.context);
  if (page.lines) return run({ lines: page.lines, context }, true, config, db);
  if (page.words) {
    const lines = linesFromWordsByText(rawText, page.words) ?? linesFromWordsByGeometry(page.words);
    if (lines.length) return run({ lines, context }, true, config, db);
    return run({ text: rawText, context }, true, config, db);
  }
  return run({ text: rawText, context }, false, config, db);
}

/**
 * Detect CSI codes in a parsed table / keynote grid. Each non-empty value is ONE cell unit with its
 * column header (PLAN §6.1, E9) — never one string joined across cells. A grid with headers but no
 * values is read header by header. Grids carry no geometry, so rows have no `triggers`.
 */
export function detectCsiFromGrid(
  headers: string[],
  rows: Record<string, string>[],
  config?: Partial<CsiV2Config>,
  db?: CsiDatabase,
): CsiCode[] {
  const cells: V2Cell[] = [];
  for (const row of rows) {
    for (const [header, val] of Object.entries(row)) {
      if (typeof val === "string" && val.trim() !== "") cells.push({ text: val, header });
    }
  }
  // the legacy <10-char gate, over the same text the legacy engine joined (headers + values)
  if ([...headers, ...cells.map((c) => c.text)].join(" ").length < CSI_MIN_TEXT_CHARS) return [];
  if (!cells.length) for (const h of headers) if (h && h.trim() !== "") cells.push({ text: h });
  return cells.length ? run({ cells }, false, config, db) : [];
}
