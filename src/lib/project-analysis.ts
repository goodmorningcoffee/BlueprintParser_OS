/**
 * project-analysis.ts
 *
 * Project-level intelligence: drawing sequence, reference graph, auto-generated report.
 * Runs once after all pages are processed.
 */

import type {
  PageIntelligence,
  ProjectIntelligence,
  DisciplineBreakdown,
  RefGraphEdge,
} from "@/types";

interface PageSummary {
  pageNumber: number;
  drawingNumber: string | null;
  pageIntelligence: PageIntelligence | null;
}

// ═══════════════════════════════════════════════════════════════════
// Drawing Sequence Analysis
// ═══════════════════════════════════════════════════════════════════

const RE_DRAWING_NUM = /^([A-Z]{1,2})-?(\d{1,3})(?:\.(\d{1,2}))?$/;

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
// Project Intelligence Report (auto-generated, no LLM needed)
// ═══════════════════════════════════════════════════════════════════

function generateProjectReport(
  pageCount: number,
  disciplines: DisciplineBreakdown[],
  refGraph: { edges: RefGraphEdge[]; hubs: string[]; leaves: string[] },
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

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════
// Main Export
// ═══════════════════════════════════════════════════════════════════

export function analyzeProject(pages: PageSummary[]): {
  intelligence: ProjectIntelligence;
  summary: string;
} {
  const disciplines = analyzeDrawingSequence(pages);
  const refGraph = assembleRefGraph(pages);
  const summary = generateProjectReport(pages.length, disciplines, refGraph);

  return {
    intelligence: {
      disciplines: disciplines.length > 0 ? disciplines : undefined,
      refGraph: refGraph.edges.length > 0 ? refGraph : undefined,
      pageCount: pages.length,
    },
    summary,
  };
}
