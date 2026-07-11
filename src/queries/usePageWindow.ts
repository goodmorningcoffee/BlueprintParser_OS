"use client";

import { useCallback } from "react";
import {
  notifyManager,
  useQuery,
  type QueryClient,
} from "@tanstack/react-query";
import {
  buildBootstrapPageWindow,
  EMPTY_ACTIVE_PAGE_WINDOW,
  mergeNormalizedNavigationPageWindow,
  normalizePageWindowPages,
  type ActivePageWindow,
  type LoadedPageRange,
  type PageWindowResponse,
} from "@/queries/pageWindowCore";
import { queryKeys } from "@/queries/queryKeys";
import { useViewerStore } from "@/stores/viewerStore";
import type {
  CsiCode,
  KeynoteShapeData,
  PageIntelligence,
  TextAnnotation,
} from "@/types";

// [refactor jul11 P2.2⑦ C3] Live active-page-window facade. The authoritative contract is
// P2_DESIGN/PAGES_WINDOW_IMPL/SPEC.md. This module deliberately owns no transport observer: eager
// bootstrap and the explicit navigation state machine remain imperative and publish through the paired
// helpers below. Components use narrow selectors unless they are on the scan-all product whitelist.

export const EMPTY_KEYNOTES_FOR_PAGE = Object.freeze([]) as unknown as KeynoteShapeData[];
export const EMPTY_CSI_CODES_FOR_PAGE = Object.freeze([]) as unknown as CsiCode[];
export const EMPTY_TEXT_ANNOTATIONS_FOR_PAGE = Object.freeze([]) as unknown as TextAnnotation[];

type PageWindowSelector<T> = (window: ActivePageWindow) => T;

function unavailablePageWindowQuery(): ActivePageWindow {
  throw new Error("pagesWindow is bootstrap/navigation seeded; queryFn must never run");
}

/** One shared disabled-query configuration; callers track `data` only. */
function usePageWindowSelection<T>(select: PageWindowSelector<T>): T | undefined {
  const publicId = useViewerStore((state) => state.publicId);
  const { data } = useQuery({
    queryKey: queryKeys.pagesWindow.active(publicId),
    queryFn: unavailablePageWindowQuery,
    enabled: false,
    initialData: EMPTY_ACTIVE_PAGE_WINDOW,
    staleTime: Infinity,
    gcTime: Infinity,
    select,
    // Keep TanStack's default structural sharing. Do not track status/fetch metadata here.
  });
  return data;
}

const selectLoadedRange = (window: ActivePageWindow) => window.loadedRange;
const selectKeynotesByPage = (window: ActivePageWindow) => window.keynotes;
const selectCsiCodesByPage = (window: ActivePageWindow) => window.csiCodes;
const selectTextAnnotationsByPage = (window: ActivePageWindow) => window.textAnnotations;
const selectPageIntelligenceByPage = (window: ActivePageWindow) => window.pageIntelligence;

export function useLoadedPageRange(): LoadedPageRange | null {
  return usePageWindowSelection(selectLoadedRange) ?? null;
}

export function useKeynotesForPage(pageNumber: number): KeynoteShapeData[] {
  const select = useCallback(
    (window: ActivePageWindow) => window.keynotes[pageNumber] ?? EMPTY_KEYNOTES_FOR_PAGE,
    [pageNumber],
  );
  return usePageWindowSelection(select) ?? EMPTY_KEYNOTES_FOR_PAGE;
}

export function useCsiCodesForPage(pageNumber: number): CsiCode[] {
  const select = useCallback(
    (window: ActivePageWindow) => window.csiCodes[pageNumber] ?? EMPTY_CSI_CODES_FOR_PAGE,
    [pageNumber],
  );
  return usePageWindowSelection(select) ?? EMPTY_CSI_CODES_FOR_PAGE;
}

export function useTextAnnotationsForPage(pageNumber: number): TextAnnotation[] {
  const select = useCallback(
    (window: ActivePageWindow) =>
      window.textAnnotations[pageNumber] ?? EMPTY_TEXT_ANNOTATIONS_FOR_PAGE,
    [pageNumber],
  );
  return usePageWindowSelection(select) ?? EMPTY_TEXT_ANNOTATIONS_FOR_PAGE;
}

export function usePageIntelligenceForPage(pageNumber: number): PageIntelligence | undefined {
  const select = useCallback(
    (window: ActivePageWindow) => window.pageIntelligence[pageNumber],
    [pageNumber],
  );
  return usePageWindowSelection(select);
}

export function useKeynotesByPage(): ActivePageWindow["keynotes"] {
  return usePageWindowSelection(selectKeynotesByPage) ?? EMPTY_ACTIVE_PAGE_WINDOW.keynotes;
}

export function useCsiCodesByPage(): ActivePageWindow["csiCodes"] {
  return usePageWindowSelection(selectCsiCodesByPage) ?? EMPTY_ACTIVE_PAGE_WINDOW.csiCodes;
}

