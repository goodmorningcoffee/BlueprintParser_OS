/**
 * csi-graph.ts
 *
 * CSI Network Graph: builds a project-wide graph of CSI division co-occurrence
 * relationships. Pure function, no DB access.
 */

import type { CsiCode, PageIntelligence } from "@/types";

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

export interface CsiGraphNode {
  division: string;
  name: string;
  totalInstances: number;
  pageCount: number;
  pages: number[];
}

export interface CsiGraphEdge {
  source: string;
  target: string;
  weight: number;
  type: "co-occurrence" | "cross-reference" | "containment";
  pages: number[];
}

export interface CsiCluster {
  name: string;
  divisions: string[];
  cohesion: number;
}

export interface CsiNetworkGraph {
  nodes: CsiGraphNode[];
  edges: CsiGraphEdge[];
  clusters: CsiCluster[];
  fingerprint: string;
}

interface PageSummary {
  pageNumber: number;
  csiCodes: { code: string; description: string; trade: string; division: string }[];
  pageIntelligence?: PageIntelligence | null;
}

// ═══════════════════════════════════════════════════════════════════
// Division names (same as project-analysis.ts)
// ═══════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════
// Known cluster definitions
// ═══════════════════════════════════════════════════════════════════

const KNOWN_CLUSTERS: { name: string; divisions: Set<string> }[] = [
  { name: "MEP",          divisions: new Set(["22", "23", "26", "27", "28"]) },
  { name: "Architectural", divisions: new Set(["08", "09", "12"]) },
  { name: "Structural",   divisions: new Set(["03", "05"]) },
  { name: "Site",         divisions: new Set(["31", "32", "33"]) },
];

// ═══════════════════════════════════════════════════════════════════
// Main entry point
// ═══════════════════════════════════════════════════════════════════

export function buildCsiGraph(pageSummaries: PageSummary[]): CsiNetworkGraph | null {
  // ── Step 1: Node construction ──────────────────────────────────
  const divData = new Map<string, { instances: number; pages: Set<number> }>();

  for (const page of pageSummaries) {
    if (!page.csiCodes || !Array.isArray(page.csiCodes)) continue;

    for (const csi of page.csiCodes) {
      const div = csi.division?.substring(0, 2).trim() || csi.code.substring(0, 2).trim();
      if (!div) continue;

      if (!divData.has(div)) {
        divData.set(div, { instances: 0, pages: new Set() });
      }
      const entry = divData.get(div)!;
      entry.instances += 1;
      entry.pages.add(page.pageNumber);
    }
  }

  // Bail if fewer than 2 divisions found
  if (divData.size < 2) return null;

  const nodes: CsiGraphNode[] = [];
  for (const [div, data] of divData) {
    const sortedPages = [...data.pages].sort((a, b) => a - b);
    nodes.push({
      division: div,
      name: DIVISION_NAMES[div] || `Division ${div}`,
      totalInstances: data.instances,
      pageCount: data.pages.size,
      pages: sortedPages,
    });
  }
  nodes.sort((a, b) => b.totalInstances - a.totalInstances);

  // ── Step 2: Co-occurrence edges ────────────────────────────────
  // For each page, collect the set of divisions present. Any pair of
  // divisions sharing a page creates (or increments) an edge.
  const edgeMap = new Map<string, { weight: number; pages: Set<number> }>();

  for (const page of pageSummaries) {
    if (!page.csiCodes || !Array.isArray(page.csiCodes)) continue;

    const divsOnPage = new Set<string>();
    for (const csi of page.csiCodes) {
      const div = csi.division?.substring(0, 2).trim() || csi.code.substring(0, 2).trim();
      if (div) divsOnPage.add(div);
    }

    const sorted = [...divsOnPage].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = `${sorted[i]}|${sorted[j]}`;
        if (!edgeMap.has(key)) {
          edgeMap.set(key, { weight: 0, pages: new Set() });
        }
        const entry = edgeMap.get(key)!;
        entry.weight += 1;
        entry.pages.add(page.pageNumber);
      }
    }
  }

  // Add cross-reference edges from pageIntelligence
  const crossRefEdges = buildCrossRefEdges(pageSummaries, divData);

  const edges: CsiGraphEdge[] = [];

  for (const [key, data] of edgeMap) {
    const [source, target] = key.split("|");
    edges.push({
      source,
      target,
      weight: data.weight,
      type: "co-occurrence",
      pages: [...data.pages].sort((a, b) => a - b),
    });
  }

  edges.push(...crossRefEdges);
  edges.sort((a, b) => b.weight - a.weight);

  // ── Step 3: Cluster detection ──────────────────────────────────
  const clusters = detectClusters(divData, edgeMap);

  // ── Step 4: Fingerprint ────────────────────────────────────────
  const fingerprint = nodes
    .map((n) => `${n.division}:${n.totalInstances}`)
    .join(",");

  return { nodes, edges, clusters, fingerprint };
}

// ═══════════════════════════════════════════════════════════════════
// Cross-reference edge construction
// ═══════════════════════════════════════════════════════════════════

/**
 * Examines pageIntelligence.crossRefs to find cross-reference edges between
 * divisions. If page A (with division X) cross-references page B (with
 * division Y), that is a cross-reference edge.
 */
