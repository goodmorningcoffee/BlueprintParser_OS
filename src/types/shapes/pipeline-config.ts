// [refactor jul23 P4.1 U11] pipelineConfig subtree shape registry (`.loose()`, log-mode).
//
// The `companies.pipelineConfig` jsonb column (schema.ts:58-154) is a bag of
// top-level subtrees, each owned by a different admin writer (census in U11 recon
// §1). U0's registry describes `annotations.data` blobs (annotation-data.ts); this
// file does the same for the pipelineConfig subtrees so the `updatePipelineConfig`
// sink (company-config.ts) can validate-and-LOG what it persists.
//
// Verdict 1 (`.loose()` everywhere): the admin-config freeze pins that unknown
// top-level siblings AND unknown csi/heuristics subkeys round-trip UNCHANGED through
// a write (admin-config.route.test.ts:155,419 `__sentinel`). A strict schema here
// would false-positive on every legacy row carrying an extra key — "the one
// unforgivable class" if it ever became a reject.
// Verdict 2 (log-mode ONLY in P4.1): these are STORED-shape descriptors read at the
// sink, NEVER 400 gates. No pipelineConfig writer carries a version tag `v`, so
// there is no v-gate leg at all — pure canary. The shell-level `zCsiConfigPut` 400
// (csi/config route) and the imperative in-service 400s (company-settings.ts) stay
// verbatim; the siblings do NOT move to the shell.
//
// Field optionality is decided from what the READ side must TOLERATE (legacy rows +
// what writers actually emit), not the schema.ts `$type` ideal (RD-I). Deviations
// from the recon table are flagged inline (`z.record` cannot be `.loose()`; demo
// values are not always boolean; heuristics rules are often written as bare
// `{id,name}`).
import { z } from "zod";
// Deliberate cross-layer import: the STORED csi shape IS the PUT-body shape plus the
// server-owned pointer triple, so it must derive from `zCsiConfigPut` (schemas.ts)
// to stay in lock-step — re-declaring the 10 fields here would be a third drift
// surface (schema.ts $type + zCsiConfigPut + this). No import cycle: schemas.ts
// pulls only zod + @/lib/annotation-split-contract (type-only @/types), never
// @/types/shapes.
import { zCsiConfigPut } from "@/server/api/schemas";

/**
 * `demo` — `Record<string,boolean>` (schema.ts:113). NOTE (recon deviation):
 * `z.record(...)` is a ZodRecord, which has NO `.loose()` (that modifier is
 * ZodObject-only) — and a record already accepts ALL string keys, so there is no
 * unknown-key concept to loosen. putDemoConfig only gates `typeof demo === "object"`
 * (company-settings.ts:87), so a stored non-boolean value (e.g. the test seed's
 * `{maxProjects: 2}`) is DRIFT we LOG, never reject.
 */
export const zDemoConfig = z.record(z.string(), z.boolean());
export type DemoConfig = z.infer<typeof zDemoConfig>;

/** `pipeline` — opaque `Record<string,unknown>` bag (schema.ts:109). Any object
 *  parses; unknown keys preserved (`.loose()`). */
export const zPipelineSubtree = z.object({}).loose();
export type PipelineSubtree = z.infer<typeof zPipelineSubtree>;

/** `llm` — `{systemPrompt?, sectionConfig?, toolUse?, domainKnowledge?}`
 *  (schema.ts:103-108). Written whole-replace by putLlmConfig + merged by
 *  updateLlmSettings (llm.systemPrompt). `.loose()`. */
export const zLlmConfig = z
  .object({
    systemPrompt: z.string().optional(),
    sectionConfig: z.record(z.string(), z.unknown()).optional(),
    toolUse: z.boolean().optional(),
    domainKnowledge: z.string().optional(),
  })
  .loose();
export type LlmConfig = z.infer<typeof zLlmConfig>;

/**
 * `csi` (STORED shape) — the `zCsiConfigPut` PUT-body fields PLUS the server-owned
 * custom-DB pointer triple (upload/revert own it; putCsiConfig re-attaches it).
 * DISTINCT from `zCsiConfigPut`, which STRIPS the triple at the shell (schemas.ts:72).
 * Derived via `.extend()` so the config fields stay in lock-step with the PUT schema.
 */
export const zCsiConfigStored = zCsiConfigPut
  .extend({
    customDatabaseS3Key: z.string().optional(),
    customDatabaseName: z.string().optional(),
    customDatabaseCodes: z.number().optional(),
  })
  .loose();
export type CsiConfigStored = z.infer<typeof zCsiConfigStored>;

/** `textAnnotation` — `{enabledDetectors?: string[]}` (schema.ts:59-61).
 *  putTextAnnotationConfig REBUILDS to exactly `{enabledDetectors}`, but a legacy row
 *  may carry sibling subkeys, so `.loose()` (read-side tolerance). */
export const zTextAnnotationConfig = z
  .object({ enabledDetectors: z.array(z.string()).optional() })
  .loose();
export type TextAnnotationConfig = z.infer<typeof zTextAnnotationConfig>;

/**
 * `heuristics` — `Array<rule>` (schema.ts:75-102, a ~24-field rule). NOTE (recon /
 * schema.ts deviation): real writes (and the test seed) store bare `{id,name}` rules
 * — putHeuristicsConfig persists whatever array the client sends (company-settings.ts
 * :282). So `source`/`enabled` (REQUIRED in the schema.ts $type) are OPTIONAL here
 * for read-tolerance; only the always-present `id`/`name` identity is pinned. Each
 * rule `.loose()` (mergeable/legacy rules carry the other ~20 fields).
 */
export const zHeuristicRule = z
  .object({
    id: z.string(),
    name: z.string(),
    source: z.enum(["built-in", "custom"]).optional(),
    enabled: z.boolean().optional(),
  })
  .loose();
export const zHeuristicsConfig = z.array(zHeuristicRule);
export type HeuristicRule = z.infer<typeof zHeuristicRule>;
export type HeuristicsConfig = z.infer<typeof zHeuristicsConfig>;

/** `pageNaming` — `{enabled?, yoloSources?:[{modelId,modelName,classes}]}`
 *  (schema.ts:114-121). `.loose()` at both the outer object and each yoloSource. */
export const zPageNaming = z
  .object({
    enabled: z.boolean().optional(),
    yoloSources: z
      .array(
        z
          .object({
            modelId: z.number(),
            modelName: z.string(),
            classes: z.array(z.string()),
          })
          .loose(),
      )
      .optional(),
  })
  .loose();
export type PageNaming = z.infer<typeof zPageNaming>;

/**
 * Per-subtree schema map keyed by the top-level `pipelineConfig` key (RD-J idiom, cf.
 * SHAPE_SCHEMAS in annotation-data.ts). The log-mode sink (company-config.ts
 * observePipelineConfig) iterates this: for each key PRESENT in the persisted config,
 * safeParse the subtree value and aggregate any issues into ONE warn. Keys absent
 * here (ensemble, autoDetect, heatmap, disabledSteps, unknown siblings) are never
 * observed.
 */
export const PIPELINE_SUBTREE_SCHEMAS = {
  demo: zDemoConfig,
  pipeline: zPipelineSubtree,
  llm: zLlmConfig,
  csi: zCsiConfigStored,
  textAnnotation: zTextAnnotationConfig,
  heuristics: zHeuristicsConfig,
  pageNaming: zPageNaming,
} as const satisfies Record<string, z.ZodType>;
