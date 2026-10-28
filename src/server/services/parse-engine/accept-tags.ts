/**
 * Tags on accept (table pipeline PLAN §3.3 A/B, §1.1 row 8; WP-3.G step 10; C3-M2).
 *
 * When the workspace commits a schedule, keynote or legend that has keys (a tag column, or row keys read from
 * tag shapes), the keys are mapped onto the drawings right away with the existing map-tags library
 * (`lib/tag-mapping`, the engine behind `POST …/map-tags-batch`) and its defaults, and written as the
 * region's tag projection through the tag-ops service (`replace-for-region`, so a re-accept replaces the
 * region's rows and keeps review statuses; rows of other regions are untouched):
 *   - keynotes and legends: THIS SHEET only (scope "page", K05); schedules: the whole project;
 *   - `model.tag.scope` (the `set-tag-scope` op) overrides that default;
 *   - strictness "balanced" (high + medium tiers kept), the map-tags route's default;
 *   - item type: text inside the tag shape class when the tag column came from shapes, else free text —
 *     the two the classic Keynote / Schedule "Map Tags" use.
 * Every row carries `links {regionId, rowId, kind}` (YoloTagLinks); a legend's rows are `source:"keynote"` with
 * `links.kind:"legend"` (YoloTag.source is not widened, C2-M9).
 *
 * Three halves, so the heavy one never runs under a lock (rule 11):
 *   `acceptTagPlan`           pure: model → keys, scope, item type (null → the model maps no tags);
 *   `computeAcceptTagMatches` reads pages + annotations and runs the matcher — BEFORE `withProjectWrite`;
 *   `buildAcceptTagRows`      pure: matches + the final region id → YoloTag rows + the AcceptBar summary.
 * Notes and specs map no tags in TP-3 (paragraph keys "1", "2" would hit every number on a plan); the Tags
 * step for keyed notes is TP-4.
 */

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { annotations, pages } from "@/lib/db/schema";
import {
  buildEnsembleContext,
  buildScope,
  DEFAULT_TAG_RULES,
  findOccurrences,
  inferTagPattern,
  type EnsembleContextPage,
  type MatchContext,
  type PageMeta,
  type ScoredMatch,
} from "@/lib/tag-mapping";
import { isHiddenDuplicate } from "@/lib/page-dedup/types";
import type { StructureModel, StructureTableModel } from "@/lib/parse-engine/types";
import type { TagSummary } from "@/lib/parse-engine/types-commit";
import type { YoloTagLinks } from "@/lib/parse-engine/tag-key";
import type { ClassifiedPageRegions, ClientAnnotation, PageIntelligence, QtoItemType, TextractPageData } from "@/types";
import type { StoredYoloTag } from "@/server/services/tag-ops";

/** The map-tags route's per-batch cap. */
export const ACCEPT_TAG_MAX_KEYS = 500;
const MAX_KEY_LENGTH = 64;

export interface AcceptTagKey {
  rowId: string;
  text: string;
  description: string;
  csi: string[];
}

export interface AcceptTagPlan {
  kind: StructureTableModel["kind"];
  page: number;
  scope: "sheet" | "project";
  itemType: QtoItemType;
  /** The tag shape class (item type "yolo-with-inner-text"). */
  shapeClass?: string;
  keys: AcceptTagKey[];
}

const clean = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();

/** Pure. The keys a committed model maps, or null when it maps none (notes, specs, a table without keys). */
const isTableModel = (m: StructureModel): m is StructureTableModel => m.kind === "schedule" || m.kind === "keynote" || m.kind === "legend";

