"use client";

// [2026-10-23] What Admin › Pipeline › Reprocess "All" really runs on. The server processes every
// non-demo project of the caller's OWN company, whatever its status (services/reprocess.ts); this tab
// lists COMPLETED projects — for a root admin across ALL companies — so the two counts differ (the
// owner saw 216 listed and 128 processed). GET /api/admin/reprocess/scope returns the server's own
// count; the tab shows it on the "All" button, explains the gap, and re-counts it in the confirm
// before a run. Nothing here changes which projects a run processes.

import { useCallback, useEffect, useState } from "react";
import { apiErrorMessage } from "@/lib/client-persist";

export interface ReprocessScopeInfo {
  companyId: number;
  companyName: string | null;
  projects: number;
  byStatus: Record<string, number>;
  description: string;
}

export interface ReprocessScopeState {
  scope: ReprocessScopeInfo | null;
  error: string | null;
}

export async function fetchReprocessScope(): Promise<ReprocessScopeState> {
  try {
    const res = await fetch("/api/admin/reprocess/scope");
    const body = await res.json().catch(() => null);
    if (!res.ok) return { scope: null, error: apiErrorMessage(body) || `HTTP ${res.status}` };
    return { scope: body as ReprocessScopeInfo, error: null };
  } catch (err) {
    return { scope: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export function useReprocessScope(): ReprocessScopeState & { reload: () => Promise<ReprocessScopeState> } {
  const [state, setState] = useState<ReprocessScopeState>({ scope: null, error: null });
  const reload = useCallback(async () => {
    const next = await fetchReprocessScope();
    setState(next);
    return next;
  }, []);
  useEffect(() => {
    let live = true;
    void fetchReprocessScope().then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
    };
  }, []);
  return { ...state, reload };
}

function statusText(byStatus: Record<string, number>): string {
  const parts = Object.entries(byStatus)
    .sort((a, b) => b[1] - a[1])
    .map(([status, n]) => `${n} ${status}`);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

function whose(scope: ReprocessScopeInfo): string {
  return scope.companyName ? `${scope.companyName}` : `company #${scope.companyId}`;
}

/** The line under the Projects buttons. */
export function reprocessScopeNote(
  scope: ReprocessScopeInfo | null,
  error: string | null,
  listed: number,
  isRootAdmin: boolean,
): string {
  const list = `The list below shows ${listed} completed project${listed === 1 ? "" : "s"}${isRootAdmin ? " across all companies" : ""}`;
  if (!scope) {
    return error
      ? `Could not count the server's scope (${error}). "All" runs on every non-demo project of your own company, any status. ${list}.`
      : `Counting the server's scope… ${list}.`;
  }
  return (
    `"All" runs on ${scope.projects} project${scope.projects === 1 ? "" : "s"}: every non-demo project of ${whose(scope)}, any status` +
    `${statusText(scope.byStatus)}. ${list}; selected projects outside ${whose(scope)} are skipped.`
  );
}

/** The confirm shown before an "All" run, from a count taken at click time. */
export function reprocessAllConfirmText(
  label: string,
  scope: ReprocessScopeInfo | null,
  error: string | null,
  listed: number,
  isRootAdmin: boolean,
): string {
  const head = scope
    ? `Run ${label} on ${scope.projects} project${scope.projects === 1 ? "" : "s"} — every non-demo project of ${whose(scope)}, any status${statusText(scope.byStatus)}.`
    : `Run ${label} on every non-demo project of your own company, any status (the count could not be read${error ? `: ${error}` : ""}).`;
  return `${head}\n\nThis is the server's scope, not the ${listed} completed project${listed === 1 ? "" : "s"} listed here${isRootAdmin ? " across all companies" : ""}.`;
}
