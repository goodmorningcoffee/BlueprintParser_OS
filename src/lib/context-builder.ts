/**
 * context-builder.ts
 *
 * Builds structured LLM context from blueprint data.
 * Extracted from the chat API route for reuse and testability.
 */

export const DEFAULT_CONTEXT_BUDGET = 24000; // ~6000 tokens

/**
 * Determine context budget based on the LLM model.
 * Larger context windows → more room for structured tags + OCR.
 */
export function getContextBudget(provider?: string, model?: string): number {
  if (!provider || !model) return DEFAULT_CONTEXT_BUDGET;

  const m = model.toLowerCase();

  // Anthropic models
  if (provider === "anthropic") {
    if (m.includes("opus")) return 200000;     // Opus: 1M context, use ~200K chars
    if (m.includes("sonnet")) return 80000;    // Sonnet: 200K context
    if (m.includes("haiku")) return 40000;     // Haiku: 200K context but keep lean
  }

  // OpenAI models
  if (provider === "openai") {
    if (m.includes("gpt-4o")) return 60000;    // GPT-4o: 128K context
    if (m.includes("gpt-4")) return 40000;     // GPT-4 Turbo: 128K
    if (m.includes("o1") || m.includes("o3")) return 80000;
  }

  // Groq (Llama, Mixtral)
  if (provider === "groq") return 24000;       // Groq free tier: tight limits

  // Custom/Ollama — conservative default
  if (provider === "custom") return 30000;

  return DEFAULT_CONTEXT_BUDGET;
}

export interface ContextSection {
  id?: string;       // stable section ID for config (optional for backwards compat)
  header: string;
  content: string;
  priority: number;
}

/** Stable section IDs for config references (headers are dynamic, IDs are stable) */
export const SECTION_REGISTRY: Record<string, { label: string; defaultPriority: number; description: string }> = {
  "project-report": { label: "Project Intelligence Report", defaultPriority: 0.5, description: "Auto-generated project summary with discipline breakdown" },
  "yolo-counts": { label: "YOLO Detection Counts", defaultPriority: 1.0, description: "Object counts by class per page with confidence" },
  "yolo-detail": { label: "YOLO Annotation Detail", defaultPriority: 1.2, description: "Per-annotation bbox locations + class descriptions + CSI tags" },
  "csi-graph": { label: "CSI Network Graph", defaultPriority: 1.0, description: "Project-wide division relationships and clusters" },
  "page-classification": { label: "Page Classification", defaultPriority: 1.5, description: "Discipline, drawing type, series" },
  "user-annotations": { label: "User Annotations", defaultPriority: 2.0, description: "User-drawn markups with notes" },
  "takeoff-notes": { label: "Takeoff Notes", defaultPriority: 3.0, description: "Quantity takeoff items with estimator notes" },
  "cross-refs": { label: "Cross-References", defaultPriority: 3.5, description: "Sheet-to-sheet reference links" },
  "csi-codes": { label: "CSI Codes", defaultPriority: 4.0, description: "CSI MasterFormat codes detected on page" },
  "text-annotations": { label: "Text Annotations", defaultPriority: 5.0, description: "Phone, email, equipment tags, dimensions, abbreviations (37 types)" },
  "note-blocks": { label: "Note Blocks", defaultPriority: 5.5, description: "General notes extracted from drawings" },
  "parsed-tables": { label: "Parsed Tables/Keynotes", defaultPriority: 5.8, description: "Structured schedule data with headers + sample rows" },
  "detected-regions": { label: "Detected Regions", defaultPriority: 6.0, description: "Classified table/schedule regions from heuristics" },
  "csi-parsed": { label: "CSI from Parsed Data", defaultPriority: 6.2, description: "CSI codes extracted from parsed schedules" },
  "heuristic-inferences": { label: "Heuristic Inferences", defaultPriority: 6.5, description: "Rule-based detections with evidence chains" },
  "csi-spatial": { label: "CSI Spatial Distribution", defaultPriority: 7.0, description: "Zone-based heatmap of CSI divisions on page" },
  "spatial-context": { label: "Spatial OCR→YOLO Context", defaultPriority: 8.0, description: "OCR text mapped into YOLO spatial regions" },
  "tag-patterns": { label: "Tag Patterns", defaultPriority: 8.5, description: "Repeating YOLO+OCR groups (e.g., circles with T-## text)" },
  "qto-results": { label: "QTO Workflow Results", defaultPriority: 9.0, description: "Auto-QTO tag counts and page locations" },
  "raw-ocr": { label: "Raw OCR Text", defaultPriority: 10.0, description: "Full OCR text (fallback, often truncated)" },
};

