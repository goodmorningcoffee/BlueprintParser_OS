"use client";

interface MapTagsSectionProps {
  grid: { headers: string[]; rows: Record<string, string>[]; tagColumn?: string };
  yoloInTableRegion: { model: string; className: string; count: number }[];
  tagYoloClass: { model: string; className: string } | null;
  onTagYoloClassChange: (cls: { model: string; className: string } | null) => void;
  onMapTags: () => void;
  tagMappingDone: boolean;
  tagMappingCount: number;
  showUniqueCount?: boolean;
}

/** Shared Map Tags UI for Auto Parse and Manual Parse tabs. */
export default function MapTagsSection({
  grid,
  yoloInTableRegion,
  tagYoloClass,
  onTagYoloClassChange,
  onMapTags,
  tagMappingDone,
  tagMappingCount,
  showUniqueCount,
}: MapTagsSectionProps) {
  if (!grid.tagColumn) return null;

  return (
    <div className="border border-cyan-500/30 rounded px-2 py-2 space-y-1.5 bg-cyan-500/5">
      <div className="text-[10px] text-cyan-400 font-medium">Map Tags to Drawings</div>
      <p className="text-[9px] text-[var(--muted)]">
        Tag column: <span className="font-mono text-[var(--fg)]">{grid.tagColumn}</span>
        {showUniqueCount && (
          <> ({new Set(grid.rows.map((r) => r[grid.tagColumn!]?.trim()).filter(Boolean)).size} unique tags)</>
        )}
      </p>
      {/* YOLO class picker */}
      {yoloInTableRegion.length > 0 && (
        <div className="space-y-0.5">
          <div className="text-[9px] text-[var(--muted)]">YOLO shapes in table region:</div>
          {yoloInTableRegion.map((g, i) => (
            <button key={i}
              onClick={() => onTagYoloClassChange(tagYoloClass?.model === g.model && tagYoloClass?.className === g.className ? null : { model: g.model, className: g.className })}
              className={`w-full text-left text-[10px] px-2 py-1 rounded border ${
                tagYoloClass?.model === g.model && tagYoloClass?.className === g.className
                  ? "border-cyan-400 bg-cyan-500/10 text-cyan-300"
                  : "border-[var(--border)] text-[var(--muted)] hover:bg-[var(--surface-hover)]"
              }`}>
              <span className="font-medium">{g.className}</span>
              <span className="text-[var(--muted)]"> ({g.model}) &mdash; {g.count} found</span>
            </button>
          ))}
        </div>
      )}
      <button
        onClick={() => onTagYoloClassChange(tagYoloClass?.className === "" ? null : { model: "", className: "" })}
        className={`w-full text-left text-[10px] px-2 py-1 rounded border ${
          tagYoloClass?.className === ""
            ? "border-cyan-400 bg-cyan-500/10 text-cyan-300"
            : "border-[var(--border)] text-[var(--muted)] hover:bg-[var(--surface-hover)]"
        }`}>
        No shape &mdash; free-floating tags
      </button>
      {!tagMappingDone ? (
        <button
          onClick={onMapTags}
          className="w-full text-xs px-3 py-1.5 rounded bg-cyan-600 text-white hover:bg-cyan-500"
        >
          Map Tags
        </button>
      ) : (
        <div className="text-[10px] text-green-400">
          Mapped {tagMappingCount} tags to YOLO Tags panel
        </div>
      )}
    </div>
  );
}
