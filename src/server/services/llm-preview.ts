// [refactor jul6 S048] admin/llm/preview SOLO — build LLM context for a project/page and
// return section METADATA (mirrors the chat route's context assembly but does NOT call the
// LLM), folded from the legacy route (git show 1ca235f:src/app/api/admin/llm/preview/route.ts).
// Char: __tests__/admin-llm-preview.route.test.ts (LP-*). requireAdmin (the shell provides
// auth:"admin"). Sanctioned diffs:
//   • A — flat auth errors → envelope; "projectId required" (400) + "Not found" (404) stay
//     byte-verbatim as ApiError.
//   • E — legacy `await req.json()` subsumed by the shell raw-parse ("Invalid JSON body").
//   • NO B — no catch-500 literal; unexpected errors → shell generic INTERNAL 500.
// PRESERVED byte-exact: the companyId-SCOPED project lookup (NO root bypass), all the
// @/lib/context-builder section assembly, the getContextBudget budget, and the response shape.
// This is a pure READ (no writes, no external LLM/AWS call).

import { db } from "@/lib/db";
import { projects, pages, annotations, takeoffItems, companies } from "@/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { findWordsInBbox, wordsToText } from "@/lib/ocr-utils";
import type { TextractPageData } from "@/types";
import {
  buildYoloSummary,
  buildTextAnnotationsSection,
  buildPageIntelligenceSection,
  buildProjectSummarySection,
  buildCsiSpatialSection,
  buildCsiGraphSection,
  buildParsedTablesSection,
  buildParsedDataCsiSection,
  assembleContextWithConfig,
  getContextBudget,
  type ContextSection,
  type LlmSectionConfig,
} from "@/lib/context-builder";
import type { AuthSession } from "@/lib/api-utils";
import { ApiError } from "@/server/api/envelope";

