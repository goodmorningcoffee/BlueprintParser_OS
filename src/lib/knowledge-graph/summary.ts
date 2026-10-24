// [graph T8 2026-10-24] Storage shapes around the graph, all pure:
//   • graphObjectKey(dataUrl)   where the full graph lives in S3 — DERIVED from the project's data
//                               prefix, never stored (projectIntelligence reaches every member, the
//                               admin export and bp-export/1; same rule as lib/tiles/keys.ts).
//   • summarizeGraph(graph)     the compact record kept in projects.projectIntelligence.knowledgeGraph:
//                               counts, resolution rates, per-sheet degree, the top unresolved targets.
//   • graphIndex(graph)         what the viewer fetches once per project: per-page refers-to /
//                               referenced-by lists + the unresolved queue (edges only, no nodes).
//   • storedGraphSummary(pi)    typed read of the jsonb key from an untrusted value.

import type {
  DetailNode,
  GraphEdge,
  GraphNode,
  KnowledgeGraph,
  ReferenceEdge,
  ReferenceStatus,
  SheetNode,
} from "./types";

export const KNOWLEDGE_GRAPH_INTELLIGENCE_KEY = "knowledgeGraph";
export const UNRESOLVED_TOP_CAP = 25;
export const UNRESOLVED_QUEUE_CAP = 500;

export function graphObjectKey(dataUrl: string): string {
  return `${dataUrl}/graph/knowledge-graph.v1.json`;
}

/** The reference index (graphIndex) — what the viewer and the LLM tool read; measured on set 64
 *  (371 pages) the full graph is 13.5 MB while the index is edges of one type. */
export function graphIndexObjectKey(dataUrl: string): string {
  return `${dataUrl}/graph/knowledge-graph.v1.index.json`;
}

export interface GraphSummary {
  v: 1;
  computedAt: string;
  /** Where the full graph is: always S3 in v1 (the key is derived, see graphObjectKey). */
  stored: "s3";
  /** Serialized size of the full graph, bytes. */
  bytes: number;
  nodes: Record<string, number>;
  edges: Record<string, number>;
  /** total = resolved + unresolved + ambiguous + self. `resolved` is CROSS-SHEET only: a page naming
   *  its own sheet number is counted under `self` (fix round: 67 of 512 were self and inflated the
   *  rate from 50.4% to 58.0%). detailFound / detailMissing cover cross-sheet resolved detail refs. */
  references: { total: number; resolved: number; unresolved: number; ambiguous: number; self: number; detailFound: number; detailMissing: number };
  /** Per-sheet degree over cross-sheet `references` edges (out = refs from the page, in = resolved refs to it). */
  sheets: Array<{ page: number; number: string | null; out: number; in: number; unresolved: number }>;
  /** Most-cited unresolved targets, for the QA queue header. */
  unresolvedTop: Array<{ target: string; count: number }>;
}

export function summarizeGraph(graph: KnowledgeGraph, bytes: number): GraphSummary {
  const nodes: Record<string, number> = {};
  const edges: Record<string, number> = {};
  for (const n of graph.nodes) nodes[n.type] = (nodes[n.type] ?? 0) + 1;
  for (const e of graph.edges) edges[e.type] = (edges[e.type] ?? 0) + 1;
  const sheets = new Map<string, { page: number; number: string | null; out: number; in: number; unresolved: number }>();
  for (const n of graph.nodes) if (n.type === "sheet") sheets.set(n.id, { page: n.page, number: n.number, out: 0, in: 0, unresolved: 0 });
  const refs = { total: 0, resolved: 0, unresolved: 0, ambiguous: 0, self: 0, detailFound: 0, detailMissing: 0 };
  const unresolvedCounts = new Map<string, number>();
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const e of graph.edges) {
    if (e.type !== "references") continue;
    refs.total++;
    if (e.self) { refs.self++; continue; }
    refs[e.status]++;
    if (e.kind === "detail" && e.status === "resolved") refs[e.detailFound ? "detailFound" : "detailMissing"]++;
    const from = sheets.get(e.from);
    if (from) { from.out++; if (e.status !== "resolved") from.unresolved++; }
    if (e.status === "resolved" && e.to) {
      const target = targetSheetId(e, nodeById);
      const to = target ? sheets.get(target) : undefined;
      if (to) to.in++;
    } else {
      const label = e.kind === "detail" ? `${e.detail}/${e.targetSheet}` : e.targetSheet;
      unresolvedCounts.set(label, (unresolvedCounts.get(label) ?? 0) + 1);
    }
  }
  const unresolvedTop = [...unresolvedCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, UNRESOLVED_TOP_CAP)
    .map(([target, count]) => ({ target, count }));
  return {
    v: 1, computedAt: graph.computedAt, stored: "s3", bytes, nodes, edges, references: refs,
    sheets: [...sheets.values()].sort((a, b) => a.page - b.page), unresolvedTop,
  };
}

/** The sheet a resolved reference lands on (the detail's sheet for a detail reference). */
function targetSheetId(e: ReferenceEdge, nodeById: Map<string, GraphNode>): string | null {
  if (!e.to) return null;
  const node = nodeById.get(e.to);
  if (!node) return null;
  if (node.type === "sheet") return node.id;
  if (node.type === "detail") return `sheet:${(node as DetailNode).page}`;
  return null;
}

