"use client";

import { useShallow } from "zustand/react/shallow";

import {
  useParseFlowStore,
  type ParseFlowState,
} from "@/stores/parseFlowStore";
import type {
  BeginParseOperationPolicy,
  BeginParseOperationResult,
  ParseKind,
  ParseOperationToken,
} from "@/lib/parse-operation-state";

export type {
  BeginParseOperationPolicy,
  BeginParseOperationResult,
  ParseKind,
  ParseOperationToken,
} from "@/lib/parse-operation-state";

export type ParseOperationLifecycle<K extends ParseKind> = {
  kind: K;
  revision: number;
  busy: boolean;
  begin: (policy?: BeginParseOperationPolicy) => BeginParseOperationResult<K>;
  isCurrent: (token: ParseOperationToken<K>) => boolean;
  finish: (token: ParseOperationToken<K>) => boolean;
  invalidate: () => void;
};

type BoundParseOperationActions<K extends ParseKind> = Pick<
  ParseOperationLifecycle<K>,
  "begin" | "isCurrent" | "finish" | "invalidate"
>;

/** Bind kind once at module scope so every selected command keeps a stable identity. */
function bindParseOperationActions<K extends ParseKind>(kind: K): BoundParseOperationActions<K> {
  return {
    begin: (policy) => useParseFlowStore.getState().beginParseOperation(kind, policy),
    isCurrent: (token) =>
      token.kind === kind && useParseFlowStore.getState().isParseOperationCurrent(token),
    finish: (token) =>
      token.kind === kind && useParseFlowStore.getState().finishParseOperation(token),
    invalidate: () => useParseFlowStore.getState().invalidateParseOperation(kind),
  };
}

type ParseOperationActionMap = {
  [K in ParseKind]: BoundParseOperationActions<K>;
};

const PARSE_OPERATION_ACTIONS: ParseOperationActionMap = {
  table: bindParseOperationActions("table"),
  keynote: bindParseOperationActions("keynote"),
  notes: bindParseOperationActions("notes"),
  spec: bindParseOperationActions("spec"),
};

type ParseOperationAdapterMap = {
  [K in ParseKind]: (state: ParseFlowState) => ParseOperationLifecycle<K>;
};
type ParseOperationLifecycleUnion = {
  [K in ParseKind]: ParseOperationLifecycle<K>;
}[ParseKind];

const PARSE_OPERATION_ADAPTERS: ParseOperationAdapterMap = {
  table: (state) => ({
    kind: "table",
    revision: state.parseOperations.table.revision,
    busy: state.parseOperations.table.busy,
    ...PARSE_OPERATION_ACTIONS.table,
  }),
  keynote: (state) => ({
    kind: "keynote",
    revision: state.parseOperations.keynote.revision,
    busy: state.parseOperations.keynote.busy,
    ...PARSE_OPERATION_ACTIONS.keynote,
  }),
  notes: (state) => ({
    kind: "notes",
    revision: state.parseOperations.notes.revision,
    busy: state.parseOperations.notes.busy,
    ...PARSE_OPERATION_ACTIONS.notes,
  }),
  spec: (state) => ({
    kind: "spec",
    revision: state.parseOperations.spec.revision,
    busy: state.parseOperations.spec.busy,
    ...PARSE_OPERATION_ACTIONS.spec,
  }),
};

/**
 * A2's cold operation-authority facade. It stays separate from `useParseFlow` so lifecycle-only
 * panels and canvas primitives do not observe busy/revision publications.
 */
export function useParseOperation<K extends ParseKind>(kind: K): ParseOperationLifecycle<K> {
  const selector: (state: ParseFlowState) => ParseOperationLifecycleUnion = kind === "table"
    ? PARSE_OPERATION_ADAPTERS.table
    : kind === "keynote"
      ? PARSE_OPERATION_ADAPTERS.keynote
      : kind === "notes"
        ? PARSE_OPERATION_ADAPTERS.notes
        : PARSE_OPERATION_ADAPTERS.spec;
  return useParseFlowStore(useShallow(selector)) as unknown as ParseOperationLifecycle<K>;
}

/**
 * Execute one synchronous completion tail only while `token` owns its kind. Callbacks must contain
 * no await, fetch, persistence, Query adoption, or other work that yields before the tail ends.
 */
export function commitParseOperation<K extends ParseKind>(
  token: ParseOperationToken<K>,
  callback: () => void,
): boolean {
  if (!useParseFlowStore.getState().isParseOperationCurrent(token)) return false;
  callback();
  return true;
}
