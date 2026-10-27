// [graph T8 2026-10-24] buildKnowledgeGraph — one project's stored pages → the v1 graph (types.ts).
// Pure and deterministic: same input, same ids, same order. No DB, no S3, no LLM.
//
// What it resolves (research §3 "first edges are free"):
//   • sheet refs   pageIntelligence.crossRefs + textAnnotations sheet-ref / detail-ref + the stacked
//                  "N over SHEET" callout read from Textract words → `references` edges, resolved to
//                  the sheet node by normalised sheet number; unresolved / ambiguous ones stay as
//                  edges with `to: null` (the QA queue), never dropped. A number that several
//                  VISIBLE pages carry is ambiguous (fix round: 162 of 512 "resolved" edges had more
//                  than one candidate and went to an arbitrary page) unless the source page is one of
//                  them, which is a self reference. Self references keep the edge but are counted
//                  apart from cross-sheet resolution (summary.ts).
//   • details      "N  TITLE" lines and stacked bubbles naming the sheet itself → detail nodes
//                  (`defined_in` the sheet); a resolved detail ref whose detail has no title still
//                  gets a node (origin "reference-target") so the edge has somewhere to point.
//   • tables/rows  parsedRegions (user-promoted, with rows) + classifier regions → table nodes
//                  `inside` the sheet; schedule rows → table_row nodes; keynote legends → rows keyed
//                  by the keynote key.
//   • tags         door-window-tag / equipment-tag annotations → tag nodes `inside` the sheet,
//                  `scheduled_as` the table_row whose tag column reads the same text, in a schedule
//                  of the SAME FAMILY (door tag ↔ door/window schedule, equipment tag ↔ equipment
//                  schedule, keynote ↔ keynote legend) — project-wide within that family.
//   • keynotes     shape-parse keynotes → keynote_code nodes `inside` the sheet, `scheduled_as` the
//                  matching keynote-legend row.
//   • CSI          pages.csi_codes → sheet `has_csi` {span}; parsedRegion csiTags → table has_csi
//                  {span}; a tag scheduled in a table with CSI → tag has_csi {propagated, low trust}.
//   • revisions    same sheet number on 2–3 pages, admin duplicate marks → `revision_of`. A number
//                  on more pages than that is a title-block misread (49 pages read "Q143" on one
//                  set) and gets no same-number links.
//   • tag families supplied through the typed hook (another track builds them) → tag_family + is_a.
//
// Input shape: everything that members can edit (crossRefs, parsedRegions, regionsV2, annotations)
// is shape-checked in pageInputFromStored, so one malformed entry drops that entry, not the graph.

import { patternRegex } from "@/lib/shape-ensemble/families";
import type { BboxLTWH } from "@/types";
import { parsedRegionMinMax } from "@/lib/parsed-region-bbox";
import {
  isCalloutDetailNumber,
  isCalloutSheetNumber,
  isSheetNumberLike,
  normaliseDetailNumber,
  normaliseSheetNumber,
  parseDetailSlash,
  sheetPrefix,
} from "./sheet-number";
import {
  KNOWLEDGE_GRAPH_VERSION,
  type CsiCodeNode,
  type DetailNode,
  type Extractor,
  type GraphBuildInput,
  type GraphBuildOptions,
  type GraphEdge,
  type GraphNode,
  type GraphPageInput,
  type HasCsiEdge,
  type KnowledgeGraph,
  type PlainEdge,
  type Provenance,
  type ReferenceEdge,
  type ReferenceKind,
  type RevisionEdge,
  type SheetNode,
  type TableNode,
  type TableRowNode,
  type TagNode,
} from "./types";

export const PROVENANCE_CAP = 6;
export const TEXT_CAP = 80;
export const ROWS_PER_TABLE_CAP = 500;
export const TAG_TYPES: ReadonlySet<string> = new Set(["door-window-tag", "equipment-tag"]);
/** Same sheet number on more pages than this is a misread, not a revision set. */
export const REVISION_SAME_NUMBER_MAX_PAGES = 3;
/** Stacked callout geometry: the sheet number sits at most this many text-heights below the number … */
export const CALLOUT_MAX_GAP = 0.8;
/** … both tokens are bubble text (normalised height), and their heights are within this ratio. */
export const CALLOUT_MAX_TEXT_HEIGHT = 0.04;
export const CALLOUT_MAX_HEIGHT_RATIO = 2;

