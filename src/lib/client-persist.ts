/**
 * Client-side persistence helpers. Use these for EVERY user-created-artifact DB
 * write so failures surface instead of silently dropping work.
 *
 * Background: inconsistent saves in admin mode traced to (a) silent
 * `.catch(() => {})` swallowing server errors, (b) gating persistence on the
 * numeric `projectId` (which starts at 0), and (c) the pages/intelligence
 * blob-overwrite clobbering sibling regions. The rule now:
 *   - gate on `publicId` (string, resolvable by every route + root-admin-safe)
 *   - never silently swallow — `persistFetch` throws a useful Error on !ok
 *   - parsed regions go through transactional /api/regions/promote (upsert) or /api/regions (delete)
 */

import type {
  BboxMinMax,
  PageIntelligence,
  ParsedRegionType,
  ProjectSummaries,
} from "@/types";

export type ParsedRegionKind = ParsedRegionType;

/** The promote route accepts this historical wire subset; full CsiCode requires server enrichment. */
export interface ParsedRegionPromotionCsiTag {
  code: string;
  description: string;
}

/** Truthful promote-response shape while canonical ParsedRegion.bbox still incorrectly says LTWH. */
export interface PromotedParsedRegion {
  id: string;
  type: ParsedRegionType;
  category: string;
  bbox: BboxMinMax;
  confidence: number;
  csiTags?: ParsedRegionPromotionCsiTag[];
  data: Record<string, unknown>;
  source?: "user" | "auto-detected";
  sourceTextRegionId?: string;
}

export interface ParsedRegionParserPromotionRequest {
  publicId: string;
  pageNumber: number;
  type: ParsedRegionKind;
  regionId: string;
  bbox: BboxMinMax;
  data: Record<string, unknown>;
  category?: string;
  csiTags?: ParsedRegionPromotionCsiTag[];
}

export interface ParsedRegionClassifierPromotionRequest {
  publicId: string;
  pageNumber: number;
  type: ParsedRegionKind;
  sourceTextRegionId: string;
}

export type PromoteParsedRegionRequest =
  | ParsedRegionParserPromotionRequest
  | ParsedRegionClassifierPromotionRequest;

export interface PromoteParsedRegionResponse {
  ok: true;
  parsedRegion: PromotedParsedRegion;
  updatedIntelligence: PageIntelligence;
  summaries: ProjectSummaries | null;
}

export interface DeletePersistedParsedRegionRequest {
  publicId: string;
  pageNumber: number;
  regionId: string;
}

export interface DeletePersistedParsedRegionResponse {
  ok: true;
  deleted: boolean;
  updatedIntelligence: PageIntelligence;
  summaries: ProjectSummaries | null;
}

/** True when the current project can accept DB writes. Gate persistence on this
 *  (publicId-based), NOT on the numeric projectId. */
export function canPersist(publicId: string | null | undefined, isDemo: boolean): boolean {
  return !!publicId && !isDemo;
}

/**
 * [refactor jun16 P1.2] Extract a human-readable message from an API error body, tolerant of
 * BOTH envelopes the app serves DURING the P1 migration: the legacy `{ error: "msg" }` (bare
 * string, un-migrated routes) and the route-shell's `{ error: { code, message } }`. Returns
 * undefined when neither shape matches (caller falls back to a status string).
 */
export function apiErrorMessage(body: unknown): string | undefined {
  const e = (body as { error?: unknown } | null | undefined)?.error;
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") {
    return (e as { message: string }).message;
  }
  return undefined;
}

/**
 * Fetch that AWAITS, checks `res.ok`, and THROWS a useful Error on failure.
 * Returns parsed JSON (or null if the body isn't JSON). Never swallows errors.
 */
export async function persistFetch(
  url: string,
  body: unknown,
  method: "POST" | "PUT" | "PATCH" | "DELETE" = "POST",
  signal?: AbortSignal,
): Promise<unknown> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    throw new Error(`Network error while saving: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      const msg = apiErrorMessage(await resp.json());
      if (msg) detail = msg;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail);
  }
  try {
    return await resp.json();
  } catch {
    return null;
  }
}

/**
 * Upsert a parsed region (table/keynote/notes/spec/legend) through the
 * transactional /api/regions/promote route. Pass a STABLE `regionId` so that
 * re-parsing the same region REPLACES the prior region instead of duplicating.
 *
 * Returns `{ ok, parsedRegion, updatedIntelligence, summaries }`. The C2 Query-aware command is
 * the sole production caller and adopts that authoritative response; components do not rebuild
 * the persistence tail around this low-level wire helper.
 */
export async function promoteParsedRegion(
  args: PromoteParsedRegionRequest,
): Promise<PromoteParsedRegionResponse> {
  const request = "sourceTextRegionId" in args
    ? {
        publicId: args.publicId,
        pageNumber: args.pageNumber,
        type: args.type,
        sourceTextRegionId: args.sourceTextRegionId,
      }
    : {
        publicId: args.publicId,
        pageNumber: args.pageNumber,
        type: args.type,
        overrides: {
          regionId: args.regionId,
          bbox: args.bbox,
          data: args.data,
          category: args.category,
          csiTags: args.csiTags,
        },
      };
  return persistFetch("/api/regions/promote", request) as Promise<PromoteParsedRegionResponse>;
}

/**
 * Delete one persisted ParsedRegion through the transactional region endpoint. The Query-aware
 * command is the sole production caller and owns authoritative cache adoption; this helper owns
 * only the exact low-level wire contract.
 */
export async function deletePersistedParsedRegion(
  args: DeletePersistedParsedRegionRequest,
): Promise<DeletePersistedParsedRegionResponse> {
  return persistFetch("/api/regions", {
    publicId: args.publicId,
    pageNumber: args.pageNumber,
    regionId: args.regionId,
  }, "DELETE") as Promise<DeletePersistedParsedRegionResponse>;
}

/** Deterministic, stable region id from page + normalized bbox, so re-parsing
 *  the same drawn region upserts (replaces) rather than appending a duplicate. */
export function regionIdFor(pageNumber: number, bbox: [number, number, number, number]): string {
  const q = (n: number) => Math.round(n * 1000); // 0.001 normalized-unit bucket
  return `pr-${pageNumber}-${q(bbox[0])}-${q(bbox[1])}-${q(bbox[2])}-${q(bbox[3])}`;
}
