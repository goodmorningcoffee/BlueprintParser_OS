"use client";

export type MapTagsStrictness = "strict" | "balanced" | "lenient";

interface MapTagsSectionProps {
  grid: { headers: string[]; rows: Record<string, string>[]; tagColumn?: string };
  yoloInTableRegion: { model: string; className: string; count: number }[];
  tagYoloClass: { model: string; className: string } | null;
  onTagYoloClassChange: (cls: { model: string; className: string } | null) => void;
  onMapTags: () => void;
  tagMappingDone: boolean;
  tagMappingCount: number;
  showUniqueCount?: boolean;
  /** Phase 2: strictness of the tier filter applied server-side.
   *  Default "balanced" (drops only tier=low). "strict" = tier=high only;
   *  "lenient" = show all matches including tier=low with dropReason. */
  strictness?: MapTagsStrictness;
  onStrictnessChange?: (s: MapTagsStrictness) => void;
  /** Phase 3: drawing-number-prefix scope. When set, Map Tags searches only
   *  pages whose `drawingNumber` begins with one of these prefixes (case
   *  insensitive). Empty array = all pages. An empty-string prefix in the
   *  list matches pages with null drawingNumber ("Unnumbered" bucket). */
  drawingNumberPrefixes?: string[];
  onDrawingNumberPrefixesChange?: (prefixes: string[]) => void;
  /** Available prefix choices derived from the project's pages.
   *  Parent passes a sorted unique list, e.g. ["A", "E-", "M-", "P-"]. */
  availablePrefixes?: string[];
  /** When provided, the Tag column field becomes a <select> listing every
   *  header in `grid.headers`. Picks default to `grid.tagColumn` (auto-
   *  detected at parse time via the regex heuristic in ManualParseTab).
   *  Absent this prop, the field renders read-only (backward compat for
   *  any caller that hasn't opted in). */
  onTagColumnChange?: (col: string) => void;
}

const STRICTNESS_OPTIONS: Array<{
  value: MapTagsStrictness;
  label: string;
  title: string;
}> = [
  { value: "strict", label: "Strict", title: "Only tier=high matches. Matches the behavior of Auto-QTO." },
  { value: "balanced", label: "Balanced", title: "Drop tier=low. Keep high + medium." },
  { value: "lenient", label: "Lenient", title: "Show all matches including low-tier with their drop reason. For audit." },
];

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
  strictness = "balanced",
  onStrictnessChange,
  drawingNumberPrefixes = [],
  onDrawingNumberPrefixesChange,
  availablePrefixes = [],
  onTagColumnChange,
}: MapTagsSectionProps) {
  if (!grid.tagColumn) return null;

  const togglePrefix = (prefix: string) => {
    if (!onDrawingNumberPrefixesChange) return;
    const set = new Set(drawingNumberPrefixes);
    if (set.has(prefix)) set.delete(prefix);
    else set.add(prefix);
    onDrawingNumberPrefixesChange(Array.from(set));
  };

  const allPagesActive = drawingNumberPrefixes.length === 0;

  return (
    <div className="border border-cyan-500/30 rounded px-2 py-2 space-y-1.5 bg-cyan-500/5">
      <div className="text-[10px] text-cyan-400 font-medium">Map Tags to Drawings</div>
      {onTagColumnChange ? (
        <div className="flex items-center gap-1.5 text-[9px] text-[var(--muted)]">
          <span className="shrink-0">Tag column:</span>
          <select
            value={grid.tagColumn}
            onChange={(e) => onTagColumnChange(e.target.value)}
            className="flex-1 text-[10px] font-mono bg-[var(--surface)] border border-[var(--border)] rounded px-1 py-0.5 text-[var(--fg)] focus:outline-none focus:border-cyan-400"
            title="Pick which parsed column holds the tag IDs. Defaults to the regex-heuristic pick; override when the auto-pick is wrong (e.g., description column that happens to match the tag pattern)."
          >
            {grid.headers.map((h) => (
              <option key={h} value={h}>{h}</option>
            ))}
          </select>
          {showUniqueCount && (
            <span className="shrink-0">
              ({new Set(grid.rows.map((r) => r[grid.tagColumn!]?.trim()).filter(Boolean)).size} unique)
            </span>
          )}
        </div>
      ) : (
        <p className="text-[9px] text-[var(--muted)]">
          Tag column: <span className="font-mono text-[var(--fg)]">{grid.tagColumn}</span>
          {showUniqueCount && (
            <> ({new Set(grid.rows.map((r) => r[grid.tagColumn!]?.trim()).filter(Boolean)).size} unique tags)</>
          )}
        </p>
      )}
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

      {/* Drawing-number-prefix scope — restrict Map Tags search to pages
          whose drawingNumber begins with one of the selected prefixes. */}
      {onDrawingNumberPrefixesChange && availablePrefixes.length > 0 && (
        <div className="space-y-0.5">
          <div className="text-[9px] text-[var(--muted)]">Scope:</div>
          <div className="flex flex-wrap gap-0.5">
            <button
              title="Search all pages in the project"
              onClick={() => onDrawingNumberPrefixesChange([])}
              className={`text-[10px] px-1.5 py-1 rounded border transition-colors ${
                allPagesActive
                  ? "border-cyan-400 bg-cyan-500/10 text-cyan-300"
                  : "border-[var(--border)] text-[var(--muted)] hover:bg-[var(--surface-hover)]"
              }`}
            >
              All pages
            </button>
            {availablePrefixes.map((prefix) => {
              const active = drawingNumberPrefixes.includes(prefix);
              const label = prefix === "" ? "Unnumbered" : `${prefix}*`;
              const title = prefix === ""
                ? "Pages without a drawing number"
                : `Pages whose drawingNumber begins with "${prefix}"`;
              return (
                <button
                  key={prefix}
                  title={title}
                  onClick={() => togglePrefix(prefix)}
                  className={`text-[10px] px-1.5 py-1 rounded border transition-colors ${
                    active
                      ? "border-cyan-400 bg-cyan-500/10 text-cyan-300"
                      : "border-[var(--border)] text-[var(--muted)] hover:bg-[var(--surface-hover)]"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Strictness selector — how aggressively the server filters low-confidence matches */}
      {onStrictnessChange && (
        <div className="space-y-0.5">
          <div className="text-[9px] text-[var(--muted)]">Strictness:</div>
          <div className="flex gap-0.5">
            {STRICTNESS_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                title={opt.title}
                onClick={() => onStrictnessChange(opt.value)}
                className={`flex-1 text-[10px] px-1.5 py-1 rounded border transition-colors ${
                  strictness === opt.value
                    ? "border-cyan-400 bg-cyan-500/10 text-cyan-300"
                    : "border-[var(--border)] text-[var(--muted)] hover:bg-[var(--surface-hover)]"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      )}

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
