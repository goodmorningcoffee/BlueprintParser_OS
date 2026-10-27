/**
 * S3 crop cache for the parse engine (table pipeline PLAN §2.2 "crop caches", §1.3 E-3; WP-3.E; K17).
 *
 *   key  `{dataUrl}/cache/parse-engine/{page}/{q3(bbox)}.{method}.json`
 *   body `{ v, method, page, box, at, value }` (JSON, private, no-store)
 *
 * `q3` rounds each MinMax coordinate to 3 dp; the run service crops the ROUNDED box, so a cached value
 * is exactly the result for its key. A body whose `v`, method, page or box does not match its key is
 * a miss (never trusted). The policy of who may read or write lives in `run.ts` (`cropCachePolicy`):
 * reads are open to every caller of the parse route, writes only for signed-in callers on non-demo
 * projects, paid results always written for them, standard results only while the `cropCache` flag is
 * on. This module only stores and loads.
 *
 * The cache lives under the project's own storage root, so the project purge removes it with
 * everything else. A failed read is a miss and a failed write is logged and ignored: the cache can only
 * save work, never fail a parse.
 */

import { downloadFromS3, uploadToS3 } from "@/lib/s3";
import { logger } from "@/lib/logger";
import type { BboxMinMax } from "@/lib/parse-engine/types";
import type { CropMethodId } from "@/lib/parse-engine/types-crop";

/** Bump when a cached body's shape or a runner's output format changes: older bodies become misses. */
export const CROP_CACHE_VERSION = 1;

export interface CropCacheStore {
  getObject(key: string): Promise<string | null>;
  putObject(key: string, body: string): Promise<void>;
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000;

/** The request box rounded to 3 dp (still MinMax, clamped to [0, 1]). */
export function q3Box(b: readonly number[]): BboxMinMax {
  const c = (v: number) => Math.min(1, Math.max(0, r3(v)));
  return [c(b[0]), c(b[1]), c(b[2]), c(b[3])];
}

/** `0.120_0.340_0.560_0.780`: fixed width, so two boxes share a key iff they round to the same box. */
export function q3Key(b: readonly number[]): string {
  return q3Box(b).map((v) => v.toFixed(3)).join("_");
}

export function cropCacheKey(dataUrl: string, page: number, box: readonly number[], method: CropMethodId): string {
  return `${dataUrl}/cache/parse-engine/${page}/${q3Key(box)}.${method}.json`;
}

interface CachedBody {
  v: number;
  method: CropMethodId;
  page: number;
  box: BboxMinMax;
  at: string;
  value: unknown;
}

function isMissing(err: unknown): boolean {
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } } | null;
  return e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.Code === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
}

export const s3CropCacheStore: CropCacheStore = {
  async getObject(key) {
    try {
      return (await downloadFromS3(key)).toString("utf8");
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  },
  putObject: (key, body) => uploadToS3(key, Buffer.from(body, "utf8"), "application/json", "private, no-store"),
};

export async function readCropCache(
  store: CropCacheStore, dataUrl: string, page: number, box: readonly number[], method: CropMethodId,
): Promise<{ value: unknown } | null> {
  const key = cropCacheKey(dataUrl, page, box, method);
  let text: string | null;
  try {
    text = await store.getObject(key);
  } catch (err) {
    logger.warn("[parse-engine] crop cache read failed; treating it as a miss", { key, error: err });
    return null;
  }
  if (text === null) return null;
  try {
    const body = JSON.parse(text) as Partial<CachedBody>;
    const want = q3Key(box);
    if (body?.v !== CROP_CACHE_VERSION || body.method !== method || body.page !== page || !Array.isArray(body.box) || q3Key(body.box) !== want || !("value" in body)) {
      return null;
    }
    return { value: body.value };
  } catch {
    logger.warn("[parse-engine] crop cache body is not valid JSON; treating it as a miss", { key });
    return null;
  }
}

/** Returns whether the object was written. Never throws. */
export async function writeCropCache(
  store: CropCacheStore, dataUrl: string, page: number, box: readonly number[], method: CropMethodId, value: unknown, now: Date = new Date(),
): Promise<boolean> {
  const key = cropCacheKey(dataUrl, page, box, method);
  const body: CachedBody = { v: CROP_CACHE_VERSION, method, page, box: q3Box(box), at: now.toISOString(), value };
  try {
    await store.putObject(key, JSON.stringify(body));
    return true;
  } catch (err) {
    logger.warn("[parse-engine] crop cache write failed; the result is returned uncached", { key, error: err });
    return false;
  }
}