export async function previewLlmContext(rawBody: Record<string, unknown>, session: AuthSession): Promise<unknown> {
  const { projectId, pageNumber, scope } = rawBody as { projectId?: string; pageNumber?: number; scope?: string };

  if (!projectId) {
    throw new ApiError("VALIDATION", "projectId required");
  }

  // Find project
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.publicId, projectId), eq(projects.companyId, session.user.companyId)))
    .limit(1);

  if (!project) {
    throw new ApiError("NOT_FOUND", "Not found");
  }

  // Load LLM config
  const [company] = await db
    .select({ pipelineConfig: companies.pipelineConfig })
    .from(companies)
    .where(eq(companies.id, session.user.companyId))
    .limit(1);

  const llmConfig = company?.pipelineConfig?.llm || {};
  const sectionConfig: LlmSectionConfig = llmConfig.sectionConfig || {};
  const budget = getContextBudget("anthropic", "sonnet"); // default preview budget

  // Build sections (mirrors chat/route.ts logic)
  const sections: ContextSection[] = [];

  // YOLO detections
  const yoloAnns = await db.select().from(annotations)
    .where(and(eq(annotations.projectId, project.id), eq(annotations.source, "yolo")));

  const yoloResult = buildYoloSummary(yoloAnns);
  if (yoloResult) {
    sections.push({ id: "yolo-counts", header: "OBJECT DETECTIONS (YOLO)", content: yoloResult.text, priority: 1 });
  }

  // User annotations — mirrors the live chat shape in scoped.ts: bbox + OCR
  // text inside each markup so the admin preview shows what the LLM actually sees.
  const userAnns = await db.select().from(annotations)
    .where(and(eq(annotations.projectId, project.id), eq(annotations.source, "user")));

  if (userAnns.length > 0) {
    const annotatedPageNumbers = Array.from(new Set(userAnns.map((a) => a.pageNumber)));
    const pageRows = await db
      .select({ pageNumber: pages.pageNumber, textractData: pages.textractData })
      .from(pages)
      .where(and(eq(pages.projectId, project.id), inArray(pages.pageNumber, annotatedPageNumbers)));
    const textractByPage: Record<number, TextractPageData | null> = {};
    for (const row of pageRows) textractByPage[row.pageNumber] = row.textractData;

    const MAX_OCR_CHARS = 300;
    const b3 = (v: number) => v.toFixed(3);
    let text = "";
    for (const a of userAnns) {
      const words = textractByPage[a.pageNumber]?.words ?? [];
      const wordsInside = findWordsInBbox(words, [a.minX, a.minY, a.maxX, a.maxY]);
      text += `Page ${a.pageNumber}: "${a.name}" [bbox ${b3(a.minX)},${b3(a.minY)} → ${b3(a.maxX)},${b3(a.maxY)}]`;
      if (a.note) text += ` — note: ${a.note}`;
      if (wordsInside.length > 0) {
        const ocr = wordsToText(wordsInside).replace(/\n/g, " / ");
        const snippet = ocr.length > MAX_OCR_CHARS ? ocr.slice(0, MAX_OCR_CHARS) + "…" : ocr;
        text += ` — OCR in region: "${snippet}"`;
      }
      text += "\n";
    }
    sections.push({ id: "user-annotations", header: "USER ANNOTATIONS", content: text, priority: 2 });
  }

  // Takeoff notes
  const items = await db.select().from(takeoffItems).where(eq(takeoffItems.projectId, project.id));
  const withNotes = items.filter((t) => t.notes);
  if (withNotes.length > 0) {
    sections.push({
      id: "takeoff-notes",
      header: "TAKEOFF NOTES",
      content: withNotes.map((t) => `${t.name}: ${t.notes}`).join("\n"),
      priority: 3,
    });
  }

  // Page-scope data
  if (scope === "page" && pageNumber) {
    const [page] = await db
      .select({
        pageNumber: pages.pageNumber,
        name: pages.name,
        drawingNumber: pages.drawingNumber,
        rawText: pages.rawText,
        csiCodes: pages.csiCodes,
        textAnnotations: pages.textAnnotations,
        pageIntelligence: pages.pageIntelligence,
      })
      .from(pages)
      .where(and(eq(pages.projectId, project.id), eq(pages.pageNumber, pageNumber)))
      .limit(1);

    if (page?.csiCodes && Array.isArray(page.csiCodes) && page.csiCodes.length > 0) {
      let csiText = "";
      for (const c of page.csiCodes) {
        csiText += `${c.code} — ${c.description} (${c.trade})\n`;
      }
      sections.push({ id: "csi-codes", header: "CSI CODES", content: csiText, priority: 4 });
    }

    if (page?.textAnnotations) {
      const text = buildTextAnnotationsSection(page.textAnnotations);
      if (text) sections.push({ id: "text-annotations", header: "AUTO-DETECTED TEXT PATTERNS", content: text, priority: 5 });
    }

    if (page?.pageIntelligence) {
      const intel = buildPageIntelligenceSection(page.pageIntelligence, pageNumber);
      if (intel) {
        for (const s of intel.sections) {
          // Map to stable IDs based on header content
          let id = "detected-regions";
          if (s.header.includes("CLASSIFICATION")) id = "page-classification";
          else if (s.header.includes("CROSS-REFERENCES")) id = "cross-refs";
          else if (s.header.includes("NOTE BLOCKS")) id = "note-blocks";
          else if (s.header.includes("DETECTED REGIONS")) id = "detected-regions";
          sections.push({ ...s, id });
        }
      }

      const parsedText = buildParsedTablesSection(page.pageIntelligence?.parsedRegions);
      if (parsedText) sections.push({ id: "parsed-tables", header: `PARSED TABLES — Page ${pageNumber}`, content: parsedText, priority: 5.8 });

      const parsedCsi = buildParsedDataCsiSection(page.pageIntelligence?.parsedRegions);
      if (parsedCsi) sections.push({ id: "csi-parsed", header: `CSI FROM PARSED DATA`, content: parsedCsi, priority: 6.2 });

      const spatial = buildCsiSpatialSection(page.pageIntelligence?.csiSpatialMap);
      if (spatial) sections.push({ id: "csi-spatial", header: `CSI SPATIAL DISTRIBUTION — Page ${pageNumber}`, content: spatial, priority: 7 });
    }

    if (page?.rawText) {
      sections.push({ id: "raw-ocr", header: `OCR TEXT — Page ${pageNumber}`, content: page.rawText, priority: 10 });
    }
  } else {
    // Project scope
    const projectSummary = buildProjectSummarySection((project as any).projectSummary || null);
    if (projectSummary) sections.push({ ...projectSummary, id: "project-report" });

    const csiGraph = buildCsiGraphSection((project as any).projectIntelligence?.csiGraph);
    if (csiGraph) sections.push({ id: "csi-graph", header: "CSI NETWORK GRAPH", content: csiGraph, priority: 1 });
  }

  // Assemble with config
  const { assembled, sectionMeta } = assembleContextWithConfig(sections, budget, sectionConfig);

  return {
    sections: sectionMeta,
    totalChars: assembled.length,
    budget,
  };
}
