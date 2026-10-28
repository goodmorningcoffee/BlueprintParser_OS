/**
 * project-analysis.ts
 *
 * Project-level intelligence: drawing sequence, reference graph, auto-generated report.
 * Runs once after all pages are processed.
 */

import type {
  PageIntelligence,
  ProjectIntelligence,
  ProjectSummaries,
  DisciplineBreakdown,
  RefGraphEdge,
  CsiCode,
  ScheduleSummaryEntry,
  ParsedTableSummaryEntry,
  NotesSummaryEntry,
  SpecSummaryEntry,
  AnnotationSummary,
  TakeoffItemTotal,
  TextAnnotationResult,
  KeynoteShapeData,
} from "@/types";
import { buildCsiGraph } from "@/lib/csi-graph";
// [refactor jul9 P2-A C1 R2] Folded the byte-dup local DIVISION_NAMES table into the
// canonical map (SPEC_FINAL §4.2 / N-2; owner "Fold them" 2026-07-09). The local was the
// 24-division set missing Div 00; canonical adds "00":"Procurement" — the sole delta here,
// surfacing a Procurement label in analyzeCsiTopology when Div-00 codes are present
// (ledger D-8 class). analyzeCsiTopology still reads DIVISION_NAMES[div] || `Division ${div}`.
import { DIVISION_NAMES } from "@/lib/csi-divisions";
import { db } from "@/lib/db";
import { pages, annotations, projects } from "@/lib/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { onVisiblePage, visiblePage } from "@/lib/page-dedup";
import { summaryTableName } from "@/lib/parsed-table-summary";
import { deriveStructureIndex } from "@/lib/parse-engine/index-derive"; // [TP-3 WP-3.H] PJ.structureIndex is derived here, never hand-written (C1-B2)
import { deriveInboxIndex } from "@/lib/parse-engine/inbox-derive"; // [TP-3 WP-3.F HIGH-1] the one inbox derive (integrate g2b)
import type { StructureIndexV1 } from "@/lib/parse-engine/types";
import { logger } from "@/lib/logger";
import {
  assertProjectWriteCapability,
  type ProjectWriteCapability,
  type ProjectWriteTransaction,
  withProjectWrite,
} from "@/server/api/project-write-capability";

// ─── [TP-3 WP-3.H verify MED-2] structureIndex.inbox, re-derived under the project lock ───
// The WP-3.F verdict route jsonb_sets one page's `inbox` slice under the project lock. The summaries pass
// derives the index from page rows read BEFORE its lock, so a verdict committed in between would be
// overwritten; rows read inside the lock are current (lock order project → page, rule 11). Only the keys
// WP-3.F's deriveInboxForPage reads (INBOX_DERIVE_PI_KEYS) are projected, so no parse data moves while the
// lock is held; widen this with that list (structure-index.route.test.ts pins the parity). `prevInbox` is the
// locked row's stored inbox: it carries the legacy-reject bindings forward (WP-3.F HIGH-1, integrate g2b).
// The other slices have no other writer, and every parsedRegions writer recomputes summaries after it commits.
const INBOX_PARSED_REGION = sql.raw(`jsonb_build_object('id', r->'id', 'type', r->'type', 'bbox', r->'bbox', 'sourceTextRegionId', r->'sourceTextRegionId')`);
const INBOX_PROPOSAL = sql.raw(`jsonb_build_object('id', q->'id', 'target', q->'target', 'classId', q->'classId', 'bbox', q->'bbox', 'displayName', q->'displayName', 'className', q->'className', 'p', q->'p', 'tableP', q->'tableP')`);

