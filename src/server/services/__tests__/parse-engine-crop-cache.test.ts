// @vitest-environment node
// [table pipeline WP-3.E] The S3 crop cache (key format, body checks, never-throw) and the per-caller
// in-flight slots (caps per budget, idempotent release, the hold ceiling). Pure: the store is in memory.
import { afterEach, describe, expect, it } from "vitest";
import {
  CROP_CACHE_VERSION,
  cropCacheKey,
  q3Box,
  q3Key,
  readCropCache,
  writeCropCache,
  type CropCacheStore,
} from "@/server/services/parse-engine/crop-cache";
import {
  PARSE_CONCURRENCY_LIMITS,
  PARSE_SLOT_HOLD_CEILING_MS,
  acquireParseSlot,
  parseSlotsInUseForTest,
  resetParseSlotsForTest,
} from "@/server/services/parse-engine/concurrency";

function mem(): CropCacheStore & { objects: Map<string, string> } {
  const objects = new Map<string, string>();
  return {
    objects,
    async getObject(key) { return objects.get(key) ?? null; },
    async putObject(key, body) { objects.set(key, body); },
  };
}

describe("crop cache keys", () => {
  it("q3 rounds to 3 dp, clamps to [0, 1] and prints fixed width", () => {
    expect(q3Box([0.12345, 0.2, 0.9999, 1.0004])).toEqual([0.123, 0.2, 1, 1]);
    expect(q3Key([0.12345, 0.2, 0.9999, 1.0004])).toBe("0.123_0.200_1.000_1.000");
    expect(cropCacheKey("co/p1", 4, [0.1, 0.2, 0.3, 0.4], "rulings")).toBe("co/p1/cache/parse-engine/4/0.100_0.200_0.300_0.400.rulings.json");
  });
});

describe("crop cache read / write", () => {
  it("a written value reads back for the same rounded box; another method, page or box is a miss", async () => {
    const s = mem();
    expect(await writeCropCache(s, "co/p1", 2, [0.1, 0.1, 0.5, 0.5], "textract", { words: [] }, new Date("2026-10-27T00:00:00Z"))).toBe(true);
    expect(await readCropCache(s, "co/p1", 2, [0.10004, 0.1, 0.5, 0.5], "textract")).toEqual({ value: { words: [] } });
    expect(await readCropCache(s, "co/p1", 2, [0.1, 0.1, 0.5, 0.5], "tatr")).toBeNull();
    expect(await readCropCache(s, "co/p1", 3, [0.1, 0.1, 0.5, 0.5], "textract")).toBeNull();
    expect(await readCropCache(s, "co/p1", 2, [0.1, 0.1, 0.5, 0.6], "textract")).toBeNull();
    const body = JSON.parse([...s.objects.values()][0]);
    expect(body).toEqual({ v: CROP_CACHE_VERSION, method: "textract", page: 2, box: [0.1, 0.1, 0.5, 0.5], at: "2026-10-27T00:00:00.000Z", value: { words: [] } });
  });

  it("a body that does not match its key, an old version or bad JSON is a miss, never trusted", async () => {
    const s = mem();
    const key = cropCacheKey("co/p1", 2, [0.1, 0.1, 0.5, 0.5], "textract");
    const good = { v: CROP_CACHE_VERSION, method: "textract", page: 2, box: [0.1, 0.1, 0.5, 0.5], at: "x", value: 1 };
    for (const bad of [{ ...good, v: CROP_CACHE_VERSION + 1 }, { ...good, method: "tatr" }, { ...good, page: 9 }, { ...good, box: [0, 0, 1, 1] }, { v: CROP_CACHE_VERSION, method: "textract", page: 2, box: good.box }]) {
      s.objects.set(key, JSON.stringify(bad));
      expect(await readCropCache(s, "co/p1", 2, [0.1, 0.1, 0.5, 0.5], "textract")).toBeNull();
    }
    s.objects.set(key, "{not json");
    expect(await readCropCache(s, "co/p1", 2, [0.1, 0.1, 0.5, 0.5], "textract")).toBeNull();
  });

  it("store failures never throw: a failed read is a miss, a failed write returns false", async () => {
    const broken: CropCacheStore = {
      async getObject() { throw new Error("s3 down"); },
      async putObject() { throw new Error("s3 down"); },
    };
    expect(await readCropCache(broken, "co/p1", 1, [0, 0, 1, 1], "rulings")).toBeNull();
    expect(await writeCropCache(broken, "co/p1", 1, [0, 0, 1, 1], "rulings", {})).toBe(false);
  });
});

describe("in-flight slots", () => {
  afterEach(() => resetParseSlotsForTest());

  it("standard ≤ 2 and thorough ≤ 1 per caller, as separate pools; instant is never capped", () => {
    expect(PARSE_CONCURRENCY_LIMITS).toEqual({ standard: 2, thorough: 1 });
    const s1 = acquireParseSlot("user:1", "standard", 0);
    const s2 = acquireParseSlot("user:1", "standard", 0);
    expect(acquireParseSlot("user:1", "standard", 0)).toBeNull();
    const t1 = acquireParseSlot("user:1", "thorough", 0);
    expect(t1).not.toBeNull();
    expect(acquireParseSlot("user:1", "thorough", 0)).toBeNull();
    for (let i = 0; i < 10; i += 1) expect(acquireParseSlot("user:1", "instant", 0)).not.toBeNull();
    expect(acquireParseSlot("user:2", "standard", 0)).not.toBeNull();
    expect(acquireParseSlot("ip:1.2.3.4", "standard", 0)).not.toBeNull();
    expect(parseSlotsInUseForTest("user:1")).toBe(3);
    s1!.release();
    s1!.release(); // idempotent: frees one slot, not two
    expect(parseSlotsInUseForTest("user:1", "standard")).toBe(1);
    expect(acquireParseSlot("user:1", "standard", 0)).not.toBeNull();
    expect(acquireParseSlot("user:1", "standard", 0)).toBeNull();
    s2!.release();
    t1!.release();
  });

  it("a slot never released stops counting after the hold ceiling", () => {
    expect(acquireParseSlot("user:5", "thorough", 1_000)).not.toBeNull();
    expect(acquireParseSlot("user:5", "thorough", 1_000 + PARSE_SLOT_HOLD_CEILING_MS - 1)).toBeNull();
    expect(acquireParseSlot("user:5", "thorough", 1_000 + PARSE_SLOT_HOLD_CEILING_MS)).not.toBeNull();
    expect(parseSlotsInUseForTest("user:5")).toBe(1);
  });
});
