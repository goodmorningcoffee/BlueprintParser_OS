import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireAuth } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { projects, pages, chatMessages, annotations, takeoffItems, models, companies } from "@/lib/db/schema";
import { eq, and, desc, sql, isNull, inArray } from "drizzle-orm";
import { checkChatQuota, checkDemoChatQuota } from "@/lib/quotas";
import { resolveLLMConfig } from "@/lib/llm/resolve";
import { streamChatResponse } from "@/lib/llm/stream";
import { mapWordsToRegions, buildSpatialContext } from "@/lib/spatial";
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
  DEFAULT_CONTEXT_BUDGET,
  type ContextSection,
  type LlmSectionConfig,
} from "@/lib/context-builder";
import type { ChatMessage, ToolStreamEvent } from "@/lib/llm/types";
import type { TextractPageData } from "@/types";
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

export async function POST(req: Request) {
  const session = await auth();
  const { projectId, pageNumber, message, scope } = await req.json();

  if (!message) {
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }

  // ─── Global RAG scope — search across all user's projects ───
  if (scope === "global" && session?.user) {
    const quota = await checkChatQuota(session.user.companyId);
    if (!quota.allowed) {
      return NextResponse.json({ error: quota.message }, { status: 429 });
    }

    const config = await resolveLLMConfig(session.user.companyId, session.user.dbId);
    if (!config) {
      return NextResponse.json({ error: "No LLM configured. Set up a provider in Admin → AI Models." }, { status: 503 });
    }
    const globalBudget = getContextBudget(config.provider, config.model);

    // ─── Layer 1: Project catalog (always included) ───
    const allProjects = await db
      .select({
        name: projects.name,
        numPages: projects.numPages,
        projectSummary: projects.projectSummary,
        projectIntelligence: projects.projectIntelligence,
      })
      .from(projects)
      .where(and(
        eq(projects.companyId, session.user.companyId),
        eq(projects.status, "completed"),
      ));

    const globalSections: ContextSection[] = [];

    // Catalog section: project names + summaries
    let catalogContent = "";
    for (const p of allProjects) {
      catalogContent += `\n## ${p.name} (${p.numPages || 0} pages)\n`;
      if (p.projectSummary) {
        catalogContent += p.projectSummary.substring(0, 800) + "\n";
      }
    }
    if (catalogContent) {
      globalSections.push({ id: "global-catalog", header: "PROJECTS IN YOUR ACCOUNT", content: catalogContent, priority: 0.5 });
    }

    // Disciplines section: per-project breakdown
    let disciplineContent = "";
    for (const p of allProjects) {
      const pi = p.projectIntelligence as any;
      if (pi?.disciplines?.length) {
        disciplineContent += `${p.name}: ${pi.disciplines.map((d: any) => `${d.discipline} (${d.count} pages)`).join(", ")}\n`;
      }
    }
    if (disciplineContent) {
      globalSections.push({ id: "global-disciplines", header: "DISCIPLINE BREAKDOWN", content: disciplineContent, priority: 1.0 });
    }

    // CSI summary: aggregated across projects
    let csiContent = "";
    for (const p of allProjects) {
      const pi = p.projectIntelligence as any;
      if (pi?.csiGraph?.nodes?.length) {
        const divisions = pi.csiGraph.nodes.slice(0, 10).map((n: any) => `${n.id} ${n.label || ""}`).join(", ");
        csiContent += `${p.name}: ${divisions}\n`;
      }
    }
    if (csiContent) {
      globalSections.push({ id: "global-csi-summary", header: "CSI DIVISIONS BY PROJECT", content: csiContent, priority: 1.5 });
    }

    // ─── Layer 2: Search-augmented detail ───
    const searchResults = await db.execute(sql`
      SELECT p.name AS project_name, pg.page_number, pg.drawing_number,
        pg.csi_codes, pg.text_annotations, pg.raw_text,
        ts_rank(pg.search_vector, plainto_tsquery('english', ${message})) AS rank
      FROM pages pg JOIN projects p ON pg.project_id = p.id
      WHERE p.company_id = ${session.user.companyId} AND p.status = 'completed'
        AND pg.search_vector @@ plainto_tsquery('english', ${message})
      ORDER BY rank DESC LIMIT 10
    `);

    if (searchResults.rows.length > 0) {
      // Structured search results (CSI codes, text annotations)
      let structuredContent = "";
      let ocrContent = "";
      for (const row of searchResults.rows as any[]) {
        const header = `--- ${row.project_name}, Page ${row.page_number} (${row.drawing_number || "unnamed"}) ---\n`;
        let structured = "";
        if (row.csi_codes?.length) {
          structured += "CSI: " + row.csi_codes.map((c: any) => `${c.code} ${c.description}`).join("; ") + "\n";
        }
        if (row.text_annotations?.summary) {
          const types = Object.entries(row.text_annotations.summary).map(([t, count]) => `${t}: ${count}`).join(", ");
          structured += "Detected: " + types + "\n";
        }
        if (structured) structuredContent += header + structured;
        // Raw OCR as lower-priority fallback
        if (row.raw_text) ocrContent += header + (row.raw_text as string).substring(0, 2000) + "\n";
      }
      if (structuredContent) {
        globalSections.push({ id: "global-search-results", header: `SEARCH RESULTS (${searchResults.rows.length} pages)`, content: structuredContent, priority: 3.0 });
      }
      if (ocrContent) {
        globalSections.push({ id: "global-search-ocr", header: "SEARCH — RAW OCR TEXT", content: ocrContent, priority: 8.0 });
      }
    }

    // Assemble with budget + overflow pool (reuses existing infrastructure)
    const { assembled } = assembleContextWithConfig(globalSections, globalBudget);

    const dataSummary = [
      `${allProjects.length} projects with summaries`,
      ...(searchResults.rows.length > 0 ? [`${searchResults.rows.length} pages matching search`] : []),
    ];
    const systemPrompt = buildSystemPrompt(dataSummary)
      + "\n\nThis is a cross-project dashboard. You have summaries of ALL projects. Answer questions about patterns, comparisons, and specific project data. Reference project names and page numbers when citing.";

    const msgs: ChatMessage[] = [
      { role: "system", content: `${systemPrompt}\n\n${assembled}` },
      { role: "user", content: message },
    ];

    return streamChatResponse(config, msgs, 0, null, session.user.dbId);
  }

  // ─── Page/Project scope ─────────────────────────────────────
  if (!projectId) {
    return NextResponse.json({ error: "projectId required" }, { status: 400 });
  }

  let project;
  let isDemo = false;

  if (session?.user) {
    const quota = await checkChatQuota(session.user.companyId);
    if (!quota.allowed) {
      return NextResponse.json({ error: quota.message }, { status: 429 });
    }

    [project] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.publicId, projectId), eq(projects.companyId, session.user.companyId)))
      .limit(1);
  } else {
    const quota = await checkDemoChatQuota();
    if (!quota.allowed) {
      return NextResponse.json({ error: quota.message }, { status: 429 });
    }

    [project] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.publicId, projectId), eq(projects.isDemo, true)))
      .limit(1);
    isDemo = true;
  }

  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

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
    return NextResponse.json(
      { error: "No LLM configured. Set up a provider in Admin → AI Models." },
      { status: 503 }
    );
  }
  const contextBudget = getContextBudget(config.provider, config.model);

  // ─── Fetch company config once (reused for tool use check + context config) ───
  let companyPipelineConfig: Record<string, unknown> = {};
  try {
    const [companyRow] = await db
      .select({ pipelineConfig: companies.pipelineConfig })
      .from(companies)
      .where(eq(companies.id, session?.user?.companyId || project.companyId))
      .limit(1);
    companyPipelineConfig = (companyRow?.pipelineConfig as Record<string, unknown>) || {};
  } catch { /* ignore */ }

  const toolUseEnabled = !!(companyPipelineConfig as any)?.llm?.toolUse;

  // Tool use only works with providers that support it (Anthropic, OpenAI)
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
  if (userAnnotations.length > 0) {
    const byPage: Record<number, typeof userAnnotations> = {};
    for (const a of userAnnotations) {
      if (!byPage[a.pageNumber]) byPage[a.pageNumber] = [];
      byPage[a.pageNumber].push(a);
    }
    let markupText = "";
    for (const [pg, anns] of Object.entries(byPage).sort(([a], [b]) => Number(a) - Number(b))) {
      markupText += `Page ${pg}:\n`;
      for (const a of anns) {
        markupText += `  "${a.name}"${a.note ? `: ${a.note}` : ""}\n`;
      }
    }
    sections.push({ header: "USER ANNOTATIONS", content: markupText, priority: 2 });
    dataSummary.push(`${userAnnotations.length} user markup annotation(s) with notes`);
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

    // CSI codes (priority 4 — structured)
    if (page?.csiCodes && Array.isArray(page.csiCodes) && page.csiCodes.length > 0) {
      let csiText = "";
      for (const c of page.csiCodes) {
        csiText += `${c.code} — ${c.description} (${c.trade})\n`;
      }
      sections.push({ header: "CSI CODES", content: csiText, priority: 4 });
      dataSummary.push(`${page.csiCodes.length} CSI construction specification code(s)`);
    }

    // Text annotations (priority 5 — semi-structured)
    if (page?.textAnnotations) {
      const textAnnsText = buildTextAnnotationsSection(page.textAnnotations);
      if (textAnnsText) {
        const annCount = page.textAnnotations?.annotations?.length || 0;
        sections.push({ header: "AUTO-DETECTED TEXT PATTERNS", content: textAnnsText, priority: 5 });
        dataSummary.push(`${annCount} auto-detected text pattern(s) (phone, dimensions, equipment, etc.)`);
      }
    }

    // ─── Page Intelligence (classification, cross-refs, notes) ───
    if (page?.pageIntelligence) {
      const intelResult = buildPageIntelligenceSection(page.pageIntelligence, pageNumber);
      if (intelResult) {
        sections.push(...intelResult.sections);
        dataSummary.push(...intelResult.summaryLines);
      }

      // Parsed table/keynote contents (priority 5.8 — after notes, before detected regions)
      const parsedTablesText = buildParsedTablesSection(page.pageIntelligence?.parsedRegions);
      if (parsedTablesText) {
        sections.push({
          header: `PARSED TABLES/KEYNOTES — Page ${pageNumber}`,
          content: parsedTablesText,
          priority: 5.8,
        });
        dataSummary.push(`Parsed table/keynote data for Page ${pageNumber}`);
      }

      // CSI from Parsed Data (priority 6.2 — after detected regions, before spatial map)
      const parsedCsiText = buildParsedDataCsiSection(page.pageIntelligence?.parsedRegions);
      if (parsedCsiText) {
        sections.push({
          header: `CSI FROM PARSED DATA — Page ${pageNumber}`,
          content: parsedCsiText,
          priority: 6.2,
        });
        dataSummary.push(`Parsed data CSI codes for Page ${pageNumber}`);
      }

      // CSI Spatial Distribution (priority 7 — after detected regions, before spatial OCR)
      const csiSpatialText = buildCsiSpatialSection(page.pageIntelligence?.csiSpatialMap);
      if (csiSpatialText) {
        const pageLabel = page.drawingNumber || page.name;
        sections.push({
          header: `CSI SPATIAL DISTRIBUTION — Page ${pageNumber} (${pageLabel})`,
          content: csiSpatialText,
          priority: 7,
        });
        dataSummary.push(`CSI spatial heatmap for Page ${pageNumber}`);
      }
    }

    // ─── Spatial Intelligence: map OCR words to YOLO regions ───
    let usedSpatialContext = false;
    if (page?.textractData && yoloAnnotations.length > 0) {
      // Collect unique modelIds from YOLO annotations, query their configs for classTypes
      const modelIds = [...new Set(yoloAnnotations.map((a) => (a.data as any)?.modelId).filter(Boolean))];
      if (modelIds.length > 0) {
        const modelConfigs = await db
          .select({ id: models.id, config: models.config })
          .from(models)
          .where(inArray(models.id, modelIds));

        // Build set of spatial class names
        const spatialClasses = new Set<string>();
        for (const mc of modelConfigs) {
          const ct = (mc.config as any)?.classTypes || {};
          for (const [cls, type] of Object.entries(ct)) {
            if (type === "spatial" || type === "both") spatialClasses.add(cls);
          }
        }

        if (spatialClasses.size > 0) {
          // Filter YOLO annotations to only spatial classes on this page
          const spatialAnnotations = yoloAnnotations
            .filter((a) => a.pageNumber === pageNumber && spatialClasses.has(a.name))
            .map((a) => ({
              name: a.name,
              minX: a.minX,
              minY: a.minY,
              maxX: a.maxX,
              maxY: a.maxY,
              confidence: (a.data as any)?.confidence || 0,
            }));

          if (spatialAnnotations.length > 0) {
            const spatialResult = mapWordsToRegions(
              page.textractData as TextractPageData,
              spatialAnnotations
            );

            if (spatialResult.regions.length > 0) {
              const spatialText = buildSpatialContext(pageNumber, page.drawingNumber, spatialResult);
              const pageLabel = page.drawingNumber || page.name;
              sections.push({
                header: `SPATIAL CONTEXT — Page ${pageNumber} (${pageLabel})`,
                content: spatialText,
                priority: 8, // after structured data, before flat OCR
              });
              const regionNames = spatialResult.regions.map((r) => r.displayName).join(", ");
              dataSummary.push(`Spatially-tagged OCR text (regions: ${regionNames}) from Page ${pageNumber}`);
              usedSpatialContext = true;
            }
          }
        }
      }
    }

    // OCR text fallback (priority 10 — only if spatial context didn't replace it)
    if (!usedSpatialContext && page?.rawText) {
      const pageLabel = page.drawingNumber || page.name;
      sections.push({
        header: `OCR TEXT — Page ${pageNumber} (${pageLabel})`,
        content: page.rawText,
        priority: 10,
      });
      dataSummary.push(`OCR extracted text from Page ${pageNumber} (${pageLabel})`);
    }

  } else {
    // Project-wide scope
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

    // Project Intelligence Report (priority 0.5 — first thing in project scope)
    const projectSummarySection = buildProjectSummarySection(
      (project as any).projectSummary || null
    );
    if (projectSummarySection) {
      sections.push(projectSummarySection);
      dataSummary.push("Auto-generated project intelligence report");
    }

    // CSI Network Graph (priority 1 — project-wide division relationships)
    const csiGraphText = buildCsiGraphSection((project as any).projectIntelligence?.csiGraph);
    if (csiGraphText) {
      const graphData = (project as any).projectIntelligence?.csiGraph;
      sections.push({
        header: "CSI NETWORK GRAPH — Project Division Relationships",
        content: csiGraphText,
        priority: 1,
      });
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
      // Reserve ~4000 chars for structured sections above
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

  // ─── Extract LLM config from already-fetched company config ──────────────
  const llmPipelineConfig = (companyPipelineConfig as any)?.llm;
  const customSystemPrompt: string | undefined = llmPipelineConfig?.systemPrompt;
  const sectionConfig: LlmSectionConfig | undefined = llmPipelineConfig?.sectionConfig;

  // ─── Build messages array ──────────────────────────────────
  const { assembled: contextText } = assembleContextWithConfig(sections, contextBudget, sectionConfig);
  const systemPrompt = buildSystemPrompt(dataSummary, customSystemPrompt);

  // Single system message with prompt + context (avoids Anthropic adapter bug)
  const systemContent = contextText
    ? `${systemPrompt}\n\n${contextText}`
    : systemPrompt;

  const messages: ChatMessage[] = [
    { role: "system", content: systemContent },
  ];

  // Add history (reversed to chronological order)
  for (const msg of history.reverse()) {
    messages.push({
      role: msg.role as "user" | "assistant",
      content: msg.content,
    });
  }

  // Add current message
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

  return streamChatResponse(
    config,
    messages,
    project.id,
    scope === "page" ? pageNumber : null,
    session?.user?.dbId || null
  );
}

/**
 * Tool-use chat handler: lightweight system prompt + tool loop.
 * LLM decides what data it needs and calls tools to get it.
 */
async function handleToolUseChat(
  config: any,
  project: any,
  message: string,
  scope: string,
  pageNumber: number | undefined,
  session: any,
  isDemo: boolean,
  history: any[],
) {
  const toolCtx: ToolContext = {
    projectId: project.id,
    publicId: project.publicId,
    companyId: project.companyId,
    pageNumber,
  };

  // Load domain knowledge: custom from company config, or cached default from file
  let domainKnowledge = "";
  try {
    const [companyDk] = await db
      .select({ pipelineConfig: companies.pipelineConfig })
      .from(companies)
      .where(eq(companies.id, session?.user?.companyId || project.companyId))
      .limit(1);
    const customDk = (companyDk?.pipelineConfig as any)?.llm?.domainKnowledge;
    if (customDk) {
      domainKnowledge = customDk;
    } else {
      domainKnowledge = await getCachedDomainKnowledge();
    }
  } catch { /* use empty */ }

  // Lightweight system prompt — project context + domain knowledge, tools handle the data
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

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
  ];

  // Add chat history (DB returns newest-first, reverse to chronological)
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
    // Fallback: provider loaded but doesn't support tools
    return NextResponse.json({ error: "Provider does not support tool use" }, { status: 400 });
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
            // Check for action results (navigate, highlight, createMarkup)
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
        // Save assistant response to DB
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

/**
 * DELETE /api/ai/chat — Clear chat messages for a project
 * Query params: projectId, scope (page|project|all), pageNumber (for page scope)
 */
export async function DELETE(req: Request) {
  const { session, error } = await requireAuth();
  if (error) return error;

  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId");
  const scope = url.searchParams.get("scope") || "all";
  const pageNum = url.searchParams.get("pageNumber");

  if (!projectId) {
    return NextResponse.json({ error: "projectId required" }, { status: 400 });
  }

  // Verify project ownership
  const [project] = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.publicId, projectId),
        eq(projects.companyId, session.user.companyId)
      )
    )
    .limit(1);

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  let conditions = [eq(chatMessages.projectId, project.id)];

  if (scope === "page" && pageNum) {
    conditions.push(eq(chatMessages.pageNumber, parseInt(pageNum)));
  } else if (scope === "project") {
    conditions.push(isNull(chatMessages.pageNumber));
  }

  const result = await db
    .delete(chatMessages)
    .where(and(...conditions));

  return NextResponse.json({ success: true });
}
