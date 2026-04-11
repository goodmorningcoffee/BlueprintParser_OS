import { TWENTY_COLORS } from "../constants";

/** The 20-color palette used for user-drawn markups, takeoff groups, and
 *  anywhere a visual ID needs to stay stable across redraws. Imported
 *  from src/types/index.ts:636 — single source of truth. */
export function ColorSwatchDemo() {
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-10 gap-1.5">
        {TWENTY_COLORS.map((hex, i) => (
          <div key={hex} className="flex flex-col items-center gap-1">
            <div
              className="w-8 h-8 rounded border border-[var(--border)]"
              style={{ backgroundColor: hex }}
              aria-label={`Color ${i + 1}: ${hex}`}
              title={hex}
            />
            <span className="text-[9px] font-mono text-[var(--muted)]">
              {i + 1}
            </span>
          </div>
        ))}
      </div>
      <div className="text-[11px] text-[var(--muted)] font-mono">
        TWENTY_COLORS — {TWENTY_COLORS.length} entries
      </div>
    </div>
  );
}
