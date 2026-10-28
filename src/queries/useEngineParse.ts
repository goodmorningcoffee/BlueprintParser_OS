"use client";

// [TP-3 WP-3.M] The workspace's parse: POST /api/projects/[id]/parse-engine/parse (WP-3.E's route; compute only,
// nothing is written). Raw fetch stays inside `src/queries/` through `persistFetchResult` (§1.6 rule 6).
//   • `parseItem` runs one parse for one inbox item and applies the result to that item's draft ONLY when the
//     draft still carries the request's stamp (`drafts[key].startedAt`): a slow answer to an older request (a
//     budget change, an added continuation box, a re-open) is dropped, never shown over a newer one (PLAN §3.2).
//   • `instant` parses go through the query cache keyed by item + request, so the next item's parse can be
//     PREFETCHED while the current one is open (C3-m8) and "Accept & next" opens it already parsed.
//     `standard` / `thorough` (paid) runs always go to the server: a paid re-run must really re-run.
//   • the request is built from the item's draft: the box, the continuation `parts` (R11, C3-M3), the kind
//     (absent for a drawn box, so the engine's kind heads answer with `kindSuggestion`) and the proposal hint.

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { apiErrorMessage, persistFetchResult } from "@/lib/client-persist";
import type { Budget, ParseRequest, ParseResult } from "@/lib/parse-engine/types";
import {
  useTablesWorkspaceStore,
  type WorkspaceDraft,
  type WorkspaceItemRef,
} from "@/stores/tablesWorkspaceStore";

/** Where an inbox item came from. `draw` = a "+ Region" box; the rest mirror WP-3.F's item origins. */
export type ItemOrigin = "proposal" | "text-region" | "region" | "draw" | "classified-table" | "ensemble";

const ORIGINS: ReadonlySet<string> = new Set(["proposal", "text-region", "region", "classified-table", "ensemble"]);

/** The item's origin: the items read carries it; a ref opened from elsewhere is classified by its id. */
export function originOf(item: WorkspaceItemRef & { origin?: unknown }): ItemOrigin {
  if (item.id.startsWith("draw:")) return "draw";
  if (typeof item.origin === "string" && ORIGINS.has(item.origin)) return item.origin as ItemOrigin;
  if (item.id.startsWith("tr:")) return "text-region";
  if (item.proposalId) return "proposal";
  return "region";
}

/** Extra paid/standard choices from the EvidenceStrip; the default is the free `instant` budget. */
export interface ParseOptions {
  budget?: Budget;
  /** "Textract this crop ($)" */
  paidTextract?: boolean;
  /** "Detect cells (model)" */
  tatr?: boolean;
}

/**
 * A fresh draft for an item: bound to the item's page (K29), no ops, no result yet. A saved region's draft also
 * carries the revision and `viewHash` it was loaded at, when the caller knows them (the commit resolves them
 * otherwise).
 */
export function draftFor(item: WorkspaceItemRef, baseline?: { revision: number; viewHash?: string }): WorkspaceDraft {
  return {
    page: item.page,
    bbox: [...item.b] as WorkspaceDraft["bbox"],
    kind: item.kind,
    ...(item.classId ? { classId: item.classId } : {}),
    ...(item.regionId ? { regionId: item.regionId } : {}),
    ...(item.regionId && baseline ? { revision: baseline.revision, ...(baseline.viewHash ? { viewHash: baseline.viewHash } : {}) } : {}),
    result: null,
    ops: [],
    startedAt: 0,
  };
}

/** The engine request for an item's draft (exactly the strict `zParseRequest` shape: no extra keys). */
export function parseRequestFor(
  item: WorkspaceItemRef,
  draft: Pick<WorkspaceDraft, "page" | "bbox" | "parts" | "kind">,
  opts: ParseOptions = {},
): ParseRequest {
  const budget: Budget = opts.budget ?? (opts.paidTextract || opts.tatr ? "thorough" : "instant");
  const hints: NonNullable<ParseRequest["hints"]> = {};
  if (item.proposalId) hints.proposalId = item.proposalId;
  if (budget === "thorough" && opts.paidTextract) hints.allowPaidTextract = true;
  if (budget === "thorough" && opts.tatr) hints.tatr = true;
  return {
    page: draft.page,
    bbox: [...draft.bbox] as ParseRequest["bbox"],
    // A drawn box is parsed with no kind (the engine's kind heads answer) until the user picks one.
    ...(originOf(item) === "draw" && draft.kind === item.kind ? {} : { kind: draft.kind }),
    ...(draft.parts && draft.parts.length > 0 ? { parts: draft.parts.map((p) => [...p] as ParseRequest["bbox"]) } : {}),
    budget,
    ...(Object.keys(hints).length > 0 ? { hints } : {}),
  };
}

