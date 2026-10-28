"use client";

// [TP-3 WP-3.L] The effective parse-engine flags for this viewer: GET /api/projects/[id]/parse-engine/flags
// (global, no project data; public for demo projects). TablesWorkspaceHost reads it to decide whether the
// Schedules/Tables and Specs/Notes buttons open the workspace (`tools.workspace === "engine"`) or the classic
// panels. Undefined while loading or after an error, which callers treat as "classic".

import { useQuery } from "@tanstack/react-query";
import { getJson } from "@/lib/client-persist";
import type { ParseEngineFlags } from "@/lib/parse-engine/types";
import { workspaceKeys } from "@/queries/workspaceKeys";

export function parseEngineFlagsUrl(publicId: string): string {
  return `/api/projects/${encodeURIComponent(publicId)}/parse-engine/flags`;
}

export function useParseEngineFlags(publicId: string): ParseEngineFlags | undefined {
  const { data } = useQuery<ParseEngineFlags>({
    queryKey: workspaceKeys.flags(publicId),
    queryFn: ({ signal }) => getJson<ParseEngineFlags>(parseEngineFlagsUrl(publicId), signal),
    enabled: !!publicId,
    staleTime: 5 * 60_000,
    retry: 1,
  });
  return data;
}

/** True when the workspace should replace the classic panels for this viewer. */
export function workspaceOn(flags: ParseEngineFlags | undefined, isDemo: boolean): boolean {
  return !!flags && !isDemo && flags.killSwitch !== true && flags.tools?.workspace === "engine";
}
