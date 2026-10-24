// [graph T8 2026-10-24] Knowledge graph v1 — the project-level pass and its storage.
//
// Build: every page row of the project (hidden duplicates included, flagged — they carry the
// revision_of edges), one Textract read per page (lines + the detail/sheet-shaped words only, never
// the whole project's OCR in memory at once), then src/lib/knowledge-graph builds the graph.
//
// Store, with NO migration and NO key in jsonb:
//   • S3 `{dataUrl}/graph/knowledge-graph.v1.json`        the full graph (13.5 MB on the largest
//                                                          measured set — scripts/knowledge-graph-measure.ts)
//   • S3 `{dataUrl}/graph/knowledge-graph.v1.index.json`  the reference index the viewer / LLM read
//   • projects.projectIntelligence.knowledgeGraph          the compact GraphSummary (counts, resolution
//                                                          rates, per-sheet degree, top unresolved)
// Both keys are DERIVED from projects.data_url (lib/knowledge-graph/summary.ts), so the summary that
// reaches members and exports never names an S3 object. Project deletion purges `{dataUrl}/`.
//
// Callers: upload end (lib/processing.ts), the intelligence reprocess, recomputeProject (hide /
// restore / delete) and the Reprocess "Knowledge graph" stage (reprocess-graph.ts). All of them go
// through refreshProjectGraph, which never throws: a graph failure must not fail the pipeline.

import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { pages, projects } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { downloadFromS3, uploadToS3 } from "@/lib/s3";
import { storedTagFamilies } from "@/lib/shape-ensemble/families";
import {
  buildKnowledgeGraph,
  graphIndex,
  graphIndexObjectKey,
  graphLinesFromTextract,
  graphObjectKey,
  graphWordsFromTextract,
  isKnowledgeGraph,
  KNOWLEDGE_GRAPH_INTELLIGENCE_KEY,
  pageInputFromStored,
  storedGraphSummary,
  summarizeGraph,
  type GraphIndex,
  type GraphPageInput,
  type GraphSummary,
  type KnowledgeGraph,
  type TagFamilyInput,
} from "@/lib/knowledge-graph";
import type { AuthSession, ProjectAccessRow } from "@/lib/api-utils";
import type { BboxLTWH } from "@/types";
import { ApiError } from "@/server/api/envelope";
import { type ProjectWriteCapability, withProjectWrite } from "@/server/api/project-write-capability";

export interface GraphProjectRow {
  id: number;
  publicId: string;
  dataUrl: string | null;
}

export interface ProjectGraphDeps {
  loadProject(projectId: number): Promise<GraphProjectRow | undefined>;
  listPages(projectId: number): Promise<Array<{
    id: number; pageNumber: number; name: string | null; drawingNumber: string | null;
    pageIntelligence: unknown; csiCodes: unknown; textAnnotations: unknown; keynotes: unknown;
  }>>;
  /** Textract lines + words of ONE page (null without OCR). */
  loadTextract(pageId: number): Promise<{ lines: Array<{ text: string; bbox: BboxLTWH }> | null; words: Array<{ text: string; bbox: BboxLTWH }> | null } | null>;
  /** Typed hook for the tag-families track: families for this project, or none. */
  loadTagFamilies(projectId: number): Promise<TagFamilyInput[] | undefined>;
  putObject(key: string, body: string): Promise<void>;
  /** null when the object does not exist. */
  getObject(key: string): Promise<string | null>;
  writeSummary(writeCapability: ProjectWriteCapability, projectId: number, summary: GraphSummary): Promise<void>;
}

const isMissing = (err: unknown): boolean => {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return e?.name === "NotFound" || e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
};