export function acceptTagPlan(input: StructureModel, page: number): AcceptTagPlan | null {
  if (!isTableModel(input)) return null;
  const model: StructureTableModel = input;
  const cols = [...model.cols].sort((a, b) => a.x0 - b.x0);
  // A keynote with no tag column keys on its first column, as its legacy projection does (legacy-view.ts).
  const tagCol = model.tag?.col ?? (model.kind === "keynote" ? cols[0]?.id : undefined);
  const cellText = new Map(model.cells.map((c) => [`${c.row}\u0000${c.col}`, c.text]));
  const keys: AcceptTagKey[] = [];
  const seen = new Set<string>();
  for (const row of model.rows) {
    if (row.role !== "body") continue;
    const fromKey = row.key && row.key.kind !== "symbol" ? clean(row.key.text) : "";
    const text = fromKey || (tagCol ? clean(cellText.get(`${row.id}\u0000${tagCol}`)) : "");
    if (!text || text.length > MAX_KEY_LENGTH || seen.has(text.toUpperCase())) continue;
    seen.add(text.toUpperCase());
    const description = cols
      .filter((c) => c.id !== tagCol)
      .map((c) => clean(cellText.get(`${row.id}\u0000${c.id}`)))
      .filter(Boolean)
      .join(" ");
    const csi = [...new Set([...(row.csi ?? []), ...model.cells.filter((c) => c.row === row.id).flatMap((c) => c.csi ?? [])].map((r) => r.code))];
    keys.push({ rowId: row.id, text, description, csi });
    if (keys.length >= ACCEPT_TAG_MAX_KEYS) break;
  }
  if (!keys.length) return null;
  const scope = model.tag?.scope ?? (model.kind === "schedule" ? "project" : "sheet");
  const shapeClass = model.tag?.src === "shape" && model.tag.shapeClass ? model.tag.shapeClass : undefined;
  return {
    kind: model.kind,
    page,
    scope,
    itemType: shapeClass ? "yolo-with-inner-text" : "text-only",
    ...(shapeClass ? { shapeClass } : {}),
    keys,
  };
}

// ── matching (heavy: outside any lock) ──────────────────────────────────────────────────────────

export interface AcceptTagMatches {
  plan: AcceptTagPlan;
  /** key text → kept matches (balanced strictness). */
  results: Record<string, ScoredMatch[]>;
}

export interface AcceptTagSource {
  annotations: ClientAnnotation[];
  pages: { pageNumber: number; drawingNumber: string | null; textractData: unknown; pageIntelligence: unknown }[];
}

/** The project's annotations and the pages in scope (every page for project scope). */
export async function loadAcceptTagSource(projectId: number, pageNumbers: number[] | null): Promise<AcceptTagSource> {
  const rows = await db
    .select({
      id: annotations.id, pageNumber: annotations.pageNumber, name: annotations.name, minX: annotations.minX,
      minY: annotations.minY, maxX: annotations.maxX, maxY: annotations.maxY, note: annotations.note,
      source: annotations.source, data: annotations.data,
    })
    .from(annotations)
    .where(pageNumbers ? and(eq(annotations.projectId, projectId), inArray(annotations.pageNumber, pageNumbers)) : eq(annotations.projectId, projectId));
  const pageRows = await db
    .select({ pageNumber: pages.pageNumber, drawingNumber: pages.drawingNumber, textractData: pages.textractData, pageIntelligence: pages.pageIntelligence })
    .from(pages)
    .where(pageNumbers ? and(eq(pages.projectId, projectId), inArray(pages.pageNumber, pageNumbers)) : eq(pages.projectId, projectId));
  return {
    annotations: rows.map((a) => ({
      id: a.id, pageNumber: a.pageNumber, name: a.name, bbox: [a.minX, a.minY, a.maxX, a.maxY] as [number, number, number, number],
      note: a.note, source: a.source as ClientAnnotation["source"], data: a.data ?? null,
    })),
    pages: pageRows,
  };
}

/** The map-tags route's context assembly (services/map-tags.ts), for one plan. Pure over its source. */
export function acceptTagContext(plan: AcceptTagPlan, source: AcceptTagSource): MatchContext {
  const textractData: Record<number, TextractPageData> = {};
  const classifiedRegionsByPage: Record<number, ClassifiedPageRegions | undefined> = {};
  const pageMeta: PageMeta[] = [];
  const ensemblePages: EnsembleContextPage[] = [];
  const hidden = new Set<number>();
  for (const row of source.pages) {
    // A hidden duplicate sheet contributes neither words nor shapes (as the map-tags route).
    if (isHiddenDuplicate(row.pageIntelligence)) { hidden.add(row.pageNumber); continue; }
    if (row.textractData) textractData[row.pageNumber] = row.textractData as TextractPageData;
    const pi = row.pageIntelligence as PageIntelligence | null;
    if (pi?.classifiedRegions) classifiedRegionsByPage[row.pageNumber] = pi.classifiedRegions;
    pageMeta.push({ pageNumber: row.pageNumber, drawingNumber: row.drawingNumber });
    ensemblePages.push({ pageNumber: row.pageNumber, drawingNumber: row.drawingNumber, textractData: row.textractData as TextractPageData | null, pageIntelligence: pi });
  }
  const visible = hidden.size ? source.annotations.filter((a) => !hidden.has(a.pageNumber)) : source.annotations;
  const ensemble = buildEnsembleContext(visible, ensemblePages);
  const selectedPages = plan.scope === "sheet" ? [plan.page] : undefined;
  return {
    scope: buildScope({ pages: selectedPages }, pageMeta),
    isPageScoped: plan.scope === "sheet",
    annotations: visible,
    textractData,
    classifiedRegionsByPage,
    pattern: inferTagPattern(plan.keys.map((k) => k.text)),
    shapes: ensemble.shapes,
    sheetNumbers: ensemble.sheetNumbers,
    rules: DEFAULT_TAG_RULES,
  };
}

