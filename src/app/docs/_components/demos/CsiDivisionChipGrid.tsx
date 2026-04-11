import { DIVISION_COLORS, DIVISION_NAMES, GROUP_COLORS } from "../constants";
import type { CsiDivisionMeta } from "../constants";

/** Full grid of CSI divisions colored by their discipline cluster.
 *  Uses the same DIVISION_COLORS table the network graph renders with, so
 *  a palette update is a one-file change that propagates everywhere. */
export function CsiDivisionChipGrid() {
  const entries = Object.entries(DIVISION_COLORS).sort(([a], [b]) => a.localeCompare(b));

  // Grouped legend
  const groups: CsiDivisionMeta["group"][] = ["MEP", "Architectural", "Structural", "Site"];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
        {entries.map(([div, meta]) => (
          <div
            key={div}
            className="flex items-center gap-2 px-2 py-1.5 rounded border bg-[var(--surface)]/40"
            style={{ borderColor: `${meta.color}60` }}
          >
            <div
              className="w-5 h-5 rounded-sm flex-shrink-0"
              style={{ backgroundColor: meta.color }}
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-mono font-semibold text-[var(--fg)]">
                Div {div}
              </div>
              <div className="text-[10px] text-[var(--muted)] truncate">
                {DIVISION_NAMES[div] || "—"}
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2 text-[10px]">
        {groups.map((g) => (
          <div key={g} className="flex items-center gap-1.5">
            <span
              className="w-3 h-3 rounded-sm"
              style={{ backgroundColor: GROUP_COLORS[g] }}
              aria-hidden="true"
            />
            <span className="text-[var(--muted)] uppercase tracking-wider">{g}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