/** Query key of one instant parse: item + the request's identity (box, parts, kind, budget, hints). */
export function engineParseKey(publicId: string, itemKey: string, request: ParseRequest) {
  const { page, bbox, kind, parts, budget, hints } = request;
  return ["project", publicId, "parseEngine", "parse", itemKey, JSON.stringify([page, bbox, kind ?? null, parts ?? [], budget, hints ?? {}])] as const;
}

export function parseUrl(publicId: string): string {
  return `/api/projects/${encodeURIComponent(publicId)}/parse-engine/parse`;
}

/** A refused or failed parse: the HTTP status and the server's message (403 demo/paid, 429 busy, 501 no engine). */
export class EngineParseError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "EngineParseError";
    this.status = status;
  }
}

function isParseResult(body: unknown): body is ParseResult {
  if (!body || typeof body !== "object") return false;
  const b = body as Partial<ParseResult>;
  return !!b.model && typeof b.model === "object" && Array.isArray(b.alternatives) && !!b.stamp &&
    typeof b.stamp.evidenceHash === "string" && Array.isArray(b.words);
}

export async function postEngineParse(publicId: string, request: ParseRequest, signal?: AbortSignal): Promise<ParseResult> {
  const res = await persistFetchResult<unknown>(parseUrl(publicId), request, "POST", signal);
  if (!res.ok) throw new EngineParseError(res.status, apiErrorMessage(res.body) ?? `Parse failed (HTTP ${res.status})`);
  if (!isParseResult(res.body)) throw new EngineParseError(res.status, "The parse response is not in the expected shape.");
  return res.body;
}

/** Instant parses stay cached for five minutes (prefetch → open → accept is well inside that). */
export const INSTANT_PARSE_STALE_MS = 5 * 60_000;

function fetchParse(qc: QueryClient, publicId: string, itemKey: string, request: ParseRequest): Promise<ParseResult> {
  if (request.budget !== "instant") return postEngineParse(publicId, request);
  return qc.fetchQuery({
    queryKey: engineParseKey(publicId, itemKey, request),
    queryFn: ({ signal }) => postEngineParse(publicId, request, signal),
    staleTime: INSTANT_PARSE_STALE_MS,
    retry: false,
  });
}

let stampSeq = 0;
/** Monotonic request stamp (never 0, which marks a draft restored from storage with no request in flight). */
export function nextParseStamp(): number {
  stampSeq += 1;
  return stampSeq;
}

export type ParseOutcome =
  | { status: "applied"; result: ParseResult }
  | { status: "stale" }
  | { status: "error"; error: EngineParseError | Error };

/**
 * Parse one item and apply the result to its draft, unless a newer request for the same item started meanwhile
 * (its stamp no longer matches) or the draft was discarded — then the answer is dropped (`stale`).
 */
export async function parseItem(
  qc: QueryClient,
  publicId: string,
  item: WorkspaceItemRef,
  opts: ParseOptions = {},
): Promise<ParseOutcome> {
  const store = useTablesWorkspaceStore.getState();
  const draft = store.drafts[item.id] ?? draftFor(item);
  const request = parseRequestFor(item, draft, opts);
  const stamp = nextParseStamp();
  store.putDraft(item.id, { ...draft, startedAt: stamp });
  try {
    const result = await fetchParse(qc, publicId, item.id, request);
    const current = useTablesWorkspaceStore.getState().drafts[item.id];
    if (!current || current.startedAt !== stamp) return { status: "stale" };
    useTablesWorkspaceStore.getState().putDraft(item.id, { ...current, result, request });
    return { status: "applied", result };
  } catch (e) {
    const current = useTablesWorkspaceStore.getState().drafts[item.id];
    if (!current || current.startedAt !== stamp) return { status: "stale" };
    return { status: "error", error: e instanceof Error ? e : new Error(String(e)) };
  }
}

