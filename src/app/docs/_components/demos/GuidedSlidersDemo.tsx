"use client";

import { useState } from "react";

/** Guided Parse tuning sliders. Defaults from GuidedParseTab.tsx:44. */
export function GuidedSlidersDemo() {
  const [rowTolerance, setRowTolerance] = useState(0.006);
  const [minColGap, setMinColGap] = useState(0.015);
  const [minHitsRatio, setMinHitsRatio] = useState(0.3);

  const sliders = [
    {
      label: "Row tolerance",
      value: rowTolerance,
      setValue: setRowTolerance,
      min: 0.002,
      max: 0.02,
      step: 0.001,
      format: (v: number) => v.toFixed(3),
      hint: "Max vertical drift between two OCR tokens in the same row.",
    },
    {
      label: "Min column gap",
      value: minColGap,
      setValue: setMinColGap,
      min: 0.005,
      max: 0.05,
      step: 0.001,
      format: (v: number) => v.toFixed(3),
      hint: "Minimum horizontal space to treat two columns as distinct.",
    },
    {
      label: "Min hits ratio",
      value: minHitsRatio,
      setValue: setMinHitsRatio,
      min: 0.1,
      max: 1.0,
      step: 0.05,
      format: (v: number) => v.toFixed(2),
      hint: "Fraction of rows a column must appear in to count.",
    },
  ];

  return (
    <div className="space-y-3 max-w-sm">
      {sliders.map((s) => (
        <div key={s.label}>
          <div className="flex items-center justify-between text-[11px] mb-1">
            <span className="text-[var(--fg)]">{s.label}</span>
            <span className="text-[var(--fg)] font-mono tabular-nums">{s.format(s.value)}</span>
          </div>
          <input
            type="range"
            min={s.min}
            max={s.max}
            step={s.step}
            value={s.value}
            onChange={(e) => s.setValue(parseFloat(e.target.value))}
            className="w-full accent-pink-400"
          />
          <div className="text-[10px] text-[var(--muted)] mt-0.5">{s.hint}</div>
        </div>
      ))}
    </div>
  );
}
