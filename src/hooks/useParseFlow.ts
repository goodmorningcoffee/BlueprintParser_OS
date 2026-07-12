"use client";

import { useShallow } from "zustand/react/shallow";

import {
  useParseFlowStore,
  type ParseFlowState,
} from "@/stores/parseFlowStore";
import {
  setKeynoteParseStep,
  setNotesParseStep,
  setSpecParseStep,
  setTableParseStep,
} from "@/stores/viewerCommands";
import type { ParseKind } from "@/lib/parse-operation-state";
import type { BboxMinMax } from "@/types";

/** Keep the A1 public type import stable while A2's pure registry becomes its canonical owner. */
export type { ParseKind } from "@/lib/parse-operation-state";

/** Derive every step union from its real flat owner instead of coupling equal-looking kinds. */
export type ParseStepMap = {
  table: ParseFlowState["tableParseStep"];
  keynote: ParseFlowState["keynoteParseStep"];
  notes: ParseFlowState["notesParseStep"];
  spec: ParseFlowState["specParseStep"];
};

export type ParseFlowLifecycle<K extends ParseKind> = {
  kind: K;
  step: ParseStepMap[K];
  region: BboxMinMax | null;
  /** Neutral command: idle-to-active entry also closes competing tool sessions. */
  setStep: (step: ParseStepMap[K]) => void;
  setRegion: (region: BboxMinMax | null) => void;
  /** Exact legacy leaf reset; kind-specific/shared reset effects are intentionally retained. */
  reset: () => void;
};

type ParseFlowAdapterMap = {
  [K in ParseKind]: (state: ParseFlowState) => ParseFlowLifecycle<K>;
};
type ParseFlowLifecycleUnion = {
  [K in ParseKind]: ParseFlowLifecycle<K>;
}[ParseKind];

/**
 * [refactor jul11 P2.4 A1] Exhaustive semantic adapters over the unchanged flat store.
 *
 * Keep these at module scope and return direct command/action references. Wrapping actions would
 * churn identities and defeat shallow suppression. The registry is also deliberately transparent
 * to the fail-closed store-owner oracle: a dynamic kind means "analyze all four selectors", never
 * "trust an opaque helper".
 */
const PARSE_FLOW_ADAPTERS: ParseFlowAdapterMap = {
  table: (state) => ({
    kind: "table",
    step: state.tableParseStep,
    region: state.tableParseRegion,
    setStep: setTableParseStep,
    setRegion: state.setTableParseRegion,
    reset: state.resetTableParse,
  }),
  keynote: (state) => ({
    kind: "keynote",
    step: state.keynoteParseStep,
    region: state.keynoteParseRegion,
    setStep: setKeynoteParseStep,
    setRegion: state.setKeynoteParseRegion,
    reset: state.resetKeynoteParse,
  }),
  notes: (state) => ({
    kind: "notes",
    step: state.notesParseStep,
    region: state.notesParseRegion,
    setStep: setNotesParseStep,
    setRegion: state.setNotesParseRegion,
    reset: state.resetNotesParse,
  }),
  spec: (state) => ({
    kind: "spec",
    step: state.specParseStep,
    region: state.specParseRegion,
    setStep: setSpecParseStep,
    setRegion: state.setSpecParseRegion,
    reset: state.resetSpecParse,
  }),
};

/**
 * Common cold-panel lifecycle. This always executes one shallow Zustand hook; `kind` selects a
 * module-scope adapter, not a conditional hook. Canvas/preview paths should keep primitive reads.
 */
export function useParseFlow<K extends ParseKind>(kind: K): ParseFlowLifecycle<K> {
  // Keep every registry access statically named. The fail-closed ownership oracle can then inspect
  // all possible selectors without pretending an arbitrary dynamic object key is exhaustive.
  const selector: (state: ParseFlowState) => ParseFlowLifecycleUnion = kind === "table"
    ? PARSE_FLOW_ADAPTERS.table
    : kind === "keynote"
      ? PARSE_FLOW_ADAPTERS.keynote
      : kind === "notes"
        ? PARSE_FLOW_ADAPTERS.notes
        : PARSE_FLOW_ADAPTERS.spec;
  // TypeScript cannot preserve the K/conditional correlation across a union of selector functions;
  // the mapped registry above checks each branch, and topology pins this exhaustive selection.
  return useParseFlowStore(useShallow(selector)) as unknown as ParseFlowLifecycle<K>;
}
