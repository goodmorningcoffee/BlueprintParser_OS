"use client";

import { useCallback, useMemo, useState } from "react";

import { commitParseOperation, useParseOperation } from "@/hooks/useParseOperation";
import { apiErrorMessage } from "@/lib/client-persist";
import { useParseFlowStore, type ParseFlowState } from "@/stores/parseFlowStore";
import { clearTableCellStructureForUser } from "@/stores/viewerCommands";

type TableCellStructureTarget = Readonly<{
  projectId: number | string;
  pageNumber: number;
  regionBbox: [number, number, number, number];
}>;

type LocalPhase = Readonly<{ key: string; revision: number }>;
type LocalError = Readonly<{ key: string; message: string }>;

/**
 * The sole Table cell-structure async root. Both the parser review and retained-row button call
 * this hook so admission, stale completion, local phase/error, and finally semantics cannot drift.
 */
export function useTableCellStructureOperation() {
  const tableOperation = useParseOperation("table");
  const [localPhase, setLocalPhase] = useState<LocalPhase | null>(null);
  const [localError, setLocalError] = useState<LocalError | null>(null);
  const loadingKey = tableOperation.busy && localPhase?.revision === tableOperation.revision
    ? localPhase.key
    : null;

  const detect = useCallback(async (input: TableCellStructureTarget, key: string) => {
    const started = tableOperation.begin();
    if (started.status === "busy") return false;
    const token = started.token;

    try {
      const target: TableCellStructureTarget = {
        projectId: input.projectId,
        pageNumber: input.pageNumber,
        regionBbox: [...input.regionBbox],
      };
      const admitted = commitParseOperation(token, () => {
        setLocalPhase({ key, revision: token.revision });
        setLocalError(null);
      });
      if (!admitted) return false;

      const response = await fetch("/api/table-structure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(target),
      });
      const data = await response.json();
      if (!response.ok || data.error) {
        commitParseOperation(token, () => {
          setLocalError({ key, message: apiErrorMessage(data) || `HTTP ${response.status}` });
        });
        return false;
      }

      const structure: NonNullable<ParseFlowState["tableCellStructure"]> = {
        cells: (data.cells || []).map((cell: any) => ({
          ...cell,
          text: cell.text || "",
          highlighted: false,
        })),
        pageNumber: target.pageNumber,
        regionBbox: target.regionBbox,
      };
      return commitParseOperation(token, () => {
        useParseFlowStore.getState().setTableCellStructure(structure);
      });
    } catch (cause) {
      commitParseOperation(token, () => {
        setLocalError({
          key,
          message: cause instanceof Error ? cause.message : "Failed to detect cell structure",
        });
      });
      return false;
    } finally {
      tableOperation.finish(token);
    }
  // The lifecycle facade exposes module-bound stable methods. Listing those exact methods avoids
  // coupling this root to busy/revision object identity while retaining the direct-call topology.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableOperation.begin, tableOperation.finish]);

  const clear = useCallback(() => {
    setLocalError(null);
    clearTableCellStructureForUser();
  }, []);

  return useMemo(() => ({
    detect,
    clear,
    loadingKey,
    busy: tableOperation.busy,
    errorKey: localError?.key ?? null,
    error: localError?.message ?? null,
  } as const), [clear, detect, loadingKey, localError, tableOperation.busy]);
}

export type TableCellStructureOperation = ReturnType<typeof useTableCellStructureOperation>;