async function withLockedInbox(tx: ProjectWriteTransaction, projectId: number, index: StructureIndexV1, prevInbox: StructureIndexV1["inbox"] | null): Promise<StructureIndexV1 | null> {
  const pi = pages.pageIntelligence;
  const rows = await tx
    .select({
      pageNumber: pages.pageNumber,
      pageIntelligence: sql<PageIntelligence>`jsonb_build_object('textRegions', ${pi}->'textRegions', 'textRegionVerdicts', ${pi}->'textRegionVerdicts',
        'rejectedTextRegionIds', ${pi}->'rejectedTextRegionIds', 'parsedRegions', (SELECT jsonb_agg(${INBOX_PARSED_REGION}) FROM jsonb_array_elements(
        CASE jsonb_typeof(${pi}->'parsedRegions') WHEN 'array' THEN ${pi}->'parsedRegions' ELSE '[]'::jsonb END) r),
        'proposalVerdicts', ${pi}->'proposalVerdicts', 'classifierProposals', jsonb_build_object('proposals', (SELECT jsonb_agg(${INBOX_PROPOSAL}) FROM jsonb_array_elements(
        CASE jsonb_typeof(${pi}->'classifierProposals'->'proposals') WHEN 'array' THEN ${pi}->'classifierProposals'->'proposals' ELSE '[]'::jsonb END) q)))`,
    })
    .from(pages)
    .where(and(eq(pages.projectId, projectId), visiblePage(pi)));
  try {
    return { ...index, inbox: deriveInboxIndex(rows, prevInbox) };
  } catch (e) {
    logger.error("[summaries] structureIndex inbox derive failed; the previous index is kept:", e);
    return null; // the caller keeps the stored index (verify LOW-5)
  }
}

interface PageSummary {
  pageNumber: number;
  drawingNumber: string | null;
  pageIntelligence: PageIntelligence | null;
  csiCodes?: CsiCode[] | null;
}

// ═══════════════════════════════════════════════════════════════════
// Drawing Sequence Analysis
// ═══════════════════════════════════════════════════════════════════

const RE_DRAWING_NUM = /^([A-Z]{1,4})-?(\d{1,4})(?:\.(\d{1,2}))?$/;

const DISCIPLINE_NAMES: Record<string, string> = {
  T: "Title/Cover", G: "General", C: "Civil", L: "Landscape",
  A: "Architectural", I: "Interior", ID: "Interior Design",
  DM: "Demolition", S: "Structural",
  M: "Mechanical", E: "Electrical", P: "Plumbing",
  FP: "Fire Protection", FA: "Fire Alarm", SP: "Sprinkler",
};

const SERIES_NAMES: Record<string, string> = {
  "0": "General", "1": "Plans", "2": "Elevations", "3": "Sections",
  "4": "Enlarged", "5": "Details", "6": "Schedules", "7": "Diagrams",
  "8": "Details", "9": "3D",
};

function analyzeDrawingSequence(pages: PageSummary[]): DisciplineBreakdown[] {
  const byPrefix = new Map<string, { nums: number[]; drawings: string[] }>();

  for (const page of pages) {
    if (!page.drawingNumber) continue;
    const match = RE_DRAWING_NUM.exec(page.drawingNumber.toUpperCase());
    if (!match) continue;

    const prefix = match[1];
    const num = parseInt(match[2]);
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, { nums: [], drawings: [] });
    const entry = byPrefix.get(prefix)!;
    entry.nums.push(num);
    entry.drawings.push(page.drawingNumber);
  }

  const results: DisciplineBreakdown[] = [];
  for (const [prefix, data] of byPrefix) {
    data.nums.sort((a, b) => a - b);
    data.drawings.sort();

    const series: Record<string, number> = {};
    for (const num of data.nums) {
      const s = `${Math.floor(num / 100) * 100}`;
      series[s] = (series[s] || 0) + 1;
    }

    results.push({
      prefix,
      discipline: DISCIPLINE_NAMES[prefix] || `Unknown (${prefix})`,
      count: data.drawings.length,
      range: data.drawings.length > 1
        ? `${data.drawings[0]} to ${data.drawings[data.drawings.length - 1]}`
        : data.drawings[0] || prefix,
      series,
    });
  }

  results.sort((a, b) => b.count - a.count);
  return results;
}

