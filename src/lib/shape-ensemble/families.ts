// [tag-mapping v2 / tag families 2026-10-24] Discover a project's tag families: the same shape
// class holding the same text pattern (digits → 9) at least `minInstances` times across the set.
// Measured (research/shapes/REPORT.md §7b, 390 pages): 686 families with ≥ 3 instances in 143 of
// 209 sets, 20/24 real by pixel referee; the 4 false families were large rectangles / squares
// (window grid, glass panel, appliance box), so those two classes carry a size cap.
// Exported for tag mapping (which tags exist before any schedule is parsed) and for the knowledge
// graph builder (`tag_family` nodes); persisted compactly as `projectIntelligence.tagFamilies`.
// Pure: no DB, no I/O.

import { isTagLike, tagPattern } from "./text-rules";
import { storedShapeEnsemble, fromCompactShape } from "./summary";
import type { EnsembleShape } from "./types";

export const TAG_FAMILIES_VERSION = 1;

export interface TagFamily {
  /** `${cls}:${pattern}` */
  id: string;
  cls: string;
  /** Text pattern with digits replaced by 9 ("D-999", "T99", "9"). */
  pattern: string;
  /** Anchored regex source matching the pattern's strings ("^D-\\d{3}$"). */
  regex: string;
  instances: number;
  pages: number[];
  /** Up to 8 distinct example strings, most frequent first. */
  values: string[];
  distinctValues: number;
  sources: { yolo: number; classical: number; both: number };
  /** Median long side as a page fraction. */
  medianLongSide: number;
  /** Share of instances whose text Textract confirmed (read by Textract, or crop and Textract agree). */
  textractConfirmedShare: number;
  /** instances × (1 + both-arm share) × (1 + Textract-confirmed share); higher is better. */
  rank: number;
}

export interface TagFamiliesSummary {
  v: typeof TAG_FAMILIES_VERSION;
  computedAt: string;
  pagesScanned: number;
  families: TagFamily[];
}

export interface DiscoverTagFamiliesOptions {
  /** Default 3 (research §7b). */
  minInstances?: number;
  /** rectangle / square families above this median long side are dropped (default 250 px on a 10,800 px sheet). */
  maxBoxLongSide?: number;
  /** Families kept in a summary (default 200). */
  cap?: number;
}

const SIZE_CAPPED_CLASSES = new Set(["rectangle", "square"]);

export function patternRegex(pattern: string): string {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `^${escaped.replace(/9+/g, (run) => `\\d{${run.length}}`)}$`;
}

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export function discoverTagFamilies(
  pages: ReadonlyArray<{ pageNumber: number; shapes: readonly EnsembleShape[] }>,
  opts: DiscoverTagFamiliesOptions = {},
): TagFamily[] {
  const minInstances = opts.minInstances ?? 3;
  const maxBoxLongSide = opts.maxBoxLongSide ?? 250 / 10800;
  const cap = opts.cap ?? 200;
  const groups = new Map<string, {
    cls: string; pattern: string; pages: Set<number>; values: Map<string, number>; longSides: number[];
    sources: { yolo: number; classical: number; both: number }; confirmed: number; n: number;
  }>();
  for (const page of pages) {
    for (const s of page.shapes) {
      if (s.kind !== "tag" || !s.text || !isTagLike(s.text)) continue;
      const pattern = tagPattern(s.text);
      const key = `${s.cls}:${pattern}`;
      let g = groups.get(key);
      if (!g) {
        g = { cls: s.cls, pattern, pages: new Set(), values: new Map(), longSides: [], sources: { yolo: 0, classical: 0, both: 0 }, confirmed: 0, n: 0 };
        groups.set(key, g);
      }
      g.n++;
      g.pages.add(page.pageNumber);
      g.values.set(s.text, (g.values.get(s.text) ?? 0) + 1);
      g.longSides.push(s.longSide);
      g.sources[s.source]++;
      if (s.textSource === "textract" || s.textSource === "both-agree") g.confirmed++;
    }
  }
  const families: TagFamily[] = [];
  for (const [id, g] of groups) {
    if (g.n < minInstances) continue;
    const medianLongSide = median(g.longSides);
    if (SIZE_CAPPED_CLASSES.has(g.cls) && medianLongSide > maxBoxLongSide) continue;
    const bothShare = g.sources.both / g.n;
    const textractConfirmedShare = g.confirmed / g.n;
    families.push({
      id, cls: g.cls, pattern: g.pattern, regex: patternRegex(g.pattern),
      instances: g.n,
      pages: [...g.pages].sort((a, b) => a - b),
      values: [...g.values.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8).map(([v]) => v),
      distinctValues: g.values.size,
      sources: g.sources,
      medianLongSide: Math.round(medianLongSide * 1e5) / 1e5,
      textractConfirmedShare: Math.round(textractConfirmedShare * 100) / 100,
      rank: Math.round(g.n * (1 + bothShare) * (1 + textractConfirmedShare) * 100) / 100,
    });
  }
  families.sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id));
  return families.slice(0, cap);
}

/** Families from pages' stored `pageIntelligence.shapes` summaries (what the graph builder reads). */
export function tagFamiliesFromStoredPages(
  pages: ReadonlyArray<{ pageNumber: number; pageIntelligence: unknown }>,
  opts: DiscoverTagFamiliesOptions = {},
  now: Date = new Date(),
): TagFamiliesSummary {
  const inputs: Array<{ pageNumber: number; shapes: EnsembleShape[] }> = [];
  for (const p of pages) {
    const stored = storedShapeEnsemble(p.pageIntelligence);
    if (!stored) continue;
    inputs.push({ pageNumber: p.pageNumber, shapes: stored.shapes.map(fromCompactShape) });
  }
  return { v: TAG_FAMILIES_VERSION, computedAt: now.toISOString(), pagesScanned: inputs.length, families: discoverTagFamilies(inputs, opts) };
}

/** Type guard for a stored `projectIntelligence.tagFamilies` value. */
export function isTagFamiliesSummary(value: unknown): value is TagFamiliesSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v.v === TAG_FAMILIES_VERSION && Array.isArray(v.families) && typeof v.computedAt === "string";
}

export function storedTagFamilies(projectIntelligence: unknown): TagFamiliesSummary | undefined {
  if (!projectIntelligence || typeof projectIntelligence !== "object") return undefined;
  const stored = (projectIntelligence as Record<string, unknown>).tagFamilies;
  return isTagFamiliesSummary(stored) ? stored : undefined;
}
