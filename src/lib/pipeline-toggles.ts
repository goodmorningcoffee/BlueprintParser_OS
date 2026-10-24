/**
 * pipeline-toggles.ts — the ONE reader (and the PUT-side normalizer) of the Pipeline tab's step
 * toggles (`disabledSteps`) and ensemble override (`ensemble.config`).
 *
 * [fix 2026-10-24 T1a] The admin Pipeline tab PUTs `{pipeline: {disabledSteps, ensemble, …}}`, so
 * every toggle was stored at `pipelineConfig.pipeline.disabledSteps` while all three readers
 * (lib/processing.ts, services/reprocess.ts, services/yolo.ts) read the TOP-LEVEL
 * `pipelineConfig.disabledSteps` that schema.ts declares — no toggle and no ensemble override ever
 * took effect. Now:
 *   • writer: `hoistPipelineToggles` moves both keys to the top level on PUT (company-settings.ts);
 *   • readers: `resolvePipelineToggles` reads the top level and FALLS BACK to the legacy nested
 *     copy, so a company that saved before the fix keeps its settings until its next save;
 *   • GET: `foldPipelineToggles` puts the effective values back into the `pipeline` slice, so the
 *     tab (which only knows `pipeline.*`) shows and re-sends what is actually in force.
 * Precedence: the top level wins whenever it is present — it is what every save since the fix writes.
 */

import type { EnsembleConfig } from "@/lib/ensemble/region-ensemble";

/** The two Pipeline-tab keys whose readers live at the top level of `pipelineConfig`. */
export const HOISTED_PIPELINE_KEYS = ["disabledSteps", "ensemble"] as const;

/** Structural slice of `companies.pipelineConfig` this module reads (any extra keys are ignored). */
export interface PipelineToggleSource {
  disabledSteps?: unknown;
  ensemble?: unknown;
  pipeline?: unknown;
}

export interface PipelineToggles {
  disabledSteps: Set<string>;
  /** Partial override handed to `reduceRegionVotes`; undefined = built-in defaults. */
  ensembleConfig: Partial<EnsembleConfig> | undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Top-level value when present, else the legacy `pipeline.<key>` copy. */
function effective(source: PipelineToggleSource, key: (typeof HOISTED_PIPELINE_KEYS)[number]): unknown {
  if (source[key] !== undefined) return source[key];
  return asRecord(source.pipeline)?.[key];
}

export function resolvePipelineToggles(
  pipelineConfig: PipelineToggleSource | null | undefined,
): PipelineToggles {
  const source = pipelineConfig ?? {};
  const rawSteps = effective(source, "disabledSteps");
  const disabledSteps = new Set<string>(
    Array.isArray(rawSteps) ? rawSteps.filter((s): s is string => typeof s === "string") : [],
  );
  const config = asRecord(asRecord(effective(source, "ensemble"))?.config);
  return {
    disabledSteps,
    ensembleConfig: config as Partial<EnsembleConfig> | undefined,
  };
}

/**
 * PUT side: split the tab's `pipeline` body into the slice stored under `pipeline` and the
 * top-level keys. A key absent from the body is absent from `topLevel` (the stored top-level
 * value is left alone); a present key moves — it is never stored in both places.
 */
export function hoistPipelineToggles(pipeline: Record<string, unknown>): {
  pipeline: Record<string, unknown>;
  topLevel: Partial<Record<(typeof HOISTED_PIPELINE_KEYS)[number], unknown>>;
} {
  const rest: Record<string, unknown> = { ...pipeline };
  const topLevel: Partial<Record<(typeof HOISTED_PIPELINE_KEYS)[number], unknown>> = {};
  for (const key of HOISTED_PIPELINE_KEYS) {
    if (key in rest) {
      topLevel[key] = rest[key];
      delete rest[key];
    }
  }
  return { pipeline: rest, topLevel };
}

/** GET side: the stored `pipeline` slice with the effective toggles folded back in. */
export function foldPipelineToggles(
  pipelineConfig: PipelineToggleSource | null | undefined,
): Record<string, unknown> {
  const source = pipelineConfig ?? {};
  const view: Record<string, unknown> = { ...(asRecord(source.pipeline) ?? {}) };
  for (const key of HOISTED_PIPELINE_KEYS) {
    const value = effective(source, key);
    if (value !== undefined) view[key] = value;
  }
  return view;
}
