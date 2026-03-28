"use client";

import { useMemo, useState } from "react";
import { useViewerStore } from "@/stores/viewerStore";
import type { CsiCode } from "@/types";

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

export default function CsiPanel() {
  const csiCodes = useViewerStore((s) => s.csiCodes);
  const pageNumber = useViewerStore((s) => s.pageNumber);
  const allCsiCodes = useViewerStore((s) => s.allCsiCodes);
  const activeCsiFilter = useViewerStore((s) => s.activeCsiFilter);
  const setCsiFilter = useViewerStore((s) => s.setCsiFilter);
  const toggleCsiPanel = useViewerStore((s) => s.toggleCsiPanel);
  const setSearch = useViewerStore((s) => s.setSearch);

  const [searchQuery, setSearchQuery] = useState("");
  const [expandedDivisions, setExpandedDivisions] = useState<Record<string, boolean>>({});
  const [scope, setScope] = useState<"page" | "project">("page");

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
    setCsiFilter(activeCsiFilter === code ? null : code);
    setSearch(code);
  }

  function toggleDivision(div: string) {
    setExpandedDivisions(prev => ({ ...prev, [div]: !prev[div] }));
  }

  return (
    <div className="w-72 flex flex-col h-full border-l border-[var(--border)] bg-[var(--bg)]">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)]">
        <h3 className="text-sm font-semibold text-[var(--fg)]">CSI Codes</h3>
        <button onClick={toggleCsiPanel} className="text-[var(--muted)] hover:text-[var(--fg)] text-lg leading-none">×</button>
      </div>

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
