import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, pages } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { checkDemoChatQuota } from "@/lib/quotas";
import { resolveLLMConfig } from "@/lib/llm/resolve";
import { streamChatResponse } from "@/lib/llm/stream";
import type { ChatMessage } from "@/lib/llm/types";

const GLOBAL_SYSTEM_PROMPT = `You are an expert construction blueprint analyst with access to text extracted from multiple construction blueprint projects. You help users understand architectural and engineering drawings.

When answering, reference specific project names and page numbers so users can find the source. Be concise and specific. If the retrieved context doesn't contain enough information, say so clearly.

You can also help users learn how to use BlueprintParser — features include YOLO object detection, full-text search, CSI code detection, quantity takeoff (count + area measurement), and AI chat.`;

const MAX_CONTEXT_CHARS = 20000;
const MAX_PAGES = 10;

/**
 * POST /api/demo/chat
 * RAG chat: search across all demo projects, retrieve relevant pages, send to LLM.
 * Uses demo-specific LLM config if admin configured one, otherwise falls back to env var.
 */
export async function POST(req: Request) {
  const quota = await checkDemoChatQuota();
  if (!quota.allowed) {
    return NextResponse.json({ error: quota.message }, { status: 429 });
  }

  const { message } = await req.json();
  if (!message || typeof message !== "string") {
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }

  // Find a demo project to get companyId for LLM config resolution
  const [demoProject] = await db
    .select({ id: projects.id, companyId: projects.companyId })
    .from(projects)
    .where(eq(projects.isDemo, true))
    .limit(1);

  // Resolve LLM config (demo-specific → company default → env var)
  const config = await resolveLLMConfig(
    demoProject?.companyId || 0,
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
  const searchResults = await db.execute(sql`
    SELECT
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

  if (searchResults.rows.length > 0) {
    for (const row of searchResults.rows as any[]) {
      const header = `\n--- ${row.project_name}, Page ${row.page_number} (${row.drawing_number || "unnamed"}) ---\n`;
      let chunk = header + (row.raw_text || "").substring(0, 3000);
      if (row.csi_codes && Array.isArray(row.csi_codes) && row.csi_codes.length > 0) {
        chunk += `\nCSI Codes: ${row.csi_codes.map((c: any) => `${c.code} (${c.description})`).join(", ")}\n`;
      }
      if (totalChars + chunk.length > MAX_CONTEXT_CHARS) break;
      contextText += chunk;
      totalChars += chunk.length;
    }
  } else {
    // No search matches — provide general context from first pages of each demo project
    const demoProjects = await db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(eq(projects.isDemo, true));

    for (const proj of demoProjects) {
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
  }

  // Step 3: Build messages and stream
  const messages: ChatMessage[] = [
    { role: "system", content: GLOBAL_SYSTEM_PROMPT },
  ];
  if (contextText) {
    messages.push({ role: "system", content: `Retrieved blueprint context:\n${contextText}` });
  }
  messages.push({ role: "user", content: message });

  return streamChatResponse(config, messages, demoProject?.id || 0, null, null);
}
