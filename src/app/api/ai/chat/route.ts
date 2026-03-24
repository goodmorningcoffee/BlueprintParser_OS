import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { projects, pages, chatMessages, annotations } from "@/lib/db/schema";
import { eq, and, desc } from "drizzle-orm";
import Groq from "groq-sdk";
import { checkChatQuota, checkDemoChatQuota } from "@/lib/quotas";

// Lazy init — env vars from Secrets Manager may not be available at module load time
function getGroqClient() {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY not configured");
  }
  return new Groq({ apiKey });
}

const SYSTEM_PROMPT = `You are an expert construction blueprint analyst. You help users understand architectural and engineering drawings by answering questions about blueprint pages.

You have access to two types of data:
1. OCR text extracted from each page (text content, labels, notes, specifications)
2. YOLO object detection results showing what objects were detected on each page (class names, counts, confidence scores)

Be concise, specific, and reference page numbers when relevant. You can answer questions about both text content and detected objects (doors, windows, symbols, etc.). If the data doesn't contain enough information to answer, say so clearly.`;

const MAX_CONTEXT_CHARS = 24000; // ~6000 tokens

export async function POST(req: Request) {
  const session = await auth();
  const { projectId, pageNumber, message, scope } = await req.json();

  if (!projectId || !message) {
    return NextResponse.json(
      { error: "projectId and message required" },
      { status: 400 }
    );
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

  // Build context from OCR text
  let contextText = "";
  if (scope === "page" && pageNumber) {
    const [page] = await db
      .select()
      .from(pages)
      .where(
        and(eq(pages.projectId, project.id), eq(pages.pageNumber, pageNumber))
      )
      .limit(1);

    if (page?.rawText) {
      contextText = `--- Page ${pageNumber} (${page.drawingNumber || page.name}) ---\n${page.rawText}`;
    }
  } else {
    // Project-wide: include all pages, truncated
    const allPages = await db
      .select()
      .from(pages)
      .where(eq(pages.projectId, project.id))
      .orderBy(pages.pageNumber);

    let totalChars = 0;
    for (const page of allPages) {
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

  // Load recent chat history
  const history = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.projectId, project.id))
    .orderBy(desc(chatMessages.createdAt))
    .limit(10);

  // Build messages array for Groq
  const systemMessage = contextText
    ? `${SYSTEM_PROMPT}\n\nHere is the extracted text from the blueprint:\n\n${contextText}`
    : SYSTEM_PROMPT;

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
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
    model: "llama-3.3-70b-versatile",
    userId: session?.user?.dbId || null,
  });

  try {
    const groq = getGroqClient();

    // Call Groq (streaming)
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages,
      temperature: 0.3,
      max_tokens: 2048,
      stream: true,
    });

    // Stream response
    let fullResponse = "";
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of completion) {
            const content = chunk.choices[0]?.delta?.content || "";
            if (content) {
              fullResponse += content;
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ content })}\n\n`)
              );
            }
          }

          // Save assistant response to DB
          await db.insert(chatMessages).values({
            projectId: project.id,
            pageNumber: scope === "page" ? pageNumber : null,
            role: "assistant",
            content: fullResponse,
            model: "llama-3.3-70b-versatile",
            userId: session?.user?.dbId || null,
          });

          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch (err) {
          console.error("Stream error:", err);
          controller.error(err);
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
  } catch (err) {
    console.error("Groq API error:", err);
    const message = err instanceof Error ? err.message : "Chat failed";
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
