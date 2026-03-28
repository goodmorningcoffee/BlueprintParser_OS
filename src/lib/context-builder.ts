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
  header: string;
  content: string;
  priority: number;
}

/**
 * Build a dynamic system prompt that describes ONLY the data actually provided.
 * Prevents hallucination by telling the model exactly what it has.
 */
export function buildSystemPrompt(dataSummary: string[]): string {
  let prompt = `You are an expert construction blueprint analyst. Below is data extracted from blueprint pages.

IMPORTANT: ONLY reference information that appears in the data sections below. Do not invent or fabricate examples, page numbers, counts, or project names. If something is not in the provided data, say "that information is not available in the current data."`;

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

  const byPage: Record<number, Record<string, { count: number; totalConf: number }>> = {};
  const globalCounts: Record<string, number> = {};

  for (const a of yoloAnnotations) {
    if (!byPage[a.pageNumber]) byPage[a.pageNumber] = {};
    const cls = a.name;
    if (!byPage[a.pageNumber][cls]) byPage[a.pageNumber][cls] = { count: 0, totalConf: 0 };
    byPage[a.pageNumber][cls].count++;
    byPage[a.pageNumber][cls].totalConf += (a.data as any)?.confidence || 0;
    globalCounts[cls] = (globalCounts[cls] || 0) + 1;
  }

  const topClasses = Object.entries(globalCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([cls, count]) => `${count} ${cls}`)
    .join(", ");
  const summaryLine = `${yoloAnnotations.length} YOLO object detections across ${Object.keys(byPage).length} page(s): ${topClasses}`;

  let text = `${yoloAnnotations.length} objects detected across ${Object.keys(byPage).length} pages.\n`;

  for (const [pg, classes] of Object.entries(byPage).sort(([a], [b]) => Number(a) - Number(b))) {
    const total = Object.values(classes).reduce((s, c) => s + c.count, 0);
    text += `\nPage ${pg} (${total} objects):`;
    for (const [cls, info] of Object.entries(classes).sort(([, a], [, b]) => b.count - a.count)) {
      text += `\n  ${cls}: ${info.count} (avg confidence ${(info.totalConf / info.count).toFixed(2)})`;
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
