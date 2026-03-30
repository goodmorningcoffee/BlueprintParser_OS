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
  assembleContext,
  getContextBudget,
  DEFAULT_CONTEXT_BUDGET,
  type ContextSection,
} from "@/lib/context-builder";
import type { ChatMessage } from "@/lib/llm/types";
import type { TextractPageData } from "@/types";


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

    const searchResults = await db.execute(sql`
      SELECT p.name AS project_name, pg.page_number, pg.drawing_number, pg.raw_text,
        ts_rank(pg.search_vector, plainto_tsquery('english', ${message})) AS rank
      FROM pages pg JOIN projects p ON pg.project_id = p.id
      WHERE p.company_id = ${session.user.companyId} AND p.status = 'completed'
        AND pg.search_vector @@ plainto_tsquery('english', ${message})
      ORDER BY rank DESC LIMIT 10
    `);

    const config = await resolveLLMConfig(session.user.companyId, session.user.dbId);

    let contextText = "";
    let totalChars = 0;
    const globalBudget = config ? getContextBudget(config.provider, config.model) : DEFAULT_CONTEXT_BUDGET;
    const pageCount = searchResults.rows.length;
    if (pageCount > 0) {
      for (const row of searchResults.rows as any[]) {
        const chunk = `\n--- ${row.project_name}, Page ${row.page_number} (${row.drawing_number || "unnamed"}) ---\n${(row.raw_text || "").substring(0, 3000)}`;
        if (totalChars + chunk.length > globalBudget) break;
        contextText += chunk;
        totalChars += chunk.length;
      }
    }
    if (!config) {
      return NextResponse.json({ error: "No LLM configured. Set up a provider in Admin → AI Models." }, { status: 503 });
    }

    const dataSummary = pageCount > 0
      ? [`OCR text from ${pageCount} pages across multiple projects (full-text search results)`]
      : [];
    const systemPrompt = buildSystemPrompt(dataSummary)
      + "\n\nThis is a cross-project search. Reference specific project names and page numbers.";

    // Single system message (fixes Anthropic adapter dropping second message)
    const systemContent = contextText
      ? `${systemPrompt}\n\n${contextText}`
      : systemPrompt;

    const msgs: ChatMessage[] = [
      { role: "system", content: systemContent },
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
    if (page?.csiCodes && Array.isArray(page.csiCodes) && (page.csiCodes as any[]).length > 0) {
      let csiText = "";
      for (const c of page.csiCodes as any[]) {
        csiText += `${c.code} — ${c.description} (${c.trade})\n`;
      }
      sections.push({ header: "CSI CODES", content: csiText, priority: 4 });
      dataSummary.push(`${(page.csiCodes as any[]).length} CSI construction specification code(s)`);
    }

    // Text annotations (priority 5 — semi-structured)
    if (page?.textAnnotations) {
      const textAnnsText = buildTextAnnotationsSection(page.textAnnotations);
      if (textAnnsText) {
        const annCount = ((page.textAnnotations as any)?.annotations || page.textAnnotations as any[])?.length || 0;
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
      const parsedTablesText = buildParsedTablesSection((page.pageIntelligence as any)?.parsedRegions);
      if (parsedTablesText) {
        sections.push({
          header: `PARSED TABLES/KEYNOTES — Page ${pageNumber}`,
          content: parsedTablesText,
          priority: 5.8,
        });
        dataSummary.push(`Parsed table/keynote data for Page ${pageNumber}`);
      }

      // CSI from Parsed Data (priority 6.2 — after detected regions, before spatial map)
      const parsedCsiText = buildParsedDataCsiSection((page.pageIntelligence as any)?.parsedRegions);
      if (parsedCsiText) {
        sections.push({
          header: `CSI FROM PARSED DATA — Page ${pageNumber}`,
          content: parsedCsiText,
          priority: 6.2,
        });
        dataSummary.push(`Parsed data CSI codes for Page ${pageNumber}`);
      }

      // CSI Spatial Distribution (priority 7 — after detected regions, before spatial OCR)
      const csiSpatialText = buildCsiSpatialSection((page.pageIntelligence as any)?.csiSpatialMap);
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
        for (const c of page.csiCodes as any[]) {
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

  // ─── Fetch custom system prompt if configured ──────────────
  let customSystemPrompt: string | undefined;
  try {
    const [companyConfig] = await db
      .select({ pipelineConfig: companies.pipelineConfig })
      .from(companies)
      .where(eq(companies.id, session?.user?.companyId || project.companyId))
      .limit(1);
    customSystemPrompt = (companyConfig?.pipelineConfig as any)?.llm?.systemPrompt;
  } catch { /* ignore */ }

  // ─── Build messages array ──────────────────────────────────
  const contextText = assembleContext(sections, contextBudget);
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
