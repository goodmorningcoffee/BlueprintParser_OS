// @vitest-environment node
/**
 * bucket-fill-routing + pdf-optional-content — which engine handles a click, and why.
 *
 * ── THE ONE THAT MUST NOT REGRESS ───────────────────────────────────────────────────────
 * `hidden-layers`. pdf.js resolves CAD layer visibility at PAINT time, so the operator list
 * contains linework from layers that are switched OFF, and the vendored extractor does not read
 * marked-content ops. MEASURED on our `hidden-ocg` fixture: the vector path traced a wall the user
 * cannot see and returned **exactly 50% of the room — 70,814 of 142,100 pt² — with status `ok` and
 * no warning**, while the raster path was correct at 98% because the hidden layer was never
 * painted. It is the single case where this port is strictly WORSE than what it replaces, and
 * upstream's own still-open issue #85 describes it in their words.
 *
 * Everything else here is ordinary policy. That test is a safety interlock.
 */

import { describe, it, expect } from "vitest";
import {
  routeBucketFill,
  rasterReasonMessage,
  RASTER_IMAGE_FRACTION,
  MIN_VECTOR_SEGMENTS,
  type RasterReason,
} from "@/lib/bucket-fill-routing";
import { pageHasHiddenOptionalContent } from "@/lib/pdf-optional-content";
import type { PageGeometryEntry, CachedPageGeometry } from "@/queries/pageGeometryCache";

const VIEW = 3000;

function geometry(over: Partial<CachedPageGeometry> = {}): CachedPageGeometry {
  return {
    points: [],
    pointsDropped: true,
    // 2000 segments — comfortably a real drawing.
    segs: new Array(MIN_VECTOR_SEGMENTS * 4 * 2).fill(0),
    meta: new Uint8Array(MIN_VECTOR_SEGMENTS * 2),
    imageArea: 0,
    viewportWidth: VIEW,
    viewportHeight: VIEW,
    scale: 1,
    pageWidthPt: VIEW,
    pageHeightPt: VIEW,
    ocUnsafe: false,
    ...over,
  };
}

const ok = (over: Partial<CachedPageGeometry> = {}): PageGeometryEntry => ({
  status: "ok",
  geometry: geometry(over),
});

const route = (
  entry: PageGeometryEntry | undefined,
  over: { mode?: "auto" | "vector" | "raster"; ocUnsafe?: boolean } = {},
) => routeBucketFill({ mode: over.mode ?? "auto", entry, ocUnsafe: over.ocUnsafe ?? false });

describe("★★ the hidden-layer guard — mandatory, not optional", () => {
  it("routes a page with hidden CAD layers to RASTER even when its geometry is perfect", () => {
    // This page looks flawless to every other signal: thousands of segments, no images. That is
    // exactly why the guard is checked before them — an unguarded route returns half a room with
    // status `ok`, and nothing downstream can tell.
    const d = route(ok(), { ocUnsafe: true });
    expect(d).toEqual({ engine: "raster", reason: "hidden-layers" });
  });

  it("takes precedence over the corpus signals, so the reason is never masked", () => {
    // A scanned sheet WITH hidden layers must report the hidden layers: that is the finding worth
    // surfacing, and "scanned-page" would hide the more serious fact.
    const d = route(ok({ segs: [], meta: new Uint8Array(0), imageArea: VIEW * VIEW }), {
      ocUnsafe: true,
    });
    expect(d).toEqual({ engine: "raster", reason: "hidden-layers" });
  });

  it("tells the user why, because this one is about their drawing", () => {
    expect(rasterReasonMessage("hidden-layers")).toMatch(/hidden CAD layers/i);
  });
});

describe("the mode gate comes first", () => {
  it("routes to raster in raster mode without inspecting geometry", () => {
    expect(route(ok(), { mode: "raster" })).toEqual({ engine: "raster", reason: "mode-raster" });
    // ...even for a page that would otherwise be demoted for a different reason.
    expect(route(undefined, { mode: "raster" })).toEqual({
      engine: "raster",
      reason: "mode-raster",
    });
  });

  it("allows vector in auto and vector modes", () => {
    expect(route(ok(), { mode: "auto" })).toEqual({ engine: "vector" });
    expect(route(ok(), { mode: "vector" })).toEqual({ engine: "vector" });
  });
});

