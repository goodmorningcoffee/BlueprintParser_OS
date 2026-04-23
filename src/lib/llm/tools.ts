/**
 * tools.ts — LLM Tool Definitions + Executor for BlueprintParser
 *
 * Defines all tools the LLM can call and routes execution to existing
 * APIs/lib functions. Tools are grouped into:
 *   - Data retrieval (read-only, cheap)
 *   - YOLO tag tools (tag-specific intelligence)
 *   - Processing/analysis (on-demand computation)
 *   - Actions (mutations, affect the UI)
 */

import { db } from "@/lib/db";
import { projects, pages, annotations } from "@/lib/db/schema";
import { eq, and, sql, inArray } from "drizzle-orm";
import {
  findOccurrences,
  scanClassForTexts,
  allPagesScope,
  type MatchContext,
} from "@/lib/tag-mapping";
import { detectCsiCodes } from "@/lib/csi-detect";
import { detectTagPatterns } from "@/lib/tag-patterns";
import type { ClientAnnotation, TextractPageData } from "@/types";

// BP_TOOLS lives in ./tools-defs so client bundles don't pull in db/fs via this module.
export { BP_TOOLS } from "./tools-defs";

// ═══════════════════════════════════════════════════════════════════
// Tool Executor — routes tool calls to existing data/APIs
// ═══════════════════════════════════════════════════════════════════

export interface ToolContext {
  projectId: number;
  publicId: string;
  companyId: number;
  pageNumber?: number; // current page for page-scoped context
}