/** Balanced strictness (the route's default): high and medium tiers kept; scope re-checked. */
function balanced(scored: ScoredMatch[], plan: AcceptTagPlan): ScoredMatch[] {
  return scored.filter((m) => (m.confidenceTier ?? "high") !== "low" && (plan.scope !== "sheet" || m.pageNumber === plan.page));
}

/** Run the matcher for every key of the plan. Pure over its source (tests feed it a synthetic one). */
export function matchAcceptTags(plan: AcceptTagPlan, source: AcceptTagSource): AcceptTagMatches {
  const ctx = acceptTagContext(plan, source);
  const results: Record<string, ScoredMatch[]> = {};
  for (const key of plan.keys) {
    results[key.text] = balanced(findOccurrences({
      itemType: plan.itemType,
      label: key.text,
      ...(plan.shapeClass ? { yoloClass: plan.shapeClass } : {}),
      text: key.text,
    }, ctx), plan);
  }
  return { plan, results };
}

/** Load + match. Heavy (project scope reads every page's OCR): call it before `withProjectWrite`. */
export async function computeAcceptTagMatches(projectId: number, plan: AcceptTagPlan): Promise<AcceptTagMatches> {
  return matchAcceptTags(plan, await loadAcceptTagSource(projectId, plan.scope === "sheet" ? [plan.page] : null));
}

// ── rows (pure) ─────────────────────────────────────────────────────────────────────────────────

export function acceptTagSource(kind: AcceptTagPlan["kind"]): "keynote" | "schedule" {
  return kind === "schedule" ? "schedule" : "keynote";
}

/** YoloTag rows for `regionId` (keys with ≥ 1 hit) and the AcceptBar summary. */
export function buildAcceptTagRows(matches: AcceptTagMatches, regionId: string): { tags: StoredYoloTag[]; summary: TagSummary } {
  const { plan, results } = matches;
  const tags: StoredYoloTag[] = [];
  const noneKeys: string[] = [];
  let hits = 0;
  for (const key of plan.keys) {
    const instances = results[key.text] ?? [];
    if (!instances.length) {
      noneKeys.push(key.text);
      continue;
    }
    hits += instances.length;
    const links: YoloTagLinks = { regionId, rowId: key.rowId, kind: plan.kind };
    tags.push({
      id: `${regionId}:${key.rowId}`,
      name: key.text,
      tagText: key.text,
      yoloClass: plan.shapeClass ?? "",
      yoloModel: "",
      source: acceptTagSource(plan.kind),
      scope: plan.scope === "sheet" ? "page" : "project",
      ...(plan.scope === "sheet" ? { pageNumber: plan.page } : {}),
      description: key.description,
      ...(key.csi.length ? { csiCodes: key.csi } : {}),
      instances,
      mapScope: { strictness: "balanced" },
      links,
    });
  }
  return {
    tags,
    summary: { keys: plan.keys.length, tags: tags.length, hits, none: noneKeys.length, noneKeys: noneKeys.slice(0, 50), scope: plan.scope },
  };
}

/**
 * Legacy (unlinked) rows the classic Map Tags wrote for the CLASSIC region this commit replaces: classic ids are
 * `${source}-${page}-${key}-${ms}` (KeynotePanel / TableParsePanel), so a row is attributed to this page's table
 * by its id prefix and its tag text. Called only when a classic region is being replaced (never for a new region
 * or "keep both", where another table on the page may own the same key).
 */
export function legacyTagIdsToRetire(rows: readonly unknown[], plan: AcceptTagPlan): string[] {
  const source = acceptTagSource(plan.kind);
  const prefix = `${source}-${plan.page}-`;
  const keys = new Set(plan.keys.map((k) => k.text.toUpperCase()));
  const out: string[] = [];
  for (const row of rows) {
    const r = row as Partial<StoredYoloTag> | null;
    if (!r || typeof r.id !== "string" || r.links?.regionId !== undefined || r.source !== source) continue;
    if (!r.id.startsWith(prefix) || typeof r.tagText !== "string" || !keys.has(r.tagText.trim().toUpperCase())) continue;
    out.push(r.id);
  }
  return out;
}