/** Section config from admin LLM/Context panel */
export interface LlmSectionConfig {
  disabledSections?: string[];
  priorityOverrides?: Record<string, number>;
  percentAllocations?: Record<string, number>;
  preset?: "balanced" | "structured" | "verbose" | "custom";
}

/** Default percent allocations for presets */
export const SECTION_PRESETS: Record<string, Record<string, number>> = {
  balanced: {},  // even distribution (no overrides, each section gets equal share)
  structured: {
    "parsed-tables": 25, "csi-codes": 8, "csi-spatial": 8, "spatial-context": 12,
    "yolo-counts": 10, "detected-regions": 5, "raw-ocr": 5,
  },
  verbose: {
    "raw-ocr": 40, "spatial-context": 15, "parsed-tables": 10,
  },
};

/**
 * Enhanced context assembly with section config + percentage allocation.
 */
export function assembleContextWithConfig(
  sections: ContextSection[],
  budget: number,
  config?: LlmSectionConfig,
): { assembled: string; sectionMeta: Array<{ id: string; header: string; priority: number; chars: number; allocated: number; included: boolean; truncated: boolean }> } {
  // Filter disabled sections (sections without IDs are always included)
  const enabled = config?.disabledSections
    ? sections.filter((s) => !s.id || !config.disabledSections!.includes(s.id))
    : sections;

  // Apply priority overrides
  for (const s of enabled) {
    const id = s.id ?? "";
    if (id && config?.priorityOverrides?.[id] !== undefined) {
      s.priority = config.priorityOverrides[id];
    }
  }

  // Sort by priority
  enabled.sort((a, b) => a.priority - b.priority);

  // Calculate per-section budgets from % allocations
  const pctConfig = config?.preset && config.preset !== "custom"
    ? SECTION_PRESETS[config.preset] || {}
    : config?.percentAllocations || {};

  const defaultPct = 100 / Math.max(enabled.length, 1);
  const sectionBudgets: Record<string, number> = {};
  let totalAllocated = 0;

  for (const s of enabled) {
    const id = s.id ?? "";
    const pct = (id ? pctConfig[id] : undefined) ?? defaultPct;
    if (id) sectionBudgets[id] = Math.floor(budget * pct / 100);
    totalAllocated += pct;
  }

  // If using custom % and total < 100, distribute remainder as overflow
  const overflowBudget = Math.max(0, budget - Object.values(sectionBudgets).reduce((a, b) => a + b, 0));

  // Fill sections within budgets, track metadata
  const sectionMeta: Array<{ id: string; header: string; priority: number; chars: number; allocated: number; included: boolean; truncated: boolean }> = [];
  let result = "";
  let totalChars = 0;
  let overflow = overflowBudget;

  for (const section of enabled) {
    const sid = section.id ?? "";
    const sectionBudget = (sid ? sectionBudgets[sid] : undefined) || 0;
    const block = `\n=== ${section.header} ===\n${section.content}\n`;

    if (block.length <= sectionBudget) {
      // Fits within allocation
      result += block;
      totalChars += block.length;
      overflow += sectionBudget - block.length; // unused allocation flows to overflow
      sectionMeta.push({ id: sid, header: section.header, priority: section.priority, chars: block.length, allocated: sectionBudget, included: true, truncated: false });
    } else if (sectionBudget + overflow >= block.length) {
      // Fits with overflow
      const used = block.length - sectionBudget;
      overflow -= used;
      result += block;
      totalChars += block.length;
      sectionMeta.push({ id: sid, header: section.header, priority: section.priority, chars: block.length, allocated: sectionBudget, included: true, truncated: false });
    } else {
      // Must truncate
      const available = sectionBudget + Math.min(overflow, budget - totalChars - sectionBudget);
      if (available > 200) {
        const truncated = `\n=== ${section.header} ===\n${section.content.substring(0, available - 30)}\n... (truncated)\n`;
        result += truncated;
        totalChars += truncated.length;
        overflow = 0;
        sectionMeta.push({ id: sid, header: section.header, priority: section.priority, chars: truncated.length, allocated: sectionBudget, included: true, truncated: true });
      } else {
        sectionMeta.push({ id: sid, header: section.header, priority: section.priority, chars: 0, allocated: sectionBudget, included: false, truncated: false });
      }
    }
  }

  // Add disabled sections to meta
  if (config?.disabledSections) {
    for (const s of sections) {
      const id = s.id ?? "";
      if (id && config.disabledSections.includes(id)) {
        sectionMeta.push({ id, header: s.header, priority: s.priority, chars: 0, allocated: 0, included: false, truncated: false });
      }
    }
  }

  return { assembled: result, sectionMeta };
}

