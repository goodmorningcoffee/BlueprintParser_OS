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

import type { ToolDefinition } from "./types";
import { db } from "@/lib/db";
import { projects, pages, annotations } from "@/lib/db/schema";
import { eq, and, sql, inArray } from "drizzle-orm";
import { mapYoloToOcrText, scanClassForTexts } from "@/lib/yolo-tag-engine";
import { detectCsiCodes } from "@/lib/csi-detect";
import { detectTagPatterns } from "@/lib/tag-patterns";
import type { ClientAnnotation, TextractPageData } from "@/types";

// ═══════════════════════════════════════════════════════════════════
// Tool Definitions (Anthropic tool schema format)
// ═══════════════════════════════════════════════════════════════════

export const BP_TOOLS: ToolDefinition[] = [
  // ─── DATA RETRIEVAL ──────────────────────────────────────────
  {
    name: "searchPages",
    description: "Search blueprint pages by text content using full-text search. Returns matching pages with text snippets and relevance scores. Use when looking for specific topics, materials, equipment, or references.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search text (2+ characters). Supports phrases in quotes." },
      },
      required: ["query"],
    },
  },
  {
    name: "getProjectOverview",
    description: "Get the full project map: discipline breakdown, page classifications, all trades, all CSI codes, schedule catalog, annotation summary counts, takeoff totals, and pre-computed page indexes. THIS SHOULD BE YOUR FIRST TOOL CALL — it gives you a complete overview before drilling into specifics.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "getPageDetails",
    description: "Get comprehensive intelligence for a specific page: classification (discipline, drawing type), cross-references to other sheets, general note blocks, detected text regions, heuristic inferences with evidence, classified tables/schedules, parsed schedule data with rows, CSI spatial heatmap, CSI codes, text annotations (37 types), and keynotes.",
    input_schema: {
      type: "object",
      properties: {
        pageNumber: { type: "number", description: "Page number (1-indexed)" },
      },
      required: ["pageNumber"],
    },
  },
  {
    name: "lookupPagesByIndex",
    description: "Instant O(1) lookup: which pages contain a specific CSI code, trade, keynote, or text annotation. Reads from pre-computed indexes — much faster than searching. Use for questions like 'which pages have Division 08?' or 'where is the electrical trade?'",
    input_schema: {
      type: "object",
      properties: {
        index: { type: "string", enum: ["csi", "trade", "keynote", "textAnnotation"], description: "Which index to query" },
        key: { type: "string", description: "The value to look up (CSI code, trade name, keynote key, or annotation text)" },
      },
      required: ["index", "key"],
    },
  },
  {
    name: "getAnnotations",
    description: "Get YOLO object detections and user markups, optionally filtered by page, class name, source type, or minimum confidence. Returns bounding boxes, class names, confidence scores, CSI codes, and keywords.",
    input_schema: {
      type: "object",
      properties: {
        pageNumber: { type: "number", description: "Filter to specific page (optional)" },
        className: { type: "string", description: "Filter by YOLO class name like 'door_single', 'circle', 'tables' (optional)" },
        source: { type: "string", enum: ["yolo", "user", "takeoff"], description: "Filter by annotation source (optional)" },
        minConfidence: { type: "number", description: "Minimum confidence 0-1 (optional, default 0.25)" },
      },
    },
  },
  {
    name: "getParsedSchedule",
    description: "Get structured data from a parsed table or schedule on a page. Returns column headers, data rows as dictionaries, tag column identifier, and CSI codes. Use for door schedules, finish schedules, equipment lists, keynote tables.",
    input_schema: {
      type: "object",
      properties: {
        pageNumber: { type: "number", description: "Page containing the schedule" },
        category: { type: "string", description: "Schedule category filter: 'door-schedule', 'finish-schedule', 'material-schedule', 'keynote-table', 'symbol-legend' (optional)" },
      },
      required: ["pageNumber"],
    },
  },
  {
    name: "getCsiSpatialMap",
    description: "Get zone-based heatmap showing where CSI construction divisions are concentrated on a page. Divides page into 9 zones (3x3 grid) plus title-block and right-margin zones. Each zone lists which divisions appear and how many instances. Use for 'what's in the top-right corner?' or 'where are the MEP systems?'",
    input_schema: {
      type: "object",
      properties: {
        pageNumber: { type: "number", description: "Page number" },
      },
      required: ["pageNumber"],
    },
  },
  {
    name: "getCrossReferences",
    description: "Get sheet-to-sheet reference graph. Returns edges (which pages reference which), hub pages (referenced by 3+ other pages), and leaf pages. Use for 'what references A-501?' or 'what are the key hub pages?' Omit pageNumber for full project graph.",
    input_schema: {
      type: "object",
      properties: {
        pageNumber: { type: "number", description: "Get references FROM this page only (optional — omit for full graph)" },
      },
    },
  },
  {
    name: "getSpatialContext",
    description: "Get OCR text mapped into YOLO spatial regions (title_block, legend, drawing_area, grid, etc.). Shows what text is inside each detected region. Use for 'what's in the title block?' or 'read the legend.'",
    input_schema: {
      type: "object",
      properties: {
        pageNumber: { type: "number", description: "Page number" },
      },
      required: ["pageNumber"],
    },
  },
  {
    name: "getPageOcrText",
    description: "Get the full raw OCR text for a page. This is the complete extracted text without any structuring. Use as a fallback when structured tools don't have what you need, or when you need to read the full page content.",
    input_schema: {
      type: "object",
      properties: {
        pageNumber: { type: "number", description: "Page number" },
      },
      required: ["pageNumber"],
    },
  },
  {
    name: "detectCsiFromText",
    description: "Run CSI MasterFormat code detection on arbitrary text. Returns matching CSI codes with descriptions, trades, and divisions. Use to identify what construction category a piece of text belongs to.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to analyze for CSI codes" },
      },
      required: ["text"],
    },
  },

  // ─── YOLO TAG TOOLS ──────────────────────────────────────────
  {
    name: "scanYoloClassTexts",
    description: "Find all unique OCR texts inside YOLO annotations of a specific class. Use to discover what labels exist inside circles, doors, or any detected shape. Specify pageNumber for fast single-page scan, or omit for full project scan.",
    input_schema: {
      type: "object",
      properties: {
        yoloClass: { type: "string", description: "YOLO class name (e.g., 'circle', 'door_single', 'horizontal_area')" },
        yoloModel: { type: "string", description: "YOLO model name filter (optional)" },
        pageNumber: { type: "number", description: "Scan only this page (optional — omit for project-wide)" },
      },
      required: ["yoloClass"],
    },
  },
  {
    name: "mapTagsToPages",
    description: "Given specific tag text values (like 'D-01', 'T-03'), find every instance. Optionally filter to a YOLO class or specific page. Specify pageNumber for fast single-page search, omit for project-wide.",
    input_schema: {
      type: "object",
      properties: {
        tags: { type: "string", description: "Comma-separated tag values to search for (e.g., 'D-01,D-02,D-03')" },
        yoloClass: { type: "string", description: "Only find tags inside this YOLO class (optional)" },
        yoloModel: { type: "string", description: "YOLO model name filter (optional)" },
        pageNumber: { type: "number", description: "Search only this page (optional — omit for project-wide)" },
      },
      required: ["tags"],
    },
  },
  {
    name: "detectTagPatterns",
    description: "Auto-discover repeating YOLO+OCR patterns across the project. Finds groups like 'circles containing T-01, T-02, T-03...' or 'diamonds with EQ-01, EQ-02...'. Returns pattern groups with instance counts, unique values, and confidence. Requires YOLO data to be loaded.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "getOcrTextInRegion",
    description: "Read OCR text inside a specific rectangular region on a page. Coordinates are normalized 0-1 (top-left origin). Use to read text in a specific area of the drawing.",
    input_schema: {
      type: "object",
      properties: {
        pageNumber: { type: "number", description: "Page number" },
        minX: { type: "number", description: "Left edge (0-1)" },
        minY: { type: "number", description: "Top edge (0-1)" },
        maxX: { type: "number", description: "Right edge (0-1)" },
        maxY: { type: "number", description: "Bottom edge (0-1)" },
      },
      required: ["pageNumber", "minX", "minY", "maxX", "maxY"],
    },
  },

  // ─── ACTIONS ─────────────────────────────────────────────────
  {
    name: "navigateToPage",
    description: "Navigate the blueprint viewer to a specific page. The user will see the page change in their viewer. Use when you want to show them a specific drawing.",
    input_schema: {
      type: "object",
      properties: {
        pageNumber: { type: "number", description: "Page number to navigate to" },
      },
      required: ["pageNumber"],
    },
  },
  {
    name: "highlightRegion",
    description: "Highlight a rectangular region on a page with a pulsing cyan outline. Use to point the user to a specific area — a detected table, a door tag, a note block, etc. Coordinates are normalized 0-1.",
    input_schema: {
      type: "object",
      properties: {
        pageNumber: { type: "number", description: "Page number" },
        minX: { type: "number", description: "Left edge (0-1)" },
        minY: { type: "number", description: "Top edge (0-1)" },
        maxX: { type: "number", description: "Right edge (0-1)" },
        maxY: { type: "number", description: "Bottom edge (0-1)" },
        label: { type: "string", description: "Optional label to show on the highlight" },
      },
      required: ["pageNumber", "minX", "minY", "maxX", "maxY"],
    },
  },
  {
    name: "createMarkup",
    description: "Create a persistent markup annotation on the blueprint with a name and optional notes. Use when the user asks you to mark, flag, or annotate something for later reference.",
    input_schema: {
      type: "object",
      properties: {
        pageNumber: { type: "number", description: "Page number" },
        minX: { type: "number", description: "Left edge (0-1)" },
        minY: { type: "number", description: "Top edge (0-1)" },
        maxX: { type: "number", description: "Right edge (0-1)" },
        maxY: { type: "number", description: "Bottom edge (0-1)" },
        name: { type: "string", description: "Markup name" },
        note: { type: "string", description: "Optional note text" },
      },
      required: ["pageNumber", "minX", "minY", "maxX", "maxY", "name"],
    },
  },
  {
    name: "addNoteToAnnotation",
    description: "Append a note to a specific annotation by ID. Notes are appended (never overwritten) to preserve existing user notes. Use when the user asks to annotate, comment on, or flag a specific detection.",
    input_schema: {
      type: "object",
      properties: {
        annotationId: { type: "number", description: "Annotation ID" },
        note: { type: "string", description: "Note text to append" },
      },
      required: ["annotationId", "note"],
    },
  },
  {
    name: "batchAddNotes",
    description: "Append a note to ALL annotations matching a filter. Notes are appended to each annotation's existing notes. Use for bulk operations like 'add a note to all door detections on page 5' or 'flag all low-confidence detections'.",
    input_schema: {
      type: "object",
      properties: {
        note: { type: "string", description: "Note text to append to each matching annotation" },
        pageNumber: { type: "number", description: "Filter to this page (optional)" },
        className: { type: "string", description: "Filter by class name like 'door_single', 'circle' (optional)" },
        source: { type: "string", enum: ["yolo", "user", "takeoff"], description: "Filter by source (optional)" },
        minConfidence: { type: "number", description: "Only annotate detections above this confidence (optional)" },
      },
      required: ["note"],
    },
  },
];

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
      return execSearchPages(input.query as string, ctx);
    case "getProjectOverview":
      return execGetProjectOverview(ctx);
    case "getPageDetails":
      return execGetPageDetails(input.pageNumber as number, ctx);
    case "lookupPagesByIndex":
      return execLookupPagesByIndex(input.index as string, input.key as string, ctx);
    case "getAnnotations":
      return execGetAnnotations(input, ctx);
    case "getParsedSchedule":
      return execGetParsedSchedule(input.pageNumber as number, input.category as string | undefined, ctx);
    case "getCsiSpatialMap":
      return execGetCsiSpatialMap(input.pageNumber as number, ctx);
    case "getCrossReferences":
      return execGetCrossReferences(input.pageNumber as number | undefined, ctx);
    case "getSpatialContext":
      return execGetSpatialContext(input.pageNumber as number, ctx);
    case "getPageOcrText":
      return execGetPageOcrText(input.pageNumber as number, ctx);
    case "detectCsiFromText":
      return detectCsiCodes(input.text as string);
    case "scanYoloClassTexts":
      return execScanYoloClassTexts(input.yoloClass as string, input.yoloModel as string | undefined, input.pageNumber as number | undefined, ctx);
    case "mapTagsToPages":
      return execMapTagsToPages(input.tags as string, input.yoloClass as string | undefined, input.yoloModel as string | undefined, input.pageNumber as number | undefined, ctx);
    case "detectTagPatterns":
      return execDetectTagPatterns(ctx);
    case "getOcrTextInRegion":
      return execGetOcrTextInRegion(input.pageNumber as number, input as Record<string, number>, ctx);
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

  const intel = project.projectIntelligence as Record<string, unknown> | null;
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

  const intel = page.pageIntelligence as Record<string, unknown> | null;
  // Return structured data, omit raw bboxes to save tokens
  return {
    pageNumber: page.pageNumber,
    name: page.name,
    drawingNumber: page.drawingNumber,
    classification: intel?.classification,
    crossRefs: intel?.crossRefs,
    noteBlocks: intel?.noteBlocks,
    heuristicInferences: intel?.heuristicInferences,
    classifiedTables: (intel?.classifiedTables as any[])?.map((t: any) => ({
      category: t.category, confidence: t.confidence, evidence: t.evidence, headerText: t.headerText,
    })),
    parsedRegions: (intel?.parsedRegions as any[])?.map((r: any) => ({
      type: r.type, category: r.category, confidence: r.confidence,
      data: r.data ? { headers: r.data.headers, rowCount: r.data.rows?.length || r.data.keynotes?.length || 0, tagColumn: r.data.tagColumn } : null,
    })),
    csiSpatialSummary: (intel?.csiSpatialMap as any)?.summary,
    csiCodes: page.csiCodes,
    textAnnotationSummary: (page.textAnnotations as any)?.summary,
    keynoteCount: Array.isArray(page.keynotes) ? page.keynotes.length : 0,
  };
}

