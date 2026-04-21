"use client";

import { useMemo, useState } from "react";
import { useNavigation, usePageData, usePanels, useProject, useDetection } from "@/stores/viewerStore";
import type { CsiCode } from "@/types";
import HelpTooltip from "./HelpTooltip";

/** Group CSI codes by division (first 2 digits). */
function groupByDivision(codes: CsiCode[]): Map<string, CsiCode[]> {
  const map = new Map<string, CsiCode[]>();
  for (const c of codes) {
    const div = c.code.substring(0, 2).replace(/\s/g, "").padStart(2, "0");
    if (!map.has(div)) map.set(div, []);
    map.get(div)!.push(c);
  }
  return new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

const DIVISION_NAMES: Record<string, string> = {
  "00": "Procurement", "01": "General Requirements", "02": "Existing Conditions",
  "03": "Concrete", "04": "Masonry", "05": "Metals",
  "06": "Wood/Plastics/Composites", "07": "Thermal & Moisture",
  "08": "Openings", "09": "Finishes", "10": "Specialties",
  "11": "Equipment", "12": "Furnishings", "13": "Special Construction",
  "14": "Conveying Equipment", "21": "Fire Suppression", "22": "Plumbing",
  "23": "HVAC", "25": "Integrated Automation", "26": "Electrical",
  "27": "Communications", "28": "Electronic Safety", "31": "Earthwork",
  "32": "Exterior Improvements", "33": "Utilities",
};

/**
 * `embedded`: when true the outer panel chrome (fixed width, border, shadow,
 * own header+close-button) is skipped so the body can be hosted inside a
 * parent orchestrator (e.g. ToolsPanel).
 */
export default function CsiPanel({ embedded = false }: { embedded?: boolean } = {}) {
  const { pageNumber } = useNavigation();
  const { csiCodes, allCsiCodes, activeCsiFilter, setCsiFilter } = usePageData();
  const { toggleCsiPanel } = usePanels();
  const { publicId, projectIntelligenceData } = useProject();
  const { setSearch } = useDetection();

  const [searchQuery, setSearchQuery] = useState("");
  const [expandedDivisions, setExpandedDivisions] = useState<Record<string, boolean>>({});
  const [allExpanded, setAllExpanded] = useState(false);
  const [scope, setScope] = useState<"page" | "project">("page");
  const [showGraph, setShowGraph] = useState(true);

  const csiGraph = projectIntelligenceData?.csiGraph as any;

  // Get codes for current scope
  const currentCodes: CsiCode[] = useMemo(() => {
    if (scope === "page") {
      return (csiCodes[pageNumber] || []) as CsiCode[];
    }
    // Project scope: allCsiCodes is { code, description }[], convert to CsiCode-like
    return allCsiCodes.map(c => ({
      code: c.code,
      description: c.description,
      trade: DIVISION_NAMES[c.code.substring(0, 2).replace(/\s/g, "")] || "Unknown",
      division: `${c.code.substring(0, 2)} 00 00`,
    }));
  }, [scope, csiCodes, pageNumber, allCsiCodes]);

  // Filter by search
  const filtered = useMemo(() => {
    if (!searchQuery) return currentCodes;
    const q = searchQuery.toLowerCase();
    return currentCodes.filter(c =>
      c.code.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)
    );
  }, [currentCodes, searchQuery]);

  // Group by division
  const grouped = useMemo(() => groupByDivision(filtered), [filtered]);

  // Autocomplete suggestions
  const suggestions = useMemo(() => {
    if (searchQuery.length < 2) return [];
    const q = searchQuery.toLowerCase();
    return currentCodes
      .filter(c => c.code.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))
      .slice(0, 8);
  }, [currentCodes, searchQuery]);

  function handleCodeClick(code: string) {
    if (activeCsiFilter === code) {
      setCsiFilter(null);
      setSearch("");
    } else {
      setCsiFilter(code);
      // Search for the description text so it highlights on the page
      const match = currentCodes.find(c => c.code === code);
      const searchText = match?.description || code;
      setSearch(searchText);
    }
  }

  function toggleDivision(div: string) {
    setExpandedDivisions(prev => ({ ...prev, [div]: !prev[div] }));
  }

  function toggleAllDivisions() {
    const target = !allExpanded;
    const updated: Record<string, boolean> = {};
    for (const div of grouped.keys()) {
      updated[div] = target;
    }
    setExpandedDivisions(updated);
    setAllExpanded(target);
  }

  return (
    <div className={embedded ? "flex flex-col h-full" : "w-72 flex flex-col h-full border border-[var(--border)] bg-[var(--surface)] shadow-lg"}>
      {/* Header — hidden in embedded mode; parent orchestrator provides it. */}
      {!embedded && (
        <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)]">
          <h3 className="text-sm font-semibold text-[var(--fg)]">CSI Codes</h3>
          <button onClick={toggleCsiPanel} className="text-[var(--muted)] hover:text-[var(--fg)] text-lg leading-none">×</button>
        </div>
      )}

      {/* Scope toggle */}
      <div className="flex px-3 py-2 gap-1 border-b border-[var(--border)]">
        <button
          onClick={() => setScope("page")}
          className={`px-2 py-1 text-[10px] rounded ${scope === "page" ? "bg-[var(--accent)]/20 text-[var(--accent)] border border-[var(--accent)]/30" : "text-[var(--muted)] hover:text-[var(--fg)]"}`}
        >
          Page {pageNumber}
        </button>
        <button
          onClick={() => setScope("project")}
          className={`px-2 py-1 text-[10px] rounded ${scope === "project" ? "bg-[var(--accent)]/20 text-[var(--accent)] border border-[var(--accent)]/30" : "text-[var(--muted)] hover:text-[var(--fg)]"}`}
        >
          Project
        </button>
        <span className="ml-auto text-[10px] text-[var(--muted)]">{filtered.length} codes</span>
      </div>

      {/* Network Graph Summary (visible in both page and project scope) */}
      {csiGraph?.nodes?.length > 0 && (
        <div className="border-b border-[var(--border)]">
          <button
            onClick={() => setShowGraph(!showGraph)}
            className="w-full flex items-center justify-between px-3 py-1.5 text-left hover:bg-[var(--surface-hover)]"
          >
            <span className="text-[10px] font-medium text-cyan-400">Network Graph</span>
            <span className="text-[10px] text-[var(--muted)]">{showGraph ? "▼" : "▶"}</span>
          </button>
          {showGraph && (
            <div className="px-3 pb-2 space-y-1.5">
              <div className="text-[10px] text-[var(--muted)]">
                {csiGraph.nodes.length} divisions, {csiGraph.edges?.length || 0} connections
              </div>
              {/* Clusters */}
              {csiGraph.clusters?.length > 0 && (
                <div className="space-y-0.5">
                  {csiGraph.clusters.map((c: any, i: number) => (
                    <div key={i} className="text-[10px]">
                      <span className="text-cyan-300 font-medium">{c.name}</span>
                      <span className="text-[var(--muted)]"> [{c.divisions.join(", ")}] {Math.round(c.cohesion * 100)}%</span>
                    </div>
                  ))}
                </div>
              )}
              {/* Top edges */}
              {csiGraph.edges?.length > 0 && (
                <div className="space-y-0.5">
                  <div className="text-[9px] text-[var(--muted)] font-medium">Strongest connections:</div>
                  {[...csiGraph.edges].sort((a: any, b: any) => b.weight - a.weight).slice(0, 3).map((e: any, i: number) => (
                    <div key={i} className="text-[10px] text-[var(--fg)]">
                      {e.source} ↔ {e.target} <span className="text-[var(--muted)]">({e.pages?.length ?? e.weight} pages)</span>
                    </div>
                  ))}
                </div>
              )}
              {/* Fingerprint */}
              {csiGraph.fingerprint && (
                <div className="text-[9px] text-[var(--muted)] font-mono truncate" title={csiGraph.fingerprint}>
                  FP: {csiGraph.fingerprint}
                </div>
              )}
              {/* Open full graph link */}
              <HelpTooltip id="csi-network-graph">
                <button
                  onClick={() => window.open(`/project/${publicId}/csi-graph`, "_blank")}
                  className="text-[12px] text-sky-300 hover:text-sky-200 font-medium underline"
                >
                  Open Full Graph →
                </button>
              </HelpTooltip>
            </div>
          )}
        </div>
      )}

      {/* Search */}
      <div className="px-3 py-2 border-b border-[var(--border)]">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search CSI codes..."
          className="w-full px-2 py-1 text-xs bg-[var(--surface)] border border-[var(--border)] rounded text-[var(--fg)] outline-none focus:border-[var(--accent)]"
        />
      </div>

      {/* Expand/Collapse All */}
      {filtered.length > 0 && (
        <div className="px-3 py-1 border-b border-[var(--border)] flex justify-end">
          <button
            onClick={toggleAllDivisions}
            className="text-[10px] text-[var(--muted)] hover:text-[var(--fg)]"
          >
            {allExpanded ? "Collapse All" : "Expand All"}
          </button>
        </div>
      )}

      {/* Active filter indicator */}
      {activeCsiFilter && (
        <div className="px-3 py-1.5 bg-[var(--accent)]/10 border-b border-[var(--accent)]/20 flex items-center gap-2">
          <span className="text-[10px] text-[var(--accent)] flex-1 truncate">
            Filtering: {activeCsiFilter}
          </span>
          <button onClick={() => setCsiFilter(null)} className="text-[10px] text-[var(--accent)] hover:text-[var(--fg)]">✕</button>
        </div>
      )}

      {/* Code list grouped by division */}
      <div className="flex-1 overflow-y-auto px-2 py-1">
        {currentCodes.length === 0 ? (
          <p className="text-xs text-[var(--muted)] text-center py-8">
            {scope === "page" ? "No CSI codes detected on this page" : "No CSI codes in this project"}
          </p>
        ) : filtered.length === 0 ? (
          <p className="text-xs text-[var(--muted)] text-center py-8">No codes match "{searchQuery}"</p>
        ) : (
          [...grouped.entries()].map(([div, codes]) => {
            const expanded = expandedDivisions[div] ?? false;
            const divName = DIVISION_NAMES[div] || `Division ${div}`;
            return (
              <div key={div} className="mb-1">
                {/* Division header */}
                <button
                  onClick={() => toggleDivision(div)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-[var(--surface-hover)] text-left"
                >
                  <span className="text-[10px] text-[var(--muted)] w-3">{expanded ? "▼" : "▶"}</span>
                  <span className="text-xs font-medium text-[var(--fg)] flex-1">{divName}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--surface)] text-[var(--muted)]">{codes.length}</span>
                </button>

                {/* Codes within division */}
                {expanded && (
                  <div className="ml-5 space-y-0.5">
                    {codes.map((c) => (
                      <button
                        key={c.code}
                        onClick={() => handleCodeClick(c.code)}
                        className={`w-full text-left px-2 py-1 rounded text-[11px] transition-colors ${
                          activeCsiFilter === c.code
                            ? "bg-[var(--accent)]/15 text-[var(--accent)] border-l-2 border-[var(--accent)]"
                            : "text-[var(--fg)] hover:bg-[var(--surface-hover)]"
                        }`}
                      >
                        <span className="text-[var(--muted)] font-mono">{c.code}</span>
                        <span className="ml-1.5">{c.description}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
