/**
 * Scoped chat service — page/project context assembly + tool-use dispatch.
 *
 * Two modes:
 * 1. Context mode: assembles priority-ordered context sections from DB, streams response
 * 2. Tool-use mode: lightweight system prompt, LLM calls tools on demand
 *
 * Extracted from ai/chat/route.ts to keep the route handler thin.
 */
import { apiError } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { projects, pages, chatMessages, annotations, takeoffItems, models, companies } from "@/lib/db/schema";
import { eq, and, desc, inArray } from "drizzle-orm";
import { resolveLLMConfig } from "@/lib/llm/resolve";
import { streamChatResponse } from "@/lib/llm/stream";
import { mapWordsToRegions, buildSpatialContext } from "@/lib/spatial";
import { findWordsInBbox, wordsToText } from "@/lib/ocr-utils";
import {
  buildSystemPrompt,
  buildYoloSummary,
  buildTextAnnotationsSection,
  buildPageIntelligenceSection,
  buildProjectSummarySection,
  buildCsiSpatialSection,
  buildCsiGraphSection,
  buildParsedDataCsiSection,
  buildParsedTablesSection,
  assembleContextWithConfig,
  getContextBudget,
  type ContextSection,
  type LlmSectionConfig,
} from "@/lib/context-builder";
import type { ChatMessage } from "@/lib/llm/types";
import type { TextractPageData } from "@/types";
import type { ProjectAccessRow } from "@/lib/api-utils";
import { BP_TOOLS, executeToolCall, type ToolContext } from "@/lib/llm/tools";
import { createLLMClient } from "@/lib/llm";

// Cache default domain knowledge file in memory (never changes at runtime)
let _cachedDomainKnowledge: string | null = null;
async function getCachedDomainKnowledge(): Promise<string> {
  if (_cachedDomainKnowledge !== null) return _cachedDomainKnowledge;
  try {
    const { readFile } = await import("fs/promises");
    const { join } = await import("path");
    _cachedDomainKnowledge = await readFile(join(process.cwd(), "src/data/domain-knowledge.md"), "utf-8");
  } catch {
    _cachedDomainKnowledge = "";
  }
  return _cachedDomainKnowledge;
}

interface ScopedChatParams {
  project: ProjectAccessRow;
  message: string;
  scope: string;
  pageNumber?: number;
  session: { user: { companyId: number; dbId: number } } | null;
  isDemo: boolean;
}

/**
 * Main entry point for page/project-scoped chat.
 * Resolves LLM config, checks for tool-use mode, then dispatches.
 */
