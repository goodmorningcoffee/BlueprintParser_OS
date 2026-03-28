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
  CsiCode,
} from "@/types";

interface PageSummary {
  pageNumber: number;
  drawingNumber: string | null;
  pageIntelligence: PageIntelligence | null;
  csiCodes?: CsiCode[] | null;
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
// CSI Topology Analysis
// ═══════════════════════════════════════════════════════════════════

interface CsiDivisionSummary {
  division: string;       // "08"
  name: string;           // "Openings"
  codeCount: number;      // unique codes in this division
  pageCount: number;      // pages mentioning any code in this division
  codes: { code: string; description: string; pages: number[] }[];
}

const DIVISION_NAMES: Record<string, string> = {
  "01": "General Requirements", "02": "Existing Conditions", "03": "Concrete",
  "04": "Masonry", "05": "Metals", "06": "Wood/Plastics/Composites",
  "07": "Thermal & Moisture", "08": "Openings", "09": "Finishes",
  "10": "Specialties", "11": "Equipment", "12": "Furnishings",
  "13": "Special Construction", "14": "Conveying Equipment",
  "21": "Fire Suppression", "22": "Plumbing", "23": "HVAC",
  "25": "Integrated Automation", "26": "Electrical", "27": "Communications",
  "28": "Electronic Safety", "31": "Earthwork", "32": "Exterior Improvements",
  "33": "Utilities",
};

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

export function analyzeProject(pages: PageSummary[]): {
  intelligence: ProjectIntelligence;
  summary: string;
} {
  const disciplines = analyzeDrawingSequence(pages);
  const refGraph = assembleRefGraph(pages);
  const csiTopology = analyzeCsiTopology(pages);
  const summary = generateProjectReport(pages.length, disciplines, refGraph, csiTopology);

  return {
    intelligence: {
      disciplines: disciplines.length > 0 ? disciplines : undefined,
      refGraph: refGraph.edges.length > 0 ? refGraph : undefined,
      pageCount: pages.length,
    },
    summary,
  };
}
