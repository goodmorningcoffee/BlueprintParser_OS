"use client";

import { useState } from "react";

/** The five tabs of the Schedules/Tables panel. Tab IDs and labels verbatim
 *  from TableParsePanel.tsx lines 306-319. */
const TABS = [
  { id: "all", label: "All Tables" },
  { id: "auto", label: "Auto Parse" },
  { id: "guided", label: "Guided" },
  { id: "manual", label: "Manual" },
  { id: "compare", label: "Compare/Edit Cells" },
] as const;

type Tab = (typeof TABS)[number]["id"];

export function TableParseTabsDemo() {
  const [active, setActive] = useState<Tab>("auto");

  return (
    <div className="inline-block">
      <div className="flex gap-1 border-b border-[var(--border)] px-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setActive(t.id)}
            className={`px-3 py-1.5 text-xs -mb-px border-b-2 transition-colors ${
              active === t.id
                ? "border-pink-400 text-pink-300"
                : "border-transparent text-[var(--muted)] hover:text-[var(--fg)]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="text-[11px] font-mono text-[var(--muted)] mt-2 px-1">
        tableParseTab = &quot;{active}&quot;
      </div>
    </div>
  );
}
