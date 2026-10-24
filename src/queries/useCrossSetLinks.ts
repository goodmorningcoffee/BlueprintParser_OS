"use client";

// [cross-set F3 2026-10-24] The viewer's read of the cross-set links: GET /api/projects/[id]/cross-set
// (every page's links to the company's other sets, target names already filtered to what this caller
// may open) once per open project, cached under queryKeys.projectGraph.crossSet. Best-effort: any
// failure reads as "not built". Not seeded from the project bootstrap (the links live in S3).

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/queries/queryKeys";
import { useSessionStore } from "@/stores/sessionStore";
import type { CrossSetLinkKind } from "@/lib/knowledge-graph/cross-set";

export interface CrossSetViewerLink {
  kind: CrossSetLinkKind;
  project: { publicId: string; name: string };
  page: number;
  sheet: string | null;
  confidence: number;
  direction: "older" | "newer";
  titleMatch?: boolean;
}

export interface CrossSetProjectRow {
  publicId: string;
  name: string;
  kind: "copy_of";
  role: "copy" | "original";
  shared: number;
  pages: number;
}

export interface CrossSetResponse {
  built: boolean;
  computedAt?: string;
  pages?: Record<string, CrossSetViewerLink[]>;
  projects?: CrossSetProjectRow[];
}

const EMPTY_LINKS: CrossSetViewerLink[] = [];
const EMPTY_PROJECTS: CrossSetProjectRow[] = [];

export async function fetchCrossSetLinks(publicId: string, signal?: AbortSignal): Promise<CrossSetResponse> {
  const res = await fetch(`/api/projects/${encodeURIComponent(publicId)}/cross-set`, { signal });
  if (!res.ok) return { built: false };
  return (await res.json()) as CrossSetResponse;
}

export function useCrossSetLinks(): { data: CrossSetResponse | undefined; isLoading: boolean } {
  const publicId = useSessionStore((s) => s.publicId);
  const { data, isLoading } = useQuery<CrossSetResponse>({
    queryKey: queryKeys.projectGraph.crossSet(publicId),
    queryFn: ({ signal }) => fetchCrossSetLinks(publicId, signal),
    enabled: Boolean(publicId),
    staleTime: 5 * 60_000,
    retry: false,
  });
  return { data, isLoading };
}

/** One page's links to other sets + the project-level copy rows, stable empties when absent. */
export function usePageCrossSetLinks(pageNumber: number): { built: boolean; links: CrossSetViewerLink[]; projects: CrossSetProjectRow[] } {
  const { data } = useCrossSetLinks();
  return {
    built: Boolean(data?.built),
    links: data?.pages?.[String(pageNumber)] ?? EMPTY_LINKS,
    projects: data?.projects ?? EMPTY_PROJECTS,
  };
}