export async function handleScopedChat(params: ScopedChatParams) {
  const { project, message, scope, pageNumber, session, isDemo } = params;

  // ─── Parallel DB queries for context data ──────────────────
  const pageFilter = scope === "page" && pageNumber
    ? [eq(annotations.pageNumber, pageNumber)]
    : [];

  const [yoloAnnotations, userAnnotations, projectTakeoffItems, history] = await Promise.all([
    db.select().from(annotations).where(and(eq(annotations.projectId, project.id), eq(annotations.source, "yolo"), ...pageFilter)),
    db.select().from(annotations).where(and(eq(annotations.projectId, project.id), eq(annotations.source, "user"), ...pageFilter)),
    db.select().from(takeoffItems).where(eq(takeoffItems.projectId, project.id)),
    db.select().from(chatMessages).where(eq(chatMessages.projectId, project.id)).orderBy(desc(chatMessages.createdAt)).limit(10),
  ]);

  // ─── Resolve LLM config early (needed for context budget) ──
  const config = await resolveLLMConfig(project.companyId, session?.user?.dbId, isDemo);
  if (!config) {
    return apiError("No LLM configured. Set up a provider in Admin → AI Models.", 503);
  }
  const contextBudget = getContextBudget(config.provider, config.model);

  // ─── Fetch company config once (reused for tool use check + context config) ───
  let companyPipelineConfig: NonNullable<typeof companies.$inferSelect.pipelineConfig> = {};
  try {
    const [companyRow] = await db
      .select({ pipelineConfig: companies.pipelineConfig })
      .from(companies)
      .where(eq(companies.id, session?.user?.companyId || project.companyId))
      .limit(1);
    companyPipelineConfig = companyRow?.pipelineConfig || {};
  } catch { /* ignore */ }

  const toolUseEnabled = !!companyPipelineConfig?.llm?.toolUse;
  const providerSupportsTools = config.provider === "anthropic" || config.provider === "openai";

  if (toolUseEnabled && providerSupportsTools && scope !== "global") {
    return handleToolUseChat(config, project, message, scope, pageNumber, session, isDemo, history);
  }

  // ─── Build context sections with priority ordering ─────────
  const sections: ContextSection[] = [];
  const dataSummary: string[] = [];

  // --- YOLO detections (priority 1 — structured, most asked about) ---
  const yoloResult = buildYoloSummary(yoloAnnotations);
  if (yoloResult) {
    sections.push({ header: "OBJECT DETECTIONS (YOLO)", content: yoloResult.text, priority: 1 });
    dataSummary.push(yoloResult.summaryLine);
  }

  // --- User markups (priority 2 — user-created, high relevance) ---
  //
  // Markup is dual-purpose: a human sticky-note AND a region-definition the LLM
  // can reason about. We emit the bbox coordinates plus the OCR text inside the
  // box so the model can answer "what did the user flag in this region?". See
  // project_markup_dual_purpose_llm_region.md for the design rationale.
  if (userAnnotations.length > 0) {
    const byPage: Record<number, typeof userAnnotations> = {};
    for (const a of userAnnotations) {
      if (!byPage[a.pageNumber]) byPage[a.pageNumber] = [];
      byPage[a.pageNumber].push(a);
    }
    // Fetch Textract data for just the pages that actually have user markups
    // — avoids loading the column for pages we won't use.
    const annotatedPageNumbers = Object.keys(byPage).map(Number);
    const pageRows = await db
      .select({ pageNumber: pages.pageNumber, textractData: pages.textractData })
      .from(pages)
      .where(and(eq(pages.projectId, project.id), inArray(pages.pageNumber, annotatedPageNumbers)));
    const textractByPage: Record<number, TextractPageData | null> = {};
    for (const row of pageRows) textractByPage[row.pageNumber] = row.textractData;

    const MAX_OCR_CHARS = 300;
    let markupText = "";
    for (const [pg, anns] of Object.entries(byPage).sort(([a], [b]) => Number(a) - Number(b))) {
      const pn = Number(pg);
      const words = textractByPage[pn]?.words ?? [];
      markupText += `Page ${pg}:\n`;
      for (const a of anns) {
        const b3 = (v: number) => v.toFixed(3);
        markupText += `  "${a.name}" [bbox ${b3(a.minX)},${b3(a.minY)} → ${b3(a.maxX)},${b3(a.maxY)}]`;
        if (a.note) markupText += ` — note: ${a.note}`;
        const wordsInside = findWordsInBbox(words, [a.minX, a.minY, a.maxX, a.maxY]);
        if (wordsInside.length > 0) {
          const ocr = wordsToText(wordsInside).replace(/\n/g, " / ");
          const snippet = ocr.length > MAX_OCR_CHARS ? ocr.slice(0, MAX_OCR_CHARS) + "…" : ocr;
          markupText += ` — OCR in region: "${snippet}"`;
        }
        markupText += "\n";
      }
    }
    sections.push({ header: "USER ANNOTATIONS", content: markupText, priority: 2 });
    dataSummary.push(`${userAnnotations.length} user markup annotation(s) with bbox + OCR-in-region`);
  }

  // --- Takeoff notes (priority 3 — short, user-created) ---
  const itemsWithNotes = projectTakeoffItems.filter((t) => t.notes);
  if (itemsWithNotes.length > 0) {
    let takeoffText = "";
    for (const t of itemsWithNotes) {
      takeoffText += `${t.name} (${t.shape}): ${t.notes}\n`;
    }
    sections.push({ header: "TAKEOFF NOTES", content: takeoffText, priority: 3 });
    dataSummary.push(`${itemsWithNotes.length} quantity takeoff item(s) with notes`);
  }

  // --- Page-specific or project-wide data ---
  if (scope === "page" && pageNumber) {
    await buildPageContext(project, pageNumber, yoloAnnotations, sections, dataSummary);
  } else {
    await buildProjectContext(project, contextBudget, sections, dataSummary);
  }

  // ─── Build messages array ──────────────────────────────────
  const llmPipelineConfig = companyPipelineConfig?.llm;
  const customSystemPrompt: string | undefined = llmPipelineConfig?.systemPrompt;
  const sectionConfig: LlmSectionConfig | undefined = llmPipelineConfig?.sectionConfig as LlmSectionConfig | undefined;

  const { assembled: contextText } = assembleContextWithConfig(sections, contextBudget, sectionConfig);
  const systemPrompt = buildSystemPrompt(dataSummary, customSystemPrompt);
  const systemContent = contextText ? `${systemPrompt}\n\n${contextText}` : systemPrompt;

  const messages: ChatMessage[] = [{ role: "system", content: systemContent }];
  for (const msg of history.reverse()) {
    messages.push({ role: msg.role as "user" | "assistant", content: msg.content });
  }
  messages.push({ role: "user", content: message });

  // Save user message to DB
  await db.insert(chatMessages).values({
    projectId: project.id,
    pageNumber: scope === "page" ? pageNumber : null,
    role: "user",
    content: message,
    model: `${config.provider}/${config.model}`,
    userId: session?.user?.dbId || null,
  });

  return streamChatResponse(config, messages, project.id, scope === "page" ? (pageNumber ?? null) : null, session?.user?.dbId ?? null);
}

