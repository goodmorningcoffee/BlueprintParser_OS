// @vitest-environment node
/**
 * bucket-fill-status — what the user is told after a vector attempt, and whether raster runs.
 *
 * ── THE ONE THAT MUST NOT REGRESS ───────────────────────────────────────────────────────
 * `no silent commit after a verdict`. The whole point of the port is RC4: the legacy engine
 * returns **963,687 pt² for a 142,100 pt² room — 578% over, status `ok`** when a door is unsealed,
 * and the vector engine refuses instead. If a leak verdict can reach the user as an uncaveated
 * raster number, the port has bought nothing on exactly the case it was bought for.
 *
 * The exhaustiveness test is the second interlock: a refusal code added to the adapter without a
 * disposition here would otherwise fall through to whatever the last branch happens to be.
 */

import { describe, it, expect } from "vitest";
import {
  decideBucketFillStatus,
  classifySheet,
  isRasterRetryPlausible,
  rasterRetryRejected,
  MIXED_SHEET_IMAGE_FRACTION,
  type SheetClass,
  type StatusInput,
} from "@/lib/bucket-fill-status";
import { VECTOR_REFUSALS, type VectorRefusal } from "@/lib/bucket-fill-vector-adapter";
import { RASTER_IMAGE_FRACTION, type RasterReason } from "@/lib/bucket-fill-routing";
import { LEAK_FRACTION } from "@/lib/oneclick/oneclick";
import type { CachedPageGeometry } from "@/queries/pageGeometryCache";

const SHEET_CLASSES: SheetClass[] = ["pure-vector", "mixed"];
const ALL_REFUSALS = Object.keys(VECTOR_REFUSALS) as VectorRefusal[];

function refused(refusal: VectorRefusal, sheetClass: SheetClass): StatusInput {
  return { attempt: { kind: "refused", refusal }, sheetClass, geometryPending: false };
}

function notRun(reason: RasterReason, geometryPending = false): StatusInput {
  return { attempt: { kind: "not-run", reason }, sheetClass: "pure-vector", geometryPending };
}

/** Only the three fields classifySheet reads; the rest of the entry is irrelevant to it. */
function geometry(imageArea: number, w = 1000, h = 1000): CachedPageGeometry {
  return { imageArea, viewportWidth: w, viewportHeight: h } as unknown as CachedPageGeometry;
}

describe("decideBucketFillStatus — a verdict is not a failure", () => {
  it("refuses a leak on a pure-vector sheet and offers the barrier", () => {
    const d = decideBucketFillStatus(refused("leak", "pure-vector"));
    expect(d.retryRaster).toBe(false);
    expect(d.tone).toBe("error");
    expect(d.offerBarrier).toBe(true);
    expect(d.message).toBe(VECTOR_REFUSALS.leak);
  });

  it("retries raster on a MIXED sheet, but caveated and still offering the barrier", () => {
    const d = decideBucketFillStatus(refused("leak", "mixed"));
    expect(d.code).toBe("vector-leak-raster-retry");
    expect(d.retryRaster).toBe(true);
    expect(d.tone).toBe("warning");
    expect(d.offerBarrier).toBe(true);
    expect(d.message).not.toBeNull();
  });

  it("gives the two leak cases DIFFERENT copy — one refuses, one caveats a number", () => {
    const pure = decideBucketFillStatus(refused("leak", "pure-vector"));
    const mixed = decideBucketFillStatus(refused("leak", "mixed"));
    expect(pure.message).not.toBe(mixed.message);
  });

  it.each(SHEET_CLASSES)(
    "refuses tiny/boundary on %s — they are verdicts about the CLICK, not the sheet",
    (sheetClass) => {
      for (const refusal of ["tiny", "boundary"] as VectorRefusal[]) {
        const d = decideBucketFillStatus(refused(refusal, sheetClass));
        expect(d.retryRaster).toBe(false);
        expect(d.tone).toBe("error");
        expect(d.message).toBe(VECTOR_REFUSALS[refusal]);
        // A barrier does not fix a click in the wrong place; offering it would be noise.
        expect(d.offerBarrier).toBe(false);
      }
    },
  );

  it.each(SHEET_CLASSES)("falls back silently on non-verdict refusals on %s", (sheetClass) => {
    for (const refusal of ["no-geometry", "no-page", "untraceable"] as VectorRefusal[]) {
      const d = decideBucketFillStatus(refused(refusal, sheetClass));
      expect(d.retryRaster).toBe(true);
      expect(d.message).toBeNull();
      expect(d.tone).toBeNull();
    }
  });

  it("falls back silently on a transport/worker error — no conclusion was reached", () => {
    const d = decideBucketFillStatus({
      attempt: { kind: "error" },
      sheetClass: "pure-vector",
      geometryPending: false,
    });
    expect(d).toMatchObject({ code: "raster-silent", retryRaster: true, message: null, tone: null });
  });
});

