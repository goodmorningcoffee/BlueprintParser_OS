"use client";

// [TP-3 WP-3.F] Workspace text-region verdicts: `pageIntelligence.textRegionVerdicts`, which the page window never
// ships (denylisted), read per page through `GET /api/projects/[id]/parse-engine/verdicts?page=N` (slim, content-keyed
// `{ "tr:<type>:<box>" → {verdict, type, b, at} }`). Writes go through `persistFetch` to `…/parse-engine/verdict`
// and patch this cache only after the server accepted them.
//
// The read is enabled only while the cached parse-engine flags say the workspace is on (`tools.workspace ===
// "engine"`, no kill switch): verdicts are written by the workspace, and the classic Notes/Spec cards read them
// through `useTextRegionVerdictFilter`. The flags query is OBSERVED here, never fetched: the workspace host
// (WP-3.L `useParseEngineFlags`, always mounted) owns that fetch under the SAME key, `workspaceKeys.flags`
// (`["project", id, "parseEngine", "flags"]`), so a classic card on its own adds no request. With the workspace
// off, existing verdicts are kept but not applied to the classic cards. (WP-3.F fix round, verify HIGH-2: the
// key was a private one the host never filled, so the cards never filtered. Since TP-3 integrate g2b this module
// imports `workspaceKeys.flags` instead of spelling it; the test still pins the literal tuple.)

import { useQuery, type QueryClient } from "@tanstack/react-query";
import { getJson, persistFetch } from "@/lib/client-persist";
import type { BboxMinMax, ParseEngineFlags } from "@/lib/parse-engine/types";
import type { TextRegionVerdictSlim, TextRegionVerdictsResponse, WorkspaceVerdictResponse } from "@/lib/parse-engine/types-items";
import { workspaceKeys } from "@/queries/workspaceKeys";
import { useProject } from "@/stores/sessionStore";

export type PageTextRegionVerdicts = Record<string, TextRegionVerdictSlim>;

const projectUrl = (publicId: string) => `/api/projects/${encodeURIComponent(publicId)}/parse-engine`;

/** Query keys (sibling file, so `queryKeys.ts` is not edited). Under `["project", publicId]` like every project key. */
export const textRegionVerdictKeys = {
  all: (publicId: string) => ["project", publicId, "textRegionVerdicts"] as const,
  page: (publicId: string, pageNumber: number) => ["project", publicId, "textRegionVerdicts", pageNumber] as const,
};
/** The parse-engine flags query key: WP-3.L's `workspaceKeys.flags`, whose host fetches it (one key; integrate g2b, WP-3.F L-2). */
export const parseEngineFlagsKey = workspaceKeys.flags;

/** GET the effective flags (the same URL and shape as WP-3.L `useParseEngineFlags`). */
export function fetchParseEngineFlags(publicId: string, signal?: AbortSignal): Promise<ParseEngineFlags> {
  return getJson<ParseEngineFlags>(`${projectUrl(publicId)}/flags`, signal);
}

/** True when cached flags say the workspace is on. Observes the cache only (never fetches). */
export function useWorkspaceFlagOn(publicId: string): boolean {
  const { data } = useQuery<ParseEngineFlags>({
    queryKey: parseEngineFlagsKey(publicId),
    queryFn: ({ signal }) => fetchParseEngineFlags(publicId, signal),
    enabled: false,
  });
  return !!data && data.killSwitch !== true && data.tools?.workspace === "engine";
}

/** The page's verdicts by content key (undefined while loading or while the workspace is off; never for demo). */
export function useTextRegionVerdicts(pageNumber: number): PageTextRegionVerdicts | undefined {
  const { publicId, isDemo } = useProject();
  const on = useWorkspaceFlagOn(publicId);
  const { data } = useQuery<PageTextRegionVerdicts>({
    queryKey: textRegionVerdictKeys.page(publicId, pageNumber),
    queryFn: async ({ signal }) => {
      const body = await getJson<Partial<TextRegionVerdictsResponse>>(`${projectUrl(publicId)}/verdicts?page=${pageNumber}`, signal);
      return body?.verdicts && typeof body.verdicts === "object" ? body.verdicts : {};
    },
    enabled: on && !!publicId && !isDemo && pageNumber > 0,
    staleTime: 30_000,
  });
  return on ? data : undefined;
}

function patchVerdicts(qc: QueryClient, publicId: string, pageNumber: number, key: string, verdict: TextRegionVerdictSlim | null): void {
  qc.setQueryData<PageTextRegionVerdicts>(textRegionVerdictKeys.page(publicId, pageNumber), (prev) => {
    const { [key]: _old, ...rest } = prev ?? {};
    return verdict ? { ...rest, [key]: verdict } : rest;
  });
}

/**
 * POST a reject on one text region (named by type + MinMax box; accept is a commit, WP-3.G). Throws the
 * server's message on failure.
 */
export async function submitTextRegionVerdict(
  qc: QueryClient,
  publicId: string,
  request: { pageNumber: number; textRegion: { type: string; bbox: BboxMinMax }; verdict: "reject" },
): Promise<WorkspaceVerdictResponse> {
  const body = (await persistFetch(`${projectUrl(publicId)}/verdict`, request, "POST")) as WorkspaceVerdictResponse;
  if (body.key && body.verdict) patchVerdicts(qc, publicId, request.pageNumber, body.key, body.verdict);
  return body;
}

/** Undo = DELETE the verdict by its content key, then clear it in the cache. */
export async function undoTextRegionVerdict(
  qc: QueryClient,
  publicId: string,
  target: { pageNumber: number; key: string },
): Promise<WorkspaceVerdictResponse> {
  const body = (await persistFetch(`${projectUrl(publicId)}/verdict`, target, "DELETE")) as WorkspaceVerdictResponse;
  patchVerdicts(qc, publicId, target.pageNumber, target.key, null);
  return body;
}
