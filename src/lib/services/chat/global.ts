/**
 * Global RAG chat service — cross-project search + catalog context.
 *
 * Extracted from ai/chat/route.ts to keep the route handler thin.
 */
import { db } from "@/lib/db";
import { projects, pages } from "@/lib/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { resolveLLMConfig } from "@/lib/llm/resolve";
import { streamChatResponse } from "@/lib/llm/stream";
import {
  buildSystemPrompt,
  buildCsiGraphSection,
  assembleContextWithConfig,
  getContextBudget,
  type ContextSection,
} from "@/lib/context-builder";
import type { ChatMessage } from "@/lib/llm/types";

export async function handleGlobalChat(
  session: { user: { companyId: number; dbId: number } },
  message: string,
) {
  const config = await resolveLLMConfig(session.user.companyId, session.user.dbId);
  if (!config) {
    return Response.json(
      { error: "No LLM configured. Set up a provider in Admin → AI Models." },
      { status: 503 }
    );
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
      if (row.raw_text) ocrContent += header + (row.raw_text as string).substring(0, 2000) + "\n";
    }
    if (structuredContent) {
      globalSections.push({ id: "global-search-results", header: `SEARCH RESULTS (${searchResults.rows.length} pages)`, content: structuredContent, priority: 3.0 });
    }
    if (ocrContent) {
      globalSections.push({ id: "global-search-ocr", header: "SEARCH — RAW OCR TEXT", content: ocrContent, priority: 8.0 });
    }
  }

  // Assemble with budget + overflow pool
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