export function useTextAnnotationsByPage(): ActivePageWindow["textAnnotations"] {
  return (
    usePageWindowSelection(selectTextAnnotationsByPage) ??
    EMPTY_ACTIVE_PAGE_WINDOW.textAnnotations
  );
}

export function usePageIntelligenceByPage(): ActivePageWindow["pageIntelligence"] {
  return (
    usePageWindowSelection(selectPageIntelligenceByPage) ??
    EMPTY_ACTIVE_PAGE_WINDOW.pageIntelligence
  );
}

// ── Synchronous handler-time readers ──────────────────────────────────────────────────────────

export function readActivePageWindow(qc: QueryClient, publicId: string): ActivePageWindow {
  return (
    qc.getQueryData<ActivePageWindow>(queryKeys.pagesWindow.active(publicId)) ??
    EMPTY_ACTIVE_PAGE_WINDOW
  );
}

export function readKeynotesForPage(
  qc: QueryClient,
  publicId: string,
  pageNumber: number,
): KeynoteShapeData[] {
  return readActivePageWindow(qc, publicId).keynotes[pageNumber] ?? EMPTY_KEYNOTES_FOR_PAGE;
}

export function readCsiCodesForPage(
  qc: QueryClient,
  publicId: string,
  pageNumber: number,
): CsiCode[] {
  return readActivePageWindow(qc, publicId).csiCodes[pageNumber] ?? EMPTY_CSI_CODES_FOR_PAGE;
}

export function readTextAnnotationsForPage(
  qc: QueryClient,
  publicId: string,
  pageNumber: number,
): TextAnnotation[] {
  return (
    readActivePageWindow(qc, publicId).textAnnotations[pageNumber] ??
    EMPTY_TEXT_ANNOTATIONS_FOR_PAGE
  );
}

export function readPageIntelligence(
  qc: QueryClient,
  publicId: string,
  pageNumber: number,
): PageIntelligence | undefined {
  return readActivePageWindow(qc, publicId).pageIntelligence[pageNumber];
}

type ActiveWindowUpdater = (oldWindow: ActivePageWindow) => ActivePageWindow;

function updateActivePageWindow(
  qc: QueryClient,
  publicId: string,
  updater: ActiveWindowUpdater,
): void {
  qc.setQueryData<ActivePageWindow>(
    queryKeys.pagesWindow.active(publicId),
    (oldWindow) => updater(oldWindow ?? EMPTY_ACTIVE_PAGE_WINDOW),
  );
}

// ── Semantic writers (no permissive generic deep merge is exported) ──────────────────────────

export function setKeynotesForPage(
  qc: QueryClient,
  publicId: string,
  pageNumber: number,
  keynotes: KeynoteShapeData[],
): void {
  updateActivePageWindow(qc, publicId, (oldWindow) => {
    if (oldWindow.keynotes[pageNumber] === keynotes) return oldWindow;
    return {
      ...oldWindow,
      keynotes: { ...oldWindow.keynotes, [pageNumber]: keynotes },
    };
  });
}

export type KeynotesPageUpdater = (current: KeynoteShapeData[]) => KeynoteShapeData[];

export function updateKeynotesForPage(
  qc: QueryClient,
  publicId: string,
  pageNumber: number,
  updater: KeynotesPageUpdater,
): void {
  updateActivePageWindow(qc, publicId, (oldWindow) => {
    const current = oldWindow.keynotes[pageNumber] ?? EMPTY_KEYNOTES_FOR_PAGE;
    const next = updater(current);
    if (next === current) return oldWindow;
    return {
      ...oldWindow,
      keynotes: { ...oldWindow.keynotes, [pageNumber]: next },
    };
  });
}

export function appendKeynotesForPage(
  qc: QueryClient,
  publicId: string,
  pageNumber: number,
  additions: readonly KeynoteShapeData[],
): void {
  if (additions.length === 0) return;
  updateKeynotesForPage(qc, publicId, pageNumber, (current) => [...current, ...additions]);
}

export function mergeKeynotesByPage(
  qc: QueryClient,
  publicId: string,
  updates: Readonly<Record<number, KeynoteShapeData[]>>,
): void {
  const entries = Object.entries(updates);
  if (entries.length === 0) return;
  updateActivePageWindow(qc, publicId, (oldWindow) => {
    if (entries.every(([pageNumber, value]) => oldWindow.keynotes[Number(pageNumber)] === value)) {
      return oldWindow;
    }
    return { ...oldWindow, keynotes: { ...oldWindow.keynotes, ...updates } };
  });
}

export function setCsiCodesForPage(
  qc: QueryClient,
  publicId: string,
  pageNumber: number,
  codes: CsiCode[],
): void {
  updateActivePageWindow(qc, publicId, (oldWindow) => {
    if (oldWindow.csiCodes[pageNumber] === codes) return oldWindow;
    return {
      ...oldWindow,
      csiCodes: { ...oldWindow.csiCodes, [pageNumber]: codes },
    };
  });
}