export async function executeToolCall(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  switch (name) {
    case "searchPages":
      if (typeof input.query !== "string") return { error: "query must be a string" };
      return execSearchPages(input.query, ctx);
    case "getProjectOverview":
      return execGetProjectOverview(ctx);
    case "getPageDetails":
      if (typeof input.pageNumber !== "number") return { error: "pageNumber must be a number" };
      return execGetPageDetails(input.pageNumber, ctx);
    case "lookupPagesByIndex":
      if (typeof input.index !== "string" || typeof input.key !== "string") return { error: "index and key must be strings" };
      return execLookupPagesByIndex(input.index, input.key, ctx);
    case "getAnnotations":
      return execGetAnnotations(input, ctx);
    case "getParsedSchedule":
      if (typeof input.pageNumber !== "number") return { error: "pageNumber must be a number" };
      return execGetParsedSchedule(input.pageNumber, input.category as string | undefined, ctx);
    case "getCsiSpatialMap":
      if (typeof input.pageNumber !== "number") return { error: "pageNumber must be a number" };
      return execGetCsiSpatialMap(input.pageNumber, ctx);
    case "getCrossReferences":
      return execGetCrossReferences(typeof input.pageNumber === "number" ? input.pageNumber : undefined, ctx);
    case "getSpatialContext":
      if (typeof input.pageNumber !== "number") return { error: "pageNumber must be a number" };
      return execGetSpatialContext(input.pageNumber, ctx);
    case "getPageOcrText":
      if (typeof input.pageNumber !== "number") return { error: "pageNumber must be a number" };
      return execGetPageOcrText(input.pageNumber, ctx);
    case "detectCsiFromText":
      if (typeof input.text !== "string") return { error: "text must be a string" };
      return detectCsiCodes(input.text);
    case "scanYoloClassTexts":
      if (typeof input.yoloClass !== "string") return { error: "yoloClass must be a string" };
      return execScanYoloClassTexts(input.yoloClass, input.yoloModel as string | undefined, typeof input.pageNumber === "number" ? input.pageNumber : undefined, ctx);
    case "mapTagsToPages":
      if (typeof input.tags !== "string") return { error: "tags must be a comma-separated string" };
      return execMapTagsToPages(input.tags, input.yoloClass as string | undefined, input.yoloModel as string | undefined, typeof input.pageNumber === "number" ? input.pageNumber : undefined, ctx);
    case "detectTagPatterns":
      return execDetectTagPatterns(ctx);
    case "getOcrTextInRegion":
      if (typeof input.pageNumber !== "number" || typeof input.minX !== "number") return { error: "pageNumber and bbox coordinates required" };
      return execGetOcrTextInRegion(input.pageNumber, input as Record<string, number>, ctx);
    // Actions return action descriptors (frontend interprets them)
    case "navigateToPage":
      return { action: "navigate", pageNumber: input.pageNumber };
    case "highlightRegion":
      return { action: "highlight", pageNumber: input.pageNumber, bbox: [input.minX, input.minY, input.maxX, input.maxY], label: input.label };
    case "createMarkup":
      return execCreateMarkup(input, ctx);
    case "addNoteToAnnotation":
      return execAddNoteToAnnotation(input.annotationId as number, input.note as string, ctx);
    case "batchAddNotes":
      return execBatchAddNotes(input, ctx);
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ═══════════════════════════════════════════════════════════════════
// Executor implementations
// ═══════════════════════════════════════════════════════════════════

async function execSearchPages(query: string, ctx: ToolContext) {
  if (!query || query.length < 2) return { error: "Query must be at least 2 characters" };
  const results = await db.execute(sql`
    SELECT p.page_number, p.name, p.drawing_number,
      ts_rank(p.search_vector, plainto_tsquery('english', ${query})) AS rank,
      ts_headline('english', p.raw_text, plainto_tsquery('english', ${query}),
        'MaxWords=30, MinWords=10, StartSel=**, StopSel=**') AS snippet
    FROM pages p
    WHERE p.project_id = ${ctx.projectId}
      AND p.search_vector @@ plainto_tsquery('english', ${query})
    ORDER BY rank DESC LIMIT 20
  `);
  return { query, results: results.rows };
}

async function execGetProjectOverview(ctx: ToolContext) {
  const [project] = await db
    .select({
      name: projects.name,
      numPages: projects.numPages,
      status: projects.status,
      projectIntelligence: projects.projectIntelligence,
      projectSummary: projects.projectSummary,
    })
    .from(projects)
    .where(eq(projects.id, ctx.projectId))
    .limit(1);

  if (!project) return { error: "Project not found" };

  const intel = project.projectIntelligence;
  return {
    name: project.name,
    numPages: project.numPages,
    status: project.status,
    disciplines: intel?.disciplines,
    summaries: intel?.summaries,
    csiGraph: intel?.csiGraph ? { nodeCount: (intel.csiGraph as any).nodes?.length, clusterCount: (intel.csiGraph as any).clusters?.length } : null,
    projectSummary: project.projectSummary,
  };
}

async function execGetPageDetails(pageNumber: number, ctx: ToolContext) {
  const [page] = await db
    .select({
      pageNumber: pages.pageNumber,
      name: pages.name,
      drawingNumber: pages.drawingNumber,
      keynotes: pages.keynotes,
      csiCodes: pages.csiCodes,
      textAnnotations: pages.textAnnotations,
      pageIntelligence: pages.pageIntelligence,
    })
    .from(pages)
    .where(and(eq(pages.projectId, ctx.projectId), eq(pages.pageNumber, pageNumber)))
    .limit(1);

  if (!page) return { error: `Page ${pageNumber} not found` };

  const intel = page.pageIntelligence;
  // Return structured data, omit raw bboxes to save tokens
  return {
    pageNumber: page.pageNumber,
    name: page.name,
    drawingNumber: page.drawingNumber,
    classification: intel?.classification,
    crossRefs: intel?.crossRefs,
    noteBlocks: intel?.noteBlocks,
    heuristicInferences: intel?.heuristicInferences,
    classifiedTables: intel?.classifiedTables?.map((t) => ({
      category: t.category, confidence: t.confidence, evidence: t.evidence, headerText: t.headerText,
    })),
    parsedRegions: intel?.parsedRegions?.map((r) => ({
      type: r.type, category: r.category, confidence: r.confidence,
      data: r.data ? { headers: (r.data as any).headers, rowCount: (r.data as any).rows?.length || (r.data as any).keynotes?.length || 0, tagColumn: (r.data as any).tagColumn } : null,
    })),
    csiSpatialSummary: intel?.csiSpatialMap?.summary,
    csiCodes: page.csiCodes,
    textAnnotationSummary: page.textAnnotations?.summary,
    keynoteCount: Array.isArray(page.keynotes) ? page.keynotes.length : 0,
  };
}

async function execLookupPagesByIndex(index: string, key: string, ctx: ToolContext) {
  const [project] = await db
    .select({ projectIntelligence: projects.projectIntelligence })
    .from(projects)
    .where(eq(projects.id, ctx.projectId))
    .limit(1);

  const summaries = project?.projectIntelligence?.summaries;
  if (!summaries) return { error: "Project summaries not computed yet" };

  const indexMap: Record<string, Record<string, number[]>> = {
    csi: summaries.csiPageIndex || {},
    trade: summaries.tradePageIndex || {},
    keynote: summaries.keynotePageIndex || {},
    textAnnotation: summaries.textAnnotationPageIndex || {},
  };

  const idx = indexMap[index];
  if (!idx) return { error: `Unknown index: ${index}` };

  // Try exact match first, then prefix match
  const exact = idx[key];
  if (exact) return { index, key, pages: exact };

  // Prefix search for CSI (e.g., "08" matches "08 11 16")
  const prefixMatches: Record<string, number[]> = {};
  const keyUpper = key.toUpperCase().replace(/\s/g, "");
  for (const [k, v] of Object.entries(idx)) {
    if (k.toUpperCase().replace(/\s/g, "").startsWith(keyUpper)) {
      prefixMatches[k] = v;
    }
  }
  if (Object.keys(prefixMatches).length > 0) return { index, key, prefixMatches };
  return { index, key, pages: [] };
}

async function execGetAnnotations(input: Record<string, unknown>, ctx: ToolContext) {
  // Push all possible filters to DB query
  const conditions = [eq(annotations.projectId, ctx.projectId)];
  if (input.pageNumber) conditions.push(eq(annotations.pageNumber, input.pageNumber as number));
  if (input.source) conditions.push(eq(annotations.source, input.source as string));
  if (input.className) conditions.push(eq(annotations.name, input.className as string));

  const allAnns = await db
    .select({
      id: annotations.id, pageNumber: annotations.pageNumber, name: annotations.name,
      minX: annotations.minX, minY: annotations.minY, maxX: annotations.maxX, maxY: annotations.maxY,
      source: annotations.source, data: annotations.data, note: annotations.note,
    })
    .from(annotations)
    .where(and(...conditions));

  // JS-level filter for confidence (stored in JSONB, can't push to DB easily)
  let filtered = allAnns;
  if (input.minConfidence) {
    const min = input.minConfidence as number;
    filtered = filtered.filter((a) => ((a.data as any)?.confidence ?? 1) >= min);
  }

  // Summarize to save tokens — don't return raw bboxes unless few results
  if (filtered.length > 50) {
    const byClass: Record<string, { count: number; pages: Set<number> }> = {};
    for (const a of filtered) {
      if (!byClass[a.name]) byClass[a.name] = { count: 0, pages: new Set() };
      byClass[a.name].count++;
      byClass[a.name].pages.add(a.pageNumber);
    }
    return {
      totalCount: filtered.length,
      summary: Object.entries(byClass).map(([cls, d]) => ({ class: cls, count: d.count, pages: [...d.pages].sort((a, b) => a - b) })),
      bboxOmittedForBrevity: true,
      hint: "Re-call with a narrower filter (pageNumber or className) to receive bbox coordinates.",
    };
  }

  return {
    totalCount: filtered.length,
    annotations: filtered.map((a) => ({
      id: a.id, pageNumber: a.pageNumber, class: a.name, source: a.source,
      bbox: [a.minX, a.minY, a.maxX, a.maxY] as [number, number, number, number],
      confidence: (a.data as any)?.confidence, note: a.note,
      csiCodes: (a.data as any)?.csiCodes,
    })),
  };
}

async function execGetParsedSchedule(pageNumber: number, category: string | undefined, ctx: ToolContext) {
  const [page] = await db
    .select({ pageIntelligence: pages.pageIntelligence })
    .from(pages)
    .where(and(eq(pages.projectId, ctx.projectId), eq(pages.pageNumber, pageNumber)))
    .limit(1);

  const regions = page?.pageIntelligence?.parsedRegions || [];
  let matched = regions.filter((r: any) => r.data?.headers);
  if (category) matched = matched.filter((r: any) => r.category === category);
  if (matched.length === 0) return { error: `No parsed schedules on page ${pageNumber}${category ? ` with category ${category}` : ""}` };

  return matched.map((r: any) => ({
    type: r.type,
    category: r.category,
    name: r.data?.tableName || r.category,
    headers: r.data?.headers,
    rows: r.data?.rows?.slice(0, 20), // cap at 20 rows to save tokens
    totalRows: r.data?.rows?.length || 0,
    tagColumn: r.data?.tagColumn,
    csiTags: r.csiTags,
  }));
}

async function execGetCsiSpatialMap(pageNumber: number, ctx: ToolContext) {
  const [page] = await db
    .select({ pageIntelligence: pages.pageIntelligence })
    .from(pages)
    .where(and(eq(pages.projectId, ctx.projectId), eq(pages.pageNumber, pageNumber)))
    .limit(1);

  return page?.pageIntelligence?.csiSpatialMap || { error: "No spatial map for this page" };
}

async function execGetCrossReferences(pageNumber: number | undefined, ctx: ToolContext) {
  if (pageNumber) {
    const [page] = await db
      .select({ pageIntelligence: pages.pageIntelligence })
      .from(pages)
      .where(and(eq(pages.projectId, ctx.projectId), eq(pages.pageNumber, pageNumber)))
      .limit(1);
    return { pageNumber, crossRefs: page?.pageIntelligence?.crossRefs || [] };
  }

  // Full project graph
  const [project] = await db
    .select({ projectIntelligence: projects.projectIntelligence })
    .from(projects)
    .where(eq(projects.id, ctx.projectId))
    .limit(1);
  return {
    refGraph: project?.projectIntelligence?.refGraph || { edges: [], hubs: [], leaves: [] },
  };
}

async function execGetSpatialContext(pageNumber: number, ctx: ToolContext) {
  // Need both textract data and annotations for spatial mapping
  const [page] = await db
    .select({ textractData: pages.textractData })
    .from(pages)
    .where(and(eq(pages.projectId, ctx.projectId), eq(pages.pageNumber, pageNumber)))
    .limit(1);

  const anns = await db
    .select({ id: annotations.id, name: annotations.name, minX: annotations.minX, minY: annotations.minY, maxX: annotations.maxX, maxY: annotations.maxY, data: annotations.data })
    .from(annotations)
    .where(and(eq(annotations.projectId, ctx.projectId), eq(annotations.pageNumber, pageNumber), eq(annotations.source, "yolo")));

  if (!page?.textractData) return { error: "No OCR data for this page" };
  const { mapWordsToRegions } = await import("@/lib/spatial");
  const textractData = page.textractData as TextractPageData;
  const spatialAnns = anns.filter((a) => {
    const classType = (a.data as any)?.classType;
    return classType === "spatial" || classType === "both";
  });

  if (spatialAnns.length === 0) return { note: "No spatial YOLO regions on this page (title blocks, grids, etc.). Try getPageOcrText instead." };

  const result = mapWordsToRegions(textractData, spatialAnns.map((a) => ({
    name: a.name,
    minX: a.minX,
    minY: a.minY,
    maxX: a.maxX,
    maxY: a.maxY,
    confidence: (a.data as any)?.confidence || 0,
  })));

  return {
    regions: result.regions.map((r) => ({ name: r.className, text: r.text.substring(0, 2000) })),
    unmappedTextPreview: result.unmappedText.substring(0, 1000),
  };
}

async function execGetPageOcrText(pageNumber: number, ctx: ToolContext) {
  const [page] = await db
    .select({ rawText: pages.rawText })
    .from(pages)
    .where(and(eq(pages.projectId, ctx.projectId), eq(pages.pageNumber, pageNumber)))
    .limit(1);

  if (!page) return { error: `Page ${pageNumber} not found` };
  // Cap at 8000 chars to avoid blowing context
  const text = page.rawText || "";
  return { pageNumber, text: text.substring(0, 8000), truncated: text.length > 8000, totalChars: text.length };
}

async function execScanYoloClassTexts(yoloClass: string, yoloModel: string | undefined, pageNumber: number | undefined, ctx: ToolContext) {
  // Filter annotations at DB level — only load the target class
  const annConditions = [eq(annotations.projectId, ctx.projectId), eq(annotations.source, "yolo"), eq(annotations.name, yoloClass)];
  if (pageNumber) annConditions.push(eq(annotations.pageNumber, pageNumber));

  const filteredAnns = await db
    .select({ id: annotations.id, pageNumber: annotations.pageNumber, name: annotations.name, minX: annotations.minX, minY: annotations.minY, maxX: annotations.maxX, maxY: annotations.maxY, source: annotations.source, data: annotations.data, note: annotations.note })
    .from(annotations)
    .where(and(...annConditions));

  const clientAnns: ClientAnnotation[] = filteredAnns.map((a) => ({
    id: a.id, pageNumber: a.pageNumber, name: a.name,
    bbox: [a.minX, a.minY, a.maxX, a.maxY] as [number, number, number, number],
    note: a.note, source: a.source as ClientAnnotation["source"], data: a.data ?? null,
  }));

  // Only load textract for pages that have matching annotations
  const relevantPages = [...new Set(clientAnns.map((a) => a.pageNumber))];
  const textractMap: Record<number, TextractPageData> = {};
  if (relevantPages.length > 0) {
    const pageRows = await db
      .select({ pageNumber: pages.pageNumber, textractData: pages.textractData })
      .from(pages)
      .where(and(eq(pages.projectId, ctx.projectId), relevantPages.length <= 50 ? inArray(pages.pageNumber, relevantPages) : sql`1=1`));
    for (const row of pageRows) if (row.textractData) textractMap[row.pageNumber] = row.textractData as TextractPageData;
  }

  const results = scanClassForTexts(yoloClass, yoloModel, clientAnns, textractMap);
  return { yoloClass, pageScope: pageNumber || "project", totalAnnotations: clientAnns.length, texts: results.map((r) => ({ text: r.text, count: r.count, pages: r.pages })) };
}

async function execMapTagsToPages(tagsStr: string, yoloClass: string | undefined, yoloModel: string | undefined, pageNumber: number | undefined, ctx: ToolContext) {
  const tags = tagsStr.split(",").map((t) => t.trim()).filter(Boolean);
  if (tags.length === 0) return { error: "No tags provided" };

  // Filter annotations at DB level
  const annConditions = [eq(annotations.projectId, ctx.projectId)];
  if (yoloClass) { annConditions.push(eq(annotations.source, "yolo")); annConditions.push(eq(annotations.name, yoloClass)); }
  if (pageNumber) annConditions.push(eq(annotations.pageNumber, pageNumber));

  const filteredAnns = await db
    .select({ id: annotations.id, pageNumber: annotations.pageNumber, name: annotations.name, minX: annotations.minX, minY: annotations.minY, maxX: annotations.maxX, maxY: annotations.maxY, source: annotations.source, data: annotations.data, note: annotations.note })
    .from(annotations)
    .where(and(...annConditions));

  const clientAnns: ClientAnnotation[] = filteredAnns.map((a) => ({
    id: a.id, pageNumber: a.pageNumber, name: a.name,
    bbox: [a.minX, a.minY, a.maxX, a.maxY] as [number, number, number, number],
    note: a.note, source: a.source as ClientAnnotation["source"], data: a.data ?? null,
  }));

  // Only load textract for relevant pages
  const pageConditions = [eq(pages.projectId, ctx.projectId)];
  if (pageNumber) pageConditions.push(eq(pages.pageNumber, pageNumber));

  const pageRows = await db
    .select({ pageNumber: pages.pageNumber, textractData: pages.textractData })
    .from(pages)
    .where(and(...pageConditions));

  const textractMap: Record<number, TextractPageData> = {};
  for (const row of pageRows) if (row.textractData) textractMap[row.pageNumber] = row.textractData as TextractPageData;

  // Build a MatchContext once for all tags. No pattern inference here —
  // the LLM-supplied tag list isn't a schedule corpus, so pattern-hard-zero
  // would be too aggressive. Scope is allPagesScope unless the caller
  // narrowed via `pageNumber`; scoping is already applied at the DB query
  // level (pageConditions) so clientAnns/textractMap only contain scoped data.
  const matchCtx: MatchContext = {
    scope: allPagesScope(),
    isPageScoped: pageNumber != null,
    pageNumber,
    annotations: clientAnns,
    textractData: textractMap,
    classifiedRegionsByPage: {},
    pattern: null,
  };
  const itemType = yoloClass ? "yolo-with-inner-text" : "text-only";
  const results: Record<string, { count: number; pages: number[] }> = {};
  for (const tag of tags) {
    const scored = findOccurrences(
      { itemType, label: tag, text: tag, yoloClass, yoloModel },
      matchCtx,
    );
    results[tag] = {
      count: scored.length,
      pages: [...new Set(scored.map((i) => i.pageNumber))].sort((a, b) => a - b),
    };
  }
  return { results };
}

async function execDetectTagPatterns(ctx: ToolContext) {
  // Only load YOLO annotations (already filtered at DB level)
  const allAnns = await db
    .select({ id: annotations.id, pageNumber: annotations.pageNumber, name: annotations.name, minX: annotations.minX, minY: annotations.minY, maxX: annotations.maxX, maxY: annotations.maxY, source: annotations.source })
    .from(annotations)
    .where(and(eq(annotations.projectId, ctx.projectId), eq(annotations.source, "yolo")));

  if (allAnns.length === 0) return { patterns: [] };

  // Only load textract for pages that have YOLO annotations
  const yoloPages = [...new Set(allAnns.map((a) => a.pageNumber))];
  const pageRows = await db
    .select({ pageNumber: pages.pageNumber, textractData: pages.textractData })
    .from(pages)
    .where(and(eq(pages.projectId, ctx.projectId), yoloPages.length <= 50 ? inArray(pages.pageNumber, yoloPages) : sql`1=1`));

  const textractMap: Record<number, TextractPageData> = {};
  for (const row of pageRows) if (row.textractData) textractMap[row.pageNumber] = row.textractData as TextractPageData;

  const patterns = detectTagPatterns(textractMap, allAnns.map((a) => ({
    id: a.id, name: a.name, pageNumber: a.pageNumber, minX: a.minX, minY: a.minY, maxX: a.maxX, maxY: a.maxY,
  })));

  return { patterns: patterns.map((p) => ({ id: p.id, yoloClass: p.yoloClass, textPattern: p.textPattern, displayName: p.displayName, uniqueValues: p.uniqueValues, instanceCount: p.instances.length, pageCount: p.pageCount, confidence: p.confidence })) };
}

async function execGetOcrTextInRegion(pageNumber: number, bbox: Record<string, number>, ctx: ToolContext) {
  const [page] = await db
    .select({ textractData: pages.textractData })
    .from(pages)
    .where(and(eq(pages.projectId, ctx.projectId), eq(pages.pageNumber, pageNumber)))
    .limit(1);

  if (!page?.textractData) return { error: "No OCR data for this page" };
  const words = (page.textractData as TextractPageData).words || [];
  const { bboxCenterLTWH, bboxContainsPoint } = await import("@/lib/ocr-utils");

  const region: [number, number, number, number] = [bbox.minX as number, bbox.minY as number, bbox.maxX as number, bbox.maxY as number];
  const inside = words.filter((w) => bboxContainsPoint(region, bboxCenterLTWH(w.bbox)));
  const text = inside.sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]).map((w) => w.text).join(" ").trim();
  return { pageNumber, text, wordCount: inside.length };
}

