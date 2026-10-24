// [tag-mapping v2 / shape ensemble 2026-10-24] The compact projection persisted as
// `pageIntelligence.shapes` (server-owned: services/pages.ts updatePageIntelligence keeps a client
// patch from setting or clearing it) and its reader. Short keys and a cap keep page rows small —
// the median page holds ~40 yolo_primitive shapes, the densest hundreds.

import type { BboxMinMax } from "@/types";
import type { CompactShape, EnsembleShape, ShapeEnsembleResult, ShapeEnsembleSummary, ShapeKind, ShapeSource, ShapeTextSource } from "./types";
import { SHAPE_ENSEMBLE_VERSION } from "./types";

/** Shapes kept in the summary, highest confidence first. */
export const SHAPE_SUMMARY_CAP = 400;

const SOURCE: Record<ShapeSource, CompactShape["s"]> = { yolo: "y", classical: "c", both: "b" };
const SOURCE_BACK: Record<CompactShape["s"], ShapeSource> = { y: "yolo", c: "classical", b: "both" };
const TEXT_SOURCE: Record<ShapeTextSource, NonNullable<CompactShape["ts"]>> = { crop: "c", textract: "x", "both-agree": "a", "both-disagree": "d" };
const TEXT_SOURCE_BACK: Record<NonNullable<CompactShape["ts"]>, ShapeTextSource> = { c: "crop", x: "textract", a: "both-agree", d: "both-disagree" };
const KIND: Record<ShapeKind, CompactShape["kd"]> = { tag: "t", detail_callout: "d", detail_title: "v", legend_key: "l" };
const KIND_BACK: Record<CompactShape["kd"], ShapeKind> = { t: "tag", d: "detail_callout", v: "detail_title", l: "legend_key" };

const round = (n: number, places: number): number => Math.round(n * 10 ** places) / 10 ** places;

/** JSON with object keys sorted at every depth (Postgres reorders jsonb keys). */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function toCompactShape(s: EnsembleShape): CompactShape {
  return {
    b: s.bbox.map((n) => round(n, 5)) as BboxMinMax,
    c: s.cls,
    s: SOURCE[s.source],
    k: round(s.confidence, 2),
    t: s.text,
    ts: s.textSource ? TEXT_SOURCE[s.textSource] : null,
    kd: KIND[s.kind],
    z: s.zone,
    ...(s.callout ? { sh: s.callout.sheet } : {}),
  };
}

/** A stored compact shape widened to the in-memory shape (ids and reads not stored → null). */
export function fromCompactShape(c: CompactShape, index: number): EnsembleShape {
  const kind = KIND_BACK[c.kd];
  return {
    id: `s${index}`,
    bbox: c.b,
    cls: c.c,
    source: SOURCE_BACK[c.s],
    confidence: c.k,
    kind,
    text: c.t,
    textSource: c.ts ? TEXT_SOURCE_BACK[c.ts] : null,
    cropText: null,
    textractText: null,
    zone: c.z,
    longSide: Math.max(c.b[2] - c.b[0], c.b[3] - c.b[1]),
    yoloAnnotationId: null,
    classicalAnnotationId: null,
    modelName: null,
    ...(kind === "detail_callout" && c.sh ? { callout: { detail: c.t?.replace(c.sh, "").trim() ?? "", sheet: c.sh } } : {}),
  };
}

export function summarizeShapeEnsemble(result: ShapeEnsembleResult, now: Date = new Date()): ShapeEnsembleSummary {
  const kept = result.shapes.slice(0, SHAPE_SUMMARY_CAP);
  return {
    v: SHAPE_ENSEMBLE_VERSION,
    computedAt: now.toISOString(),
    counts: result.counts,
    drops: result.drops,
    shapes: kept.map(toCompactShape),
    truncated: Math.max(0, result.shapes.length - kept.length),
  };
}

/** Type guard for a stored `pageIntelligence.shapes` value (jsonb, so shape is not guaranteed). */
export function isShapeEnsembleSummary(value: unknown): value is ShapeEnsembleSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v.v === SHAPE_ENSEMBLE_VERSION && Array.isArray(v.shapes) && typeof v.computedAt === "string"
    && !!v.counts && typeof v.counts === "object";
}

export function storedShapeEnsemble(pageIntelligence: unknown): ShapeEnsembleSummary | undefined {
  if (!pageIntelligence || typeof pageIntelligence !== "object") return undefined;
  const stored = (pageIntelligence as Record<string, unknown>).shapes;
  return isShapeEnsembleSummary(stored) ? stored : undefined;
}

/** Equal apart from `computedAt` (and jsonb key order), so an unchanged page is not rewritten. */
export function sameShapeEnsemble(a: ShapeEnsembleSummary | undefined, b: ShapeEnsembleSummary | undefined): boolean {
  if (!a || !b) return a === b;
  const strip = ({ computedAt: _c, ...rest }: ShapeEnsembleSummary) => rest;
  return stableStringify(strip(a)) === stableStringify(strip(b));
}
