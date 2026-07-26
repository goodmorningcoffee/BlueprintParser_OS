/**
 * Regression tests for the two BlueprintParser modifications to the vendored One-Click engine
 * (`src/lib/oneclick/oneclick.ts`). Both are recorded in that file's MODIFICATIONS list, which
 * is the Apache-2.0 §4(b) compliance artifact; these tests are what keep them honest.
 *
 * ── MODIFICATION 2 IS THE DANGEROUS ONE ─────────────────────────────────────────────────
 * `floodRegion` runs `floodPass` up to twice — a strict pass (walls + hatch block) and, if the
 * strict fill looks hatch-bounded, an escalated pass (walls only). It holds `r1` across the
 * second pass and RETURNS r1 whenever the escalation is rejected.
 *
 * The optimisation replaces `new Uint8Array(mw*mh)` per pass (~5.8 MB at mask dim 3000) with
 * reusable scratch buffers. With ONE shared buffer that is silently wrong: the escalated pass
 * removes hatch from the barrier, so it floods STRICTLY FURTHER and overwrites r1's pixels in
 * place. The returned result would then carry r1's `count` with r2's region — and `traceRegion`
 * traces the region, so the user gets a polygon larger than the area that was measured.
 * Status "ok". No warning. That is the failure class this whole rebuild exists to remove, so
 * introducing it as a performance optimisation would be a poor trade.
 *
 * The invariant below catches it directly and cheaply:
 *
 *     popcount(result.region) === result.count
 *
 * It holds for every correct result and is violated exactly when a returned region has been
 * overwritten by a later, larger flood. With two slots it passes; collapse them to one and the
 * "escalation rejected" test fails.
 */

import { describe, it, expect } from "vitest";
import {
  floodRegion,
  releaseFloodScratch,
  SENS_BALANCED,
  type MaskObj,
} from "@/lib/oneclick/oneclick";

/** Count set cells — the right-hand side of the invariant. */
function popcount(region: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < region.length; i++) if (region[i]) n++;
  return n;
}

/**
 * Hand-build a mask rather than going through a PDF: these tests are about buffer lifetime,
 * not extraction, and a literal mask makes the geometry unambiguous.
 *
 * Layout (mw x mh), bit 1 = wall (hard), bit 2 = hatch (soft):
 *
 *     ####################        <- hard wall, top
 *     #        :         #        <- ':' is a HATCH column at x = xHatch
 *     #  seed  :  open   #           left of it: the room. right: open space that
 *     #        :         #           reaches the sheet edge through a gap in the
 *     ####################  gap      bottom wall, so a walls-only flood LEAKS.
 *
 * Strict pass  (barrier = 3): blocked by the hatch column -> bounded room, status "ok".
 * Escalated    (barrier = 1): hatch is transparent -> escapes through the gap -> "leak".
 * floodRegion therefore rejects the escalation and returns r1 — the exact path that a shared
 * buffer would corrupt.
 */
function maskWithHatchDividerAndLeak(): MaskObj {
  // ⚠ SIZE THE ROOM WELL UNDER LEAK_FRACTION (0.30 of the mask), or the STRICT pass leaks and
  // the test measures nothing. A first draft used a 160x120 mask whose room was 6,962 cells
  // against a 5,760 cap — the instinct to draw a room that fills the canvas is exactly wrong,
  // because a real room IS a small fraction of a sheet. Here: 79 x 298 = 23,542 of 120,000
  // = 19.6%, comfortably clear.
  const mw = 400;
  const mh = 300;
  const mask = new Uint8Array(mw * mh);
  const set = (x: number, y: number, v: number) => {
    if (x >= 0 && y >= 0 && x < mw && y < mh) mask[y * mw + x] |= v;
  };

  // Outer wall, with a gap in the bottom edge on the RIGHT side only.
  for (let x = 0; x < mw; x++) {
    set(x, 0, 1);
    if (x < 150) set(x, mh - 1, 1); // gap for x >= 150 -> escaped flood reaches the sheet edge
  }
  for (let y = 0; y < mh; y++) {
    set(0, y, 1);
    set(mw - 1, y, 1);
  }

  // Hatch column dividing room (left) from open space (right).
  const xHatch = 80;
  for (let y = 1; y < mh - 1; y++) set(xHatch, y, 2);

  return { mask, mw, mh, ws: 1, softCount: mh - 2 };
}

