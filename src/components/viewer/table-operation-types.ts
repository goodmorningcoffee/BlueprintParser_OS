import type { ParseOperationToken } from "@/lib/parse-operation-state";
import type { ParseFlowState } from "@/stores/parseFlowStore";

export type TableGrid = NonNullable<ParseFlowState["tableParsedGrid"]>;

export type TablePersistOptions = {
  /** Preserve the review workspace for Auto/Manual auto-persist when false. */
  resetAfter?: boolean;
  /**
   * Runs inside the same synchronous current-token completion block as the shared Table reset.
   * It must never await, fetch, persist, or publish Query data.
   */
  onAuthorizedSuccess?: () => void;
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