async function execLookupPagesByIndex(index: string, key: string, ctx: ToolContext) {
  const [project] = await db
    .select({ projectIntelligence: projects.projectIntelligence })
    .from(projects)
    .where(eq(projects.id, ctx.projectId))
    .limit(1);

  const summaries = (project?.projectIntelligence as any)?.summaries;
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
    };
  }

  return {
    totalCount: filtered.length,
    annotations: filtered.map((a) => ({
      id: a.id, pageNumber: a.pageNumber, class: a.name, source: a.source,
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

  const regions = (page?.pageIntelligence as any)?.parsedRegions as any[] || [];
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

  return (page?.pageIntelligence as any)?.csiSpatialMap || { error: "No spatial map for this page" };
}

async function execGetCrossReferences(pageNumber: number | undefined, ctx: ToolContext) {
  if (pageNumber) {
    const [page] = await db
      .select({ pageIntelligence: pages.pageIntelligence })
      .from(pages)
      .where(and(eq(pages.projectId, ctx.projectId), eq(pages.pageNumber, pageNumber)))
      .limit(1);
    return { pageNumber, crossRefs: (page?.pageIntelligence as any)?.crossRefs || [] };
  }

  // Full project graph
  const [project] = await db
    .select({ projectIntelligence: projects.projectIntelligence })
    .from(projects)
    .where(eq(projects.id, ctx.projectId))
    .limit(1);
  const intel = project?.projectIntelligence as any;
  return {
    refGraph: intel?.refGraph || { edges: [], hubs: [], leaves: [] },
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

  const regions = mapWordsToRegions(textractData.words, spatialAnns.map((a) => ({
    className: a.name,
    displayName: a.name,
    bbox: [a.minX, a.minY, a.maxX, a.maxY] as [number, number, number, number],
    confidence: (a.data as any)?.confidence || 0,
    text: "",
  })));

  return {
    regions: regions.regions.map((r) => ({ name: r.className, text: r.text.substring(0, 2000) })),
    unmappedTextPreview: regions.unmappedText.substring(0, 1000),
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
    note: a.note, source: a.source, data: a.data as Record<string, unknown> | null,
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
    note: a.note, source: a.source, data: a.data as Record<string, unknown> | null,
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

  const scope = pageNumber ? "page" : "project";
  const results: Record<string, { count: number; pages: number[] }> = {};
  for (const tag of tags) {
    const instances = mapYoloToOcrText({ tagText: tag, yoloClass, yoloModel, scope, pageNumber, annotations: clientAnns, textractData: textractMap });
    results[tag] = { count: instances.length, pages: [...new Set(instances.map((i) => i.pageNumber))].sort((a, b) => a - b) };
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