/** Default system prompt used when no custom prompt is configured. */
export const DEFAULT_SYSTEM_PROMPT = `You are an expert construction blueprint analyst. Below is data extracted from blueprint pages.

IMPORTANT: ONLY reference information that appears in the data sections below. Do not invent or fabricate examples, page numbers, counts, or project names. If something is not in the provided data, say "that information is not available in the current data."`;

/**
 * Build a dynamic system prompt that describes ONLY the data actually provided.
 * Prevents hallucination by telling the model exactly what it has.
 * Accepts optional custom prompt (from admin config) to replace the default preamble.
 */
export function buildSystemPrompt(dataSummary: string[], customPrompt?: string): string {
  let prompt = customPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;

  if (dataSummary.length > 0) {
    prompt += `\n\nDATA PROVIDED:\n${dataSummary.map(s => `• ${s}`).join("\n")}`;
  } else {
    prompt += `\n\nNo extracted data is available for this request.`;
  }

  prompt += `\n\nWhen answering, be specific — cite actual page numbers, exact counts, and real text from the data. Reference the section headers (OBJECT DETECTIONS, CSI CODES, OCR TEXT, etc.) when pointing users to information.`;

  return prompt;
}

/**
 * Build a YOLO detection summary (counts by class per page, NO raw bounding boxes).
 */
export function buildYoloSummary(
  yoloAnnotations: any[]
): { text: string; summaryLine: string } | null {
  if (yoloAnnotations.length === 0) return null;

  const byPage: Record<number, Record<string, { count: number; totalConf: number; csiCodes: Set<string>; keywords: Set<string> }>> = {};
  const globalCounts: Record<string, number> = {};
  const globalCsi: Record<string, Set<string>> = {};

  for (const a of yoloAnnotations) {
    if (!byPage[a.pageNumber]) byPage[a.pageNumber] = {};
    const cls = a.name;
    if (!byPage[a.pageNumber][cls]) byPage[a.pageNumber][cls] = { count: 0, totalConf: 0, csiCodes: new Set(), keywords: new Set() };
    byPage[a.pageNumber][cls].count++;
    byPage[a.pageNumber][cls].totalConf += (a.data as any)?.confidence || 0;
    const annCsi = (a.data as any)?.csiCodes as string[] | undefined;
    const annKw = (a.data as any)?.keywords as string[] | undefined;
    annCsi?.forEach((c: string) => byPage[a.pageNumber][cls].csiCodes.add(c));
    annKw?.forEach((k: string) => byPage[a.pageNumber][cls].keywords.add(k));
    globalCounts[cls] = (globalCounts[cls] || 0) + 1;
    if (!globalCsi[cls]) globalCsi[cls] = new Set();
    annCsi?.forEach((c: string) => globalCsi[cls].add(c));
  }

  const topClasses = Object.entries(globalCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([cls, count]) => {
      const csi = globalCsi[cls]?.size ? ` (CSI ${[...globalCsi[cls]].join(", ")})` : "";
      return `${count} ${cls}${csi}`;
    })
    .join(", ");
  const summaryLine = `${yoloAnnotations.length} YOLO object detections across ${Object.keys(byPage).length} page(s): ${topClasses}`;

  let text = `${yoloAnnotations.length} objects detected across ${Object.keys(byPage).length} pages.\n`;

  for (const [pg, classes] of Object.entries(byPage).sort(([a], [b]) => Number(a) - Number(b))) {
    const total = Object.values(classes).reduce((s, c) => s + c.count, 0);
    text += `\nPage ${pg} (${total} objects):`;
    for (const [cls, info] of Object.entries(classes).sort(([, a], [, b]) => b.count - a.count)) {
      const csiStr = info.csiCodes.size > 0 ? `, CSI ${[...info.csiCodes].join(", ")}` : "";
      text += `\n  ${cls}: ${info.count} (avg confidence ${(info.totalConf / info.count).toFixed(2)}${csiStr})`;
    }
  }

  return { text, summaryLine };
}

