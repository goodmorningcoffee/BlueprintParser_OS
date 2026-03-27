import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { projects, pages, chatMessages, annotations, takeoffItems } from "@/lib/db/schema";
import { eq, and, desc, sql, isNull } from "drizzle-orm";
import { checkChatQuota, checkDemoChatQuota } from "@/lib/quotas";
import { resolveLLMConfig } from "@/lib/llm/resolve";
import { streamChatResponse } from "@/lib/llm/stream";
import type { ChatMessage } from "@/lib/llm/types";

const SYSTEM_PROMPT = `You are an expert construction blueprint analyst. You help users understand architectural and engineering drawings by answering questions about blueprint pages.

You have access to four types of data:
1. OCR text extracted from each page (text content, labels, notes, specifications)
2. YOLO object detection results showing what objects were detected on each page (class names, counts, confidence scores)
3. CSI (Construction Specifications Institute) codes detected on each page — these identify what construction divisions and trades are referenced
4. User markup annotations — regions highlighted by the user with names and notes describing areas of interest, questions, or observations about the blueprints

Be concise, specific, and reference page numbers when relevant. You can answer questions about both text content and detected objects (doors, windows, symbols, etc.). If the data doesn't contain enough information to answer, say so clearly.

You can also help users learn how to use BlueprintParser. Key features:
- YOLO button (purple): toggle AI object detections with confidence slider
- Chat (this panel): ask questions about pages or the whole project
- QTO button (green): quantity takeoff — Count tab for counting items, Area tab for measuring surface areas with polygon drawing + scale calibration
- Search bar: full-text search across all pages with word-level highlighting
- Trade/CSI filters: filter pages by construction trade or CSI code
- Markup tools: draw, move, resize annotation rectangles
- Keyboard: arrows for pages, Ctrl+scroll for zoom, Escape to cancel, Ctrl+Z to undo polygon vertex`;

const MAX_CONTEXT_CHARS = 24000; // ~6000 tokens

