"use client";

import { useState } from "react";

interface ConfidenceSliderDemoProps {
  modelName?: string;
  initial?: number;
}

/** Mirrors the per-model confidence slider in the viewer's YOLO dropdown
 *  (ViewerToolbar.tsx ~500-520). Purple accent matches the real slider. */
export function ConfidenceSliderDemo({
  modelName = "yolo_medium",
  initial = 0.25,
}: ConfidenceSliderDemoProps) {
  const [threshold, setThreshold] = useState(initial);

  return (
    <div className="inline-flex flex-col gap-2 px-3 py-2 border border-[var(--border)] rounded bg-[var(--surface)]/40">
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          defaultChecked
          className="accent-purple-400"
          readOnly
        />
        <span className="text-xs font-medium text-purple-300">{modelName}</span>
      </label>
      <div className="flex items-center gap-2 ml-5">
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={threshold}
          onChange={(e) => setThreshold(parseFloat(e.target.value))}
          className="w-32 h-1 accent-purple-400"
        />
        <span className="text-[10px] text-[var(--muted)] w-10 tabular-nums">
          {Math.round(threshold * 100)}%
        </span>
      </div>
    </div>
  );
}