// ═══════════════════════════════════════════════════════════════════
// Reference Graph Assembly
// ═══════════════════════════════════════════════════════════════════

function assembleRefGraph(pages: PageSummary[]): {
  edges: RefGraphEdge[];
  hubs: string[];
  leaves: string[];
} {
  const edges: RefGraphEdge[] = [];
  const incomingCount = new Map<string, number>();
  const outgoingCount = new Map<string, number>();
  const allPages = new Set<string>();

  for (const page of pages) {
    const fromPage = page.drawingNumber || `Page ${page.pageNumber}`;
    allPages.add(fromPage);

    const refs = page.pageIntelligence?.crossRefs;
    if (!refs) continue;

    for (const ref of refs) {
      edges.push({
        fromPage,
        toPage: ref.targetDrawing,
        refType: ref.refType,
        detail: ref.detail,
      });
      incomingCount.set(ref.targetDrawing, (incomingCount.get(ref.targetDrawing) || 0) + 1);
      outgoingCount.set(fromPage, (outgoingCount.get(fromPage) || 0) + 1);
    }
  }

  // Hubs: pages referenced by 3+ other pages
  const hubs = [...incomingCount.entries()]
    .filter(([, count]) => count >= 3)
    .sort(([, a], [, b]) => b - a)
    .map(([page]) => page);

  // Leaves: pages that reference others but are never referenced
  const leaves = [...outgoingCount.keys()]
    .filter(page => !incomingCount.has(page))
    .sort();

  return { edges, hubs, leaves };
}

// ═══════════════════════════════════════════════════════════════════
// CSI Topology Analysis
// ═══════════════════════════════════════════════════════════════════

interface CsiDivisionSummary {
  division: string;       // "08"
  name: string;           // "Openings"
  codeCount: number;      // unique codes in this division
  pageCount: number;      // pages mentioning any code in this division
  codes: { code: string; description: string; pages: number[] }[];
}

// [refactor jul9 P2-A C1 R2] local DIVISION_NAMES deleted — now imported from
// @/lib/csi-divisions (canonical 25-division map). See import-site note above.

function analyzeCsiTopology(pages: PageSummary[]): CsiDivisionSummary[] {
  const divMap = new Map<string, {
    codes: Map<string, { description: string; pages: Set<number> }>;
    pages: Set<number>;
  }>();

  for (const page of pages) {
    if (!page.csiCodes || !Array.isArray(page.csiCodes)) continue;
    for (const csi of page.csiCodes as CsiCode[]) {
      const div = csi.code.substring(0, 2).trim();
      if (!divMap.has(div)) divMap.set(div, { codes: new Map(), pages: new Set() });
      const entry = divMap.get(div)!;
      entry.pages.add(page.pageNumber);
      if (!entry.codes.has(csi.code)) {
        entry.codes.set(csi.code, { description: csi.description, pages: new Set() });
      }
      entry.codes.get(csi.code)!.pages.add(page.pageNumber);
    }
  }

  const results: CsiDivisionSummary[] = [];
  for (const [div, data] of divMap) {
    results.push({
      division: div,
      name: DIVISION_NAMES[div] || `Division ${div}`,
      codeCount: data.codes.size,
      pageCount: data.pages.size,
      codes: [...data.codes.entries()].map(([code, info]) => ({
        code,
        description: info.description,
        pages: [...info.pages].sort((a, b) => a - b),
      })),
    });
  }

  results.sort((a, b) => b.pageCount - a.pageCount);
  return results;
}

// ═══════════════════════════════════════════════════════════════════
// Project Intelligence Report (auto-generated, no LLM needed)
// ═══════════════════════════════════════════════════════════════════

