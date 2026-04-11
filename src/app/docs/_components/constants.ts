/**
 * constants.ts — single source of truth for all values the docs import
 * from the rest of the app. Touching this file is a signal that something
 * downstream (a demo, a section) needs to be re-verified.
 *
 * Add new re-exports here rather than reaching into lib/components from
 * individual sections or demos.
 */

export { TWENTY_COLORS } from "@/types";
export { DIVISION_COLORS, GROUP_COLORS, DIVISION_NAMES, getDivColor } from "@/lib/csi-colors";
export type { CsiDivisionMeta } from "@/lib/csi-colors";
export { SECTION_REGISTRY, GLOBAL_SECTION_REGISTRY, SECTION_PRESETS, DEFAULT_CONTEXT_BUDGET, getContextBudget } from "@/lib/context-builder";
export { BP_TOOLS } from "@/lib/llm/tools-defs";

/** Docs-local tag for the subset of LLM tools that are *actions* (mutations / viewer commands) vs pure data retrieval. */
export const ACTION_TOOL_NAMES = new Set([
  "navigateToPage",
  "highlightRegion",
  "createMarkup",
  "addNoteToAnnotation",
  "batchAddNotes",
]);

/** Docs-local grouping for the LLM tool reference card grid. */
export const TOOL_GROUPS = [
  {
    id: "retrieval",
    label: "Data Retrieval",
    description: "Cheap, read-only queries against pre-computed blueprint structure.",
    tools: [
      "searchPages",
      "getProjectOverview",
      "getPageDetails",
      "lookupPagesByIndex",
      "getAnnotations",
      "getParsedSchedule",
      "getCsiSpatialMap",
      "getCrossReferences",
      "getSpatialContext",
      "getPageOcrText",
    ],
  },
  {
    id: "analysis",
    label: "Text Analysis",
    description: "Run BP engines on arbitrary strings.",
    tools: ["detectCsiFromText"],
  },
  {
    id: "yolo-aware",
    label: "YOLO-Aware",
    description: "Tools that join OCR text to YOLO object detections.",
    tools: [
      "scanYoloClassTexts",
      "mapTagsToPages",
      "detectTagPatterns",
      "getOcrTextInRegion",
    ],
  },
  {
    id: "actions",
    label: "Viewer Actions",
    description: "Side-effecting tools that drive the viewer or mutate data.",
    tools: [
      "navigateToPage",
      "highlightRegion",
      "createMarkup",
      "addNoteToAnnotation",
      "batchAddNotes",
    ],
  },
] as const;

/** Context budgets table data — rows sourced from getContextBudget(). */
export const CONTEXT_BUDGET_ROWS: { provider: string; model: string; chars: number }[] = [
  { provider: "anthropic", model: "claude-opus-*", chars: 200_000 },
  { provider: "anthropic", model: "claude-sonnet-*", chars: 80_000 },
  { provider: "anthropic", model: "claude-haiku-*", chars: 30_000 },
  { provider: "openai", model: "gpt-4o*", chars: 60_000 },
  { provider: "openai", model: "gpt-4* (Turbo)", chars: 40_000 },
  { provider: "openai", model: "o1 / o3", chars: 80_000 },
  { provider: "groq", model: "any", chars: 24_000 },
  { provider: "custom", model: "Ollama / self-hosted", chars: 30_000 },
  { provider: "(fallback)", model: "DEFAULT_CONTEXT_BUDGET", chars: 24_000 },
];