/**
 * Warm the cache with an item's instant parse (no draft is touched; a cached or in-flight key is not re-sent, and
 * neither is one whose prefetch already failed: opening the item retries it, an inbox re-read does not).
 */
export function prefetchItemParse(qc: QueryClient, publicId: string, item: WorkspaceItemRef): Promise<void> {
  const draft = useTablesWorkspaceStore.getState().drafts[item.id] ?? draftFor(item);
  const request = parseRequestFor(item, draft, { budget: "instant" });
  const queryKey = engineParseKey(publicId, item.id, request);
  if (qc.getQueryState(queryKey)?.status === "error") return Promise.resolve();
  return qc.prefetchQuery({
    queryKey,
    queryFn: ({ signal }) => postEngineParse(publicId, request, signal),
    staleTime: INSTANT_PARSE_STALE_MS,
    retry: false,
  });
}

export interface EngineParseState {
  busy: boolean;
  error: string | null;
  /** Run (or re-run) this item's parse with a budget; resolves when it settled. */
  run: (opts?: ParseOptions) => Promise<ParseOutcome | null>;
}

/**
 * The open item's parse. Runs the instant parse once when the item's draft has no result, and prefetches the
 * NEXT item at `instant` once while this one is open (C3-m8). Errors and busy state are per item.
 */
export function useEngineParse(
  publicId: string,
  item: WorkspaceItemRef | null,
  nextItem: WorkspaceItemRef | null,
  enabled = true,
): EngineParseState {
  const qc = useQueryClient();
  const hasDraft = useTablesWorkspaceStore((s) => (item ? !!s.drafts[item.id] : false));
  const hasResult = useTablesWorkspaceStore((s) => (item ? !!s.drafts[item.id]?.result : false));
  const [state, setState] = useState<{ key: string | null; busy: boolean; error: string | null }>({ key: null, busy: false, error: null });
  const itemKey = item?.id ?? null;
  const currentKey = useRef<string | null>(itemKey);
  const inFlight = useRef(0);
  useEffect(() => {
    currentKey.current = itemKey;
  }, [itemKey]);

  const run = useCallback(async (opts: ParseOptions = {}): Promise<ParseOutcome | null> => {
    const target = item;
    if (!target || !publicId) return null;
    inFlight.current += 1;
    setState({ key: target.id, busy: true, error: null });
    const outcome = await parseItem(qc, publicId, target, opts);
    inFlight.current -= 1;
    if (currentKey.current !== target.id) return outcome;
    const busy = inFlight.current > 0;
    // A stale answer changes nothing but the busy flag: the newer request owns the error and the result.
    if (outcome.status === "error") setState({ key: target.id, busy, error: outcome.error.message });
    else setState((prev) => ({ key: target.id, busy, error: outcome.status === "applied" ? null : prev.error }));
    return outcome;
  }, [qc, publicId, item]);

  // `run` changes with the item's identity (the inbox re-reads); the auto-run reads it through a ref so a
  // re-read never re-fires the parse. Refs are written in effects only (never during render).
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  }, [run]);
  useEffect(() => {
    if (!enabled || !itemKey || !hasDraft || hasResult) return;
    void runRef.current({ budget: "instant" });
  }, [enabled, itemKey, hasDraft, hasResult]);

  // Prefetch: a cached or in-flight key is never re-sent, so a new identity of the same next item is harmless.
  useEffect(() => {
    if (!enabled || !itemKey || !nextItem || !publicId) return;
    if (useTablesWorkspaceStore.getState().drafts[nextItem.id]?.result) return;
    prefetchItemParse(qc, publicId, nextItem).catch(() => { /* a failed prefetch is retried on open */ });
  }, [enabled, itemKey, nextItem, publicId, qc]);

  const mine = state.key === itemKey;
  return { busy: mine && state.busy, error: mine ? state.error : null, run };
}
