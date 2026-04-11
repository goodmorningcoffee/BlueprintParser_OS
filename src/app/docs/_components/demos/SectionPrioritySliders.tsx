import { SECTION_REGISTRY } from "../constants";

/** Visual bar-chart of the 20 LLM context sections sorted by default priority.
 *  Lower priority number = earlier/higher importance in context-builder.ts. */
export function SectionPrioritySliders() {
  const entries = Object.entries(SECTION_REGISTRY)
    .map(([id, meta]) => ({ id, ...meta }))
    .sort((a, b) => a.defaultPriority - b.defaultPriority);

  const maxPriority = Math.max(...entries.map((e) => e.defaultPriority));

  return (
    <div className="space-y-1">
      <div className="text-[11px] text-[var(--muted)] mb-2">
        Bars show default priority from <span className="font-mono text-[var(--accent)]">SECTION_REGISTRY</span>. Shorter bar = higher priority (packs earlier).
      </div>
      {entries.map((e) => {
        const width = (e.defaultPriority / maxPriority) * 100;
        return (
          <div key={e.id} className="flex items-center gap-2 text-[11px]">
            <div className="w-44 truncate text-[var(--fg)] font-mono">{e.id}</div>
            <div className="flex-1 h-4 bg-[var(--bg)] border border-[var(--border)] rounded-sm relative overflow-hidden">
              <div
                className="absolute inset-y-0 left-0 bg-gradient-to-r from-[var(--accent)]/60 to-[var(--accent)]/20"
                style={{ width: `${width}%` }}
              />
              <div className="absolute inset-0 px-2 flex items-center text-[10px] text-[var(--fg)] tabular-nums">
                {e.defaultPriority.toFixed(1)}
              </div>
            </div>
          </div>
        );
      })}
      <div className="text-[10px] text-[var(--muted)] mt-3 leading-relaxed">
        20 sections total. Admins can disable sections, override priority per-company, or pick a preset (<span className="font-mono">balanced</span>, <span className="font-mono">structured</span>, <span className="font-mono">verbose</span>) from Admin → LLM Context.
      </div>
    </div>
  );
}
