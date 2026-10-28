/**
 * Text-region verdicts and inbox kinds (table pipeline TP-3 WP-3.F; PLAN §2.1 `TextRegionVerdict`, the
 * "TextRegion type → StructureKind" table, §2.3 "Text regions"; K30, C2-M12, C2-m5, C2-m8).
 *
 * A Layer-1 `TextRegion` id is POSITIONAL (`region-${i}`): it rebinds after a re-OCR or a classifier change
 * (K30), so a verdict keyed by id hides the wrong card. Workspace verdicts are keyed by CONTENT instead:
 * `tr:${type}:${q2(bbox)}` (MinMax, two decimals), and the read side matches a region to a verdict of the
 * same type by IoU ≥ .7, so a small re-OCR wobble still matches and a renumbering never does.
 *
 * Pure and client-safe (E-8): imports only `./types` and `./geometry`. The viewer's classic Notes/Spec cards
 * (`useTextRegionVerdictFilter`) and the server (inbox derive, verdict service) share these functions.
 *
 * `countParagraphKeys` is the ≥ 3-keys rule for `paragraph` regions (C2-m5). It is an interim counter: once
 * WP-3.C's `paragraphs/keys.ts` lands, the integration repoints it there (see the WP-3.F report).
 */

import { ltwhToMinMax } from "./geometry";
import type { BboxMinMax, StructureKind, TextRegionVerdict } from "./types";

type Box = readonly [number, number, number, number];

/** Read side: a verdict matches a region of the same type at IoU ≥ this (K30). */
export const TEXT_REGION_VERDICT_IOU = 0.7;

/** IoU of two MinMax boxes (0 when either is empty). */
export function iouMinMax(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const union = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]) + Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]) - inter;
  return union > 0 ? inter / union : 0;
}

const q2 = (n: number): string => (Math.round(n * 100) / 100).toFixed(2);

/** The content key of a text region: `tr:${type}:${x0},${y0},${x1},${y1}` (MinMax, two decimals). */
export function textRegionKey(type: string, b: Box): string {
  return `tr:${type}:${b.map(q2).join(",")}`;
}

/** Minimal structural view of a stored `TextRegion` (LTWH box, as stored). */
export interface TextRegionLike {
  id?: unknown;
  type?: unknown;
  bbox?: unknown;
  confidence?: unknown;
  headerText?: unknown;
  containedText?: unknown;
  rowCount?: unknown;
  hasNumberedItems?: unknown;
  classifiedLabels?: { tier1?: unknown } | null;
  grid?: { headers?: unknown; rows?: unknown } | null;
}

const finiteBox = (b: unknown): b is Box =>
  Array.isArray(b) && b.length === 4 && b.every((v) => typeof v === "number" && Number.isFinite(v));

/** The region's box as MinMax (stored LTWH, converted at this edge: E-4); null when malformed. */
export function textRegionMinMax(tr: TextRegionLike | null | undefined): BboxMinMax | null {
  if (!tr || !finiteBox(tr.bbox)) return null;
  return ltwhToMinMax(tr.bbox);
}

function isVerdict(value: unknown): value is TextRegionVerdict {
  const v = value as TextRegionVerdict | null;
  return !!v && typeof v === "object" && (v.verdict === "reject" || v.verdict === "accept")
    && typeof v.type === "string" && finiteBox(v.b) && typeof v.at === "string";
}

/** `pageIntelligence.textRegionVerdicts`, well-formed entries only (tolerates a missing or malformed key). */
export function storedTextRegionVerdicts(pageIntelligence: unknown): Record<string, TextRegionVerdict> {
  const raw = (pageIntelligence as { textRegionVerdicts?: unknown } | null)?.textRegionVerdicts;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, TextRegionVerdict> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) if (isVerdict(value)) out[key] = value;
  return out;
}

/**
 * The verdict that applies to a region of `type` at `b`, or null: the exact content key first, else the
 * same-type verdict with the highest IoU ≥ .7 (ties broken by key, so the answer is deterministic).
 */
export function findTextRegionVerdict(
  verdicts: Readonly<Record<string, Pick<TextRegionVerdict, "verdict" | "type" | "b">>>,
  type: string,
  b: Box,
): { key: string; verdict: "reject" | "accept" } | null {
  const exact = textRegionKey(type, b);
  const hit = verdicts[exact];
  if (hit && hit.type === type) return { key: exact, verdict: hit.verdict };
  let best: { key: string; verdict: "reject" | "accept"; iou: number } | null = null;
  for (const key of Object.keys(verdicts).sort()) {
    const v = verdicts[key];
    if (!v || v.type !== type || !finiteBox(v.b)) continue;
    const iou = iouMinMax(v.b, b);
    if (iou >= TEXT_REGION_VERDICT_IOU && (!best || iou > best.iou)) best = { key, verdict: v.verdict, iou };
  }
  return best ? { key: best.key, verdict: best.verdict } : null;
}

