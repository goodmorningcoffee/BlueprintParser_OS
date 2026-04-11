"use client";

import { useState } from "react";

/** AREA_UNITS from src/components/viewer/AreaTab.tsx — the four units the
 *  calibration input accepts. Not SF/SM/LF/M — those are display formats,
 *  not the underlying unit tags. */
const AREA_UNITS = ["ft", "in", "m", "cm"] as const;

export function AreaUnitChipDemo() {
  const [active, setActive] = useState<(typeof AREA_UNITS)[number]>("ft");

  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-[var(--muted)] font-mono">unit</span>
      <div className="flex border border-[var(--border)] rounded">
        {AREA_UNITS.map((u, i) => (
          <button
            key={u}
            onClick={() => setActive(u)}
            className={`px-3 py-1 text-xs ${i === 0 ? "rounded-l" : ""} ${i === AREA_UNITS.length - 1 ? "rounded-r" : ""} ${
              active === u
                ? "bg-[var(--accent)] text-white"
                : "text-[var(--muted)] hover:text-[var(--fg)]"
            }`}
          >
            {u}
          </button>
        ))}
      </div>
      <span className="text-[11px] text-[var(--muted)] font-mono">
        = &quot;{active}&quot;
      </span>
    </div>
  );
}