export function setPageIntelligenceForPage(
  qc: QueryClient,
  publicId: string,
  pageNumber: number,
  intelligence: PageIntelligence,
): void {
  updateActivePageWindow(qc, publicId, (oldWindow) => {
    if (oldWindow.pageIntelligence[pageNumber] === intelligence) return oldWindow;
    return {
      ...oldWindow,
      pageIntelligence: {
        ...oldWindow.pageIntelligence,
        [pageNumber]: intelligence,
      },
    };
  });
}

export type PageIntelligenceUpdater = (
  current: PageIntelligence | undefined,
) => PageIntelligence;

export function updatePageIntelligenceForPage(
  qc: QueryClient,
  publicId: string,
  pageNumber: number,
  updater: PageIntelligenceUpdater,
): void {
  updateActivePageWindow(qc, publicId, (oldWindow) => {
    const current = oldWindow.pageIntelligence[pageNumber];
    const next = updater(current);
    if (next === current) return oldWindow;
    return {
      ...oldWindow,
      pageIntelligence: { ...oldWindow.pageIntelligence, [pageNumber]: next },
    };
  });
}

// ── Ordered annotation + active-window publication ───────────────────────────────────────────

export function publishBootstrapPageWindow(
  qc: QueryClient,
  publicId: string,
  response: PageWindowResponse | null | undefined,
  numPages: number | null | undefined,
): void {
  const activeWindow = response
    ? buildBootstrapPageWindow(response, numPages)
    : EMPTY_ACTIVE_PAGE_WINDOW;

  notifyManager.batch(() => {
    // Physical order is load-bearing: a synchronous active-window reader may never see annotations
    // older than the range it just observed. Both writes remain in this one no-await callback.
    qc.setQueryData(queryKeys.annotations.all(publicId), response?.annotations ?? []);
    qc.setQueryData(queryKeys.pagesWindow.active(publicId), activeWindow);
  });
}

export interface NavigationPageWindowPublication {
  actualFrom: number;
  actualTo: number;
  /** Generation/identity predicate evaluated once immediately before the first cache write. */
  isCurrent: () => boolean;
}

export function publishNavigationPageWindow(
  qc: QueryClient,
  publicId: string,
  response: PageWindowResponse,
  publication: NavigationPageWindowPublication,
): boolean {
  if (!publication.isCurrent()) return false;

  // Complete the ONE pure wire walk before annotations become visible. The pre-normalized maps flow
  // into the functional response-time update below, so a stateful/malformed row cannot be reread or
  // leave annotations-new + active-window-old.
  const incoming = normalizePageWindowPages(response.pages);

  notifyManager.batch(() => {
    qc.setQueryData(queryKeys.annotations.all(publicId), response.annotations);
    qc.setQueryData<ActivePageWindow>(
      queryKeys.pagesWindow.active(publicId),
      (oldWindow) =>
        mergeNormalizedNavigationPageWindow(
          oldWindow ?? EMPTY_ACTIVE_PAGE_WINDOW,
          incoming,
          publication.actualFrom,
          publication.actualTo,
        ),
    );
  });
  return true;
}

// ── AutoQto exact-page intelligence detail ───────────────────────────────────────────────────

export class PageWindowHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Page window request failed: ${status}`);
    this.name = "PageWindowHttpError";
    this.status = status;
  }
}

export interface EnsurePageIntelligenceOptions {
  publicId: string;
  pageNumber: number;
  isDemo: boolean;
  signal?: AbortSignal;
}

/**
 * Fetch exactly one page for AutoQto's detail fallback and adopt only that page's PI object.
 * HTTP status is typed for the caller's existing status message; network/JSON errors pass through.
 */
export async function ensurePageIntelligence(
  qc: QueryClient,
  options: EnsurePageIntelligenceOptions,
): Promise<PageIntelligence | undefined> {
  const base = options.isDemo ? "/api/demo/projects" : "/api/projects";
  const endpoint = `${base}/${options.publicId}/pages?from=${options.pageNumber}&to=${options.pageNumber}`;
  // Preserve AutoQto's one-argument fetch arity unless a caller explicitly supplies a signal.
  const response = options.signal
    ? await fetch(endpoint, { signal: options.signal })
    : await fetch(endpoint);
  if (!response.ok) throw new PageWindowHttpError(response.status);

  const payload = (await response.json()) as PageWindowResponse;
  // The exact N..N route returns at most that requested row. Keep the live caller's pages[0]
  // adoption semantics instead of inventing a new malformed-response policy during extraction.
  const intelligence = payload.pages[0]?.pageIntelligence;
  if (!intelligence) return undefined;

  setPageIntelligenceForPage(
    qc,
    options.publicId,
    options.pageNumber,
    intelligence,
  );
  return intelligence;
}