/** Numbered general notes start like this; a detail title does not. */
const NOTE_STARTERS = new Set([
  "ALL", "THE", "PROVIDE", "CONTRACTOR", "SEE", "REFER", "VERIFY", "INSTALL", "TYP", "TYPICAL", "NOT",
  "DO", "FOR", "AT", "IN", "ON", "TO", "AND", "OR", "WITH", "PER", "NEW", "EXISTING", "COORDINATE",
  "WHERE", "UNLESS", "THIS", "THESE", "USE", "NO", "ANY", "EACH",
]);
const RE_DETAIL_TITLE = /^(\d{1,2}|[A-Z])\s+([A-Z][A-Z0-9 ,.'&/()\-]{4,60})/;

const clip = (text: string | undefined): string | undefined =>
  text === undefined ? undefined : text.length > TEXT_CAP ? `${text.slice(0, TEXT_CAP - 1)}…` : text;

const ltwhFromMinMax = (b: [number, number, number, number]): BboxLTWH => [b[0], b[1], b[2] - b[0], b[3] - b[1]];

function prov(extractor: Extractor, page: number, bbox?: BboxLTWH, text?: string): Provenance {
  const p: Provenance = { extractor, page };
  if (bbox) p.bbox = bbox;
  const t = clip(text);
  if (t) p.text = t;
  return p;
}

function addProv(list: Provenance[], p: Provenance): void {
  if (list.length < PROVENANCE_CAP) list.push(p);
}

const sheetId = (page: number) => `sheet:${page}`;
const detailId = (page: number, number: string) => `detail:${page}:${number}`;
const csiId = (code: string) => `csi:${code}`;
const tagKey = (text: string) => text.trim().toUpperCase().replace(/\s+/g, " ");

/** Which kind of tag a schedule's rows answer to. "other" rows are indexed but never matched. */
export type ScheduleFamily = "opening" | "equipment" | "keynote" | "other";
export function scheduleFamily(category: string, hasKeynotes = false): ScheduleFamily {
  const c = category.toLowerCase();
  if (hasKeynotes || /keynote|legend|symbol/.test(c)) return "keynote";
  if (/door|window|opening|glaz|hardware/.test(c)) return "opening";
  if (/equip|mech|plumb|electr|light|fixture|panel|hvac|fan|pump|unit/.test(c)) return "equipment";
  return "other";
}
const TAG_FAMILY: Record<string, ScheduleFamily> = { "door-window-tag": "opening", "equipment-tag": "equipment" };
const rowKey = (family: ScheduleFamily, text: string) => `${family}|${tagKey(text)}`;

interface RawRef {
  page: number;
  kind: ReferenceKind;
  targetSheet: string;
  detail?: string;
  confidence: number;
  prov: Provenance;
}

class Graph {
  readonly nodes = new Map<string, GraphNode>();
  readonly edges = new Map<string, GraphEdge>();

  node<T extends GraphNode>(n: T): T {
    const existing = this.nodes.get(n.id) as T | undefined;
    if (existing) return existing;
    this.nodes.set(n.id, n);
    return n;
  }

  /** Plain edge, merged on (type, from, to); provenance accumulates, confidence keeps the max. */
  plain(type: PlainEdge["type"], from: string, to: string, confidence: number, p: Provenance): PlainEdge {
    const id = `${type}:${from}->${to}`;
    const existing = this.edges.get(id) as PlainEdge | undefined;
    if (existing) {
      addProv(existing.provenance, p);
      existing.confidence = Math.max(existing.confidence, confidence);
      return existing;
    }
    const edge: PlainEdge = { id, type, from, to, confidence, provenance: [p] };
    this.edges.set(id, edge);
    return edge;
  }

  csi(from: string, code: string, method: HasCsiEdge["method"], trust: number, p: Provenance): void {
    const id = `has_csi:${from}->${csiId(code)}`;
    const existing = this.edges.get(id) as HasCsiEdge | undefined;
    if (existing) {
      addProv(existing.provenance, p);
      // A direct span beats a propagated guess on the same pair.
      if (trust > existing.trust) { existing.trust = trust; existing.method = method; existing.confidence = trust; }
      return;
    }
    this.edges.set(id, { id, type: "has_csi", from, to: csiId(code), confidence: trust, method, trust, provenance: [p] });
  }
}

export function buildKnowledgeGraph(input: GraphBuildInput, options: GraphBuildOptions = {}): KnowledgeGraph {
  const g = new Graph();
  const pages = [...input.pages].sort((a, b) => a.pageNumber - b.pageNumber);
  const projectId = `project:${input.publicId}`;
  g.node({ id: projectId, type: "project", label: input.publicId, publicId: input.publicId, provenance: [] });

  // ── sheets ───────────────────────────────────────────────────────────────────────────────────
  const byKey = new Map<string, SheetNode[]>();
  const sheets = new Map<number, SheetNode>();
  for (const page of pages) {
    const key = normaliseSheetNumber(page.drawingNumber);
    const node: SheetNode = {
      id: sheetId(page.pageNumber), type: "sheet", page: page.pageNumber,
      label: page.drawingNumber ?? `Page ${page.pageNumber}`, number: page.drawingNumber ?? null, key,
      provenance: [prov("title-block", page.pageNumber, undefined, page.drawingNumber ?? undefined)],
    };
    if (page.classification?.discipline) node.discipline = page.classification.discipline;
    if (page.classification?.disciplinePrefix) node.disciplinePrefix = page.classification.disciplinePrefix;
    else if (key) node.disciplinePrefix = sheetPrefix(key) ?? undefined;
    if (page.classification?.subType) node.subType = page.classification.subType;
    if (page.name) node.title = clip(page.name);
    if (page.hidden) node.hidden = true;
    g.node(node);
    sheets.set(page.pageNumber, node);
    g.plain("inside", node.id, projectId, 1, prov("title-block", page.pageNumber));
    if (key) byKey.set(key, [...(byKey.get(key) ?? []), node]);
  }

  // ── revision_of: same number on 2–3 pages; admin duplicate marks ─────────────────────────────
  const revision = (from: SheetNode, to: SheetNode, basis: RevisionEdge["basis"], confidence: number, p: Provenance) => {
    const id = `revision_of:${from.id}->${to.id}`;
    const existing = g.edges.get(id) as RevisionEdge | undefined;
    if (existing) { addProv(existing.provenance, p); existing.confidence = Math.max(existing.confidence, confidence); return; }
    g.edges.set(id, { id, type: "revision_of", from: from.id, to: to.id, basis, confidence, provenance: [p] });
  };
  for (const [, list] of byKey) {
    if (list.length > REVISION_SAME_NUMBER_MAX_PAGES) continue; // a misread number, not a revision set
    for (let i = 1; i < list.length; i++) {
      revision(list[i], list[i - 1], "same-number", 0.6, prov("title-block", list[i].page, undefined, list[i].number ?? undefined));
    }
  }
  for (const page of pages) {
    const canonical = page.duplicateOf != null ? sheets.get(page.duplicateOf) : undefined;
    const self = sheets.get(page.pageNumber);
    if (canonical && self && canonical !== self) revision(self, canonical, "duplicate-mark", 0.9, prov("duplicateOf", page.pageNumber));
  }

  // ── sheet lookup ─────────────────────────────────────────────────────────────────────────────
  // Exact key first, then the prefix fallback (A101 → A101.01). In either pool, hidden pages
  // yield to visible ones; ONE visible page resolves; several visible pages are ambiguous unless
  // the source page is among them (a sheet naming its own number = self reference).
  const prefixIndex = new Map<string, SheetNode[]>();
  for (const [key, list] of byKey) {
    const dot = key.indexOf(".");
    if (dot > 0) { const base = key.slice(0, dot); prefixIndex.set(base, [...(prefixIndex.get(base) ?? []), ...list]); }
  }
  type Lookup = { status: "resolved" | "ambiguous" | "unresolved"; sheet?: SheetNode; candidates: SheetNode[]; viaPrefix: boolean };
  const pick = (list: SheetNode[], sourcePage: number, viaPrefix: boolean): Lookup => {
    const visible = list.filter((s) => !s.hidden);
    const pool = visible.length ? visible : list;
    if (pool.length === 1) return { status: "resolved", sheet: pool[0], candidates: list, viaPrefix };
    const self = pool.find((s) => s.page === sourcePage);
    if (self) return { status: "resolved", sheet: self, candidates: list, viaPrefix };
    return { status: "ambiguous", candidates: list, viaPrefix };
  };
  const lookup = (targetKey: string, sourcePage: number): Lookup => {
    const exact = byKey.get(targetKey);
    if (exact?.length) return pick(exact, sourcePage, false);
    const prefixed = prefixIndex.get(targetKey) ?? [];
    const distinct = new Set(prefixed.map((s) => s.key));
    if (distinct.size === 1) return pick(prefixed, sourcePage, true);
    if (distinct.size > 1) return { status: "ambiguous", candidates: prefixed, viaPrefix: true };
    return { status: "unresolved", candidates: [], viaPrefix: false };
  };

  // ── details: titles on the sheet + stacked bubbles; stacked callouts become refs ─────────────
  const rawRefs: RawRef[] = [];
  const defineDetail = (page: number, number: string, origin: DetailNode["origin"], confidence: number, p: Provenance): DetailNode => {
    const id = detailId(page, number);
    const existing = g.nodes.get(id) as DetailNode | undefined;
    if (existing) {
      addProv(existing.provenance, p);
      if (existing.origin === "reference-target" && origin !== "reference-target") existing.origin = origin;
      return existing;
    }
    const node: DetailNode = { id, type: "detail", page, number, label: `${number}`, origin, provenance: [p] };
    g.node(node);
    g.plain("defined_in", id, sheetId(page), confidence, p);
    return node;
  };

  for (const page of pages) {
    const own = sheets.get(page.pageNumber)!;
    for (const line of page.lines ?? []) {
      const text = line.text.trim().toUpperCase();
      if (text.length > 120 || text.split(/\s+/).length > 12) continue;
      const match = RE_DETAIL_TITLE.exec(text);
      if (!match) continue;
      const title = match[2].trim();
      const firstWord = title.split(/\s+/)[0];
      if (NOTE_STARTERS.has(firstWord) || isSheetNumberLike(title) || /^\d/.test(title)) continue;
      const number = normaliseDetailNumber(match[1]);
      if (!number) continue;
      const node = defineDetail(page.pageNumber, number, "title", 0.5, prov("detail-title", page.pageNumber, line.bbox, text));
      if (!node.label.includes(" ")) node.label = clip(`${number} ${title}`)!;
    }

    // Stacked bubble: a printed detail number with a printed sheet number directly below, centres
    // aligned, both bubble-sized, a bubble-sized gap between them.
    const words = page.words ?? [];
    const numbers = words.filter((w) => isCalloutDetailNumber(w.text) && w.bbox[3] <= CALLOUT_MAX_TEXT_HEIGHT);
    const sheetWords = words.filter((w) => isCalloutSheetNumber(w.text) && w.bbox[3] <= CALLOUT_MAX_TEXT_HEIGHT);
    if (numbers.length && sheetWords.length) {
      for (const n of numbers) {
        const [nl, nt, nw, nh] = n.bbox;
        const ncx = nl + nw / 2;
        let best: { w: typeof sheetWords[number]; gap: number } | null = null;
        for (const s of sheetWords) {
          const [sl, st, sw, sh] = s.bbox;
          const h = Math.max(nh, sh);
          if (h <= 0 || h > Math.min(nh, sh) * CALLOUT_MAX_HEIGHT_RATIO) continue;
          const gap = st - (nt + nh);
          if (gap < -0.2 * h || gap > CALLOUT_MAX_GAP * h) continue;
          if (Math.abs(sl + sw / 2 - ncx) > Math.max(nw, sw) * 0.6) continue;
          if (!best || gap < best.gap) best = { w: s, gap };
        }
        if (!best) continue;
        const detail = normaliseDetailNumber(n.text)!;
        const targetKey = normaliseSheetNumber(best.w.text)!;
        const bbox: BboxLTWH = [Math.min(nl, best.w.bbox[0]), nt, Math.max(nw, best.w.bbox[2]), best.w.bbox[1] + best.w.bbox[3] - nt];
        const text = `${n.text} / ${best.w.text}`;
        if (own.key && targetKey === own.key) {
          defineDetail(page.pageNumber, detail, "stacked-title", 0.7, prov("stacked-callout", page.pageNumber, bbox, text));
        } else {
          rawRefs.push({ page: page.pageNumber, kind: "detail", targetSheet: best.w.text, detail, confidence: 0.7, prov: prov("stacked-callout", page.pageNumber, bbox, text) });
        }
      }
    }
  }

  // ── references from the two stored extractors ────────────────────────────────────────────────
  for (const page of pages) {
    const own = sheets.get(page.pageNumber)!;
    for (const ref of page.crossRefs ?? []) {
      const detail = normaliseDetailNumber(ref.detail) ?? undefined;
      const kind: ReferenceKind = detail && ["detail", "section", "elevation"].includes(ref.refType) ? "detail" : "sheet";
      rawRefs.push({ page: page.pageNumber, kind, targetSheet: ref.targetDrawing, detail: kind === "detail" ? detail : undefined,
        confidence: ref.confidence ?? 0.8, prov: prov("crossRefs", page.pageNumber, ref.bbox, ref.sourceText) });
    }
    for (const a of page.textAnnotations ?? []) {
      const conf = typeof a.confidence === "number" ? Math.min(1, a.confidence > 1 ? a.confidence / 100 : a.confidence) : 0.7;
      if (a.type === "sheet-ref") {
        const sheet = typeof a.meta?.sheetNumber === "string" ? a.meta.sheetNumber : a.text.split(/\s+/).pop() ?? "";
        if (!isSheetNumberLike(sheet)) continue;
        rawRefs.push({ page: page.pageNumber, kind: "sheet", targetSheet: sheet, confidence: conf, prov: prov("text-annotations", page.pageNumber, a.bbox, a.text) });
      } else if (a.type === "detail-ref") {
        const metaSheet = typeof a.meta?.sheet === "string" ? a.meta.sheet : undefined;
        const metaDetail = typeof a.meta?.detail === "string" ? a.meta.detail : undefined;
        const slash = metaDetail ? parseDetailSlash(metaDetail) : null;
        const detail = slash?.detail ?? normaliseDetailNumber(metaDetail);
        const sheet = slash?.sheet ?? metaSheet ?? (detail && own.number ? own.number : undefined);
        if (!detail || !sheet || !isSheetNumberLike(sheet)) continue;
        rawRefs.push({ page: page.pageNumber, kind: "detail", targetSheet: sheet, detail, confidence: conf, prov: prov("text-annotations", page.pageNumber, a.bbox, a.text) });
      }
    }
  }

  // Merge by (source page, kind, target key, detail) and resolve.
  const merged = new Map<string, ReferenceEdge & { extractors: Set<string> }>();
  for (const r of rawRefs) {
    const targetKey = normaliseSheetNumber(r.targetSheet);
    if (!targetKey) continue;
    const id = `references:${sheetId(r.page)}->${targetKey}${r.kind === "detail" ? `#${r.detail}` : ""}`;
    const existing = merged.get(id);
    if (existing) {
      addProv(existing.provenance, r.prov);
      existing.confidence = Math.max(existing.confidence, r.confidence);
      existing.extractors.add(r.prov.extractor);
      continue;
    }
    merged.set(id, {
      id, type: "references", from: sheetId(r.page), to: null, kind: r.kind, targetSheet: r.targetSheet, targetKey,
      ...(r.kind === "detail" ? { detail: r.detail } : {}), status: "unresolved", confidence: r.confidence,
      provenance: [r.prov], seen: 1, extractors: new Set([r.prov.extractor]),
    });
  }
  for (const [id, edge] of merged) {
    const sourcePage = Number(edge.from.slice("sheet:".length));
    const found = lookup(edge.targetKey, sourcePage);
    edge.seen = edge.extractors.size;
    if (found.status === "resolved" && found.sheet) {
      edge.status = "resolved";
      if (found.viaPrefix) edge.confidence = Math.round(edge.confidence * 0.9 * 100) / 100;
      if (found.candidates.length > 1) edge.candidates = found.candidates.map((s) => s.id);
      if (found.sheet.page === sourcePage) edge.self = true;
      if (edge.kind === "detail" && edge.detail) {
        const existed = g.nodes.has(detailId(found.sheet.page, edge.detail));
        const node = defineDetail(found.sheet.page, edge.detail, "reference-target", 0.4, prov("reference-target", sourcePage, undefined, edge.provenance[0]?.text));
        edge.detailFound = existed;
        edge.to = node.id;
      } else {
        edge.to = found.sheet.id;
      }
    } else if (found.status === "ambiguous") {
      edge.status = "ambiguous";
      edge.candidates = found.candidates.map((s) => s.id);
    }
    const { extractors: _dropped, ...clean } = edge;
    void _dropped;
    g.edges.set(id, clean);
  }

  // ── CSI codes on sheets ──────────────────────────────────────────────────────────────────────
  const csiNode = (code: string, description?: string, division?: string): CsiCodeNode =>
    g.node<CsiCodeNode>({ id: csiId(code), type: "csi_code", label: code, code, description: clip(description), division: division ?? code.slice(0, 2), provenance: [] });
  for (const page of pages) {
    for (const c of page.csiCodes ?? []) {
      if (!c.code) continue;
      csiNode(c.code, c.description, c.division);
      const trigger = c.triggers?.[0];
      const trust = typeof c.confidence === "number" ? Math.max(0.05, Math.min(1, c.confidence)) : 0.5;
      g.csi(sheetId(page.pageNumber), c.code, "span", trust, prov("csiCodes", page.pageNumber, trigger?.bbox, trigger?.text));
    }
  }

  // ── tables, rows, and the project-wide row index by (schedule family, tag) ───────────────────
  const rowsByTag = new Map<string, TableRowNode[]>();
  const tableCsi = new Map<string, string[]>();
  const addTable = (page: number, id: string, category: string, bbox: BboxLTWH, confidence: number, p: Provenance, sourceId?: string): TableNode => {
    const node = g.node<TableNode>({ id, type: "table", page, label: category, category, bbox, provenance: [p], ...(sourceId ? { sourceId } : {}) });
    g.plain("inside", id, sheetId(page), confidence, p);
    return node;
  };
  for (const page of pages) {
    const pn = page.pageNumber;
    (page.parsedRegions ?? []).forEach((r, i) => {
      const id = `table:${pn}:pr:${r.id ?? i}`;
      const category = r.category || r.type || "parsed-region";
      const mm = parsedRegionMinMax(r); // the saved box is MinMax (K04); graph nodes are LTWH
      const bbox: BboxLTWH = mm ? ltwhFromMinMax(mm) : [0, 0, 0, 0];
      addTable(pn, id, category, bbox, 0.9, prov("parsedRegions", pn, mm ? bbox : undefined), r.id);
      for (const tag of r.csiTags ?? []) {
        if (!tag.code) continue;
        csiNode(tag.code, tag.description, tag.division);
        g.csi(id, tag.code, "span", 0.7, prov("parsedRegions", pn, mm ? bbox : undefined));
        tableCsi.set(id, [...(tableCsi.get(id) ?? []), tag.code]);
      }
      const data = (r.data ?? null) as { rows?: unknown[]; tagColumn?: string | number | null; keynotes?: Array<{ key: string; description?: string }> } | null;
      const rows: Array<{ tag?: string; label: string }> = [];
      const family = scheduleFamily(category, Array.isArray(data?.keynotes));
      if (Array.isArray(data?.rows)) {
        const col = typeof data?.tagColumn === "string" ? data.tagColumn : undefined;
        for (const row of data.rows.slice(0, ROWS_PER_TABLE_CAP)) {
          if (!row || typeof row !== "object") continue;
          const rec = row as Record<string, unknown>;
          const tag = col && typeof rec[col] === "string" ? (rec[col] as string) : undefined;
          const first = Object.values(rec).find((v) => typeof v === "string" && v.trim()) as string | undefined;
          rows.push({ tag: tag?.trim() || undefined, label: (tag?.trim() || first || "").toString() });
        }
      } else if (Array.isArray(data?.keynotes)) {
        for (const k of data.keynotes.slice(0, ROWS_PER_TABLE_CAP)) if (k?.key) rows.push({ tag: String(k.key).trim(), label: `${k.key} ${k.description ?? ""}`.trim() });
      }
      rows.forEach((row, rowIndex) => {
        const rowNode = g.node<TableRowNode>({ id: `${id}:row:${rowIndex}`, type: "table_row", page: pn, tableId: id, rowIndex, label: clip(row.label) ?? "", provenance: [prov("parsedRegions", pn)], ...(row.tag ? { tag: row.tag } : {}) });
        g.plain("inside", rowNode.id, id, 0.9, prov("parsedRegions", pn));
        if (row.tag && family !== "other") rowsByTag.set(rowKey(family, row.tag), [...(rowsByTag.get(rowKey(family, row.tag)) ?? []), rowNode]);
      });
    });
    (page.classifiedTables ?? []).forEach((t, i) => addTable(pn, `table:${pn}:ct:${t.id ?? i}`, t.category, t.bbox, t.confidence ?? 0.5, prov("classifiedTables", pn, t.bbox, t.headerText), t.id));
    for (const r of page.regionsV2?.regions ?? []) {
      if (r.kind !== "table" && r.kind !== "legend" && r.kind !== "keynotes") continue;
      const bbox = ltwhFromMinMax(r.bbox);
      addTable(pn, `table:${pn}:v2:${r.id}`, r.className === "UNCLASSIFIED" ? r.kind : r.className, bbox, r.nameScore, prov("regionsV2", pn, bbox), r.id);
    }
  }

  // ── tags and keynotes on drawings ────────────────────────────────────────────────────────────
  const schedule = (from: string, family: ScheduleFamily, text: string, p: Provenance, propagateCsi: boolean) => {
    for (const row of rowsByTag.get(rowKey(family, text)) ?? []) {
      g.plain("scheduled_as", from, row.id, 0.6, p);
      if (!propagateCsi) continue;
      for (const code of tableCsi.get(row.tableId) ?? []) g.csi(from, code, "propagated", 0.3, prov("parsedRegions", row.page));
    }
  };
  const tagNodes = new Map<string, TagNode>();
  for (const page of pages) {
    const pn = page.pageNumber;
    for (const a of page.textAnnotations ?? []) {
      if (!TAG_TYPES.has(a.type) || !a.text.trim()) continue;
      const key = tagKey(a.text);
      const id = `tag:${pn}:${key}`;
      const p = prov("text-annotations", pn, a.bbox, a.text);
      let node = tagNodes.get(id);
      if (node) { node.count++; addProv(node.provenance, p); }
      else {
        node = g.node<TagNode>({ id, type: "tag", page: pn, label: key, text: key, tagType: a.type, count: 1, provenance: [p] });
        tagNodes.set(id, node);
        g.plain("inside", id, sheetId(pn), 0.8, p);
        schedule(id, TAG_FAMILY[a.type] ?? "other", key, p, true);
      }
      for (const c of a.csiTags ?? []) { if (c.code) { csiNode(c.code, c.description, c.division); g.csi(id, c.code, "span", 0.6, p); } }
    }
    const seen = new Map<string, number>();
    for (const k of page.keynotes ?? []) {
      const code = (k.text ?? "").trim().toUpperCase();
      if (!code) continue;
      const id = `keynote:${pn}:${code}`;
      const bbox = k.bbox ? ltwhFromMinMax(k.bbox) : undefined;
      const p = prov("keynotes", pn, bbox, code);
      const existing = g.nodes.get(id);
      if (existing && existing.type === "keynote_code") { existing.count++; addProv(existing.provenance, p); seen.set(id, existing.count); continue; }
      g.node({ id, type: "keynote_code", page: pn, label: code, code, shape: k.shape, count: 1, provenance: [p] });
      g.plain("inside", id, sheetId(pn), 0.8, p);
      schedule(id, "keynote", code, p, false);
    }
  }

  // ── tag families (typed hook; built elsewhere) ───────────────────────────────────────────────
  for (const family of input.tagFamilies ?? []) {
    const id = `tag_family:${family.key}`;
    g.node({ id, type: "tag_family", key: family.key, label: family.label, provenance: [] });
    for (const m of family.members) {
      const tag = tagNodes.get(`tag:${m.page}:${tagKey(m.text)}`);
      if (tag) g.plain("is_a", tag.id, id, family.confidence ?? 0.5, prov("tag-families", m.page, m.bbox, m.text));
    }
    if (family.pattern && family.pages?.length) {
      const fits = new RegExp(patternRegex(family.pattern), "i"); // literal + \d{n} only: escaped, no backtracking
      const onPages = new Set(family.pages);
      for (const tag of tagNodes.values()) {
        if (onPages.has(tag.page) && fits.test(tagKey(tag.text))) {
          g.plain("is_a", tag.id, id, family.confidence ?? 0.5, prov("tag-families", tag.page, undefined, tag.text));
        }
      }
    }
  }

  const computedAt = (options.now ?? new Date()).toISOString();
  return {
    v: KNOWLEDGE_GRAPH_VERSION, computedAt, project: { publicId: input.publicId, pages: pages.length },
    nodes: [...g.nodes.values()], edges: [...g.edges.values()],
  };
}

// ── shape guards over member-editable jsonb ──────────────────────────────────────────────────────
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isBbox4 = (v: unknown): v is [number, number, number, number] => Array.isArray(v) && v.length === 4 && v.every(isNum);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const objs = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isObj) : []);
const codeTags = (v: unknown) => objs(v).filter((t) => isStr(t.code)) as unknown as Array<{ code: string; description?: string; division?: string }>;
const orNull = <T,>(list: T[]): T[] | null => (list.length ? list : null);

