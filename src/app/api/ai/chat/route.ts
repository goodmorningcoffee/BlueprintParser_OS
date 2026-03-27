import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { projects, pages, chatMessages, annotations, takeoffItems } from "@/lib/db/schema";
import { eq, and, desc, sql, isNull } from "drizzle-orm";
import { checkChatQuota, checkDemoChatQuota } from "@/lib/quotas";
import { resolveLLMConfig } from "@/lib/llm/resolve";
import { streamChatResponse } from "@/lib/llm/stream";
import type { ChatMessage } from "@/lib/llm/types";

const MAX_CONTEXT_CHARS = 24000; // ~6000 tokens

/**
 * Build a dynamic system prompt that describes ONLY the data actually provided.
 * Prevents hallucination by telling the model exactly what it has.
 */
function buildSystemPrompt(dataSummary: string[]): string {
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
 * Raw bbox coordinates are meaningless to the LLM — only summaries help it answer questions.
 */
function buildYoloSummary(
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

  // Build a one-line summary for the system prompt DATA PROVIDED section
  const topClasses = Object.entries(globalCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([cls, count]) => `${count} ${cls}`)
    .join(", ");
  const summaryLine = `${yoloAnnotations.length} YOLO object detections across ${Object.keys(byPage).length} page(s): ${topClasses}`;

  // Build the full context section
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
function buildTextAnnotationsSection(textAnnotations: any): string | null {
  const anns = textAnnotations?.annotations || textAnnotations;
  if (!Array.isArray(anns) || anns.length === 0) return null;

  const byCategory: Record<string, string[]> = {};
  for (const a of anns) {
    const cat = a.category || "other";
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(`${a.type}: ${a.text}${a.meta?.code ? ` [${a.meta.code}]` : ""}`);
  }

  let text = "";
  for (const [cat, items] of Object.entries(byCategory)) {
    text += `${cat}: ${items.join(", ")}\n`;
  }
  return text;
}

/**
 * Assemble context sections in priority order (structured data first, raw OCR last)
 * and enforce MAX_CONTEXT_CHARS limit.
 */
function assembleContext(
  sections: { header: string; content: string; priority: number }[]
): string {
  // Sort by priority (lower = more important = appears first)
  sections.sort((a, b) => a.priority - b.priority);

  let result = "";
  let totalChars = 0;

  for (const section of sections) {
    const block = `\n=== ${section.header} ===\n${section.content}\n`;
    if (totalChars + block.length > MAX_CONTEXT_CHARS) {
      // Try to fit a truncated version
      const remaining = MAX_CONTEXT_CHARS - totalChars - section.header.length - 30;
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

    let contextText = "";
    let totalChars = 0;
    const pageCount = searchResults.rows.length;
    if (pageCount > 0) {
      for (const row of searchResults.rows as any[]) {
        const chunk = `\n--- ${row.project_name}, Page ${row.page_number} (${row.drawing_number || "unnamed"}) ---\n${(row.raw_text || "").substring(0, 3000)}`;
        if (totalChars + chunk.length > MAX_CONTEXT_CHARS) break;
        contextText += chunk;
        totalChars += chunk.length;
      }
    }

    const config = await resolveLLMConfig(session.user.companyId, session.user.dbId);
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

  // ─── Build context sections with priority ordering ─────────
  const sections: { header: string; content: string; priority: number }[] = [];
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
        csiCodes: pages.csiCodes,
        textAnnotations: pages.textAnnotations,
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

    // OCR text (priority 10 — longest, least structured, goes LAST)
    if (page?.rawText) {
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
      if (ocrChars + chunk.length > MAX_CONTEXT_CHARS - 4000) {
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

  // ─── Resolve LLM config ────────────────────────────────────
  const config = await resolveLLMConfig(project.companyId, session?.user?.dbId, isDemo);
  if (!config) {
    return NextResponse.json(
      { error: "No LLM configured. Set up a provider in Admin → AI Models." },
      { status: 503 }
    );
  }

  // ─── Build messages array ──────────────────────────────────
  const contextText = assembleContext(sections);
  const systemPrompt = buildSystemPrompt(dataSummary);

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
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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
