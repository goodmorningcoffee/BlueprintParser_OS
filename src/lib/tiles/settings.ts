// [tiles T9 2026-10-24] Root-only switch + level list for upload-time tiling. Stored in the existing
// app_settings table under TILES_SETTING_KEY as { enabled, levels } — no schema change. Pure and
// client-safe: the admin toggle renders from it, the server validates writes against it, and the
// upload pipeline's reader (services/tiles-setting.ts) falls back to these defaults for anything it
// cannot read. Default ON: the owner asked for every page to be tiled at upload; root can switch it
// off here. The Reprocess "Tile images" stage ignores the switch (an explicit admin action).

import { DEFAULT_TILE_OVERLAP, isTileSize } from "./plan";

export const TILES_SETTING_KEY = "tiles_enabled";

/** 3600 px ≈ detector input at 3x the whole-page shrink; 1280 px = yolo_text's input size. 1824 (yolo_primitive) is a candidate third level. */
export const DEFAULT_TILE_LEVELS: readonly number[] = [3600, 1280];
export const MAX_TILE_LEVELS = 4;

export interface TilesSetting {
  enabled: boolean;
  /** Tile edge sizes in px, one level each; validated unique and within plan.ts bounds. */
  levels: number[];
  overlap: number;
}

export const DEFAULT_TILES_SETTING: TilesSetting = Object.freeze({
  enabled: true,
  levels: [...DEFAULT_TILE_LEVELS],
  overlap: DEFAULT_TILE_OVERLAP,
}) as TilesSetting;

export function isTileLevelList(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_TILE_LEVELS &&
    value.every(isTileSize) &&
    new Set(value).size === value.length
  );
}

/**
 * Lenient read of the stored value. A missing row → defaults (valid:false, so the UI can say
 * "default"); a hand-edited document with a bad field → that field's default, valid:false, and the
 * good fields kept. Never throws.
 */
export function resolveTilesSetting(value: unknown): { setting: TilesSetting; valid: boolean; raw: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { setting: { ...DEFAULT_TILES_SETTING, levels: [...DEFAULT_TILE_LEVELS] }, valid: false, raw: value };
  }
  const doc = value as { enabled?: unknown; levels?: unknown };
  const enabledOk = typeof doc.enabled === "boolean";
  const levelsOk = doc.levels === undefined || isTileLevelList(doc.levels);
  return {
    setting: {
      enabled: enabledOk ? (doc.enabled as boolean) : DEFAULT_TILES_SETTING.enabled,
      levels: levelsOk && doc.levels !== undefined ? [...(doc.levels as number[])] : [...DEFAULT_TILE_LEVELS],
      overlap: DEFAULT_TILE_OVERLAP,
    },
    valid: enabledOk && levelsOk,
    raw: value,
  };
}

/** "3600, 1280" ↔ [3600, 1280] for the admin toggle's text field. */
export function formatTileLevels(levels: readonly number[]): string {
  return levels.join(", ");
}

export function parseTileLevels(text: string): number[] | null {
  const parts = text.split(/[,\s]+/).filter(Boolean);
  if (parts.length === 0) return null;
  const levels = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : Number.NaN));
  return isTileLevelList(levels) ? levels : null;
}
