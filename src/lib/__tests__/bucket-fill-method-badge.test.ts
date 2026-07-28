// @vitest-environment node
/**
 * `method` — which engine produced this polygon, and the badge that reports it.
 *
 * ── ⚠ WHY THIS SUITE EXISTS: A SHIPPED BRANCH THAT COULD NEVER FIRE ─────────────────────
 * `DrawingPreviewLayer` labelled the preview with
 * `bucketFillPreview.method === "vector" ? "Vector" : "Raster"`, and PLAN recorded that badge as
 * "free — the branch already ships". It does ship. It could also never fire: **no producer emits
 * the string `"vector"`.** The only values that exist are `client-vector`, `client-raster` and
 * `server-raster`, so the comparison was always false and every fill was labelled "Raster".
 *
 * It was invisible because the label happened to be CORRECT for the only engine that could run.
 * The moment the vector path goes live it would silently mislabel every vector fill — a wrong
 * provenance claim on the exact feature whose selling point is knowing which engine measured your
 * room, and one that persists onto the annotation.
 *
 * The lesson generalises past this one line: an equality against a literal that nothing produces
 * is indistinguishable from working code until the day the other branch matters.
 */

import { describe, it, expect } from "vitest";
import {
  isVectorMethod,
  BUCKET_FILL_METHODS,
  type BucketFillMethod,
} from "@/lib/bucket-fill-mode";
import { VECTOR_REFUSALS } from "@/lib/bucket-fill-vector-adapter";

describe("isVectorMethod", () => {
  it("recognises the value the vector engine actually emits", () => {
    expect(isVectorMethod("client-vector")).toBe(true);
    expect(isVectorMethod(BUCKET_FILL_METHODS.clientVector)).toBe(true);
  });

  it("is false for both raster producers", () => {
    expect(isVectorMethod("client-raster")).toBe(false);
    expect(isVectorMethod("server-raster")).toBe(false);
  });

  it("★ is false for the string the dead branch compared against", () => {
    // The whole bug in one assertion. If someone 'simplifies' this back to an equality against
    // "vector", this fails rather than silently relabelling every fill.
    expect(isVectorMethod("vector")).toBe(false);
  });

  it("treats absent/unknown as NOT vector — unknown must never be reported as vector", () => {
    // Rows written before `method` existed mean UNKNOWN. Reporting them as vector would relabel
    // history, the same reason the field is left absent rather than defaulted.
    expect(isVectorMethod(undefined)).toBe(false);
    expect(isVectorMethod(null)).toBe(false);
    expect(isVectorMethod("")).toBe(false);
    expect(isVectorMethod("Client-Vector")).toBe(false);
  });
});

describe("★ the wire format is closed — every emitted method is a declared one", () => {
  it("the three producers' literals are exactly the declared set", () => {
    const declared = Object.values(BUCKET_FILL_METHODS).sort();
    expect(declared).toEqual(["client-raster", "client-vector", "server-raster"]);
  });

  it("the vector adapter's success path emits a declared method", async () => {
    const { vectorBucketFill } = await import("@/lib/bucket-fill-vector-adapter");
    // A 400x300 room inside a 1000x800 page — big enough to flood, small enough not to leak.
    const segs = [
      200, 150, 600, 150,
      600, 150, 600, 450,
      600, 450, 200, 450,
      200, 450, 200, 150,
    ];
    const out = vectorBucketFill({
      geo: { segs, meta: new Uint8Array(4).fill(1 << 4), points: [], imageArea: 0 },
      imgW: 1000,
      imgH: 800,
      seedX: 400 / 1000,
      seedY: 300 / 800,
    });
    expect(out.type).toBe("result");
    expect(Object.values(BUCKET_FILL_METHODS)).toContain(out.method as BucketFillMethod);
    // ★ And it is the VECTOR one — which is what the badge has to be able to see.
    expect(isVectorMethod(out.method)).toBe(true);
  });

  it("a refusal still carries the declared vector method, not a bare string", async () => {
    const { vectorBucketFill } = await import("@/lib/bucket-fill-vector-adapter");
    const out = vectorBucketFill({
      geo: { segs: [], meta: new Uint8Array(0), points: [], imageArea: 0 },
      imgW: 1000, imgH: 800, seedX: 0.5, seedY: 0.5,
    });
    expect(out.error).toBe(VECTOR_REFUSALS["no-geometry"]);
    expect(isVectorMethod(out.method)).toBe(true);
  });
});