export async function POST(req: Request) {
  const session = await auth();
  const { projectId, pageNumber, message, scope } = await req.json();

  if (!message) {
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }

  // Global RAG scope — search across all user's projects
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
    if (searchResults.rows.length > 0) {
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

    const msgs: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT + "\n\nYou have access to text from multiple projects. Reference specific project names and page numbers." },
    ];
    if (contextText) msgs.push({ role: "system", content: `Retrieved context:\n${contextText}` });
    msgs.push({ role: "user", content: message });

    return streamChatResponse(config, msgs, 0, null, session.user.dbId);
  }

  if (!projectId) {
    return NextResponse.json({ error: "projectId required" }, { status: 400 });
  }

  let project;
  let isDemo = false;

  if (session?.user) {
    // Authenticated user — check company quota + project ownership
    const quota = await checkChatQuota(session.user.companyId);
    if (!quota.allowed) {
      return NextResponse.json({ error: quota.message }, { status: 429 });
    }

    [project] = await db
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.publicId, projectId),
          eq(projects.companyId, session.user.companyId)
        )
      )
      .limit(1);
  } else {
    // Unauthenticated — only allow demo projects with global quota
    const quota = await checkDemoChatQuota();
    if (!quota.allowed) {
      return NextResponse.json({ error: quota.message }, { status: 429 });
    }

    [project] = await db
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.publicId, projectId),
          eq(projects.isDemo, true)
        )
      )
      .limit(1);
    isDemo = true;
  }

  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Build context from OCR text + CSI codes
  let contextText = "";
  if (scope === "page" && pageNumber) {
    const [page] = await db
      .select({
        pageNumber: pages.pageNumber,
        name: pages.name,
        drawingNumber: pages.drawingNumber,
        rawText: pages.rawText,
        csiCodes: pages.csiCodes,
      })
      .from(pages)
      .where(
        and(eq(pages.projectId, project.id), eq(pages.pageNumber, pageNumber))
      )
      .limit(1);

    if (page?.rawText) {
      contextText = `--- Page ${pageNumber} (${page.drawingNumber || page.name}) ---\n${page.rawText}`;
    }
    if (page?.csiCodes && Array.isArray(page.csiCodes) && (page.csiCodes as any[]).length > 0) {
      contextText += `\n\nCSI Codes on this page:\n`;
      for (const c of page.csiCodes as any[]) {
        contextText += `  ${c.code} — ${c.description} (${c.trade})\n`;
      }
    }
  } else {
    // Project-wide: include all pages, truncated
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

    let totalChars = 0;
    const allCsiSet = new Map<string, { description: string; trade: string; pages: number[] }>();
    for (const page of allPages) {
      // Collect CSI codes across all pages
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

      if (!page.rawText) continue;
      const header = `\n--- Page ${page.pageNumber} (${page.drawingNumber || page.name}) ---\n`;
      const chunk = header + page.rawText;
      if (totalChars + chunk.length > MAX_CONTEXT_CHARS) {
        contextText += `\n... (${allPages.length - allPages.indexOf(page)} more pages truncated)`;
        break;
      }
      contextText += chunk;
      totalChars += chunk.length;
    }

    // Append CSI summary
    if (allCsiSet.size > 0) {
      contextText += `\n\n--- CSI Codes Detected Across Project ---\n`;
      for (const [code, info] of [...allCsiSet.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        contextText += `${code} — ${info.description} (${info.trade}) — pages: ${info.pages.join(", ")}\n`;
      }
    }
  }

  // Add YOLO detection context if available
  const yoloAnnotations = await db
    .select()
    .from(annotations)
    .where(
      and(
        eq(annotations.projectId, project.id),
        eq(annotations.source, "yolo"),
        ...(scope === "page" && pageNumber ? [eq(annotations.pageNumber, pageNumber)] : [])
      )
    );

  if (yoloAnnotations.length > 0) {
    // Group by page, then by class
    const byPage: Record<number, Record<string, { count: number; totalConf: number }>> = {};
    for (const a of yoloAnnotations) {
      if (!byPage[a.pageNumber]) byPage[a.pageNumber] = {};
      const cls = a.name;
      if (!byPage[a.pageNumber][cls]) byPage[a.pageNumber][cls] = { count: 0, totalConf: 0 };
      byPage[a.pageNumber][cls].count++;
      byPage[a.pageNumber][cls].totalConf += (a.data as any)?.confidence || 0;
    }

    let yoloContext = "\n\n--- Object Detection Results (YOLO) ---\n";
    yoloContext += `${yoloAnnotations.length} objects detected across ${Object.keys(byPage).length} pages:\n`;

    for (const [pg, classes] of Object.entries(byPage).sort(([a], [b]) => Number(a) - Number(b))) {
      const total = Object.values(classes).reduce((s, c) => s + c.count, 0);
      yoloContext += `\nPage ${pg} (${total} objects):`;
      for (const [cls, info] of Object.entries(classes).sort(([, a], [, b]) => b.count - a.count)) {
        yoloContext += `\n  ${cls}: ${info.count} (avg confidence ${(info.totalConf / info.count).toFixed(2)})`;
      }
    }

    contextText += yoloContext;
  }

  // Add user markup annotations + notes
  const userAnnotations = await db
    .select()
    .from(annotations)
    .where(
      and(
        eq(annotations.projectId, project.id),
        eq(annotations.source, "user"),
        ...(scope === "page" && pageNumber ? [eq(annotations.pageNumber, pageNumber)] : [])
      )
    );

  if (userAnnotations.length > 0) {
    let markupContext = "\n\n--- User Markup Annotations ---\n";
    const byPage: Record<number, typeof userAnnotations> = {};
    for (const a of userAnnotations) {
      if (!byPage[a.pageNumber]) byPage[a.pageNumber] = [];
      byPage[a.pageNumber].push(a);
    }
    for (const [pg, anns] of Object.entries(byPage).sort(([a], [b]) => Number(a) - Number(b))) {
      markupContext += `\nPage ${pg}:\n`;
      for (const a of anns) {
        markupContext += `  "${a.name}"${a.note ? `: ${a.note}` : ""}\n`;
      }
    }
    contextText += markupContext;
  }

  // Add takeoff item notes if any
  const projectTakeoffItems = await db
    .select()
    .from(takeoffItems)
    .where(eq(takeoffItems.projectId, project.id));

  const itemsWithNotes = projectTakeoffItems.filter((t) => t.notes);
  if (itemsWithNotes.length > 0) {
    contextText += "\n\n--- Quantity Takeoff Notes ---\n";
    for (const t of itemsWithNotes) {
      contextText += `${t.name} (${t.shape}): ${t.notes}\n`;
    }
  }

  // Load recent chat history
  const history = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.projectId, project.id))
    .orderBy(desc(chatMessages.createdAt))
    .limit(10);

  // Resolve LLM config (DB → env var hierarchy)
  const config = await resolveLLMConfig(
    project.companyId,
    session?.user?.dbId,
    isDemo
  );
  if (!config) {
    return NextResponse.json(
      { error: "No LLM configured. Set up a provider in Admin → AI Models." },
      { status: 503 }
    );
  }

  // Build messages
  const systemMessage = contextText
    ? `${SYSTEM_PROMPT}\n\nHere is the extracted text from the blueprint:\n\n${contextText}`
    : SYSTEM_PROMPT;

  const messages: ChatMessage[] = [
    { role: "system", content: systemMessage },
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
  // scope === "all" — no extra filter, deletes everything

  const result = await db
    .delete(chatMessages)
    .where(and(...conditions));

  return NextResponse.json({ success: true });
}