/**
 * Build text annotations section grouped by category.
 */
export function buildTextAnnotationsSection(textAnnotations: any): string | null {
  const anns = textAnnotations?.annotations || textAnnotations;
  if (!Array.isArray(anns) || anns.length === 0) return null;

  const byCategory: Record<string, string[]> = {};
  for (const a of anns) {
    const cat = a.category || "other";
    if (!byCategory[cat]) byCategory[cat] = [];
    // Include CSI tags if present (universal tagging)
    const csiSuffix = a.csiTags?.length
      ? ` [${a.csiTags.map((c: any) => `CSI ${c.code} — ${c.description}`).join("; ")}]`
      : a.meta?.code ? ` [${a.meta.code}]` : "";
    byCategory[cat].push(`${a.type}: ${a.text}${csiSuffix}`);
  }

  let text = "";
  for (const [cat, items] of Object.entries(byCategory)) {
    text += `${cat}: ${items.join(", ")}\n`;
  }
  return text;
}

/**
 * Build page intelligence section (classification, cross-refs, note blocks).
 */
export function buildPageIntelligenceSection(pageIntelligence: any, pageNumber: number): {
  sections: ContextSection[];
  summaryLines: string[];
} | null {
  if (!pageIntelligence) return null;

  const sections: ContextSection[] = [];
  const summaryLines: string[] = [];

  // Page classification (priority 1.5 — right after YOLO)
  if (pageIntelligence.classification) {
    const c = pageIntelligence.classification;
    const text = `Discipline: ${c.discipline} (${c.disciplinePrefix})`
      + (c.subType ? `\nDrawing type: ${c.subType}` : "")
      + (c.series ? `\nSeries: ${c.series}` : "");
    sections.push({ header: `PAGE CLASSIFICATION — Page ${pageNumber}`, content: text, priority: 1.5 });
    summaryLines.push(`Page ${pageNumber}: ${c.discipline}${c.subType ? ` — ${c.subType}` : ""}`);
  }

  // Cross-references (priority 3.5 — after takeoff, before CSI)
  if (pageIntelligence.crossRefs?.length > 0) {
    const refs = pageIntelligence.crossRefs;
    const text = refs.map((r: any) => `${r.refType}: ${r.sourceText} → ${r.targetDrawing}`).join("\n");
    sections.push({ header: `CROSS-REFERENCES — Page ${pageNumber}`, content: text, priority: 3.5 });
    summaryLines.push(`${refs.length} cross-page reference(s) from Page ${pageNumber}`);
  }

  // Note blocks (priority 5.5 — after text annotations)
  if (pageIntelligence.noteBlocks?.length > 0) {
    const blocks = pageIntelligence.noteBlocks;
    let text = "";
    for (const b of blocks) {
      text += `${b.title} (${b.noteCount} notes):\n`;
      for (const note of b.notes.slice(0, 10)) { // cap at 10 notes per block
        text += `  ${note}\n`;
      }
      if (b.notes.length > 10) text += `  ... (${b.notes.length - 10} more)\n`;
    }
    sections.push({ header: `NOTE BLOCKS — Page ${pageNumber}`, content: text, priority: 5.5 });
    const totalNotes = blocks.reduce((s: number, b: any) => s + b.noteCount, 0);
    summaryLines.push(`${totalNotes} general note(s) in ${blocks.length} block(s) on Page ${pageNumber}`);
  }

  // Text regions / classified tables (priority 6 — after notes, before spatial)
  if (pageIntelligence.textRegions?.length > 0 || pageIntelligence.classifiedTables?.length > 0) {
    const tables = pageIntelligence.classifiedTables || [];
    const regions = pageIntelligence.textRegions || [];

    let text = "";
    // Show classified tables first (higher value)
    for (const t of tables) {
      const csi = t.csiTags?.length ? ` [${t.csiTags.map((c: any) => `CSI ${c.code}`).join(", ")}]` : "";
      text += `${t.category}: "${t.headerText || "untitled"}" (confidence ${Math.round(t.confidence * 100)}%)${csi}\n`;
      if (t.evidence?.length) text += `  Evidence: ${t.evidence.join(", ")}\n`;
    }
    // Show remaining unclassified regions
    for (const r of regions) {
      if (r.type === "paragraph") continue; // skip paragraph noise
      const csi = r.csiTags?.length ? ` [${r.csiTags.map((c: any) => `CSI ${c.code}`).join(", ")}]` : "";
      text += `${r.type}: ${r.wordCount} words${r.headerText ? `, header: "${r.headerText}"` : ""}${r.columnCount ? `, ${r.columnCount} columns` : ""}${csi}\n`;
    }

    if (text) {
      sections.push({ header: `DETECTED REGIONS — Page ${pageNumber}`, content: text, priority: 6 });
      const tableCount = tables.length;
      const regionCount = regions.filter((r: any) => r.type !== "paragraph").length;
      if (tableCount > 0) summaryLines.push(`${tableCount} classified table(s) on Page ${pageNumber}`);
      else if (regionCount > 0) summaryLines.push(`${regionCount} text region(s) detected on Page ${pageNumber}`);
    }
  }

  return sections.length > 0 ? { sections, summaryLines } : null;
}