describe("oneclick vendored MODIFICATION 2 — two scratch buffers", () => {
  it("returns a region whose set-cell count equals the reported count (escalation REJECTED)", () => {
    releaseFloodScratch();
    const maskObj = maskWithHatchDividerAndLeak();

    // Seed inside the room, left of the hatch column.
    const r = floodRegion(maskObj, 40, 150, SENS_BALANCED);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;

    // THE INVARIANT. With a single shared buffer this is where it breaks: `count` is the strict
    // pass's, while `region` would hold the escaped walls-only flood.
    expect(popcount(r.region)).toBe(r.count);

    // And the region must stay on the room side of the hatch divider.
    let beyond = 0;
    for (let y = 0; y < maskObj.mh; y++) {
      for (let x = 81; x < maskObj.mw; x++) if (r.region[y * maskObj.mw + x]) beyond++;
    }
    expect(beyond).toBe(0);
  });

  it("holds the invariant across repeated floods that reuse the buffers", () => {
    releaseFloodScratch();
    const maskObj = maskWithHatchDividerAndLeak();
    for (let i = 0; i < 4; i++) {
      const r = floodRegion(maskObj, 20 + i, 100 + i * 5, SENS_BALANCED);
      expect(r.status).toBe("ok");
      if (r.status !== "ok") return;
      // A reused buffer that is not re-zeroed would accumulate cells from earlier floods.
      expect(popcount(r.region)).toBe(r.count);
    }
  });

  it("releaseFloodScratch() drops the buffers without breaking the next flood", () => {
    const maskObj = maskWithHatchDividerAndLeak();
    const before = floodRegion(maskObj, 40, 150, SENS_BALANCED);
    expect(before.status).toBe("ok");
    releaseFloodScratch();
    const after = floodRegion(maskObj, 40, 150, SENS_BALANCED);
    expect(after.status).toBe("ok");
    if (before.status !== "ok" || after.status !== "ok") return;
    expect(after.count).toBe(before.count);
    expect(popcount(after.region)).toBe(after.count);
  });
});

describe("oneclick vendored MODIFICATION 1 — bbox lifted out of the flood pass", () => {
  it("reports the flood's bounding box, and it bounds every filled cell", () => {
    releaseFloodScratch();
    const maskObj = maskWithHatchDividerAndLeak();
    const r = floodRegion(maskObj, 40, 150, SENS_BALANCED);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;

    // Present and well-formed (upstream discarded these).
    expect(r.minX).toBeGreaterThanOrEqual(0);
    expect(r.minY).toBeGreaterThanOrEqual(0);
    expect(r.maxX).toBeLessThan(maskObj.mw);
    expect(r.maxY).toBeLessThan(maskObj.mh);
    expect(r.maxX).toBeGreaterThan(r.minX);
    expect(r.maxY).toBeGreaterThan(r.minY);

    // The contract BP2's findHoleBorders relies on: the rectangle must CONTAIN every filled
    // pixel. A bbox that under-covers would make hole detection miss holes near the edge.
    for (let y = 0; y < maskObj.mh; y++) {
      for (let x = 0; x < maskObj.mw; x++) {
        if (r.region[y * maskObj.mw + x]) {
          expect(x).toBeGreaterThanOrEqual(r.minX);
          expect(x).toBeLessThanOrEqual(r.maxX);
          expect(y).toBeGreaterThanOrEqual(r.minY);
          expect(y).toBeLessThanOrEqual(r.maxY);
        }
      }
    }
  });

  it("is shaped like BP2's SolidRoomRectangle so it can be passed straight to findHoleBorders", () => {
    releaseFloodScratch();
    const r = floodRegion(maskWithHatchDividerAndLeak(), 40, 150, SENS_BALANCED);
    if (r.status !== "ok") throw new Error("expected ok");
    const bounds: { minX: number; minY: number; maxX: number; maxY: number } = r;
    expect(Object.keys(bounds)).toEqual(expect.arrayContaining(["minX", "minY", "maxX", "maxY"]));
  });
});