export interface GraphLink {
  /** The other end's page (null when unresolved / ambiguous). */
  page: number | null;
  sheet: string;
  detail?: string;
  kind: "sheet" | "detail";
  status: ReferenceStatus;
  confidence: number;
  /** Distinct extractors that saw it. */
  seen: number;
  /** One example of the text as read. */
  text?: string;
}

export interface UnresolvedReference {
  fromPage: number;
  fromSheet: string | null;
  sheet: string;
  detail?: string;
  status: Exclude<ReferenceStatus, "resolved">;
  /** Candidate pages when ambiguous. */
  candidates?: number[];
  text?: string;
  confidence: number;
}

export interface GraphIndex {
  v: 1;
  computedAt: string;
  counts: { nodes: number; edges: number };
  references: GraphSummary["references"];
  pages: Record<number, { refersTo: GraphLink[]; referencedBy: GraphLink[] }>;
  unresolved: UnresolvedReference[];
}

export function graphIndex(graph: KnowledgeGraph): GraphIndex {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const pages: GraphIndex["pages"] = {};
  const entry = (page: number) => (pages[page] ??= { refersTo: [], referencedBy: [] });
  const unresolved: UnresolvedReference[] = [];
  const pageOf = (id: string) => Number(id.slice("sheet:".length));
  for (const n of graph.nodes) if (n.type === "sheet") entry(n.page);
  for (const e of graph.edges) {
    if (e.type !== "references" || e.self) continue; // self references are not links between pages
    const fromPage = pageOf(e.from);
    const fromSheet = (nodeById.get(e.from) as SheetNode | undefined)?.number ?? null;
    const targetId = targetSheetId(e, nodeById);
    const toPage = targetId ? pageOf(targetId) : null;
    const text = e.provenance[0]?.text;
    const base = { sheet: e.targetSheet, kind: e.kind, status: e.status, confidence: e.confidence, seen: e.seen, ...(e.detail ? { detail: e.detail } : {}), ...(text ? { text } : {}) };
    entry(fromPage).refersTo.push({ page: toPage, ...base });
    if (toPage !== null && toPage !== fromPage) entry(toPage).referencedBy.push({ page: fromPage, ...base, sheet: fromSheet ?? `Page ${fromPage}` });
    if (e.status !== "resolved" && unresolved.length < UNRESOLVED_QUEUE_CAP) {
      unresolved.push({
        fromPage, fromSheet, sheet: e.targetSheet, status: e.status, confidence: e.confidence,
        ...(e.detail ? { detail: e.detail } : {}), ...(text ? { text } : {}),
        ...(e.candidates?.length ? { candidates: e.candidates.map(pageOf) } : {}),
      });
    }
  }
  const byPage = (a: GraphLink, b: GraphLink) => (a.page ?? 1e9) - (b.page ?? 1e9) || a.sheet.localeCompare(b.sheet);
  for (const p of Object.values(pages)) { p.refersTo.sort(byPage); p.referencedBy.sort(byPage); }
  unresolved.sort((a, b) => a.fromPage - b.fromPage || a.sheet.localeCompare(b.sheet));
  const refs = summarizeGraph(graph, 0).references;
  return { v: 1, computedAt: graph.computedAt, counts: { nodes: graph.nodes.length, edges: graph.edges.length }, references: refs, pages, unresolved };
}

/** Neighbourhood of one sheet: the node, every edge touching it, and the nodes at the other ends. */
export function sheetNeighbourhood(graph: KnowledgeGraph, page: number): { nodes: GraphNode[]; edges: GraphEdge[] } | null {
  const id = `sheet:${page}`;
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  if (!nodeById.has(id)) return null;
  const onPage = new Set(graph.nodes.filter((n) => n.page === page).map((n) => n.id));
  const edges = graph.edges.filter((e) => onPage.has(e.from) || (e.to !== null && onPage.has(e.to)));
  const ids = new Set<string>([id]);
  for (const e of edges) { ids.add(e.from); if (e.to) ids.add(e.to); }
  return { nodes: [...ids].map((i) => nodeById.get(i)).filter((n): n is GraphNode => Boolean(n)), edges };
}

export function isKnowledgeGraph(value: unknown): value is KnowledgeGraph {
  if (!value || typeof value !== "object") return false;
  const g = value as Partial<KnowledgeGraph>;
  return g.v === 1 && typeof g.computedAt === "string" && Array.isArray(g.nodes) && Array.isArray(g.edges) && !!g.project;
}

export function storedGraphSummary(projectIntelligence: unknown): GraphSummary | null {
  if (!projectIntelligence || typeof projectIntelligence !== "object") return null;
  const s = (projectIntelligence as Record<string, unknown>)[KNOWLEDGE_GRAPH_INTELLIGENCE_KEY] as Partial<GraphSummary> | undefined;
  if (!s || typeof s !== "object" || s.v !== 1 || typeof s.computedAt !== "string" || !s.references || !Array.isArray(s.sheets)) return null;
  return s as GraphSummary;
}
