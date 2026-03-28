"use client";

interface ClassGroupHeaderProps {
  className: string;
  count: number;
  isExpanded: boolean;
  onToggleExpand: () => void;
  isVisible: boolean;
  onToggleVisibility: () => void;
  isActive: boolean;
  onToggleFilter: (name: string) => void;
  color?: string;
  csiCodes?: string[];
  keywords?: string[];
}

export default function ClassGroupHeader({
  className: cls, count, isExpanded, onToggleExpand,
  isVisible, onToggleVisibility, isActive, onToggleFilter,
  color = "#a855f7", csiCodes = [], keywords = [],
}: ClassGroupHeaderProps) {
  const hasTags = csiCodes.length > 0 || keywords.length > 0;
  return (
    <div className={isActive ? "bg-[var(--accent)]/10" : ""}>
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button onClick={onToggleExpand} className="text-[10px] text-[var(--muted)] hover:text-[var(--fg)] shrink-0 w-3 text-center">
          {isExpanded ? "\u25BC" : "\u25B6"}
        </button>
        <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
        <button
          onClick={() => onToggleFilter(cls)}
          className={`text-xs font-medium truncate flex-1 text-left ${isActive ? "text-[var(--accent)]" : "text-[var(--fg)]"}`}
          title={cls}
        >
          {cls}
        </button>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--surface)] text-[var(--muted)] shrink-0">{count}</span>
        <button
          onClick={(e) => { e.stopPropagation(); onToggleVisibility(); }}
          className={`text-sm shrink-0 ${isVisible ? "text-[var(--fg)]" : "text-[var(--muted)] opacity-40"}`}
          title={isVisible ? "Hide class" : "Show class"}
        >
          {isVisible ? "\u{1F441}" : "\u{1F441}\u200D\u{1F5E8}"}
        </button>
      </div>
      {hasTags && (
        <div className="flex flex-wrap gap-1 px-7 pb-1.5">
          {csiCodes.map((code) => (
            <span key={code} className="text-[9px] px-1 py-0.5 rounded bg-blue-500/10 text-blue-400/70 border border-blue-500/15">{code}</span>
          ))}
          {keywords.map((kw) => (
            <span key={kw} className="text-[9px] px-1 py-0.5 rounded bg-emerald-500/10 text-emerald-400/70 border border-emerald-500/15">{kw}</span>
          ))}
        </div>
      )}
    </div>
  );
}
