import type { ParseOperationToken } from "@/lib/parse-operation-state";
import type { ParseFlowState } from "@/stores/parseFlowStore";

export type TableGrid = NonNullable<ParseFlowState["tableParsedGrid"]>;

export type TablePersistOptions = {
  /** Preserve the review workspace for Auto/Manual auto-persist when false. */
  resetAfter?: boolean;
  /** Clear the Table-owned shared Guided generation in the terminal reset. */
  resetGuided?: boolean;
  /**
   * React-local bookkeeping run only when the terminal reset did not synchronously admit B.
   * It must never await or publish store, Query, tool, or durable work.
   */
  onLocalSuccess?: () => void;
};

/**
 * Shared Table save composition seam. Event roots pass their outer token as the third argument;
 * direct callers omit it and the helper owns one root token itself.
 */
export type DetectCsiAndPersist = (
  grid: TableGrid,
  options?: TablePersistOptions,
  inheritedToken?: ParseOperationToken<"table">,
) => Promise<boolean>;
