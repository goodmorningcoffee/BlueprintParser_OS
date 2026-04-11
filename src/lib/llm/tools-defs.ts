/**
 * tools-defs.ts — client-safe definitions of BP_TOOLS.
 *
 * Pure data: the tool schemas the LLM sees. Zero runtime dependencies on
 * the database or filesystem, so docs pages and any other client surfaces
 * can import it without pulling `pg`/`fs` into the browser bundle.
 *
 * Execution of these tools lives in `tools.ts` alongside the server-only
 * db/csi/etc. imports. Keep this file pure data.
 */

import type { ToolDefinition } from "./types";

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