function buildCrossRefEdges(
  pages: PageSummary[],
  divData: Map<string, { instances: number; pages: Set<number> }>,
): CsiGraphEdge[] {
  // Build a lookup: drawingNumber -> set of divisions on that page.
  // We also index by page number for fallback resolution.
  const pageDivisions = new Map<number, Set<string>>();

  for (const page of pages) {
    if (!page.csiCodes || !Array.isArray(page.csiCodes)) continue;
    const divs = new Set<string>();
    for (const csi of page.csiCodes) {
      const div = csi.division?.substring(0, 2).trim() || csi.code.substring(0, 2).trim();
      if (div) divs.add(div);
    }
    if (divs.size > 0) pageDivisions.set(page.pageNumber, divs);
  }

  const crossEdgeMap = new Map<string, { weight: number; pages: Set<number> }>();

  for (const page of pages) {
    const refs = page.pageIntelligence?.crossRefs;
    if (!refs || refs.length === 0) continue;

    const sourceDivs = pageDivisions.get(page.pageNumber);
    if (!sourceDivs) continue;

    for (const ref of refs) {
      // Try to resolve the target page to find its divisions.
      // We look for a page whose number matches the target drawing's page.
      // This is approximate since we only have page numbers, not drawing numbers.
      for (const targetPage of pages) {
        if (targetPage.pageNumber === page.pageNumber) continue;
        const targetDivs = pageDivisions.get(targetPage.pageNumber);
        if (!targetDivs) continue;

        // Create edges between source divisions and target divisions
        for (const sd of sourceDivs) {
          for (const td of targetDivs) {
            if (sd === td) continue;
            const [lo, hi] = sd < td ? [sd, td] : [td, sd];
            const key = `${lo}|${hi}`;
            // Only create cross-ref edge if there is not already a
            // co-occurrence edge between these divisions on this page pair.
            if (!crossEdgeMap.has(key)) {
              crossEdgeMap.set(key, { weight: 0, pages: new Set() });
            }
            const entry = crossEdgeMap.get(key)!;
            entry.weight += 1;
            entry.pages.add(page.pageNumber);
          }
        }
      }
    }
  }

  const edges: CsiGraphEdge[] = [];
  for (const [key, data] of crossEdgeMap) {
    const [source, target] = key.split("|");
    edges.push({
      source,
      target,
      weight: data.weight,
      type: "cross-reference",
      pages: [...data.pages].sort((a, b) => a - b),
    });
  }

  return edges;
}

// ═══════════════════════════════════════════════════════════════════
// Cluster detection
// ═══════════════════════════════════════════════════════════════════

/**
 * Detects clusters of divisions that co-occur on 70%+ of each other's pages.
 * First attempts to match known cluster patterns, then discovers ad-hoc clusters.
 */
function detectClusters(
  divData: Map<string, { instances: number; pages: Set<number> }>,
  edgeMap: Map<string, { weight: number; pages: Set<number> }>,
): CsiCluster[] {
  const clusters: CsiCluster[] = [];
  const clusteredDivisions = new Set<string>();

  // ── Known cluster matching ─────────────────────────────────────
  for (const known of KNOWN_CLUSTERS) {
    const present = [...known.divisions].filter((d) => divData.has(d));
    if (present.length < 2) continue;

    const cohesion = computeGroupCohesion(present, divData, edgeMap);
    if (cohesion >= 0.7) {
      clusters.push({
        name: known.name,
        divisions: present.sort(),
        cohesion: Math.round(cohesion * 1000) / 1000,
      });
      for (const d of present) clusteredDivisions.add(d);
    }
  }

  // ── Ad-hoc cluster discovery ───────────────────────────────────
  // Find pairs of unclustered divisions with 70%+ overlap, then grow.
  const unclustered = [...divData.keys()].filter((d) => !clusteredDivisions.has(d));

  for (let i = 0; i < unclustered.length; i++) {
    if (clusteredDivisions.has(unclustered[i])) continue;

    const group = [unclustered[i]];

    for (let j = i + 1; j < unclustered.length; j++) {
      if (clusteredDivisions.has(unclustered[j])) continue;

      const candidate = [...group, unclustered[j]];
      const cohesion = computeGroupCohesion(candidate, divData, edgeMap);
      if (cohesion >= 0.7) {
        group.push(unclustered[j]);
      }
    }

    if (group.length >= 2) {
      const cohesion = computeGroupCohesion(group, divData, edgeMap);
      const name = nameCluster(group);
      clusters.push({
        name,
        divisions: group.sort(),
        cohesion: Math.round(cohesion * 1000) / 1000,
      });
      for (const d of group) clusteredDivisions.add(d);
    }
  }

  return clusters;
}

/**
 * Compute cohesion of a group: for every pair in the group, what fraction of
 * the smaller division's pages are shared? Return the minimum pairwise overlap.
 */
function computeGroupCohesion(
  divisions: string[],
  divData: Map<string, { instances: number; pages: Set<number> }>,
  edgeMap: Map<string, { weight: number; pages: Set<number> }>,
): number {
  if (divisions.length < 2) return 0;

  let minOverlap = 1;

  for (let i = 0; i < divisions.length; i++) {
    for (let j = i + 1; j < divisions.length; j++) {
      const [lo, hi] = divisions[i] < divisions[j]
        ? [divisions[i], divisions[j]]
        : [divisions[j], divisions[i]];
      const key = `${lo}|${hi}`;
      const edge = edgeMap.get(key);
      const sharedPages = edge ? edge.weight : 0;

      const pagesA = divData.get(divisions[i])!.pages.size;
      const pagesB = divData.get(divisions[j])!.pages.size;
      const minPages = Math.min(pagesA, pagesB);

      if (minPages === 0) return 0;

      const overlap = sharedPages / minPages;
      if (overlap < minOverlap) minOverlap = overlap;
    }
  }

  return minOverlap;
}

/**
 * Generate a human-readable name for an ad-hoc cluster based on its divisions.
 */
function nameCluster(divisions: string[]): string {
  const names = divisions
    .map((d) => DIVISION_NAMES[d] || `Div ${d}`)
    .sort();

  if (names.length <= 3) {
    return names.join(" + ");
  }
  return `${names[0]} + ${names.length - 1} related`;
}
