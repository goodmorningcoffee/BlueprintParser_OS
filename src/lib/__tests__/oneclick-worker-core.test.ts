// @vitest-environment node
/**
 * oneclick-worker-core — worker #2's protocol.
 *
 * The property this suite exists for is **barrier isolation**. "Transfer once" means the mask is
 * built per page and kept, while barriers are drawn per click — so if a fill burned its barriers
 * into the cached mask, the NEXT click on that page would silently inherit them and return a
 * smaller room with status `ok`. A wrong number, produced confidently, with nothing to notice it.
 * That is the exact failure class this rebuild exists to remove, so it is tested directly and
 * negative-tested by deleting the copy.
 *
 * Geometry is hand-built rather than extracted from a PDF: this layer takes `segs`/`meta` as
 * inputs and nothing here depends on how they were produced, so a real PDF would only add a
 * dependency on pdf.js to an otherwise pure test.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  createWorkerState,
  handleOneclickMessage,
  maskCacheKey,
  MAX_RETAINED_MASKS,
  VECTOR_FILL_TIMEOUT_MS,
  type OneclickWorkerState,
  type OneclickResponse,
} from "@/lib/oneclick-worker-core";

const IMG_W = 1200;
const IMG_H = 800;

/** A sealed rectangular room, 600x400 of a 1200x800 sheet = 25% — under LEAK_FRACTION (0.30). */
const ROOM = { x0: 200, y0: 200, x1: 800, y1: 600 };

function roomGeometry() {
  const { x0, y0, x1, y1 } = ROOM;
  const segs = Float64Array.from([
    x0, y0, x1, y0,
    x1, y0, x1, y1,
    x1, y1, x0, y1,
    x0, y1, x0, y0,
  ]);
  // One meta byte per segment. High nibble is the device line width; 1 px is enough to seal.
  const meta = new Uint8Array([1 << 4, 1 << 4, 1 << 4, 1 << 4]);
  return { segs, meta };
}

const SEED = {
  seedX: ((ROOM.x0 + ROOM.x1) / 2) / IMG_W,
  seedY: ((ROOM.y0 + ROOM.y1) / 2) / IMG_H,
};

const KEY = maskCacheKey("proj", 1, 3000, "vector");

let state: OneclickWorkerState;

function sendMask(key = KEY, over: Partial<{ imgW: number; imgH: number }> = {}) {
  const { segs, meta } = roomGeometry();
  return handleOneclickMessage(state, {
    type: "mask",
    key,
    segs,
    meta,
    imgW: over.imgW ?? IMG_W,
    imgH: over.imgH ?? IMG_H,
  });
}

function sendFill(over: Partial<Parameters<typeof handleOneclickMessage>[1]> = {}) {
  return handleOneclickMessage(state, {
    type: "fill",
    key: KEY,
    requestId: 1,
    ...SEED,
    ...over,
  } as Parameters<typeof handleOneclickMessage>[1]);
}

const areaOf = (r: OneclickResponse) =>
  r.type === "result" ? r.areaFraction : Number.NaN;

beforeEach(() => {
  state = createWorkerState();
});

describe("the mask/fill/evict protocol", () => {
  it("builds a mask and reports its size", () => {
    const res = sendMask();
    expect(res.type).toBe("mask-ready");
    if (res.type !== "mask-ready") throw new Error("unreachable");
    expect(res.key).toBe(KEY);
    expect(res.maskBytes).toBeGreaterThan(0);
  });

  it("floods the cached mask and returns a polygon", () => {
    sendMask();
    const res = sendFill();
    expect(res.type).toBe("result");
    if (res.type !== "result") throw new Error(`expected result, got ${JSON.stringify(res)}`);
    expect(res.vertices.length).toBeGreaterThanOrEqual(3);
    expect(res.method).toBe("client-vector");
    // 600x400 of 1200x800 = 25% of the sheet, minus the one-mask-px inset per side.
    expect(res.areaFraction).toBeGreaterThan(0.24);
    expect(res.areaFraction).toBeLessThanOrEqual(0.25);
  });

  it("refuses a fill for a key it never received, without throwing", () => {
    const res = sendFill();
    expect(res.type).toBe("error");
    if (res.type !== "error") throw new Error("unreachable");
    expect(res.requestId).toBe(1);
  });

  it("refuses a mask with no segments or no page size", () => {
    const empty = handleOneclickMessage(state, {
      type: "mask", key: KEY, segs: new Float64Array(0), meta: new Uint8Array(0),
      imgW: IMG_W, imgH: IMG_H,
    });
    expect(empty.type).toBe("mask-error");
    const { segs, meta } = roomGeometry();
    const noPage = handleOneclickMessage(state, {
      type: "mask", key: KEY, segs, meta, imgW: 0, imgH: IMG_H,
    });
    expect(noPage.type).toBe("mask-error");
  });
});

