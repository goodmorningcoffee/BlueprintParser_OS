"use client";

import { useState } from "react";

/** Materials from AutoQtoTab.tsx:14-20. Icon letters + labels + scheduleCategory
 *  are verbatim so the docs stay in sync with the wizard. */
const MATERIALS = [
  { type: "doors", label: "Doors", scheduleCategory: "door-schedule", icon: "D" },
  { type: "finishes", label: "Finishes", scheduleCategory: "finish-schedule", icon: "F" },
  { type: "equipment", label: "Equipment", scheduleCategory: "material-schedule", icon: "E" },
  { type: "plumbing", label: "Plumbing", scheduleCategory: "plumbing-schedule", icon: "P" },
  { type: "electrical", label: "Electrical", scheduleCategory: "electrical-schedule", icon: "Z" },
] as const;

export function MaterialPickerDemo() {
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        {MATERIALS.map((m) => (
          <button
            key={m.type}
            onClick={() => setSelected(m.type)}
            className={`flex flex-col items-center gap-1.5 px-3 py-3 border rounded transition-colors ${
              selected === m.type
                ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--fg)]"
                : "border-[var(--border)] text-[var(--muted)] hover:border-[var(--accent)]/50 hover:text-[var(--fg)]"
            }`}
          >
            <div
              className="w-9 h-9 rounded-full border flex items-center justify-center font-mono font-bold text-sm"
              style={{
                borderColor: selected === m.type ? "var(--accent)" : "var(--border)",
                color: selected === m.type ? "var(--accent)" : "var(--muted)",
              }}
            >
              {m.icon}
            </div>
            <span className="text-[11px] font-medium">{m.label}</span>
            <span className="text-[9px] text-[var(--muted)] font-mono">{m.scheduleCategory}</span>
          </button>
        ))}
      </div>
      {selected && (
        <div className="text-[11px] font-mono text-[var(--muted)]">
          materialType = &quot;{selected}&quot;
        </div>
      )}
    </div>
  );
}
