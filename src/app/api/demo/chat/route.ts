import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, pages, annotations } from "@/lib/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { checkDemoChatQuota } from "@/lib/quotas";
import { assertDemoFeatureEnabled } from "@/lib/demo-features";
import { resolveLLMConfig } from "@/lib/llm/resolve";
import { streamChatResponse } from "@/lib/llm/stream";
import type { ChatMessage } from "@/lib/llm/types";

const MAX_CONTEXT_CHARS = 20000;
const MAX_PAGES = 10;
// Anonymous input, sent verbatim to a paid provider. A question, not a document.
const MAX_MESSAGE_CHARS = 2000;
const MAX_BODY_CHARS = 16 * 1024;

/**
 * POST /api/demo/chat
 * RAG chat: search across all demo projects, retrieve relevant pages, send to LLM.
 * Includes YOLO detection summaries alongside OCR text.
 */
export async function POST(req: Request) {
  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY_CHARS) {
    return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  }
  let message: unknown;
  try {
    message = (JSON.parse(rawBody) as { message?: unknown } | null)?.message;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!message || typeof message !== "string") {
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return NextResponse.json(
      { error: `message too long (max ${MAX_MESSAGE_CHARS} characters)` },
      { status: 400 },
    );
  }

  // Find a demo project to get companyId for LLM config resolution
  const [demoProject] = await db
    .select({ id: projects.id, companyId: projects.companyId })
    .from(projects)
    .where(eq(projects.isDemo, true))
    .limit(1);

  // With no published demo there is nothing to answer about; without this the route is an open
  // proxy to the LLM key from the first minute the site is up.
  if (!demoProject) {
    return NextResponse.json({ error: "Demo chat is not available." }, { status: 404 });
  }
  // The admin "LLM Chat" demo switch must cover this route too, not only /api/ai/chat.
  const gate = await assertDemoFeatureEnabled(demoProject.companyId, "chat");
  if (gate) return gate;

  // Consume quota last: every refusal above is free, so garbage cannot exhaust the daily cap.
  // A verified root admin (server-side session flag) neither checks nor consumes the shared pool
  // (owner ruling 2026-10-21). Anonymous callers hold no session: their path is unchanged.
  const session = await auth().catch(() => null);
  const quota = await checkDemoChatQuota(session?.user?.isRootAdmin === true);
  if (!quota.allowed) {
    return NextResponse.json({ error: quota.message }, { status: 429 });
  }

  // Resolve LLM config (demo-specific → company default → env var)
  const config = await resolveLLMConfig(
    demoProject.companyId,
    undefined,
    true // isDemo
  );
  if (!config) {
    return NextResponse.json(
      { error: "No LLM configured for demo. Admin must set up a provider." },
      { status: 503 }
    );
  }

  // Step 1: Search for relevant pages across all demo projects
  // Include project_id so we can query YOLO annotations
  const searchResults = await db.execute(sql`
    SELECT
      p.id AS project_id,
      p.name AS project_name,
      pg.page_number,
      pg.drawing_number,
      pg.raw_text,
      pg.csi_codes,
      ts_rank(pg.search_vector, plainto_tsquery('english', ${message})) AS rank
    FROM pages pg
    JOIN projects p ON pg.project_id = p.id
    WHERE p.is_demo = true
      AND p.status = 'completed'
      AND pg.search_vector @@ plainto_tsquery('english', ${message})
    ORDER BY rank DESC
    LIMIT ${MAX_PAGES}
  `);

  // Step 2: Build context from retrieved pages
  let contextText = "";
  let totalChars = 0;
  const dataSummary: string[] = [];
  const matchedProjectIds = new Set<number>();

  if (searchResults.rows.length > 0) {
    for (const row of searchResults.rows as any[]) {
      matchedProjectIds.add(row.project_id);
      const header = `\n--- ${row.project_name}, Page ${row.page_number} (${row.drawing_number || "unnamed"}) ---\n`;
      let chunk = header + (row.raw_text || "").substring(0, 3000);
      if (row.csi_codes && Array.isArray(row.csi_codes) && row.csi_codes.length > 0) {
        chunk += `\nCSI Codes: ${row.csi_codes.map((c: any) => `${c.code} (${c.description})`).join(", ")}\n`;
      }
      if (totalChars + chunk.length > MAX_CONTEXT_CHARS) break;
      contextText += chunk;
      totalChars += chunk.length;
    }
    dataSummary.push(`OCR text from ${searchResults.rows.length} matching page(s) across demo projects`);
  } else {
    // No search matches — provide general context from first pages of each demo project
    const demoProjects = await db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(eq(projects.isDemo, true));

    for (const proj of demoProjects) {
      matchedProjectIds.add(proj.id);
      const firstPages = await db
        .select({ pageNumber: pages.pageNumber, drawingNumber: pages.drawingNumber, rawText: pages.rawText })
        .from(pages)
        .where(eq(pages.projectId, proj.id))
        .orderBy(pages.pageNumber)
        .limit(2);

      for (const pg of firstPages) {
        const header = `\n--- ${proj.name}, Page ${pg.pageNumber} (${pg.drawingNumber || "unnamed"}) ---\n`;
        const chunk = header + (pg.rawText || "").substring(0, 2000);
        if (totalChars + chunk.length > MAX_CONTEXT_CHARS) break;
        contextText += chunk;
        totalChars += chunk.length;
      }
    }
    if (demoProjects.length > 0) {
      dataSummary.push(`General context from ${demoProjects.length} demo project(s) (no exact search matches)`);
    }
  }

  // Step 3: Query YOLO detections for matched projects
  let yoloSection = "";
  if (matchedProjectIds.size > 0) {
    // Query YOLO annotations for all matched projects
    const allYolo: any[] = [];
    for (const pid of matchedProjectIds) {
      const yolo = await db.select().from(annotations)
        .where(and(eq(annotations.projectId, pid), eq(annotations.source, "yolo")));
      allYolo.push(...yolo);
    }

    if (allYolo.length > 0) {
      const byClass: Record<string, number> = {};
      for (const a of allYolo) {
        byClass[a.name] = (byClass[a.name] || 0) + 1;
      }
      yoloSection = `\n\n=== OBJECT DETECTIONS (YOLO) ===\n${allYolo.length} objects detected across demo projects:\n`;
      for (const [cls, count] of Object.entries(byClass).sort(([, a], [, b]) => b - a)) {
        yoloSection += `  ${cls}: ${count}\n`;
      }
      dataSummary.push(`${allYolo.length} YOLO object detection(s) (${Object.entries(byClass).slice(0, 3).map(([c, n]) => `${n} ${c}`).join(", ")})`);

      // Add to context if space allows
      if (totalChars + yoloSection.length < MAX_CONTEXT_CHARS) {
        contextText = yoloSection + contextText; // YOLO first, then OCR
        totalChars += yoloSection.length;
      }
    }
  }

  // Step 4: Build dynamic system prompt + single system message
  let systemPrompt = `You are an expert construction blueprint analyst. Below is data retrieved from demo blueprint projects.

IMPORTANT: ONLY reference information that appears in the data below. Do not invent or fabricate examples, page numbers, counts, or project names. If something is not in the provided data, say "that information is not available."`;

  if (dataSummary.length > 0) {
    systemPrompt += `\n\nDATA PROVIDED:\n${dataSummary.map(s => `• ${s}`).join("\n")}`;
  }

  systemPrompt += `\n\nReference specific project names and page numbers when answering.`;

  // Single system message (fixes Anthropic adapter silently dropping second message)
  const systemContent = contextText
    ? `${systemPrompt}\n\n${contextText}`
    : systemPrompt;

  const messages: ChatMessage[] = [
    { role: "system", content: systemContent },
    { role: "user", content: message },
  ];

  // [refactor jun13 P0.5-G2] null when no demo project (was `|| 0` → the same
  // FK-throw-after-stream class as global chat)
  const isDemo = true;
  const noPersist = isDemo;
  return streamChatResponse(config, messages, demoProject?.id ?? null, null, null, noPersist);
}
