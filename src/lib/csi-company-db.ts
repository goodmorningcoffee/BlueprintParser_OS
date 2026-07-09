/**
 * csi-company-db.ts — per-company CSI database + config resolver (SPEC_FINAL §1.7).
 *
 * [refactor jul9 P2-A C1] NEW module (commit C3). Reconnects the two dormant
 * C1 "levers" — a company's stored engine config (`pipelineConfig.csi`) and its
 * uploaded custom CSI database — into ONE async funnel that every threaded
 * detect call site (commit C6) will call BEFORE opening its db.transaction.
 * SERVER-ONLY. NO caller wires it yet in this commit ⇒ zero observable route
 * change lands here (proven by the existing suite staying green).
 *
 * ── Design invariants honored ──────────────────────────────────────────────
 * • I-1: fully async here, resolved pre-transaction; the engine itself stays
 *   synchronous — it receives the resolved bundle as a plain 4th arg.
 * • I-2: `db` is a CsiDatabase bundle (entries + wordFrequency together) so
 *   anchor scoring reads the SAME frequency map the entries were built from.
 * • I-3 / I-4: the parsed custom DB is fetched at most once per company per TTL
 *   window per process (via cachedQuery, inflight-coalesced) and ANY failure —
 *   S3 error, oversize, empty/garbage parse, bad pointer — logs + falls back to
 *   builtin. This path can NEVER throw into detect.
 * • I-7: only S3 keys under `csiDbKeyPrefix(companyId)` are fetched (tenant
 *   guard); the prefix helper is shared with the upload writer (csi-database.ts).
 * • I-9: oversized stored objects (bytes or rows) are refused → builtin, so a
 *   pre-existing giant S3 object cannot become hot-path resident.
 * • I-10: `pickEngineConfig` drops a non-positive `matchingConfidenceThreshold`
 *   (a legacy z.unknown()-era stored ≤0 would otherwise return the WHOLE DB per
 *   detect call — an ingest-hot-path availability hazard).
 *
 * ── Staleness model (precise — SPEC_FINAL §1.7 docstring block) ─────────────
 * • The pipelineConfig POINTER is a fresh per-request PK read (NOT cached), so
 *   a REVERT and a company's FIRST upload are visible cluster-wide immediately
 *   (pointer absence/appearance short-circuits the cache entirely). Only the
 *   parsed S3 payload is cached.
 * • Exactly TWO flows are TTL-bounded (≤15 min) on a FOREIGN task: re-upload to
 *   the same deterministic s3Key (csi-upload.ts), and upload-after-revert within
 *   the TTL. On the INVALIDATING task both are immediate.
 * • Same-process invalidation is GENERATION-GUARDED (query-cache.ts §1.8): an
 *   in-flight load of the pre-upload object can never reinstate a stale snapshot
 *   in the invalidating process.
 * • S3 is strongly consistent — no storage-layer staleness on top.
 * • A cached FAILURE (builtin fallback) also persists ≤TTL — a deliberate
 *   anti-retry-storm choice (no S3 GET storm on a broken/deleted pointer).
 * • Memory (C1-F4): cached values are MB-scale parsed DBs, one per custom-DB
 *   company, process-lifetime resident on expiry (no sweep), bounded by the I-9
 *   caps × tenant count — accepted at current scale.
 */

import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { downloadFromS3 } from "@/lib/s3";
// [refactor jul9 P2-A C1 · DETECTOR closer jul9] only cachedQuery is used here; the
// invalidateCache caller is csi-upload.ts (imports it separately). Was an unused import
// (C3 review, CONFIRMED-cosmetic — noUnusedLocals off, so build was green regardless).
import { cachedQuery } from "@/lib/admin-logs/query-cache";
import {
  loadBuiltinCsiDatabase,
  parseCsiTsv,
  csiDbKeyPrefix,
  CSI_DB_MAX_BYTES,
  CSI_DB_MAX_ENTRIES,
  type CsiDatabase,
} from "@/lib/csi-database";
import type { CsiDetectConfig } from "@/lib/csi-detect-defs";
import { logger } from "@/lib/logger";

/** Resolved per-company CSI context handed to `detectCsiCodes` / `detectCsiFromGrid`. */
export interface CompanyCsiContext {
  /** Custom uploaded DB if resolvable+valid, otherwise the builtin masterformat. */
  db: CsiDatabase;
  /** Validated engine-config subset; `undefined` when the company stored nothing usable. */
  config: Partial<CsiDetectConfig> | undefined;
}

// [refactor jul9 P2-A C1] custom-DB payload cache TTL (SPEC_FINAL §1.7).
export const CSI_DB_CACHE_TTL_MS = 15 * 60_000;

// [refactor jul9 P2-A C1] delimiter-TERMINATED cache key (C1-F3 / C2-F5 / C3-F-9):
// the trailing ":v1" (not a bare `csi-db:${id}`) prevents prefix over-invalidation —
// invalidating company 1 must NOT evict company 11. invalidateCache is called with
// the FULL key, so the ":v1" suffix also bounds the startsWith match to this exact key.
export function csiDbCacheKey(companyId: number): string {
  return `csi-db:${companyId}:v1`;
}

