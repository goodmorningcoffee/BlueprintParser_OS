// [tiles T9 2026-10-24] The stored { enabled, levels } document is read leniently (never throws, bad
// fields fall back to the defaults) and the admin text field round-trips level lists.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TILE_LEVELS,
  DEFAULT_TILES_SETTING,
  TILES_SETTING_KEY,
  formatTileLevels,
  isTileLevelList,
  parseTileLevels,
  resolveTilesSetting,
} from "../settings";

describe("resolveTilesSetting", () => {
  it("missing or non-object → defaults ON with [3600, 1280], valid:false", () => {
    for (const v of [undefined, null, "on", 1, [], true]) {
      const r = resolveTilesSetting(v);
      expect(r.setting).toEqual({ enabled: true, levels: [3600, 1280], overlap: 0.2 });
      expect(r.valid).toBe(false);
      expect(r.raw).toBe(v);
    }
    expect(DEFAULT_TILES_SETTING.levels).toEqual([...DEFAULT_TILE_LEVELS]);
    expect(TILES_SETTING_KEY).toBe("tiles_enabled");
  });

  it("a saved document is honoured; a bad field falls back on its own and marks the document invalid", () => {
    expect(resolveTilesSetting({ enabled: false })).toMatchObject({ setting: { enabled: false, levels: [3600, 1280] }, valid: true });
    expect(resolveTilesSetting({ enabled: true, levels: [1824] })).toMatchObject({ setting: { enabled: true, levels: [1824] }, valid: true });
    expect(resolveTilesSetting({ enabled: "yes", levels: [1824] })).toMatchObject({ setting: { enabled: true, levels: [1824] }, valid: false });
    expect(resolveTilesSetting({ enabled: false, levels: [32] })).toMatchObject({ setting: { enabled: false, levels: [3600, 1280] }, valid: false });
    expect(resolveTilesSetting({ enabled: false, levels: [1280, 1280] })).toMatchObject({ setting: { levels: [3600, 1280] }, valid: false });
    expect(resolveTilesSetting({ enabled: false, levels: [] })).toMatchObject({ setting: { levels: [3600, 1280] }, valid: false });
    // the returned level list is a copy, never the stored array or the default constant
    const stored = { enabled: true, levels: [2048] };
    const r = resolveTilesSetting(stored);
    r.setting.levels.push(1);
    expect(stored.levels).toEqual([2048]);
    resolveTilesSetting(undefined).setting.levels.push(1);
    expect(DEFAULT_TILE_LEVELS).toEqual([3600, 1280]);
  });

  it("level lists: 1–4 unique integer px sizes within the planner's bounds", () => {
    expect(isTileLevelList([3600, 1280])).toBe(true);
    expect(isTileLevelList([64, 16384])).toBe(true);
    expect(isTileLevelList([3600, 1280, 1824, 640, 512])).toBe(false);
    expect(isTileLevelList([3600, 3600])).toBe(false);
    expect(isTileLevelList([3600.5])).toBe(false);
    expect(isTileLevelList(["3600"])).toBe(false);
    expect(isTileLevelList([])).toBe(false);
    expect(isTileLevelList(null)).toBe(false);
  });

  it("text field round-trip", () => {
    expect(formatTileLevels([3600, 1280])).toBe("3600, 1280");
    expect(parseTileLevels("3600, 1280")).toEqual([3600, 1280]);
    expect(parseTileLevels("3600 1280,1824")).toEqual([3600, 1280, 1824]);
    expect(parseTileLevels("")).toBeNull();
    expect(parseTileLevels("3600, big")).toBeNull();
    expect(parseTileLevels("3600, 3600")).toBeNull();
    expect(parseTileLevels("-1280")).toBeNull();
  });
});