async function execCreateMarkup(input: Record<string, unknown>, ctx: ToolContext) {
  const [inserted] = await db
    .insert(annotations)
    .values({
      projectId: ctx.projectId,
      pageNumber: input.pageNumber as number,
      name: input.name as string,
      minX: input.minX as number,
      minY: input.minY as number,
      maxX: input.maxX as number,
      maxY: input.maxY as number,
      note: (input.note as string) || null,
      source: "user",
      data: {},
    })
    .returning({ id: annotations.id });

  return { action: "createMarkup", annotationId: inserted.id, pageNumber: input.pageNumber, name: input.name };
}

async function execAddNoteToAnnotation(annotationId: number, note: string, ctx: ToolContext) {
  // Verify annotation belongs to this project
  const [ann] = await db
    .select({ id: annotations.id, note: annotations.note, projectId: annotations.projectId })
    .from(annotations)
    .where(eq(annotations.id, annotationId))
    .limit(1);

  if (!ann || ann.projectId !== ctx.projectId) return { error: "Annotation not found" };

  // Append note (preserve existing)
  const existingNote = ann.note?.trim() || "";
  const newNote = existingNote ? `${existingNote}\n${note}` : note;

  await db.update(annotations).set({ note: newNote }).where(eq(annotations.id, annotationId));
  return { annotationId, note: newNote, appended: true };
}