/**
 * Every stored verdict that applies to a region of `type` at `b` (the exact key, and every same-type verdict at
 * IoU ≥ .7), sorted. A new verdict on a region replaces all of them, so a region carries at most one verdict
 * after a re-OCR wobble re-minted its key (verify LOW-4); an Undo clears all of them.
 */
export function matchingTextRegionVerdictKeys(
  verdicts: Readonly<Record<string, Pick<TextRegionVerdict, "type" | "b">>>,
  type: string,
  b: Box,
): string[] {
  const exact = textRegionKey(type, b);
  return Object.keys(verdicts).filter((key) => {
    const v = verdicts[key];
    if (!v || v.type !== type) return false;
    return key === exact || (finiteBox(v.b) && iouMinMax(v.b, b) >= TEXT_REGION_VERDICT_IOU);
  }).sort();
}

// ── the ≥ 3-keys rule and the kind table (PLAN §2.1, C2-m8) ─────────────────────────────────────────

/** A numbered key opening a line: "1.", "12)", "(3)", "A." / "B)" — never "2.5 MM" or "1:50". */
const LINE_KEY = /^\s*(?:\(\s*(\d{1,3}|[A-Z])\s*\)|(\d{1,3}|[A-Z])[.)])\s+\S/;

/** Distinct numbered keys that open a line of `text` (interim, see the header). */
export function countParagraphKeys(text: unknown): number {
  if (typeof text !== "string" || text.length === 0) return 0;
  const keys = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = LINE_KEY.exec(line);
    if (m) keys.add(m[1] ?? m[2]);
  }
  return keys.size;
}

const LEGEND_TIER1 = new Set(["LEGEND", "ABBREVIATIONS"]);
const SHORT_NON_NUMERIC = /^(?=.*[A-Za-z])[^\s]{1,8}$/;

/** The key column of a key-value region: the grid's first column, else the first token of each line. */
function keyValueKeys(tr: TextRegionLike): string[] {
  const headers = Array.isArray(tr.grid?.headers) ? (tr.grid!.headers as unknown[]) : [];
  const rows = Array.isArray(tr.grid?.rows) ? (tr.grid!.rows as unknown[]) : [];
  const first = typeof headers[0] === "string" ? (headers[0] as string) : null;
  if (first && rows.length > 0) {
    return rows.map((r) => (r && typeof r === "object" ? String((r as Record<string, unknown>)[first] ?? "") : "")).map((s) => s.trim()).filter(Boolean);
  }
  if (typeof tr.containedText !== "string") return [];
  return tr.containedText.split(/\r?\n/).map((l) => l.trim().split(/\s+/)[0] ?? "").filter(Boolean);
}

/** True when a key-value region is a legend: tier1 LEGEND/ABBREVIATIONS, or ≥ 60 % short non-numeric keys. */
export function isLegendKeyValue(tr: TextRegionLike): boolean {
  const tier1 = tr.classifiedLabels?.tier1;
  if (typeof tier1 === "string" && LEGEND_TIER1.has(tier1.toUpperCase())) return true;
  const keys = keyValueKeys(tr);
  if (keys.length === 0) return false;
  return keys.filter((k) => SHORT_NON_NUMERIC.test(k)).length / keys.length >= 0.6;
}

/**
 * The inbox kind of a text region (PLAN §2.1 table), or null when it is not an inbox item.
 * `paragraph` counts only with `hasNumberedItems` and ≥ 3 keys, read from `containedText` or `rowCount`
 * (stored fields only: never recomputed per GET, C2-m5).
 */
export function textRegionInboxKind(tr: TextRegionLike): StructureKind | null {
  switch (tr.type) {
    case "notes-numbered": return "notes";
    case "notes-key-value": return isLegendKeyValue(tr) ? "legend" : "notes";
    case "spec-dense-columns": return "spec";
    case "schedule-table": {
      const tier1 = tr.classifiedLabels?.tier1;
      return typeof tier1 === "string" && tier1.toUpperCase() === "KEYNOTE" ? "keynote" : "schedule";
    }
    case "paragraph": {
      if (tr.hasNumberedItems !== true) return null;
      const rows = typeof tr.rowCount === "number" ? tr.rowCount : 0;
      return rows >= 3 || countParagraphKeys(tr.containedText) >= 3 ? "notes" : null;
    }
    default: return null;
  }
}

/** Kind family for dedupe: tables (schedule, keynote, legend) never merge with text (notes, spec). */
export function kindFamily(kind: StructureKind): "table" | "text" {
  return kind === "notes" || kind === "spec" ? "text" : "table";
}
