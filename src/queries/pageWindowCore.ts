import type {
  ClientAnnotation,
  CsiCode,
  KeynoteShapeData,
  PageIntelligence,
  TextAnnotation,
  TextAnnotationResult,
} from "@/types";

/**
 * Canonical client-side shape of one row returned by either `/pages` route.
 *
 * The four window fields are optional as well as nullable because old JSON rows and sparse fixtures
 * can omit them. That omission is meaningful: normalization emits no incoming value for that map,
 * allowing a retained client value to survive a later navigation merge.
 */
export interface PageWindowResponsePage {
  pageNumber: number;
  name: string;
  drawingNumber: string | null;
  keynotes?: KeynoteShapeData[] | null;
  csiCodes?: CsiCode[] | null;
  textAnnotations?: Partial<TextAnnotationResult> | null;
  pageIntelligence?: PageIntelligence | null;
}

/** Shared wire contract for bootstrap, navigation, and exact-page detail consumers. */
export interface PageWindowResponse {
  from: number;
  to: number;
  pages: PageWindowResponsePage[];
  annotations: ClientAnnotation[];
}

export interface LoadedPageRange {
  from: number;
  to: number;
}

export interface PageWindowMaps {
  readonly keynotes: Readonly<Record<number, KeynoteShapeData[]>>;
  readonly csiCodes: Readonly<Record<number, CsiCode[]>>;
  readonly textAnnotations: Readonly<Record<number, TextAnnotation[]>>;
  readonly pageIntelligence: Readonly<Record<number, PageIntelligence>>;
}

export interface ActivePageWindow extends PageWindowMaps {
  readonly loadedRange: LoadedPageRange | null;
}

const EMPTY_KEYNOTES = Object.freeze({}) as Readonly<Record<number, KeynoteShapeData[]>>;
const EMPTY_CSI_CODES = Object.freeze({}) as Readonly<Record<number, CsiCode[]>>;
const EMPTY_TEXT_ANNOTATIONS = Object.freeze({}) as Readonly<Record<number, TextAnnotation[]>>;
const EMPTY_PAGE_INTELLIGENCE = Object.freeze({}) as Readonly<
  Record<number, PageIntelligence>
>;

/**
 * Stable, deeply immutable absence sentinel for the future imperative-seed cache facade.
 * Pure helpers never mutate it; callers may safely use it as the response-time merge default.
 */
export const EMPTY_ACTIVE_PAGE_WINDOW: ActivePageWindow = Object.freeze({
  loadedRange: null,
  keynotes: EMPTY_KEYNOTES,
  csiCodes: EMPTY_CSI_CODES,
  textAnnotations: EMPTY_TEXT_ANNOTATIONS,
  pageIntelligence: EMPTY_PAGE_INTELLIGENCE,
});

export const PAGE_WINDOW_RETENTION_BUFFER = 5;

/**
 * Convert sparse wire rows into the four active maps without applying any cache/range policy.
 *
 * Deliberately uses JavaScript truthiness to match the three current callers: empty arrays create
 * keys, null/undefined fields do not, a truthy text wrapper with no annotations creates `[]`, and a
 * later duplicate page row replaces the earlier value independently for each provided field.
 */
export function normalizePageWindowPages(
  pages: readonly PageWindowResponsePage[],
): PageWindowMaps {
  const keynotes: Record<number, KeynoteShapeData[]> = {};
  const csiCodes: Record<number, CsiCode[]> = {};
  const textAnnotations: Record<number, TextAnnotation[]> = {};
  const pageIntelligence: Record<number, PageIntelligence> = {};

  for (const page of pages) {
    if (page.keynotes) keynotes[page.pageNumber] = page.keynotes;
    if (page.csiCodes) csiCodes[page.pageNumber] = page.csiCodes;
    if (page.textAnnotations) {
      textAnnotations[page.pageNumber] = page.textAnnotations.annotations || [];
    }
    if (page.pageIntelligence) {
      pageIntelligence[page.pageNumber] = page.pageIntelligence;
    }
  }

  return { keynotes, csiCodes, textAnnotations, pageIntelligence };
}

/** Reproduce both eager loaders' special initial-range rule exactly. */
export function deriveBootstrapLoadedRange(
  pages: readonly Pick<PageWindowResponsePage, "pageNumber">[],
  numPages: number | null | undefined,
): LoadedPageRange {
  return {
    from: 1,
    to:
      pages.length > 0
        ? Math.max(...pages.map((page) => page.pageNumber))
        : Math.min(numPages || 1, 15),
  };
}

/** Build a successful eager-bootstrap value. Bootstrap intentionally performs no retention merge. */
export function buildBootstrapPageWindow(
  response: Pick<PageWindowResponse, "pages">,
  numPages: number | null | undefined,
): ActivePageWindow {
  return {
    loadedRange: deriveBootstrapLoadedRange(response.pages, numPages),
    ...normalizePageWindowPages(response.pages),
  };
}

function retainAndOverlay<T>(
  oldMap: Readonly<Record<number, T>>,
  incomingMap: Readonly<Record<number, T>>,
  evictFrom: number,
  evictTo: number,
): Readonly<Record<number, T>> {
  const next: Record<number, T> = {};
  let changed = false;

  for (const [rawPageNumber, value] of Object.entries(oldMap)) {
    const pageNumber = Number(rawPageNumber);
    if (pageNumber >= evictFrom && pageNumber <= evictTo) {
      next[pageNumber] = value;
    } else {
      changed = true;
    }
  }

  // Response fields are overlaid last. Object identity is a useful change detector here: a new
  // server array/object replaces the retained value even when its contents happen to be equal.
  for (const [rawPageNumber, value] of Object.entries(incomingMap)) {
    const pageNumber = Number(rawPageNumber);
    if (!Object.prototype.hasOwnProperty.call(next, pageNumber) || next[pageNumber] !== value) {
      changed = true;
    }
    next[pageNumber] = value;
  }

  // Preserve an unrelated map reference when retention removed nothing and this response supplied
  // no changed value for it. Retained page values themselves always keep their original references.
  return changed ? next : oldMap;
}

/**
 * Apply one navigation response to the response-time active value.
 *
 * `response.from/to` are intentionally absent from every decision below. The locally computed range
 * is authoritative even for sparse or empty responses. Each map retains ±5 independently, then lets
 * normalized response-provided fields win.
 */
export function mergeNavigationPageWindow(
  oldWindow: ActivePageWindow,
  response: PageWindowResponse,
  actualFrom: number,
  actualTo: number,
): ActivePageWindow {
  const incoming = normalizePageWindowPages(response.pages);
  const evictFrom = actualFrom - PAGE_WINDOW_RETENTION_BUFFER;
  const evictTo = actualTo + PAGE_WINDOW_RETENTION_BUFFER;

  return {
    loadedRange: { from: actualFrom, to: actualTo },
    keynotes: retainAndOverlay(oldWindow.keynotes, incoming.keynotes, evictFrom, evictTo),
    csiCodes: retainAndOverlay(oldWindow.csiCodes, incoming.csiCodes, evictFrom, evictTo),
    textAnnotations: retainAndOverlay(
      oldWindow.textAnnotations,
      incoming.textAnnotations,
      evictFrom,
      evictTo,
    ),
    pageIntelligence: retainAndOverlay(
      oldWindow.pageIntelligence,
      incoming.pageIntelligence,
      evictFrom,
      evictTo,
    ),
  };
}