// ─── Page-scope context builder ──────────────────────────────────
async function buildPageContext(
  project: ProjectAccessRow,
  pageNumber: number,
  yoloAnnotations: any[],
  sections: ContextSection[],
  dataSummary: string[],
) {
  const [page] = await db
    .select({
      pageNumber: pages.pageNumber,
      name: pages.name,
      drawingNumber: pages.drawingNumber,
      rawText: pages.rawText,
      textractData: pages.textractData,
      csiCodes: pages.csiCodes,
      textAnnotations: pages.textAnnotations,
      pageIntelligence: pages.pageIntelligence,
    })
    .from(pages)
    .where(and(eq(pages.projectId, project.id), eq(pages.pageNumber, pageNumber)))
    .limit(1);

  // CSI codes (priority 4)
  if (page?.csiCodes && Array.isArray(page.csiCodes) && page.csiCodes.length > 0) {
    let csiText = "";
    for (const c of page.csiCodes) {
      csiText += `${c.code} — ${c.description} (${c.trade})\n`;
    }
    sections.push({ header: "CSI CODES", content: csiText, priority: 4 });
    dataSummary.push(`${page.csiCodes.length} CSI construction specification code(s)`);
  }

  // Text annotations (priority 5)
  if (page?.textAnnotations) {
    const textAnnsText = buildTextAnnotationsSection(page.textAnnotations);
    if (textAnnsText) {
      const annCount = page.textAnnotations?.annotations?.length || 0;
      sections.push({ header: "AUTO-DETECTED TEXT PATTERNS", content: textAnnsText, priority: 5 });
      dataSummary.push(`${annCount} auto-detected text pattern(s) (phone, dimensions, equipment, etc.)`);
    }
  }

  // Page Intelligence (classification, cross-refs, notes)
  if (page?.pageIntelligence) {
    const intelResult = buildPageIntelligenceSection(page.pageIntelligence, pageNumber);
    if (intelResult) {
      sections.push(...intelResult.sections);
      dataSummary.push(...intelResult.summaryLines);
    }

    const parsedTablesText = buildParsedTablesSection(page.pageIntelligence?.parsedRegions);
    if (parsedTablesText) {
      sections.push({ header: `PARSED TABLES/KEYNOTES — Page ${pageNumber}`, content: parsedTablesText, priority: 5.8 });
      dataSummary.push(`Parsed table/keynote data for Page ${pageNumber}`);
    }

    const parsedCsiText = buildParsedDataCsiSection(page.pageIntelligence?.parsedRegions);
    if (parsedCsiText) {
      sections.push({ header: `CSI FROM PARSED DATA — Page ${pageNumber}`, content: parsedCsiText, priority: 6.2 });
      dataSummary.push(`Parsed data CSI codes for Page ${pageNumber}`);
    }

    const csiSpatialText = buildCsiSpatialSection(page.pageIntelligence?.csiSpatialMap);
    if (csiSpatialText) {
      const pageLabel = page.drawingNumber || page.name;
      sections.push({ header: `CSI SPATIAL DISTRIBUTION — Page ${pageNumber} (${pageLabel})`, content: csiSpatialText, priority: 7 });
      dataSummary.push(`CSI spatial heatmap for Page ${pageNumber}`);
    }
  }

  // Spatial Intelligence: map OCR words to YOLO regions
  let usedSpatialContext = false;
  if (page?.textractData && yoloAnnotations.length > 0) {
    const modelIds = [...new Set(yoloAnnotations.map((a) => (a.data as any)?.modelId).filter(Boolean))];
    if (modelIds.length > 0) {
      const modelConfigs = await db.select({ id: models.id, config: models.config }).from(models).where(inArray(models.id, modelIds));
      const spatialClasses = new Set<string>();
      for (const mc of modelConfigs) {
        const ct = mc.config?.classTypes || {};
        for (const [cls, type] of Object.entries(ct)) {
          if (type === "spatial" || type === "both") spatialClasses.add(cls);
        }
      }

      if (spatialClasses.size > 0) {
        const spatialAnnotations = yoloAnnotations
          .filter((a) => a.pageNumber === pageNumber && spatialClasses.has(a.name))
          .map((a) => ({ name: a.name, minX: a.minX, minY: a.minY, maxX: a.maxX, maxY: a.maxY, confidence: (a.data as any)?.confidence || 0 }));

        if (spatialAnnotations.length > 0) {
          const spatialResult = mapWordsToRegions(page.textractData as TextractPageData, spatialAnnotations);
          if (spatialResult.regions.length > 0) {
            const spatialText = buildSpatialContext(pageNumber, page.drawingNumber, spatialResult);
            const pageLabel = page.drawingNumber || page.name;
            sections.push({ header: `SPATIAL CONTEXT — Page ${pageNumber} (${pageLabel})`, content: spatialText, priority: 8 });
            dataSummary.push(`Spatially-tagged OCR text (regions: ${spatialResult.regions.map((r) => r.displayName).join(", ")}) from Page ${pageNumber}`);
            usedSpatialContext = true;
          }
        }
      }
    }
  }

  // OCR text fallback (priority 10)
  if (!usedSpatialContext && page?.rawText) {
    const pageLabel = page.drawingNumber || page.name;
    sections.push({ header: `OCR TEXT — Page ${pageNumber} (${pageLabel})`, content: page.rawText, priority: 10 });
    dataSummary.push(`OCR extracted text from Page ${pageNumber} (${pageLabel})`);
  }
}

