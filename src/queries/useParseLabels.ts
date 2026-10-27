"use client";

// [TP-2 WP-2.F] The verdict bar's labels: `pageIntelligence.parseLabels`, which the page window never ships
// (denylisted), so they are read here per page through `GET /api/projects/[id]/parse-labels?page=N` (slim
// `{regionId → {verdict, at, was?}}`; "corrected" is inferred by the server on read). Writes go through
// `persistFetch` and patch this cache only after the server accepted them.

import { useQuery, type QueryClient } from "@tanstack/react-query";
import { getJson, persistFetch } from "@/lib/client-persist";
import { queryKeys } from "@/queries/queryKeys";
import { useProject } from "@/stores/sessionStore";

export type ParseLabelVerdict = "correct" | "wrong" | "corrected" | "committed";
export interface ParseLabelSlim {
  verdict: ParseLabelVerdict;
  at: string;
  /** Only on an inferred "corrected": the verdict given before the region was edited. */
  was?: ParseLabelVerdict;
}
export type PageParseLabels = Record<string, ParseLabelSlim>;

const labelsUrl = (publicId: string) => `/api/projects/${encodeURIComponent(publicId)}/parse-labels`;

/** The page's labels by region id (undefined while loading; never fetched for demo or without a project). */
export function useParseLabels(pageNumber: number): PageParseLabels | undefined {
  const { publicId, isDemo } = useProject();
  const { data } = useQuery<PageParseLabels>({
    queryKey: queryKeys.parseLabels.page(publicId, pageNumber),
    queryFn: async ({ signal }) => {
      const body = await getJson<{ labels?: PageParseLabels }>(`${labelsUrl(publicId)}?page=${pageNumber}`, signal);
      return body?.labels ?? {};
    },
    enabled: !!publicId && !isDemo && pageNumber > 0,
    staleTime: 30_000,
  });
  return data;
}

/** Re-read a page's labels (an edit-save may have turned a ✓/✗ into "corrected"). */
export function invalidateParseLabels(qc: QueryClient, publicId: string, pageNumber: number): void {
  if (!publicId) return;
  void qc.invalidateQueries({ queryKey: queryKeys.parseLabels.page(publicId, pageNumber), exact: true });
}

function patchLabels(qc: QueryClient, publicId: string, pageNumber: number, regionId: string, label: ParseLabelSlim | null): void {
  qc.setQueryData<PageParseLabels>(queryKeys.parseLabels.page(publicId, pageNumber), (prev) => {
    const { [regionId]: _old, ...rest } = prev ?? {};
    return label ? { ...rest, [regionId]: label } : rest;
  });
}

/** POST ✓ ("correct") or ✗ ("wrong") for one saved region. Throws the server's message on failure. */
export async function submitParseLabel(
  qc: QueryClient,
  publicId: string,
  request: { pageNumber: number; regionId: string; verdict: "correct" | "wrong" },
): Promise<void> {
  const body = (await persistFetch(labelsUrl(publicId), request, "POST")) as { regionId: string; label: ParseLabelSlim };
  patchLabels(qc, publicId, request.pageNumber, request.regionId, body.label);
}

/** Undo = DELETE the label, then clear it in the cache. */
export async function undoParseLabel(
  qc: QueryClient,
  publicId: string,
  target: { pageNumber: number; regionId: string },
): Promise<void> {
  await persistFetch(labelsUrl(publicId), target, "DELETE");
  patchLabels(qc, publicId, target.pageNumber, target.regionId, null);
}