function generateProjectReport(
  pageCount: number,
  disciplines: DisciplineBreakdown[],
  refGraph: { edges: RefGraphEdge[]; hubs: string[]; leaves: string[] },
  csiTopology: CsiDivisionSummary[],
): string {
  const lines: string[] = [];
  lines.push(`PROJECT OVERVIEW: ${pageCount} sheets`);

  if (disciplines.length > 0) {
    lines.push("");
    lines.push("DISCIPLINES:");
    for (const d of disciplines) {
      const seriesStr = Object.entries(d.series)
        .map(([s, n]) => `${n} ${SERIES_NAMES[String(parseInt(s) / 100)] || s}`)
        .join(", ");
      lines.push(`  ${d.discipline} (${d.prefix}): ${d.count} sheets (${d.range}) — ${seriesStr}`);
    }
  }

  if (refGraph.edges.length > 0) {
    lines.push("");
    lines.push(`CROSS-REFERENCES: ${refGraph.edges.length} references detected`);
    if (refGraph.hubs.length > 0) {
      lines.push(`  Key pages (referenced by 3+ others): ${refGraph.hubs.join(", ")}`);
    }
  }

  if (csiTopology.length > 0) {
    lines.push("");
    lines.push("CSI TOPOLOGY:");
    for (const div of csiTopology.slice(0, 10)) { // top 10 divisions
      const topCodes = div.codes.slice(0, 3).map(c => c.code).join(", ");
      lines.push(`  Division ${div.division} (${div.name}): ${div.codeCount} codes across ${div.pageCount} pages [${topCodes}]`);
    }
  }

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════
// Main Export
// ═══════════════════════════════════════════════════════════════════

export function analyzeProject(pageSummaries: PageSummary[]): {
  intelligence: ProjectIntelligence;
  summary: string;
} {
  const disciplines = analyzeDrawingSequence(pageSummaries);
  const refGraph = assembleRefGraph(pageSummaries);
  const csiTopology = analyzeCsiTopology(pageSummaries);
  const csiGraph = buildCsiGraph(pageSummaries.map(p => ({
    ...p,
    csiCodes: (p.csiCodes || []) as { code: string; description: string; trade: string; division: string }[],
  })));
  const summary = generateProjectReport(pageSummaries.length, disciplines, refGraph, csiTopology);

  return {
    intelligence: {
      disciplines: disciplines.length > 0 ? disciplines : undefined,
      refGraph: refGraph.edges.length > 0 ? refGraph : undefined,
      csiGraph: csiGraph || undefined,
      // [refactor jul9 P2-A S2] pageCount purged — zero readers repo-wide (U1-F2).
      // NOTE this was the only UNCONDITIONALLY-emitted key; every remaining key
      // degrades to undefined when empty (dropped by the jsonb write), so
      // "did analysis run" witnesses must pin a stale-key REFRESH instead.
    },
    summary,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Project Summaries (chunking support)
// Pre-compute lightweight indexes so browser can power sidebar/panels
// without loading all page data.
// ═══════════════════════════════════════════════════════════════════

interface PageRow {
  pageNumber: number;
  name: string | null;
  drawingNumber: string | null;
  keynotes: KeynoteShapeData[] | null | undefined;
  csiCodes: { code: string; description: string; trade: string; division: string }[] | null | undefined;
  textAnnotations: TextAnnotationResult | null | undefined;
  pageIntelligence: PageIntelligence | null | undefined;
}

interface AnnotationRow {
  id: number;
  pageNumber: number;
  name: string;
  source: string;
  data: any;
}

/**
 * Compute summary indexes for a project from DB data.
 * Called at end of processing pipeline and after YOLO load.
 * Stores result in projects.projectIntelligence.summaries.
 */
export async function computeProjectSummaries(
  projectId: number,
  writeCapability: ProjectWriteCapability,
): Promise<ProjectSummaries> {
  await assertProjectWriteCapability(writeCapability, projectId);
  // Fetch all page metadata (lightweight columns only, no textractData/rawText)
  const pageRows: PageRow[] = await db
    .select({
      pageNumber: pages.pageNumber,
      name: pages.name,
      drawingNumber: pages.drawingNumber,
      keynotes: pages.keynotes,
      csiCodes: pages.csiCodes,
      textAnnotations: pages.textAnnotations,
      pageIntelligence: pages.pageIntelligence,
    })
    .from(pages)
    .where(and(eq(pages.projectId, projectId), visiblePage(pages.pageIntelligence))) // hidden duplicates out
    .orderBy(pages.pageNumber);

  // Fetch all annotations (lightweight: no full bbox needed for summary)
  const annotationRows: AnnotationRow[] = await db
    .select({
      id: annotations.id,
      pageNumber: annotations.pageNumber,
      name: annotations.name,
      source: annotations.source,
      data: annotations.data,
    })
    .from(annotations)
    .where(and(eq(annotations.projectId, projectId), onVisiblePage(annotations.projectId, annotations.pageNumber)));

  // ─── Build schedule + parsed table + keynote table catalogs ───
  const schedules: ScheduleSummaryEntry[] = [];
  const parsedTables: ParsedTableSummaryEntry[] = [];
  const keynoteTablePages: { pageNum: number; confidence: number }[] = [];
  // Stage 3: notes + spec catalogs. Sourced from pageIntelligence.textRegions
  // (Layer 1 classifier output). Populated in the pageRows loop below.
  const notesRegions: NotesSummaryEntry[] = [];
  const specRegions: SpecSummaryEntry[] = [];

  // ─── Build page indexes ───
  const csiPageIndex: Record<string, number[]> = {};
  const tradePageIndex: Record<string, number[]> = {};
  const keynotePageIndex: Record<string, number[]> = {};
  const textAnnotationPageIndex: Record<string, number[]> = {};
  const pageClassifications: Record<number, { discipline: string; prefix: string }> = {};
  const allTradesSet = new Set<string>();
  const allCsiMap = new Map<string, string>(); // code -> description

  for (const page of pageRows) {
    const pn = page.pageNumber;

    // classifiedTables → schedule catalog + keynote table catalog
    const pi = page.pageIntelligence;
    if (pi?.classifiedTables) {
      for (const t of pi.classifiedTables) {
        schedules.push({
          pageNum: pn,
          category: t.category,
          name: page.name || `Page ${pn}`,
          confidence: t.confidence,
        });
        if (t.category === "keynote-table") {
          keynoteTablePages.push({ pageNum: pn, confidence: t.confidence });
        }
      }
    }

    // parsedRegions → parsed table catalog
    if (pi?.parsedRegions) {
      for (const pr of pi.parsedRegions) {
        if (pr.type === "schedule" || pr.type === "keynote") {
          parsedTables.push({
            pageNum: pn,
            name: summaryTableName(pr),
            category: pr.category,
            rowCount: (pr.data as any)?.rowCount || (pr.data as any)?.rows?.length || 0,
            colCount: (pr.data as any)?.columnCount || (pr.data as any)?.headers?.length || 0,
            regionId: pr.id,
          });
        }
      }
    }

    // Stage 3: textRegions → notes + spec catalogs
    if (pi?.textRegions) {
      for (const r of pi.textRegions) {
        const pageName = page.name || `Page ${pn}`;
        const drawingNumber = page.drawingNumber ?? null;
        if (r.type === "notes-numbered" || r.type === "notes-key-value") {
          notesRegions.push({
            pageNum: pn,
            pageName,
            drawingNumber,
            type: r.type,
            headerText: r.headerText,
            tier1: r.classifiedLabels?.tier1,
            tier2: r.classifiedLabels?.tier2,
            trade: r.classifiedLabels?.trade,
            confidence: r.confidence,
            rowCount: r.rowCount,
            csiTags: r.csiTags,
            bbox: r.bbox,
            regionId: r.id,
          });
        } else if (r.type === "spec-dense-columns") {
          specRegions.push({
            pageNum: pn,
            pageName,
            drawingNumber,
            headerText: r.headerText,
            tier1: r.classifiedLabels?.tier1,
            tier2: r.classifiedLabels?.tier2,
            confidence: r.confidence,
            wordCount: r.wordCount,
            csiTags: r.csiTags,
            bbox: r.bbox,
            regionId: r.id,
          });
        }
      }
    }

    // classification → pageClassifications
    if (pi?.classification) {
      pageClassifications[pn] = {
        discipline: pi.classification.discipline,
        prefix: pi.classification.disciplinePrefix,
      };
    }

    // csiCodes → csiPageIndex + tradePageIndex + allTrades + allCsiCodes
    const codes = page.csiCodes;
    if (codes && Array.isArray(codes)) {
      for (const c of codes) {
        // CSI page index
        if (!csiPageIndex[c.code]) csiPageIndex[c.code] = [];
        if (!csiPageIndex[c.code].includes(pn)) csiPageIndex[c.code].push(pn);

        // Trade page index
        if (c.trade) {
          if (!tradePageIndex[c.trade]) tradePageIndex[c.trade] = [];
          if (!tradePageIndex[c.trade].includes(pn)) tradePageIndex[c.trade].push(pn);
          allTradesSet.add(c.trade);
        }

        // Unique CSI codes
        if (!allCsiMap.has(c.code)) allCsiMap.set(c.code, c.description);
      }
    }

    // keynotes → keynotePageIndex
    const kn = page.keynotes;
    if (kn && Array.isArray(kn)) {
      for (const k of kn) {
        const key = `${k.shape || ""}:${k.text || ""}`;
        if (!keynotePageIndex[key]) keynotePageIndex[key] = [];
        if (!keynotePageIndex[key].includes(pn)) keynotePageIndex[key].push(pn);
      }
    }

    // textAnnotations → textAnnotationPageIndex
    const ta = page.textAnnotations;
    if (ta?.annotations && Array.isArray(ta.annotations)) {
      for (const a of ta.annotations) {
        const key = `${a.type}:${a.text}`;
        if (!textAnnotationPageIndex[key]) textAnnotationPageIndex[key] = [];
        if (!textAnnotationPageIndex[key].includes(pn)) textAnnotationPageIndex[key].push(pn);
      }
    }
  }

  // ─── Build annotation summary ───
  const modelNamesSet = new Set<string>();
  const categoryCounts: Record<string, { count: number; pages: number[] }> = {};
  const pageAnnotationCounts: Record<number, { yolo: number; user: number; takeoff: number }> = {};
  const takeoffTotals: Record<number, TakeoffItemTotal> = {};

  for (const ann of annotationRows) {
    const pn = ann.pageNumber;

    // Per-page counts
    if (!pageAnnotationCounts[pn]) pageAnnotationCounts[pn] = { yolo: 0, user: 0, takeoff: 0 };
    if (ann.source === "yolo") {
      pageAnnotationCounts[pn].yolo++;
    } else if (ann.source === "takeoff") {
      pageAnnotationCounts[pn].takeoff++;
    } else {
      pageAnnotationCounts[pn].user++;
    }

    // YOLO model names
    if (ann.source === "yolo" && ann.data?.modelName) {
      modelNamesSet.add(ann.data.modelName as string);
    }

    // Category counts (by annotation name)
    if (!categoryCounts[ann.name]) categoryCounts[ann.name] = { count: 0, pages: [] };
    categoryCounts[ann.name].count++;
    if (!categoryCounts[ann.name].pages.includes(pn)) {
      categoryCounts[ann.name].pages.push(pn);
    }

    // Takeoff totals
    if (ann.source === "takeoff" && ann.data) {
      const d = ann.data as any;
      const itemId = d.takeoffItemId as number;
      if (itemId != null) {
        if (!takeoffTotals[itemId]) takeoffTotals[itemId] = { count: 0, totalArea: 0, pages: [] };
        takeoffTotals[itemId].count++;
        if (d.areaSqUnits) takeoffTotals[itemId].totalArea += d.areaSqUnits as number;
        if (!takeoffTotals[itemId].pages.includes(pn)) {
          takeoffTotals[itemId].pages.push(pn);
        }
      }
    }
  }

  const annotationSummary: AnnotationSummary = {
    modelNames: [...modelNamesSet],
    categoryCounts,
    pageAnnotationCounts,
  };

  const summaries: ProjectSummaries = {
    schedules,
    parsedTables,
    keynoteTablePages,
    notesRegions: notesRegions.length > 0 ? notesRegions : undefined,
    specRegions: specRegions.length > 0 ? specRegions : undefined,
    csiPageIndex,
    tradePageIndex,
    keynotePageIndex,
    textAnnotationPageIndex,
    pageClassifications,
    annotationSummary,
    takeoffTotals,
    allTrades: [...allTradesSet].sort(),
    allCsiCodes: [...allCsiMap.entries()]
      .map(([code, description]) => ({ code, description }))
      .sort((a, b) => a.code.localeCompare(b.code)),
  };

  let structureIndex: StructureIndexV1 | null = null; // visible pages only; a derive failure keeps the stored index (verify LOW-5)
  try {
    structureIndex = deriveStructureIndex(pageRows, new Date().toISOString());
  } catch (e) {
    logger.error("[summaries] structureIndex derive failed; the previous index is kept:", e);
  }
  // The potentially long read/analysis phase stays outside a transaction. Re-read merge state and
  // publish only after acquiring the parent project lock for this exact lifecycle generation.
  await withProjectWrite(writeCapability, projectId, async (tx) => {
    const [currentProject] = await tx
      .select({ pi: projects.projectIntelligence })
      .from(projects)
      .where(eq(projects.id, projectId));

    const existingPi = currentProject?.pi || {};
    // inbox re-derived from rows read under this lock: the verdict route jsonb_sets that slice (verify MED-2)
    const storedInbox = (existingPi as { structureIndex?: Partial<StructureIndexV1> }).structureIndex?.inbox ?? null;
    const index = structureIndex ? await withLockedInbox(tx, projectId, structureIndex, storedInbox) : null;
    await tx
      .update(projects)
      .set({
        projectIntelligence: { ...existingPi, summaries, ...(index ? { structureIndex: index } : {}) }, // typed PJ has no structureIndex field (types/index.ts at its ceiling)
        updatedAt: new Date(),
      })
      .where(eq(projects.id, projectId));
  });

  return summaries;
}

/**
 * Patch a specific field in project summaries without full recomputation.
 * Used for incremental updates when a single table is parsed, annotation
 * is added/removed, etc.
 */
export async function patchProjectSummaries(
  projectId: number,
  patch: Partial<ProjectSummaries>,
  writeCapability: ProjectWriteCapability,
): Promise<void> {
  const patched = await withProjectWrite(writeCapability, projectId, async (tx) => {
    const [currentProject] = await tx
      .select({ pi: projects.projectIntelligence })
      .from(projects)
      .where(eq(projects.id, projectId));

    const existingPi = currentProject?.pi || {};
    const existingSummaries = existingPi.summaries || null;
    if (!existingSummaries) return false;

    const mergedSummaries = { ...existingSummaries, ...patch };
    await tx
      .update(projects)
      .set({
        projectIntelligence: { ...existingPi, summaries: mergedSummaries },
        updatedAt: new Date(),
      })
      .where(eq(projects.id, projectId));
    return true;
  });

  if (!patched) {
    // No summaries yet — do a full computation instead
    await computeProjectSummaries(projectId, writeCapability);
  }
}