// ─── Project-scope context builder ───────────────────────────────
async function buildProjectContext(
  project: ProjectAccessRow,
  contextBudget: number,
  sections: ContextSection[],
  dataSummary: string[],
) {
  const allPages = await db
    .select({
      pageNumber: pages.pageNumber,
      name: pages.name,
      drawingNumber: pages.drawingNumber,
      rawText: pages.rawText,
      csiCodes: pages.csiCodes,
    })
    .from(pages)
    .where(eq(pages.projectId, project.id))
    .orderBy(pages.pageNumber);

  // Fetch heavy project fields only when needed (not included in lightweight access query)
  const [projectExtra] = await db
    .select({ projectSummary: projects.projectSummary, projectIntelligence: projects.projectIntelligence })
    .from(projects)
    .where(eq(projects.id, project.id))
    .limit(1);

  // Project Intelligence Report (priority 0.5)
  const projectSummarySection = buildProjectSummarySection(
    projectExtra?.projectSummary || null
  );
  if (projectSummarySection) {
    sections.push(projectSummarySection);
    dataSummary.push("Auto-generated project intelligence report");
  }

  // CSI Network Graph (priority 1)
  const pi = projectExtra?.projectIntelligence as Record<string, unknown> | null;
  const csiGraphText = buildCsiGraphSection(pi?.csiGraph);
  if (csiGraphText) {
    const graphData = pi?.csiGraph as any;
    sections.push({ header: "CSI NETWORK GRAPH — Project Division Relationships", content: csiGraphText, priority: 1 });
    dataSummary.push(`CSI network graph with ${graphData?.nodes?.length || 0} divisions and ${graphData?.clusters?.length || 0} cluster(s)`);
  }

  // Aggregate CSI codes across project (priority 4)
  const allCsiSet = new Map<string, { description: string; trade: string; pages: number[] }>();
  for (const page of allPages) {
    if (page.csiCodes && Array.isArray(page.csiCodes)) {
      for (const c of page.csiCodes) {
        const existing = allCsiSet.get(c.code);
        if (existing) {
          existing.pages.push(page.pageNumber);
        } else {
          allCsiSet.set(c.code, { description: c.description, trade: c.trade, pages: [page.pageNumber] });
        }
      }
    }
  }
  if (allCsiSet.size > 0) {
    let csiText = "";
    for (const [code, info] of [...allCsiSet.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      csiText += `${code} — ${info.description} (${info.trade}) — pages: ${info.pages.join(", ")}\n`;
    }
    sections.push({ header: "CSI CODES ACROSS PROJECT", content: csiText, priority: 4 });
    dataSummary.push(`${allCsiSet.size} unique CSI code(s) across ${allPages.length} pages`);
  }

  // OCR text per page (priority 10 — truncated to fit)
  let ocrText = "";
  let ocrChars = 0;
  let pagesIncluded = 0;
  for (const page of allPages) {
    if (!page.rawText) continue;
    const header = `\n--- Page ${page.pageNumber} (${page.drawingNumber || page.name}) ---\n`;
    const chunk = header + page.rawText;
    if (ocrChars + chunk.length > contextBudget - 4000) {
      ocrText += `\n... (${allPages.length - pagesIncluded} more pages not shown)`;
      break;
    }
    ocrText += chunk;
    ocrChars += chunk.length;
    pagesIncluded++;
  }
  if (ocrText) {
    sections.push({ header: `OCR TEXT — ${pagesIncluded} of ${allPages.length} pages`, content: ocrText, priority: 10 });
    dataSummary.push(`OCR extracted text from ${pagesIncluded} of ${allPages.length} page(s)`);
  }
}

// ─── Tool-use chat handler ───────────────────────────────────────
async function handleToolUseChat(
  config: any,
  project: ProjectAccessRow,
  message: string,
  scope: string,
  pageNumber: number | undefined,
  session: { user: { companyId: number; dbId: number } } | null,
  isDemo: boolean,
  history: any[],
) {
  const toolCtx: ToolContext = {
    projectId: project.id,
    publicId: project.publicId,
    companyId: project.companyId,
    pageNumber,
  };

  // Load domain knowledge
  let domainKnowledge = "";
  try {
    const [companyDk] = await db
      .select({ pipelineConfig: companies.pipelineConfig })
      .from(companies)
      .where(eq(companies.id, session?.user?.companyId || project.companyId))
      .limit(1);
    const customDk = companyDk?.pipelineConfig?.llm?.domainKnowledge;
    if (customDk) {
      domainKnowledge = customDk;
    } else {
      domainKnowledge = await getCachedDomainKnowledge();
    }
  } catch { /* use empty */ }

  const systemPrompt = `You are an expert construction blueprint analyst with access to tools that query blueprint data.

PROJECT: "${project.name}" (${project.numPages} pages, status: ${project.status})
${scope === "page" && pageNumber ? `CURRENT PAGE: ${pageNumber}` : "SCOPE: Full project"}

IMPORTANT RULES:
- Call getProjectOverview FIRST to understand the project structure before answering.
- ONLY reference data returned by your tools. Never invent page numbers, counts, or details.
- Use navigateToPage and highlightRegion to SHOW the user what you're talking about.
- When citing counts or locations, be specific — give exact page numbers and coordinates.
- Keep tool calls focused — don't fetch data you won't use.
${domainKnowledge ? `\n--- DOMAIN KNOWLEDGE ---\n${domainKnowledge}` : ""}`;

  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }];
  for (const msg of [...history].reverse()) {
    messages.push({ role: msg.role as "user" | "assistant", content: msg.content });
  }
  messages.push({ role: "user", content: message });

  // Save user message
  await db.insert(chatMessages).values({
    projectId: project.id,
    pageNumber: scope === "page" ? pageNumber : null,
    role: "user",
    content: message,
    model: `${config.provider}/${config.model}`,
    userId: session?.user?.dbId || null,
  });

  // Create LLM client
  const client = createLLMClient(config.provider, config.apiKey, config.baseUrl);
  if (!client.streamChatWithTools) {
    return apiError("Provider does not support tool use", 400);
  }

  // Stream tool use events as SSE
  const encoder = new TextEncoder();
  let fullResponse = "";

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const events = client.streamChatWithTools!({
          model: config.model,
          messages,
          tools: BP_TOOLS,
          executeToolCall: (name, input) => executeToolCall(name, input, toolCtx),
          maxToolRounds: 10,
          temperature: config.temperature,
          maxTokens: config.maxTokens ?? 4096,
        });

        for await (const event of events) {
          if (event.type === "text_delta") {
            fullResponse += event.text;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content: event.text })}\n\n`));
          } else if (event.type === "tool_call_start") {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ tool_call: event.name, status: "start" })}\n\n`));
          } else if (event.type === "tool_call_result") {
            try {
              const result = JSON.parse(event.result);
              if (result.action) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ action: result })}\n\n`));
              }
            } catch { /* not JSON or no action */ }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ tool_call: event.name, status: "done" })}\n\n`));
          } else if (event.type === "done") {
            controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Tool use failed";
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: msg })}\n\n`));
      } finally {
        if (fullResponse) {
          await db.insert(chatMessages).values({
            projectId: project.id,
            pageNumber: scope === "page" ? pageNumber : null,
            role: "assistant",
            content: fullResponse,
            model: `${config.provider}/${config.model}`,
            userId: null,
          }).catch(() => {});
        }
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
