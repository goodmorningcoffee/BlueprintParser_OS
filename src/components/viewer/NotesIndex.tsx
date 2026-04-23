"use client";

import { useMemo, useState } from "react";
import { useViewerStore } from "@/stores/viewerStore";
import type { NotesSummaryEntry } from "@/types";

interface NotesIndexProps {
  /** Called after the user clicks a row so the parent NotesPanel can
   *  switch to the Parser tab. The row click itself sets page + region. */
  onOpenParser: () => void;
}

/**
 * NotesIndex — Stage 4 project-wide notes view.
 *
 * Reads `summaries.notesRegions` (populated by `computeProjectSummaries`
 * from pageIntelligence.textRegions) and renders rows sorted by drawing
 * number. Row click:
 *   1. Jumps to the page via setPage
 *   2. Writes the region bbox into notesParseRegion (NotesPanel auto-
 *      switches to Parser tab via its useEffect)
 *   3. Seeds notesType from classifier tier2
 *   4. Calls onOpenParser() so the parent forces the tab switch even
 *      when notesParseRegion was already set on a prior row
 */
export default function NotesIndex({ onOpenParser }: NotesIndexProps) {
  const summaries = useViewerStore((s) => s.summaries);
  const setPage = useViewerStore((s) => s.setPage);
  const setNotesParseRegion = useViewerStore((s) => s.setNotesParseRegion);
  const [filter, setFilter] = useState("");

  const rows = useMemo(() => {
    const raw = summaries?.notesRegions ?? [];
    const sorted = [...raw].sort((a, b) => {
      const ad = a.drawingNumber ?? "";
      const bd = b.drawingNumber ?? "";
      if (ad !== bd) return ad.localeCompare(bd);
      return a.pageNum - b.pageNum;
    });
    if (!filter.trim()) return sorted;
    const q = filter.trim().toLowerCase();
    return sorted.filter((r) => {
      const hay = [
        r.pageName,
        r.drawingNumber,
        r.headerText,
        r.tier1,
        r.tier2,
        r.trade,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [summaries, filter]);

  if (!summaries?.notesRegions || summaries.notesRegions.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center px-6 py-8 text-center">
        <div>
          <div className="text-[11px] text-[var(--muted)] mb-1">No notes detected yet</div>
          <div className="text-[10px] text-[var(--muted)]/70">
            Run admin reprocess (intelligence scope) on this project to populate
            the index, or draw a region in the Parser tab.
          </div>
        </div>
      </div>
    );
  }

  const handleRowClick = (r: NotesSummaryEntry) => {
    setPage(r.pageNum);
    if (r.bbox) {
      // textRegion.bbox is LTWH → convert to MinMax for the viewer store
      const [l, t, w, h] = r.bbox;
      setNotesParseRegion([l, t, l + w, t + h]);
    } else {
      setNotesParseRegion(null);
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
          className="w-full text-[10px] px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg)] text-[var(--fg)] placeholder:text-[var(--muted)]/60 focus:outline-none focus:border-blue-400"
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
                  <span className="text-[10px] font-semibold text-blue-300 truncate">
                    {r.drawingNumber || `Page ${r.pageNum}`}
                  </span>
                  <span className="text-[9px] text-[var(--muted)]">
                    {typeof r.rowCount === "number" ? `${r.rowCount} rows` : r.type}
                  </span>
                </div>
                {r.headerText && (
                  <div className="text-[10px] text-[var(--fg)] truncate mb-0.5">
                    {r.headerText}
                  </div>
                )}
                <div className="flex flex-wrap gap-1">
                  {r.tier1 && <TierChip color="emerald">{r.tier1}</TierChip>}
                  {r.tier2 && <TierChip color="sky">{r.tier2}</TierChip>}
                  {r.trade && <TierChip color="violet">{r.trade}</TierChip>}
                  {r.csiTags && r.csiTags.length > 0 && (
                    <TierChip color="amber">
                      {r.csiTags.length} CSI
                    </TierChip>
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

function TierChip({
  color,
  children,
}: {
  color: "emerald" | "sky" | "violet" | "amber";
  children: React.ReactNode;
}) {
  const classes = {
    emerald: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    sky: "bg-sky-500/15 text-sky-300 border-sky-500/30",
    violet: "bg-violet-500/15 text-violet-300 border-violet-500/30",
    amber: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  }[color];
  return (
    <span
      className={`inline-block px-1.5 py-[1px] rounded border text-[8.5px] leading-tight ${classes}`}
    >
      {children}
    </span>
  );
}