const dbDeps: ProjectGraphDeps = {
  async loadProject(projectId) {
    const [row] = await db.select({ id: projects.id, publicId: projects.publicId, dataUrl: projects.dataUrl })
      .from(projects).where(eq(projects.id, projectId)).limit(1);
    return row;
  },
  listPages: (projectId) =>
    db.select({
      id: pages.id, pageNumber: pages.pageNumber, name: pages.name, drawingNumber: pages.drawingNumber,
      pageIntelligence: pages.pageIntelligence, csiCodes: pages.csiCodes, textAnnotations: pages.textAnnotations, keynotes: pages.keynotes,
    }).from(pages).where(eq(pages.projectId, projectId)).orderBy(pages.pageNumber),
  async loadTextract(pageId) {
    const [row] = await db
      .select({ lines: sql<unknown>`${pages.textractData}->'lines'`, words: sql<unknown>`${pages.textractData}->'words'` })
      .from(pages).where(eq(pages.id, pageId)).limit(1);
    if (!row || (!row.lines && !row.words)) return null;
    const arr = (v: unknown) => (Array.isArray(v) ? (v as Array<{ text: string; bbox: BboxLTWH }>) : null);
    return { lines: arr(row.lines), words: arr(row.words) };
  },
  async loadTagFamilies(projectId) {
    // [wave3 merge] the tag-mapping track's families (projectIntelligence.tagFamilies, written at YOLO load).
    const [row] = await db.select({ pi: projects.projectIntelligence }).from(projects).where(eq(projects.id, projectId)).limit(1);
    const stored = storedTagFamilies(row?.pi);
    return stored?.families.map((f) => ({
      key: f.id, label: `${f.cls} ${f.pattern}`, members: [], pattern: f.pattern, pages: f.pages, confidence: 0.5,
    }));
  },
  putObject: (key, body) => uploadToS3(key, Buffer.from(body, "utf8"), "application/json", "private, no-store"),
  async getObject(key) {
    try {
      return (await downloadFromS3(key)).toString("utf8");
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  },
  async writeSummary(writeCapability, projectId, summary) {
    await withProjectWrite(writeCapability, projectId, async (tx) => {
      await tx.update(projects)
        .set({ projectIntelligence: sql`coalesce(${projects.projectIntelligence}, '{}'::jsonb) || jsonb_build_object(${KNOWLEDGE_GRAPH_INTELLIGENCE_KEY}::text, ${JSON.stringify(summary)}::jsonb)` })
        .where(eq(projects.id, projectId));
    });
  },
};

/** Assemble the builder input from stored rows and build. Pure apart from the reads. */
export async function buildProjectGraph(project: GraphProjectRow, deps: ProjectGraphDeps = dbDeps, now?: Date): Promise<KnowledgeGraph> {
  const rows = await deps.listPages(project.id);
  const inputs: GraphPageInput[] = [];
  for (const row of rows) {
    const ocr = await deps.loadTextract(row.id);
    inputs.push(pageInputFromStored({ ...row, lines: graphLinesFromTextract(ocr?.lines), words: graphWordsFromTextract(ocr?.words) }));
  }
  const tagFamilies = await deps.loadTagFamilies(project.id);
  return buildKnowledgeGraph({ publicId: project.publicId, pages: inputs, tagFamilies }, { now });
}

/** Full graph + index to S3 (derived keys), summary into projectIntelligence.knowledgeGraph. */
export async function persistProjectGraph(
  writeCapability: ProjectWriteCapability,
  project: GraphProjectRow & { dataUrl: string },
  graph: KnowledgeGraph,
  deps: ProjectGraphDeps = dbDeps,
): Promise<GraphSummary> {
  const json = JSON.stringify(graph);
  const summary = summarizeGraph(graph, Buffer.byteLength(json, "utf8"));
  await deps.putObject(graphObjectKey(project.dataUrl), json);
  await deps.putObject(graphIndexObjectKey(project.dataUrl), JSON.stringify(graphIndex(graph)));
  await deps.writeSummary(writeCapability, project.id, summary);
  return summary;
}

export interface GraphRefreshResult {
  ok: boolean;
  summary?: GraphSummary;
  /** "no-data-url" when the project has no storage prefix (nothing to write to). */
  reason?: string;
}

/** Build + persist under the caller's write capability. Never throws — logs and returns ok:false. */
export async function refreshProjectGraph(
  projectId: number,
  writeCapability: ProjectWriteCapability,
  deps: ProjectGraphDeps = dbDeps,
  now?: Date,
): Promise<GraphRefreshResult> {
  try {
    const project = await deps.loadProject(projectId);
    if (!project) return { ok: false, reason: "no-project" };
    if (!project.dataUrl) return { ok: false, reason: "no-data-url" };
    const graph = await buildProjectGraph(project, deps, now);
    const summary = await persistProjectGraph(writeCapability, { ...project, dataUrl: project.dataUrl }, graph, deps);
    logger.info(`[project-graph] project ${projectId}: ${graph.nodes.length} nodes, ${graph.edges.length} edges, refs ${summary.references.resolved}/${summary.references.total} resolved`);
    return { ok: true, summary };
  } catch (err) {
    logger.error(`[project-graph] project ${projectId} graph failed:`, err);
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export async function readProjectGraphIndex(dataUrl: string, deps: ProjectGraphDeps = dbDeps): Promise<GraphIndex | null> {
  const body = await deps.getObject(graphIndexObjectKey(dataUrl));
  if (!body) return null;
  const parsed = JSON.parse(body) as GraphIndex;
  return parsed && parsed.v === 1 && parsed.pages ? parsed : null;
}

export async function readProjectGraph(dataUrl: string, deps: ProjectGraphDeps = dbDeps): Promise<KnowledgeGraph | null> {
  const body = await deps.getObject(graphObjectKey(dataUrl));
  if (!body) return null;
  const parsed: unknown = JSON.parse(body);
  return isKnowledgeGraph(parsed) ? parsed : null;
}

/**
 * Compact view for the LLM `getCrossReferences` tool (lib/llm/tools.ts): the stored summary's
 * resolution counts plus, for one page, its resolved refers-to / referenced-by lists; for the whole
 * project, the unresolved queue head. null when the project has no graph yet.
 */
export async function projectGraphForLlm(projectId: number, pageNumber?: number, deps: ProjectGraphDeps = dbDeps): Promise<Record<string, unknown> | null> {
  const project = await deps.loadProject(projectId);
  if (!project?.dataUrl) return null;
  const index = await readProjectGraphIndex(project.dataUrl, deps);
  if (!index) return null;
  const strip = (l: { page: number | null; sheet: string; detail?: string; status: string; text?: string }) =>
    ({ page: l.page, sheet: l.sheet, ...(l.detail ? { detail: l.detail } : {}), status: l.status, ...(l.text ? { text: l.text } : {}) });
  if (typeof pageNumber === "number") {
    const entry = index.pages[pageNumber] ?? { refersTo: [], referencedBy: [] };
    return { computedAt: index.computedAt, refersTo: entry.refersTo.map(strip), referencedBy: entry.referencedBy.map(strip) };
  }
  return { computedAt: index.computedAt, references: index.references, unresolved: index.unresolved.slice(0, 50) };
}

export interface GraphQuery {
  view?: "index" | "full" | "page";
  page?: number;
}

const isAdminSession = (session: AuthSession | null): boolean =>
  Boolean(session?.user && (session.user.role === "admin" || session.user.isRootAdmin));

/**
 * GET /api/projects/[id]/graph — read-only (auth:{project}).
 *   default / view=index  the reference index + the stored summary (one fetch per project open)
 *   view=page&page=N      one page's refers-to / referenced-by, read from the index (no full-graph load)
 *   view=full             the whole graph (13.5 MB on the largest measured set) — company admin or
 *                         root only, so a member cannot make the server parse it on every call
 * `built:false` when the project has no graph yet (uploaded before this track, or not reprocessed).
 */
export async function getProjectGraph(project: ProjectAccessRow, query: GraphQuery, session: AuthSession | null, deps: ProjectGraphDeps = dbDeps): Promise<unknown> {
  if (!project.dataUrl) return { built: false, reason: "no-data-url" };
  const [row] = await db.select({ pi: projects.projectIntelligence }).from(projects).where(eq(projects.id, project.id)).limit(1);
  const summary = storedGraphSummary(row?.pi);
  if (query.view === "full") {
    if (!isAdminSession(session)) throw new ApiError("FORBIDDEN", "view=full is for company admins");
    const graph = await readProjectGraph(project.dataUrl, deps);
    return graph ? { built: true, summary, graph } : { built: false };
  }
  const index = await readProjectGraphIndex(project.dataUrl, deps);
  if (!index) return { built: false };
  if (query.view === "page") {
    if (typeof query.page !== "number") throw new ApiError("VALIDATION", "page is required for view=page");
    const entry = index.pages[query.page] ?? { refersTo: [], referencedBy: [] };
    return { built: true, computedAt: index.computedAt, page: query.page, ...entry };
  }
  return { built: true, summary, index };
}
