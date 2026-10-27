"use client";

// [TP-3 WP-3.L] The workspace inbox: GET /api/projects/[id]/parse-engine/items?scope=sheet&page=N | scope=all
// (PLAN §3.2; the route and its service land in WP-3.F — this module only reads it). Raw fetch lives here,
// inside `src/queries/`, through `getJson` (§1.6 rule 6). staleTime 30 s; a commit or a verdict invalidates
// `workspaceKeys.items(publicId)` (every scope and page at once).
//
// The wire shape below is the client's reading of the WP-3.F response: `items` (each row an `InboxSlim` plus its
// page and the scores and chips the inbox shows) and an optional `lowConfidence` group (items below the server's
// threshold). The reader is tolerant: a missing array is empty, so a partial response renders, never throws.

import { useQuery, type QueryClient } from "@tanstack/react-query";
import { getJson, persistFetch } from "@/lib/client-persist";
import type { InboxSlim } from "@/lib/parse-engine/types";
import { workspaceKeys } from "@/queries/workspaceKeys";
import type { WorkspaceFilter, WorkspaceItemRef, WorkspaceScope } from "@/stores/tablesWorkspaceStore";

export interface WorkspaceItemChips {
  shapes?: number;
  textract?: boolean;
  cols?: number;
  paragraphs?: number;
}

export interface WorkspaceItem extends WorkspaceItemRef {
  origin: InboxSlim["origin"];
  title: string | null;
  /** Kind probability. */
  p: number;
  /** Table-ness, when the recipe scored it; the inbox sorts by `tableP × p`. */
  tableP?: number;
  state: InboxSlim["state"];
  /** The saved region predates a capability bump (WP-3.H `stale`). */
  stale?: boolean;
  chips?: WorkspaceItemChips;
}

export interface WorkspaceItemsData {
  items: WorkspaceItem[];
  lowConfidence: WorkspaceItem[];
}

export const EMPTY_ITEMS: WorkspaceItemsData = Object.freeze({ items: [], lowConfidence: [] }) as WorkspaceItemsData;

const projectBase = (publicId: string) => `/api/projects/${encodeURIComponent(publicId)}/parse-engine`;

export function itemsUrl(publicId: string, scope: WorkspaceScope, pageNumber?: number): string {
  const q = scope === "sheet" ? `scope=sheet&page=${pageNumber ?? 0}` : "scope=all";
  return `${projectBase(publicId)}/items?${q}`;
}

function rows(value: unknown): WorkspaceItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is WorkspaceItem =>
    !!row && typeof row === "object" && typeof (row as WorkspaceItem).id === "string" &&
    typeof (row as WorkspaceItem).page === "number" && Array.isArray((row as WorkspaceItem).b));
}

export function normalizeItems(body: unknown): WorkspaceItemsData {
  const obj = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return { items: rows(obj.items), lowConfidence: rows(obj.lowConfidence) };
}

/** One inbox read. `scope = "sheet"` needs a page; never fetched for demo projects (the route refuses them). */
export function useWorkspaceItems(
  publicId: string,
  scope: WorkspaceScope,
  pageNumber: number,
  enabled = true,
): { data: WorkspaceItemsData | undefined; isLoading: boolean; error: Error | null } {
  const { data, isLoading, error } = useQuery<WorkspaceItemsData>({
    queryKey: scope === "sheet" ? workspaceKeys.itemsSheet(publicId, pageNumber) : workspaceKeys.itemsAll(publicId),
    queryFn: async ({ signal }) => normalizeItems(await getJson<unknown>(itemsUrl(publicId, scope, pageNumber), signal)),
    enabled: enabled && !!publicId && (scope === "all" || pageNumber > 0),
    staleTime: 30_000,
  });
  return { data, isLoading, error: error as Error | null };
}

export function invalidateWorkspaceItems(qc: QueryClient, publicId: string): void {
  if (!publicId) return;
  void qc.invalidateQueries({ queryKey: workspaceKeys.items(publicId) });
}

