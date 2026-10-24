// [tiles T9 2026-10-24] Root-only switch for upload-time tiling (+ the tile level list). Stored in
// the existing app_settings table under TILES_SETTING_KEY as { enabled, levels } — no schema change.
//
//   GET /api/admin/tiles → { enabled, levels, overlap, valid, defaults }                 (auth:"root")
//   PUT /api/admin/tiles   { enabled, levels? } — levels validated by lib/tiles/plan.ts  (auth:"root")
//       The write and its audit_log row commit in one transaction.
//
// readTilesSetting() is the RUN-PATH reader (processing.ts, once per project run; reprocess-tiles
// for the level list): it never throws — a missing row, a hand-edited bad field or a failed read
// all resolve to the defaults (ON, [3600, 1280]) and the anomaly is logged. The generic
// /api/admin/app-settings route refuses this key, so every write passes the validation here.
// Modelled on services/upload-compute.ts (7de15bd).

import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { appSettings, auditLog } from "@/lib/db/schema";
import type { AuthSession } from "@/lib/api-utils";
import { ApiError } from "@/server/api/envelope";
import { logger } from "@/lib/logger";
import { MAX_TILE_SIZE, MIN_TILE_SIZE } from "@/lib/tiles/plan";
import {
  DEFAULT_TILES_SETTING,
  MAX_TILE_LEVELS,
  TILES_SETTING_KEY,
  isTileLevelList,
  resolveTilesSetting,
  type TilesSetting,
} from "@/lib/tiles/settings";

export const TILES_AUDIT_ACTION = "tiles_setting_changed";

export const zTilesPut = z
  .object({
    enabled: z.boolean(),
    levels: z
      .array(z.number().int().min(MIN_TILE_SIZE).max(MAX_TILE_SIZE))
      .min(1)
      .max(MAX_TILE_LEVELS)
      .refine(isTileLevelList, { message: "levels must be unique tile sizes in px" })
      .optional(),
  })
  .strict();
export type TilesPutBody = z.infer<typeof zTilesPut>;

async function storedValue(): Promise<unknown> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, TILES_SETTING_KEY))
    .limit(1);
  return row?.value;
}

/** Run-path reader. Never throws; unknown/missing/failed read → the defaults (+ log when anomalous). */
export async function readTilesSetting(): Promise<TilesSetting> {
  try {
    const value = await storedValue();
    const resolved = resolveTilesSetting(value);
    if (!resolved.valid && value !== undefined) {
      logger.warn("[tiles] app_settings holds an invalid tiles document; using the defaults for its bad fields", {
        key: TILES_SETTING_KEY,
        stored: typeof resolved.raw,
        fallback: DEFAULT_TILES_SETTING,
      });
    }
    return resolved.setting;
  } catch (err) {
    logger.error(`[tiles] reading ${TILES_SETTING_KEY} failed; using the defaults`, { error: err });
    return resolveTilesSetting(undefined).setting;
  }
}

export async function getTilesSetting(): Promise<TilesSetting & { valid: boolean; defaults: TilesSetting }> {
  const resolved = resolveTilesSetting(await storedValue());
  return { ...resolved.setting, valid: resolved.valid, defaults: DEFAULT_TILES_SETTING };
}

export async function putTilesSetting(
  body: TilesPutBody,
  session: AuthSession,
): Promise<{ success: true; enabled: boolean; levels: number[] }> {
  // The route is auth:"root"; this is the in-service belt so no other caller can reach a write.
  if (!session.user.isRootAdmin) throw new ApiError("FORBIDDEN", "Root admin required");
  const levels = body.levels ?? [...DEFAULT_TILES_SETTING.levels];
  if (!isTileLevelList(levels)) throw new ApiError("VALIDATION", "levels must be unique tile sizes in px");
  const value = { enabled: body.enabled, levels };

  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, TILES_SETTING_KEY))
      .for("update");
    const before = row ? resolveTilesSetting(row.value).raw ?? null : null;
    await tx
      .insert(appSettings)
      .values({ key: TILES_SETTING_KEY, value, updatedBy: session.user.dbId })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value, updatedBy: session.user.dbId, updatedAt: new Date() },
      });
    await tx.insert(auditLog).values({
      action: TILES_AUDIT_ACTION,
      userId: session.user.dbId,
      companyId: session.user.companyId,
      details: { before, after: value },
    });
  });

  return { success: true, enabled: value.enabled, levels: value.levels };
}
