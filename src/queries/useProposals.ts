"use client";

// [classifier-builder 2026-10-24] Bootstrap owner for projectIntelligence.proposals (the compact list the
// Tables panel shows). Seeded once per project open like csiGraph; verdicts patch the cached item in place
// after the server accepted them, so the list never refetches the project.

import { useQuery, type QueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/queries/queryKeys";
import { useSessionStore } from "@/stores/sessionStore";
import { persistFetch } from "@/lib/client-persist";
import type { ProjectProposalSummary, ProposalVerdict, VerdictKind } from "@/lib/classifier-engine/types";

type ProjectIntelligence = Record<string, unknown> | null | undefined;

/** The stored summary, or null when absent or not the contract's shape. */
export function readProposalSummary(value: unknown): ProjectProposalSummary | null {
  const s = value as ProjectProposalSummary | null | undefined;
  if (!s || typeof s !== "object" || !Array.isArray(s.items)) return null;
  return s;
}

/** Unconditional openProject seed; `null` is explicit because undefined is a v5 no-op. */
export function seedProposalsFromBootstrap(
  qc: QueryClient,
  publicId: string,
  projectIntelligence: ProjectIntelligence,
): void {
  qc.setQueryData<ProjectProposalSummary | null>(
    queryKeys.proposals.all(publicId),
    readProposalSummary(projectIntelligence?.proposals),
  );
}

export function clearProposalsProject(qc: QueryClient, publicId: string): void {
  if (!publicId) return;
  qc.removeQueries({ queryKey: queryKeys.proposals.all(publicId), exact: true });
}

export function useProposals(): ProjectProposalSummary | null {
  const publicId = useSessionStore((state) => state.publicId);
  const { data } = useQuery<ProjectProposalSummary | null>({
    queryKey: queryKeys.proposals.all(publicId),
    queryFn: () => {
      throw new Error("proposals are project-bootstrap seeded; queryFn must never run");
    },
    enabled: false,
    initialData: null,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data;
}

/** Set (or clear, verdict undefined) one cached item's verdict. */
export function applyProposalVerdict(
  qc: QueryClient,
  publicId: string,
  proposalId: string,
  verdict: VerdictKind | undefined,
): void {
  qc.setQueryData<ProjectProposalSummary | null>(queryKeys.proposals.all(publicId), (prev) => {
    if (!prev) return prev;
    return {
      ...prev,
      items: prev.items.map((item) => {
        if (item.id !== proposalId) return item;
        const { verdict: _old, ...rest } = item;
        return verdict === undefined ? rest : { ...rest, verdict };
      }),
    };
  });
}

export interface VerdictRequest {
  pageNumber: number;
  proposalId: string;
  verdict: VerdictKind;
  classId?: string;
  name?: string;
}

const verdictUrl = (publicId: string) => `/api/projects/${encodeURIComponent(publicId)}/proposals/verdict`;

/** POST the verdict, then mirror it into the cache. Throws the server's message on failure. */
export async function submitProposalVerdict(
  qc: QueryClient,
  publicId: string,
  request: VerdictRequest,
): Promise<ProposalVerdict> {
  const body = (await persistFetch(verdictUrl(publicId), request, "POST")) as { verdict: ProposalVerdict };
  applyProposalVerdict(qc, publicId, request.proposalId, request.verdict);
  return body.verdict;
}

/**
 * [TP-2 WP-2.F, K58] After the SAVE of a parse that started from "Parse this table": post the proposal's
 * `accept` with `via:"parse"` and the saved region. The server takes the stored classId and writes only when
 * the proposal has no verdict yet and the region overlaps it; the client also skips a proposal its cache
 * already shows as verdicted. Best-effort: never throws (the parse is saved either way).
 */
export async function postParseAcceptVerdict(
  qc: QueryClient,
  publicId: string,
  pageNumber: number,
  proposalId: string,
  regionId: string,
): Promise<void> {
  if (!publicId) return;
  const cached = qc.getQueryData<ProjectProposalSummary | null>(queryKeys.proposals.all(publicId));
  if (cached?.items.some((item) => item.id === proposalId && item.verdict !== undefined)) return;
  try {
    const body = (await persistFetch(
      verdictUrl(publicId),
      { pageNumber, proposalId, verdict: "accept", via: "parse", regionId },
      "POST",
    )) as { verdict: ProposalVerdict | null } | null;
    if (body?.verdict) applyProposalVerdict(qc, publicId, proposalId, body.verdict.verdict);
  } catch (err) {
    console.warn("[proposals] accept after parse failed:", err);
  }
}

/** Undo = DELETE the verdict, then clear it in the cache. */
export async function undoProposalVerdict(
  qc: QueryClient,
  publicId: string,
  target: { pageNumber: number; proposalId: string },
): Promise<void> {
  await persistFetch(verdictUrl(publicId), target, "DELETE");
  applyProposalVerdict(qc, publicId, target.proposalId, undefined);
}