/**
 * Build project summary section for project-scope chat.
 */
export function buildProjectSummarySection(projectSummary: string | null): ContextSection | null {
  if (!projectSummary) return null;
  return {
    header: "PROJECT INTELLIGENCE REPORT (auto-generated)",
    content: projectSummary,
    priority: 0.5, // highest priority in project scope
  };
}

/**
 * Build CSI Spatial Distribution section (page-level).
 * Shows where CSI divisions cluster on the page.
 */
export function buildCsiSpatialSection(csiSpatialMap: any): string | null {
  if (!csiSpatialMap?.zones?.length) return null;
  let text = "";
  for (const zone of csiSpatialMap.zones) {
    if (zone.totalInstances === 0) continue;
    const divs = zone.divisions
      .map((d: any) => `${d.division} ${d.name} (${d.count})`)
      .join(", ");
    text += `${zone.zone}: ${divs}\n`;
  }
  if (csiSpatialMap.summary) text += `\n${csiSpatialMap.summary}`;
  return text || null;
}

/**
 * Build CSI Network Graph section (project-level).
 * Shows division relationships, clusters, and fingerprint.
 */
export function buildCsiGraphSection(csiGraph: any): string | null {
  if (!csiGraph?.nodes?.length) return null;

  let text = "DIVISIONS:\n";
  for (const node of csiGraph.nodes) {
    text += `  ${node.division} (${node.name}): ${node.totalInstances} instances across ${node.pageCount} pages\n`;
  }

  if (csiGraph.clusters?.length > 0) {
    text += "\nCLUSTERS:\n";
    for (const cluster of csiGraph.clusters) {
      text += `  ${cluster.name}: [${cluster.divisions.join(", ")}] (cohesion ${(cluster.cohesion * 100).toFixed(0)}%)\n`;
    }
  }

  if (csiGraph.edges?.length > 0) {
    text += "\nKEY RELATIONSHIPS:\n";
    const topEdges = [...csiGraph.edges].sort((a: any, b: any) => b.weight - a.weight).slice(0, 5);
    for (const edge of topEdges) {
      text += `  ${edge.source} ↔ ${edge.target}: ${edge.type}, strength ${edge.weight}, ${edge.pages.length} pages\n`;
    }
  }

  if (csiGraph.fingerprint) text += `\nFINGERPRINT: ${csiGraph.fingerprint}`;

  return text;
}

