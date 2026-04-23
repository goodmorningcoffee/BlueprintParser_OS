"use client";

import { useMemo, useState } from "react";
import { useViewerStore } from "@/stores/viewerStore";
import type { SpecSummaryEntry } from "@/types";

interface SpecIndexProps {
  onOpenParser: () => void;
}

/**
 * SpecIndex — Stage 5 project-wide spec regions view.
 * Mirrors NotesIndex. Reads `summaries.specRegions` (populated by
 * computeProjectSummaries from pageIntelligence.textRegions). Row click
 * seeds page + specParseRegion so the Parser tab opens pre-targeted.
 */
export default function SpecIndex({ onOpenParser }: SpecIndexProps) {
  const summaries = useViewerStore((s) => s.summaries);
  const setPage = useViewerStore((s) => s.setPage);
  const setSpecParseRegion = useViewerStore((s) => s.setSpecParseRegion);
  const [filter, setFilter] = useState("");

  const rows = useMemo(() => {
    const raw = summaries?.specRegions ?? [];
    const sorted = [...raw].sort((a, b) => {
      const ad = a.drawingNumber ?? "";
      const bd = b.drawingNumber ?? "";
      if (ad !== bd) return ad.localeCompare(bd);
      return a.pageNum - b.pageNum;
    });
    if (!filter.trim()) return sorted;
    const q = filter.trim().toLowerCase();
    return sorted.filter((r) => {
      const hay = [r.pageName, r.drawingNumber, r.headerText, r.tier1, r.tier2]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [summaries, filter]);

  if (!summaries?.specRegions || summaries.specRegions.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center px-6 py-8 text-center">
        <div>
          <div className="text-[11px] text-[var(--muted)] mb-1">No spec regions detected yet</div>
          <div className="text-[10px] text-[var(--muted)]/70">
            Run admin reprocess (intelligence scope) on this project to populate
            the index, or draw a region in the Parser tab.
          </div>
        </div>
      </div>
    );
  }

  const handleRowClick = (r: SpecSummaryEntry) => {
    setPage(r.pageNum);
    if (r.bbox) {
      const [l, t, w, h] = r.bbox;
      setSpecParseRegion([l, t, l + w, t + h]);
    } else {
      setSpecParseRegion(null);
    }
    onOpenParser();
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-2 py-1.5 border-b border-[var(--border)]">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by drawing / header / tier…"
          className="w-full text-[10px] px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg)] text-[var(--fg)] placeholder:text-[var(--muted)]/60 focus:outline-none focus:border-violet-400"
        />
      </div>
      <div className="flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <div className="px-3 py-6 text-center text-[10px] text-[var(--muted)]">
            No matches for &ldquo;{filter}&rdquo;
          </div>
        ) : (
          <ul className="divide-y divide-[var(--border)]/60">
            {rows.map((r, i) => (
              <li
                key={`${r.pageNum}-${i}`}
                onClick={() => handleRowClick(r)}
                className="px-2 py-1.5 cursor-pointer hover:bg-[var(--surface-2)] transition-colors"
              >
                <div className="flex items-center justify-between gap-2 mb-0.5">
                  <span className="text-[10px] font-semibold text-violet-300 truncate">
                    {r.drawingNumber || `Page ${r.pageNum}`}
                  </span>
                  <span className="text-[9px] text-[var(--muted)]">
                    {typeof r.wordCount === "number" ? `${r.wordCount} words` : "spec"}
                  </span>
                </div>
                {r.headerText && (
                  <div className="text-[10px] text-[var(--fg)] truncate mb-0.5">{r.headerText}</div>
                )}
                <div className="flex flex-wrap gap-1">
                  {r.tier1 && <Chip color="emerald">{r.tier1}</Chip>}
                  {r.tier2 && <Chip color="sky">{r.tier2}</Chip>}
                  {r.csiTags && r.csiTags.length > 0 && (
                    <Chip color="amber">{r.csiTags.length} CSI</Chip>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Chip({
  color,
  children,
}: {
  color: "emerald" | "sky" | "amber";
  children: React.ReactNode;
}) {
  const classes = {
    emerald: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    sky: "bg-sky-500/15 text-sky-300 border-sky-500/30",
    amber: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  }[color];
  return (
    <span className={`inline-block px-1.5 py-[1px] rounded border text-[8.5px] leading-tight ${classes}`}>
      {children}
    </span>
  );
}