async function execBatchAddNotes(input: Record<string, unknown>, ctx: ToolContext) {
  const note = input.note as string;
  if (!note?.trim()) return { error: "Note text required" };

  // Build filter conditions at DB level
  const conditions = [eq(annotations.projectId, ctx.projectId)];
  if (input.pageNumber) conditions.push(eq(annotations.pageNumber, input.pageNumber as number));
  if (input.className) conditions.push(eq(annotations.name, input.className as string));
  if (input.source) conditions.push(eq(annotations.source, input.source as string));

  // Fetch matching annotations
  const matching = await db
    .select({ id: annotations.id, note: annotations.note, data: annotations.data })
    .from(annotations)
    .where(and(...conditions));

  // JS-level confidence filter
  let filtered = matching;
  if (input.minConfidence) {
    const min = input.minConfidence as number;
    filtered = filtered.filter((a) => ((a.data as any)?.confidence ?? 1) >= min);
  }

  if (filtered.length === 0) return { error: "No annotations matched the filter", filters: { pageNumber: input.pageNumber, className: input.className, source: input.source } };

  // Batch update — append note to each
  let updated = 0;
  for (const ann of filtered) {
    const existing = ann.note?.trim() || "";
    const newNote = existing ? `${existing}\n${note}` : note;
    await db.update(annotations).set({ note: newNote }).where(eq(annotations.id, ann.id));
    updated++;
  }

  return { updated, totalMatched: filtered.length, noteAppended: note };
}