describe("the miss IS the fallback mechanism", () => {
  it("routes to raster when nothing is cached", () => {
    // Startup, eviction, never-armed — all the same absence, all the same answer. PLAN: the
    // mechanism falls out of the cache design rather than being invented.
    expect(route(undefined)).toEqual({ engine: "raster", reason: "no-geometry" });
  });

  it("distinguishes a cached SENTINEL from a plain miss", () => {
    // "We tried and it cannot work here" is different information from "not tried yet", and phase
    // 3 shows different copy for each.
    const d = route({ status: "unavailable", reason: "oplist-failed" });
    expect(d).toEqual({ engine: "raster", reason: "geometry-unavailable" });
  });
});

describe("the two-signal corpus policy", () => {
  it("routes a scan (images dominant AND almost no linework) to raster", () => {
    const d = route(ok({ segs: [], meta: new Uint8Array(0), imageArea: VIEW * VIEW * 0.9 }));
    expect(d).toEqual({ engine: "raster", reason: "scanned-page" });
  });

  it("★ does NOT call a decorated CAD sheet a scan", () => {
    // MEASURED: the VA sheet carries 12,433 decorative 1-px gradient strips in its title block, so
    // imageArea alone misreads real CAD as a scan. This is why the scan verdict needs BOTH signals.
    const d = route(ok({ imageArea: VIEW * VIEW * 0.5 })); // heavy images, but 2000 segments
    expect(d).toEqual({ engine: "vector" });
  });

  it("routes a sparse sheet to raster, and names it sparse rather than scanned", () => {
    const d = route(ok({ segs: new Array(4 * 10).fill(0), meta: new Uint8Array(10) }));
    expect(d).toEqual({ engine: "raster", reason: "sparse-geometry" });
  });

  it("puts the segment boundary exactly at MIN_VECTOR_SEGMENTS", () => {
    const at = (n: number) => ok({ segs: new Array(n * 4).fill(0), meta: new Uint8Array(n) });
    expect(route(at(MIN_VECTOR_SEGMENTS - 1)).engine).toBe("raster");
    expect(route(at(MIN_VECTOR_SEGMENTS)).engine).toBe("vector");
  });

  it("puts the image boundary exactly at RASTER_IMAGE_FRACTION, given sparse linework", () => {
    const sparse = { segs: new Array(4 * 10).fill(0), meta: new Uint8Array(10) };
    const area = (f: number) => ok({ ...sparse, imageArea: VIEW * VIEW * f });
    // Below the threshold it is sparse, not scanned — a real distinction in the message.
    expect(route(area(RASTER_IMAGE_FRACTION - 0.001)).engine).toBe("raster");
    expect((route(area(RASTER_IMAGE_FRACTION - 0.001)) as { reason: string }).reason).toBe(
      "sparse-geometry",
    );
    expect((route(area(RASTER_IMAGE_FRACTION)) as { reason: string }).reason).toBe("scanned-page");
  });

  it("does not divide by zero on a degenerate viewport", () => {
    const d = route(ok({ viewportWidth: 0, viewportHeight: 0, imageArea: 1000 }));
    expect(d.engine).toBe("vector"); // 2000 segments; imageFraction treated as 0, not NaN
  });
});

