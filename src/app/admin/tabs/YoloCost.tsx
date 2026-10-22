"use client";

// [2026-10-21 owner ask] Cost estimates ADJACENT to Run all / Run on selected (YoloBulkBar) and each
// per-project Run (AiModelsTab): "≈ $X · N pages · J jobs" on the CURRENT inference instance at its
// live (or approximate) $/h, timed from past runs of the model (src/lib/yolo-cost.ts). Root only —
// the data comes from the root-only options endpoint (./yolo-options-store); without it these
// render nothing.

import { formatUsd, yoloEstimateFor, yoloEstimateText } from "@/lib/yolo-cost";
import { readYoloOptions, useYoloOptions } from "./yolo-options-store";

/** Plain-text estimate for the Run confirmation (no hook; null when unavailable). */
export function yoloConfirmEstimate(modelId: number, pages: readonly (number | null)[]): string | null {
  const e = yoloEstimateFor(readYoloOptions(), modelId, pages);
  return e && e.estimate.jobs > 0 ? `Estimated cost: ${yoloEstimateText(e)}` : null;
}

/** Tiny "≈$0.12" next to a per-project Run button; the full breakdown is its tooltip. */
export function YoloRunCost({ modelId, pages }: { modelId: number; pages: number | null }) {
  const { data } = useYoloOptions();
  const e = yoloEstimateFor(data, modelId, [pages]);
  if (!e || e.estimate.jobs === 0) return null;
  return (
    <span className="text-[10px] text-[var(--muted)]" title={yoloEstimateText(e)} data-testid="yolo-run-cost">
      ≈{formatUsd(e.estimate.usd)}
      {e.estimate.overTimeout > 0 ? " ⚠ timeout" : ""}
    </span>
  );
}

/** "Selected: ≈ $X · N pages · J jobs · <instance @ $/h> · <basis> · timeout" for the bulk bar. */
export function YoloBulkCost({ label, modelId, pages }: { label: string; modelId: number; pages: readonly (number | null)[] }) {
  const { data } = useYoloOptions();
  const e = yoloEstimateFor(data, modelId, pages);
  if (!e || pages.length === 0) return null;
  return (
    <div className="text-[var(--muted)]" data-testid="yolo-bulk-cost">
      <span className="text-[var(--fg)]">{label}:</span> {yoloEstimateText(e)}
    </div>
  );
}