/**
 * Build Parsed Table/Keynote metadata section (priority 5.8).
 * Tells the LLM what parsed tables/keynotes exist and their structure.
 * Includes a sample of rows so LLM can understand the data format.
 */
export function buildParsedTablesSection(parsedRegions: any[] | undefined): string | null {
  if (!parsedRegions?.length) return null;

  let text = "";
  for (const region of parsedRegions) {
    const name = region.data?.tableName || region.category || "Unnamed Table";
    const type = region.type || "schedule";
    const headers = region.data?.headers || [];
    const rows = region.data?.rows || [];
    const tagCol = region.data?.tagColumn;
    if (headers.length === 0) continue;

    text += `PARSED ${type.toUpperCase()}: "${name}"\n`;
    text += `  Columns: ${headers.join(", ")}`;
    if (tagCol) text += ` (tag column: ${tagCol})`;
    text += `\n  Rows: ${rows.length}\n`;

    // CSI codes associated with this table
    const csiTags = region.csiTags || [];
    if (csiTags.length > 0) {
      text += `  CSI Codes: ${csiTags.map((c: any) => `${c.code} ${c.description}`).join("; ")}\n`;
    }

    // Show first 3 rows as sample
    const sample = Math.min(rows.length, 3);
    if (sample > 0) {
      text += "  Sample data:\n";
      for (let i = 0; i < sample; i++) {
        const vals = headers.map((h: string) => `${h}: ${rows[i][h] || "—"}`);
        text += `    Row ${i + 1}: ${vals.join(", ")}\n`;
      }
      if (rows.length > sample) text += `    ... (${rows.length - sample} more rows)\n`;
    }
    text += "\n";
  }

  return text || null;
}

/**
 * Build CSI from Parsed Data section (priority 6.2).
 * Shows CSI codes from user-parsed tables/keynotes.
 */
export function buildParsedDataCsiSection(parsedRegions: any[] | undefined): string | null {
  if (!parsedRegions?.length) return null;

  const regionsWithCsi = parsedRegions.filter(
    (r: any) => r.csiTags?.length > 0,
  );
  if (regionsWithCsi.length === 0) return null;

  let text = "";
  for (const region of regionsWithCsi) {
    const type = region.type || "table";
    const name = region.data?.tableName || region.category || "Unknown";
    const rowCount = region.data?.rowCount || region.data?.rows?.length || 0;
    const tagCol = region.data?.tagColumn;

    // Group CSI tags by division
    const divMap: Record<string, { name: string; count: number }> = {};
    for (const tag of region.csiTags) {
      const div = tag.code.substring(0, 2);
      if (!divMap[div]) divMap[div] = { name: tag.description, count: 0 };
      divMap[div].count++;
    }

    const divParts = Object.entries(divMap)
      .map(([div, d]) => `Div ${div} (${d.count} codes)`)
      .join(", ");

    text += `${name} (${type}): ${divParts}`;
    if (rowCount) text += ` — ${rowCount} rows`;
    if (tagCol) text += `, tag column: ${tagCol}`;
    text += "\n";
  }

  return text || null;
}

/**
 * Assemble context sections in priority order (structured data first, raw OCR last)
 * and enforce a character budget.
 */
export function assembleContext(
  sections: ContextSection[],
  budget: number = DEFAULT_CONTEXT_BUDGET
): string {
  sections.sort((a, b) => a.priority - b.priority);

  let result = "";
  let totalChars = 0;

  for (const section of sections) {
    const block = `\n=== ${section.header} ===\n${section.content}\n`;
    if (totalChars + block.length > budget) {
      const remaining = budget - totalChars - section.header.length - 30;
      if (remaining > 200) {
        result += `\n=== ${section.header} ===\n${section.content.substring(0, remaining)}\n... (truncated)\n`;
      }
      break;
    }
    result += block;
    totalChars += block.length;
  }

  return result;
}