describe("messages", () => {
  it("stays silent for the two ordinary states", () => {
    // Announcing the default engine, or a page whose geometry has not been extracted yet, would
    // train users to ignore the messages that actually say something about their drawing.
    expect(rasterReasonMessage("mode-raster")).toBeNull();
    expect(rasterReasonMessage("no-geometry")).toBeNull();
  });

  it("has copy for every reason that says something about the drawing", () => {
    const speaking: RasterReason[] = ["hidden-layers", "scanned-page", "sparse-geometry", "geometry-unavailable"];
    for (const r of speaking) expect(rasterReasonMessage(r)).toBeTruthy();
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────
// pdf-optional-content — the detector that feeds `ocUnsafe`
// ────────────────────────────────────────────────────────────────────────────────────────

const BEGIN_MC_PROPS = 91;

/** Op list shape measured from pdf.js: argsArray[i] === ["OC", { type: "OCG", id: "5R" }]. */
function opList(refs: Array<{ id: string } | null>) {
  return {
    fnArray: refs.map(() => BEGIN_MC_PROPS),
    argsArray: refs.map((r) => (r ? ["OC", { type: "OCG", id: r.id }] : null)),
  };
}

const config = (hidden: string[], groups: Record<string, unknown> = { g: 1 }) => ({
  isVisible: (g: unknown) => !hidden.includes((g as { id: string }).id),
  getGroups: () => groups,
});

describe("pageHasHiddenOptionalContent", () => {
  it("detects a hidden group referenced by this page", () => {
    expect(
      pageHasHiddenOptionalContent(opList([{ id: "5R" }]), config(["5R"]), BEGIN_MC_PROPS),
    ).toBe(true);
  });

  it("returns false when every referenced group is visible", () => {
    expect(
      pageHasHiddenOptionalContent(opList([{ id: "5R" }, { id: "9R" }]), config([]), BEGIN_MC_PROPS),
    ).toBe(false);
  });

  it("★ is PER-PAGE: a hidden group this page never references does not demote it", () => {
    // A deliberate refinement of PLAN §4.4's document-level phrasing. Linework that is not in this
    // page's op list cannot be extracted from this page, so demoting it would forfeit the vector
    // path for nothing. The two agree exactly when hidden linework is actually present.
    expect(
      pageHasHiddenOptionalContent(opList([{ id: "9R" }]), config(["5R"]), BEGIN_MC_PROPS),
    ).toBe(false);
  });

  it("skips the scan entirely for a document with no groups", () => {
    // The common case, and a real sheet's op list is ~71,819 entries.
    expect(pageHasHiddenOptionalContent(opList([{ id: "5R" }]), config(["5R"], {}), BEGIN_MC_PROPS))
      .toBe(false);
  });

  it("fails OPEN on anything it cannot read", () => {
    // This predicate DEMOTES a page, so a false positive silently forfeits the vector path. Only an
    // explicit `false` from isVisible counts as hidden.
    expect(pageHasHiddenOptionalContent(opList([{ id: "5R" }]), null, BEGIN_MC_PROPS)).toBe(false);
    expect(pageHasHiddenOptionalContent(opList([null]), config(["5R"]), BEGIN_MC_PROPS)).toBe(false);
    const throwing = {
      isVisible: () => { throw new Error("unresolvable ref"); },
      getGroups: () => ({ g: 1 }),
    };
    expect(pageHasHiddenOptionalContent(opList([{ id: "5R" }]), throwing, BEGIN_MC_PROPS)).toBe(false);
    const undef = { isVisible: () => undefined, getGroups: () => ({ g: 1 }) };
    expect(pageHasHiddenOptionalContent(opList([{ id: "5R" }]), undef, BEGIN_MC_PROPS)).toBe(false);
  });

  it("ignores operators that are not beginMarkedContentProps", () => {
    const ops = { fnArray: [1, 2, 3], argsArray: [["OC", { id: "5R" }], null, null] };
    expect(pageHasHiddenOptionalContent(ops, config(["5R"]), BEGIN_MC_PROPS)).toBe(false);
  });

  it("dedupes repeated references, because a real sheet re-enters a layer thousands of times", () => {
    let calls = 0;
    const counting = {
      isVisible: () => { calls++; return true; },
      getGroups: () => ({ g: 1 }),
    };
    const repeated = opList(new Array(500).fill({ id: "5R" }));
    pageHasHiddenOptionalContent(repeated, counting, BEGIN_MC_PROPS);
    expect(calls).toBe(1);
  });
});