interface StoredAnnotation { type: string; text: string; bbox: BboxLTWH; confidence?: number; meta?: Record<string, unknown>; csiTags?: ReturnType<typeof codeTags> }

/** Narrow a stored pageIntelligence / row set to the builder's page input. Tolerant of old rows and
 *  of malformed member edits: an entry with the wrong shape is dropped, never thrown on. */
export function pageInputFromStored(row: {
  pageNumber: number;
  name?: string | null;
  drawingNumber: string | null;
  pageIntelligence: unknown;
  csiCodes?: unknown;
  textAnnotations?: unknown;
  keynotes?: unknown;
  lines?: GraphPageInput["lines"];
  words?: GraphPageInput["words"];
}): GraphPageInput {
  const pi = isObj(row.pageIntelligence) ? row.pageIntelligence : {};
  const dup = isObj(pi.duplicateOf) ? pi.duplicateOf : undefined;
  const cls = isObj(pi.classification) ? pi.classification : undefined;
  const annotations = isObj(row.textAnnotations) ? row.textAnnotations.annotations : undefined;
  const v2 = isObj(pi.regionsV2) ? pi.regionsV2 : undefined;
  const textAnnotations: StoredAnnotation[] = objs(annotations)
    .filter((a) => isStr(a.type) && (a.type === "sheet-ref" || a.type === "detail-ref" || TAG_TYPES.has(a.type)) && isStr(a.text) && isBbox4(a.bbox))
    .map((a) => ({
      type: a.type as string, text: a.text as string, bbox: a.bbox as BboxLTWH,
      ...(isNum(a.confidence) ? { confidence: a.confidence } : {}), ...(isObj(a.meta) ? { meta: a.meta } : {}),
      ...(Array.isArray(a.csiTags) ? { csiTags: codeTags(a.csiTags) } : {}),
    }));
  return {
    pageNumber: row.pageNumber,
    name: row.name ?? null,
    drawingNumber: row.drawingNumber,
    hidden: Boolean(dup?.hiddenAt),
    duplicateOf: isNum(dup?.pageNumber) ? dup.pageNumber : null,
    classification: cls
      ? { ...(isStr(cls.discipline) ? { discipline: cls.discipline } : {}), ...(isStr(cls.disciplinePrefix) ? { disciplinePrefix: cls.disciplinePrefix } : {}), ...(isStr(cls.subType) ? { subType: cls.subType } : {}) }
      : null,
    crossRefs: orNull(objs(pi.crossRefs).filter((r) => isStr(r.targetDrawing)).map((r) => ({
      sourceText: isStr(r.sourceText) ? r.sourceText : "", targetDrawing: r.targetDrawing as string, refType: isStr(r.refType) ? r.refType : "sheet",
      ...(isStr(r.detail) ? { detail: r.detail } : {}), ...(isBbox4(r.bbox) ? { bbox: r.bbox } : {}), ...(isNum(r.confidence) ? { confidence: r.confidence } : {}),
    }))),
    textAnnotations: orNull(textAnnotations),
    csiCodes: orNull(objs(row.csiCodes).filter((c) => isStr(c.code)).map((c) => ({
      code: c.code as string, ...(isStr(c.description) ? { description: c.description } : {}), ...(isStr(c.division) ? { division: c.division } : {}),
      ...(isNum(c.confidence) ? { confidence: c.confidence } : {}),
      ...(Array.isArray(c.triggers) ? { triggers: objs(c.triggers).map((t) => ({ ...(isStr(t.text) ? { text: t.text } : {}), ...(isBbox4(t.bbox) ? { bbox: t.bbox } : {}) })) } : {}),
    }))),
    classifiedTables: orNull(objs(pi.classifiedTables).filter((t) => isStr(t.category) && isBbox4(t.bbox)).map((t) => ({
      ...(isStr(t.id) ? { id: t.id } : {}), category: t.category as string, bbox: t.bbox as BboxLTWH,
      ...(isNum(t.confidence) ? { confidence: t.confidence } : {}), ...(isStr(t.headerText) ? { headerText: t.headerText } : {}),
    }))),
    regionsV2: v2 && Array.isArray(v2.regions)
      ? { regions: objs(v2.regions).filter((r) => isStr(r.id) && isStr(r.kind) && isBbox4(r.bbox)).map((r) => ({
          id: r.id as string, kind: r.kind as string, className: isStr(r.className) ? r.className : "UNCLASSIFIED",
          bbox: r.bbox as [number, number, number, number], nameScore: isNum(r.nameScore) ? r.nameScore : 0.5,
        })) }
      : null,
    parsedRegions: orNull(objs(pi.parsedRegions).map((r) => ({
      ...(isStr(r.id) ? { id: r.id } : {}), ...(isStr(r.type) ? { type: r.type } : {}), ...(isStr(r.category) ? { category: r.category } : {}),
      ...(isBbox4(r.bbox) ? { bbox: r.bbox } : {}), ...(Array.isArray(r.csiTags) ? { csiTags: codeTags(r.csiTags) } : {}),
      data: isObj(r.data) ? (r.data as NonNullable<GraphPageInput["parsedRegions"]>[number]["data"]) : null,
    }))),
    keynotes: orNull(objs(row.keynotes).filter((k) => isStr(k.text)).map((k) => ({
      text: k.text as string, ...(isStr(k.shape) ? { shape: k.shape } : {}), ...(isBbox4(k.bbox) ? { bbox: k.bbox } : {}),
    }))),
    lines: row.lines ?? null,
    words: row.words ?? null,
  };
}

/** The Textract words the builder reads: callout-shaped detail numbers and sheet numbers only. */
export function graphWordsFromTextract(words: Array<{ text: string; bbox: BboxLTWH; confidence?: number }> | null | undefined): GraphPageInput["words"] {
  if (!words?.length) return null;
  const out = words.filter((w) => isStr(w.text) && isBbox4(w.bbox) && (isCalloutDetailNumber(w.text) || isCalloutSheetNumber(w.text))).map((w) => ({ text: w.text, bbox: w.bbox }));
  return out.length ? out : null;
}

export function graphLinesFromTextract(lines: Array<{ text: string; bbox: BboxLTWH }> | null | undefined): GraphPageInput["lines"] {
  if (!lines?.length) return null;
  const out = lines.filter((l) => isStr(l.text) && isBbox4(l.bbox) && RE_DETAIL_TITLE.test(l.text.trim().toUpperCase())).map((l) => ({ text: l.text, bbox: l.bbox }));
  return out.length ? out : null;
}