describe("★★ barrier isolation — the reason the cache holds a CLEAN mask", () => {
  it("a barrier on one click does NOT survive into the next", () => {
    sendMask();
    const baseline = areaOf(sendFill());
    expect(baseline).toBeGreaterThan(0.24);

    // A barrier straight down the middle of the room. The flood should be roughly halved.
    const midX = (ROOM.x0 + ROOM.x1) / 2 / IMG_W;
    const barriered = areaOf(
      sendFill({
        requestId: 2,
        barriers: [{ x1: midX, y1: 0, x2: midX, y2: 1 }],
      } as never),
    );
    expect(barriered).toBeGreaterThan(0);
    expect(barriered).toBeLessThan(baseline * 0.75); // genuinely cut the room down

    // ...and now the SAME click with no barriers must return to baseline. If the barrier had been
    // burned into the cached mask, this would still read the halved area — status `ok`, no
    // warning, wrong number.
    const after = areaOf(sendFill({ requestId: 3 } as never));
    expect(after).toBeCloseTo(baseline, 10);
  });

  it("polygon exclusions are equally per-click", () => {
    sendMask();
    const baseline = areaOf(sendFill());
    // ⚠ Placed in a CORNER of the room, clear of the seed at (0.417, 0.500). The first version
    // spanned the middle and swallowed the seed, so the engine correctly refused (`boundary`) and
    // the assertion compared NaN — my fixture, not the engine. Room in normalised coords is
    // x 0.167..0.667, y 0.250..0.750.
    const blob = {
      vertices: [
        { x: 0.20, y: 0.28 }, { x: 0.32, y: 0.28 }, { x: 0.32, y: 0.44 }, { x: 0.20, y: 0.44 },
      ],
    };
    const excluded = areaOf(sendFill({ requestId: 2, polygonBarriers: [blob] } as never));
    expect(excluded).toBeLessThan(baseline);
    expect(areaOf(sendFill({ requestId: 3 } as never))).toBeCloseTo(baseline, 10);
  });

  it("repeated barrier-free fills are byte-identical, so nothing accumulates", () => {
    sendMask();
    const runs = [1, 2, 3, 4].map((requestId) => areaOf(sendFill({ requestId } as never)));
    for (const r of runs) expect(r).toBeCloseTo(runs[0], 12);
  });
});

describe("eviction", () => {
  it("drops one key and leaves the others", () => {
    const other = maskCacheKey("proj", 2, 3000, "vector");
    sendMask();
    sendMask(other);

    const res = handleOneclickMessage(state, { type: "evict", key: KEY });
    expect(res).toEqual({ type: "evicted", keys: [KEY] });
    expect(sendFill().type).toBe("error"); // KEY is gone
    // ...the sibling still floods.
    const still = handleOneclickMessage(state, {
      type: "fill", key: other, requestId: 9, ...SEED,
    });
    expect(still.type).toBe("result");
  });

  it("reports nothing evicted for a key it never held", () => {
    expect(handleOneclickMessage(state, { type: "evict", key: "nope" }))
      .toEqual({ type: "evicted", keys: [] });
  });

  it("drops everything when no key is given — project teardown", () => {
    sendMask();
    sendMask(maskCacheKey("proj", 2, 3000, "vector"));
    const res = handleOneclickMessage(state, { type: "evict" });
    expect(res.type).toBe("evicted");
    if (res.type !== "evicted") throw new Error("unreachable");
    expect(res.keys).toHaveLength(2);
    expect(sendFill().type).toBe("error");
  });

  it("caps retention as a backstop against a caller that never evicts", () => {
    // The geometry cache owns the real policy; this only stops unbounded growth.
    for (let page = 1; page <= MAX_RETAINED_MASKS + 2; page++) {
      sendMask(maskCacheKey("proj", page, 3000, "vector"));
    }
    // The oldest went first, so page 1 is gone and the newest is resident.
    const oldest = handleOneclickMessage(state, {
      type: "fill", key: maskCacheKey("proj", 1, 3000, "vector"), requestId: 1, ...SEED,
    });
    expect(oldest.type).toBe("error");
    const newest = handleOneclickMessage(state, {
      type: "fill",
      key: maskCacheKey("proj", MAX_RETAINED_MASKS + 2, 3000, "vector"),
      requestId: 2,
      ...SEED,
    });
    expect(newest.type).toBe("result");
  });
});

describe("cache identity", () => {
  it("separates pages, mask dimensions and source kinds", () => {
    const keys = new Set([
      maskCacheKey("p", 1, 3000, "vector"),
      maskCacheKey("p", 2, 3000, "vector"),
      maskCacheKey("p", 1, 4000, "vector"),
      // ★ phase 5 converges the raster path onto this worker with a second mask builder. A
      // raster-built and a vector-built mask for the same page are NOT interchangeable.
      maskCacheKey("p", 1, 3000, "raster"),
      maskCacheKey("q", 1, 3000, "vector"),
    ]);
    expect(keys.size).toBe(5);
  });

  it("encodes the publicId so a separator inside it cannot forge another page's key", () => {
    expect(maskCacheKey("a::1", 2, 3000, "vector"))
      .not.toBe(maskCacheKey("a", 1, 2, "vector"));
  });
});

describe("robustness", () => {
  it("returns a typed error instead of throwing on an unknown message", () => {
    const res = handleOneclickMessage(
      state,
      { type: "nonsense" } as unknown as Parameters<typeof handleOneclickMessage>[1],
    );
    expect(res.type).toBe("error");
  });

  it("keeps the fill timeout far above the measured worst click", () => {
    // p95 warm click is 32 ms and the worst grid-sweep sample was 63 ms. A timeout that could fire
    // on a slow-but-working click would route good vector results to raster at random.
    expect(VECTOR_FILL_TIMEOUT_MS).toBeGreaterThanOrEqual(1000);
    expect(VECTOR_FILL_TIMEOUT_MS / 63).toBeGreaterThan(10);
  });
});