/**
 * [refactor jul9 P2-A C1] Copy ONLY the 6 `CsiDetectConfig` fields out of a
 * stored (untrusted) `csi` blob, each type-checked; return `undefined` if none
 * survive so the engine falls through to DEFAULT_CSI_DETECT_CONFIG byte-for-byte.
 *
 * Exported for unit tests only (module-private in intent). The 4 orphan admin-UI
 * fields and the `customDatabase*` pointer triple are deliberately NOT copied —
 * no engine slot exists for them.
 *
 * `tier1WeightByWordCount` is ALL-OR-NOTHING: the engine's `{...DEFAULT, ...config}`
 * shallow spread replaces the whole array, so a partial/garbage array is dropped
 * wholesale rather than merged element-wise.
 *
 * I-10: `matchingConfidenceThreshold` must be `> 0` — a non-positive threshold is
 * an availability hazard (returns the entire DB per detect call), not a preference.
 */
export function pickEngineConfig(csi: unknown): Partial<CsiDetectConfig> | undefined {
  if (!csi || typeof csi !== "object" || Array.isArray(csi)) return undefined;
  const src = csi as Record<string, unknown>;
  const out: Partial<CsiDetectConfig> = {};

  const t = src.matchingConfidenceThreshold;
  if (typeof t === "number" && Number.isFinite(t) && t > 0) out.matchingConfidenceThreshold = t; // I-10

  const finiteFields = ["tier2MinWords", "tier3MinWords", "tier2Weight", "tier3Weight"] as const;
  for (const f of finiteFields) {
    const v = src[f];
    if (typeof v === "number" && Number.isFinite(v)) out[f] = v;
  }

  const w = src.tier1WeightByWordCount;
  if (Array.isArray(w) && w.length > 0 && w.every(n => typeof n === "number" && Number.isFinite(n))) {
    out.tier1WeightByWordCount = w as number[];
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Resolve a company's CSI detection context (config + database).
 *
 * @param companyId  the company to resolve for; `null`/`undefined` → builtin,
 *                   ZERO db/S3 touch (legacy/no-company callers byte-identical).
 * @param preloadedPipelineConfig  pass `companies.pipelineConfig` when the caller
 *                   already SELECTed the row (reprocess.ts), to save one PK read.
 */
export async function getCompanyCsiContext(
  companyId?: number,
  preloadedPipelineConfig?: unknown,
): Promise<CompanyCsiContext> {
  // 1. No company → builtin only, no DB/S3.
  if (companyId == null) {
    return { db: loadBuiltinCsiDatabase(), config: undefined };
  }

  // 2. Pointer read is FRESH (never cached) so admin threshold saves take effect
  //    on the next request; only the parsed S3 payload is cached (see docstring).
  let pc = preloadedPipelineConfig;
  if (pc === undefined) {
    const [row] = await db
      .select({ pipelineConfig: companies.pipelineConfig })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);
    pc = row?.pipelineConfig ?? undefined;
  }

  // 3. Tolerate legacy scalar/null/array garbage in pipelineConfig.csi (CSI-4).
  const pcObj = pc && typeof pc === "object" && !Array.isArray(pc) ? (pc as Record<string, unknown>) : {};
  const csiRaw = pcObj.csi;
  const csi = csiRaw && typeof csiRaw === "object" && !Array.isArray(csiRaw)
    ? (csiRaw as Record<string, unknown>)
    : {};

  // 4. Engine config (validated subset, or undefined).
  const config = pickEngineConfig(csi);

  // 5. No custom-DB pointer → builtin + config, no S3, no cache entry.
  const s3Key = csi.customDatabaseS3Key;
  if (typeof s3Key !== "string" || s3Key.length === 0) {
    return { db: loadBuiltinCsiDatabase(), config };
  }

  // 6. Tenant guard (I-7): only fetch keys inside this company's own prefix.
  //    A traversal-shaped key (…/company-1/../company-X/…) can PASS this
  //    startsWith check but is non-exploitable — S3 GetObject keys are literal,
  //    so it 404s → the step-7 catch falls back to builtin. Do NOT "fix" this
  //    with path normalization (see §6.2-3 traversal-key-pin test, C3-F-5).
  if (!s3Key.startsWith(csiDbKeyPrefix(companyId))) {
    logger.warn(`[csi-db] rejected foreign-prefix customDatabaseS3Key for company ${companyId}, using builtin`);
    return { db: loadBuiltinCsiDatabase(), config };
  }

  // 7. Fetch + parse the custom DB, cached per company per TTL, coalesced.
  //    The fetcher NEVER rejects — every failure resolves to builtin — so the
  //    rejected-inflight poisoning path is unreachable, and a cached failure
  //    (builtin) is deliberately retained for the TTL (anti-retry-storm).
  const resolved = await cachedQuery(csiDbCacheKey(companyId), CSI_DB_CACHE_TTL_MS, async () => {
    try {
      const buf = await downloadFromS3(s3Key);
      if (buf.byteLength > CSI_DB_MAX_BYTES) {
        // I-9 resolver guard: covers pre-existing oversized S3 objects predating the upload gate.
        logger.error(`[csi-db] custom DB oversize (${buf.byteLength}B) for company ${companyId}, using builtin`);
        return loadBuiltinCsiDatabase();
      }
      const parsed = parseCsiTsv(buf.toString("utf-8"));
      if (parsed.entries.length === 0 || parsed.entries.length > CSI_DB_MAX_ENTRIES) {
        logger.error(`[csi-db] custom DB unusable (${parsed.entries.length} rows) for company ${companyId}, using builtin`);
        return loadBuiltinCsiDatabase();
      }
      return parsed;
    } catch (err) {
      // I-4: never throw into detect. Result (builtin) is cached for the TTL.
      logger.error(`[csi-db] custom DB load failed for company ${companyId}, using builtin`, err);
      return loadBuiltinCsiDatabase();
    }
  });

  return { db: resolved, config };
}