// ── pure inbox model ──────────────────────────────────────────────────────────────────────────────

/** The inbox sort key: table-ness × kind probability (an unscored table-ness counts as 1). */
export function itemScore(item: Pick<WorkspaceItem, "p" | "tableP">): number {
  const p = Number.isFinite(item.p) ? item.p : 0;
  const t = item.tableP === undefined || !Number.isFinite(item.tableP) ? 1 : item.tableP;
  return t * p;
}

/** Highest score first; ties by page, then top-to-bottom, then id — deterministic. */
export function sortItems<T extends WorkspaceItem>(items: readonly T[]): T[] {
  return [...items].sort((a, b) =>
    itemScore(b) - itemScore(a) || a.page - b.page || a.b[1] - b.b[1] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function matchesFilter(item: WorkspaceItem, filter: WorkspaceFilter): boolean {
  if (filter === "stale") return item.stale === true;
  if (filter === "parsed") return item.state === "parsed";
  if (filter === "rejected") return item.state === "rejected";
  return item.state === "todo";
}

export function filterCounts(items: readonly WorkspaceItem[]): Record<WorkspaceFilter, number> {
  const counts: Record<WorkspaceFilter, number> = { todo: 0, parsed: 0, rejected: 0, stale: 0 };
  for (const item of items) for (const f of ["todo", "parsed", "rejected", "stale"] as const) if (matchesFilter(item, f)) counts[f]++;
  return counts;
}

/** The kind-chip and filter view of one read: sorted main rows and the sorted low-confidence fold. */
export function inboxView(
  data: WorkspaceItemsData,
  kinds: readonly string[],
  filter: WorkspaceFilter,
): { rows: WorkspaceItem[]; low: WorkspaceItem[]; counts: Record<WorkspaceFilter, number>; total: number } {
  const ofKind = (item: WorkspaceItem) => kinds.includes(item.kind);
  const all = [...data.items, ...data.lowConfidence].filter(ofKind);
  return {
    rows: sortItems(data.items.filter((i) => ofKind(i) && matchesFilter(i, filter))),
    low: sortItems(data.lowConfidence.filter((i) => ofKind(i) && matchesFilter(i, filter))),
    counts: filterCounts(all),
    total: all.length,
  };
}

// ── verdict writes (route: WP-3.F `POST …/parse-engine/verdict`) ─────────────────────────────────

export interface WorkspaceVerdictRequest {
  pageNumber: number;
  itemId: string;
  origin: WorkspaceItem["origin"];
  kind: WorkspaceItem["kind"];
  bbox: WorkspaceItem["b"];
  proposalId?: string;
  verdict: "reject" | "accept";
  classId?: string;
}

export function verdictRequestFor(item: WorkspaceItem, verdict: "reject" | "accept", classId?: string): WorkspaceVerdictRequest {
  return {
    pageNumber: item.page,
    itemId: item.id,
    origin: item.origin,
    kind: item.kind,
    bbox: [...item.b] as WorkspaceItem["b"],
    ...(item.proposalId ? { proposalId: item.proposalId } : {}),
    verdict,
    ...(classId ? { classId } : {}),
  };
}

/**
 * Bulk "Not a table": one verdict per item, SEQUENTIALLY (each write takes the project lock), stopping on the
 * first failure. Returns how many were saved; the items cache is invalidated either way.
 */
export async function rejectItems(
  qc: QueryClient,
  publicId: string,
  items: readonly WorkspaceItem[],
): Promise<{ saved: number; error: string | null }> {
  let saved = 0;
  let error: string | null = null;
  for (const item of items) {
    try {
      await persistFetch(`${projectBase(publicId)}/verdict`, verdictRequestFor(item, "reject"), "POST");
      saved++;
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not save";
      break;
    }
  }
  invalidateWorkspaceItems(qc, publicId);
  return { saved, error };
}
