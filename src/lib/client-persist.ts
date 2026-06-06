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
 *   - parsed regions go through the transactional /api/regions/promote (upsert)
 */

export type ParsedRegionKind = "schedule" | "keynote" | "notes" | "spec" | "legend";

/** True when the current project can accept DB writes. Gate persistence on this
 *  (publicId-based), NOT on the numeric projectId. */
export function canPersist(publicId: string | null | undefined, isDemo: boolean): boolean {
  return !!publicId && !isDemo;
}

/**
 * Fetch that AWAITS, checks `res.ok`, and THROWS a useful Error on failure.
 * Returns parsed JSON (or null if the body isn't JSON). Never swallows errors.
 */
export async function persistFetch(
  url: string,
  body: unknown,
  method: "POST" | "PUT" | "PATCH" | "DELETE" = "POST",
): Promise<unknown> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`Network error while saving: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      const j = await resp.json();
      if (j?.error) detail = j.error;
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
 * Returns the server response `{ ok, parsedRegion, updatedIntelligence, summaries }`
 * — callers should adopt `updatedIntelligence` as the authoritative store value
 * rather than trusting an optimistic local blob.
 */
export async function promoteParsedRegion(args: {
  publicId: string;
  pageNumber: number;
  type: ParsedRegionKind;
  regionId: string;
  bbox: [number, number, number, number];
  data: Record<string, unknown>;
  category?: string;
  csiTags?: { code: string; description: string }[];
}): Promise<{
  ok: true;
  parsedRegion: unknown;
  updatedIntelligence: Record<string, unknown>;
  summaries: unknown;
}> {
  const { publicId, pageNumber, type, regionId, bbox, data, category, csiTags } = args;
  return persistFetch("/api/regions/promote", {
    publicId,
    pageNumber,
    type,
    overrides: { regionId, bbox, data, category, csiTags },
  }) as Promise<{
    ok: true;
    parsedRegion: unknown;
    updatedIntelligence: Record<string, unknown>;
    summaries: unknown;
  }>;
}

/** Deterministic, stable region id from page + normalized bbox, so re-parsing
 *  the same drawn region upserts (replaces) rather than appending a duplicate. */
export function regionIdFor(pageNumber: number, bbox: [number, number, number, number]): string {
  const q = (n: number) => Math.round(n * 1000); // 0.001 normalized-unit bucket
  return `pr-${pageNumber}-${q(bbox[0])}-${q(bbox[1])}-${q(bbox[2])}-${q(bbox[3])}`;
}