describe("★ the interlock: no sheet class keeps today's silent-commit behaviour", () => {
  it("never returns a raster number without a message after a LEAK verdict", () => {
    for (const sheetClass of SHEET_CLASSES) {
      const d = decideBucketFillStatus(refused("leak", sheetClass));
      // Either it refuses outright, or it produces a number WITH copy. Never both silent and go.
      expect(d.retryRaster && d.message === null).toBe(false);
    }
  });

  it("handles every refusal the adapter can emit — exhaustively, by construction", () => {
    expect(ALL_REFUSALS.length).toBeGreaterThan(0);
    for (const refusal of ALL_REFUSALS) {
      for (const sheetClass of SHEET_CLASSES) {
        const d = decideBucketFillStatus(refused(refusal, sheetClass));
        // A refusal is disposed of one of two ways, and mixing them is incoherent:
        // refuse (no retry, an error, a message) or fall through (retry).
        if (d.retryRaster) {
          expect(d.tone).not.toBe("error");
        } else {
          expect(d.tone).toBe("error");
          expect(d.message).not.toBeNull();
        }
      }
    }
  });

  it("only ever offers the barrier when a barrier would actually help", () => {
    for (const refusal of ALL_REFUSALS) {
      for (const sheetClass of SHEET_CLASSES) {
        const d = decideBucketFillStatus(refused(refusal, sheetClass));
        if (d.offerBarrier) expect(refusal).toBe("leak");
      }
    }
  });
});

describe("the census state — 'still preparing' is not 'cannot use vector here'", () => {
  it("explains the wait while geometry is in flight", () => {
    const d = decideBucketFillStatus(notRun("no-geometry", true));
    expect(d.code).toBe("raster-preparing");
    expect(d.retryRaster).toBe(true);
    expect(d.tone).toBe("warning");
    expect(d.message).not.toBeNull();
  });

  it("says NOTHING for the same reason once nothing is in flight", () => {
    // `no-geometry` with no fetch running is the ordinary state — announcing it would train users
    // to ignore the messages that matter.
    const d = decideBucketFillStatus(notRun("no-geometry", false));
    expect(d.code).toBe("raster-silent");
    expect(d.message).toBeNull();
  });

  it("does not reuse the geometry-unavailable copy for the preparing state", () => {
    const preparing = decideBucketFillStatus(notRun("no-geometry", true));
    const unavailable = decideBucketFillStatus(notRun("geometry-unavailable", false));
    expect(preparing.message).not.toBe(unavailable.message);
    expect(unavailable.code).toBe("raster-explained");
  });

  it("pre-empts every other explanation while a fetch is in flight", () => {
    // A page can be both 'still being read' and 'sparse' — temporary wins, because it resolves.
    const d = decideBucketFillStatus(notRun("sparse-geometry", true));
    expect(d.code).toBe("raster-preparing");
  });

  it("stays silent on mode-raster — the default engine is not news", () => {
    expect(decideBucketFillStatus(notRun("mode-raster", false)).message).toBeNull();
  });
});

describe("★ isRasterRetryPlausible — the backstop, using the engine's OWN criterion", () => {
  it("is literally the engine's leak threshold, not a copy of it", () => {
    expect(LEAK_FRACTION).toBe(0.3);
    expect(isRasterRetryPlausible(LEAK_FRACTION)).toBe(true);
    expect(isRasterRetryPlausible(LEAK_FRACTION + 1e-9)).toBe(false);
  });

  it("rejects both confidently-wrong-number cases measured in phase 0", () => {
    // e-size-hairline: legacy returned 8,946,545 of 8,957,952 pt².
    expect(isRasterRetryPlausible(8_946_545 / 8_957_952)).toBe(false);
    // door-gap: legacy returned 963,687 pt² for a 142,100 pt² room — essentially the whole sheet.
    expect(isRasterRetryPlausible(0.99)).toBe(false);
  });

  it("accepts an ordinary room", () => {
    // The 490×290 fixture room is 14.7% of its sheet, chosen to sit under LEAK_FRACTION.
    expect(isRasterRetryPlausible(0.147)).toBe(true);
  });

  it("rejects garbage at BOTH ends, not just the leak end", () => {
    // ⚠ These four are not interchangeable, and a mutation test proved it: NaN and +Infinity are
    // already rejected by `<=` alone, so asserting them measures nothing. The lower bound is the
    // half that a bare `areaFraction <= LEAK_FRACTION` would silently accept.
    expect(isRasterRetryPlausible(Number.NaN)).toBe(false);
    expect(isRasterRetryPlausible(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isRasterRetryPlausible(Number.NEGATIVE_INFINITY)).toBe(false);
    expect(isRasterRetryPlausible(-0.01)).toBe(false);
    expect(isRasterRetryPlausible(0)).toBe(false);
  });

  it("refuses with the barrier offered when the retry is implausible too", () => {
    const d = rasterRetryRejected();
    expect(d.retryRaster).toBe(false);
    expect(d.tone).toBe("error");
    expect(d.offerBarrier).toBe(true);
  });
});

describe("classifySheet", () => {
  it("calls the VA sheet pure-vector — its 0.0144 image fraction is title-block decoration", () => {
    expect(classifySheet(geometry(0.0144 * 1_000_000))).toBe("pure-vector");
  });

  it("calls a scan-underlaid sheet mixed", () => {
    expect(classifySheet(geometry(0.55 * 1_000_000))).toBe("mixed");
  });

  it("puts the boundary exactly at the router's own scan threshold", () => {
    expect(MIXED_SHEET_IMAGE_FRACTION).toBe(RASTER_IMAGE_FRACTION);
    expect(classifySheet(geometry(MIXED_SHEET_IMAGE_FRACTION * 1_000_000))).toBe("mixed");
    expect(classifySheet(geometry(MIXED_SHEET_IMAGE_FRACTION * 1_000_000 - 1))).toBe("pure-vector");
  });

  it("treats a degenerate viewport as pure-vector rather than dividing by zero", () => {
    expect(classifySheet(geometry(500, 0, 0))).toBe("pure-vector");
  });
});
