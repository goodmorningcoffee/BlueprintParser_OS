/**
 * bucket-fill-mode — the dev/e2e override, and the prefetch rule the transport invariant needs.
 *
 * Two things are being defended and only one of them is a feature flag:
 *
 *   1. The default is `raster`. Phase 2 and 3 ship dark; flipping the public default is phase 4
 *      and owner-gated. A test that pins the default is cheap insurance against it drifting in a
 *      refactor nobody reviews closely.
 *
 *   2. `shouldPrefetchGeometry` is the reason `e2e/viewer-perf-v2.spec.ts`'s bucket-window
 *      transport barrier keeps holding. `PDFViewer` loads the PDF with `disableAutoFetch: true`
 *      and 1 MiB ranges, so extracting geometry for a page whose bytes are not resident ISSUES
 *      RANGE REQUESTS — and that barrier asserts an exact zero across four transport counters.
 *      A `raster` session must therefore prefetch nothing at all. That is a correctness property,
 *      not a preference, and it is tested as one.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  resolveBucketFillMode,
  isBucketFillMode,
  vectorMayRun,
  shouldPrefetchGeometry,
  BUCKET_FILL_MODE_DEFAULT,
  BUCKET_FILL_MODE_STORAGE_KEY,
  type BucketFillMode,
} from "@/lib/bucket-fill-mode";

const ALL_MODES: BucketFillMode[] = ["auto", "vector", "raster"];

afterEach(() => {
  vi.unstubAllGlobals();
  try {
    window.localStorage.clear();
  } catch {
    /* jsdom always has storage; guard anyway so a failure here cannot mask a real one */
  }
});

describe("the default is raster, and phase 2 must not change it", () => {
  it("defaults to raster with neither override present", () => {
    expect(BUCKET_FILL_MODE_DEFAULT).toBe("raster");
    expect(resolveBucketFillMode({ env: undefined, storage: undefined })).toBe("raster");
  });

  it("means the vector engine cannot run and nothing is prefetched", () => {
    const mode = resolveBucketFillMode({ env: undefined, storage: undefined });
    expect(vectorMayRun(mode)).toBe(false);
    expect(shouldPrefetchGeometry(mode, true)).toBe(false);
  });
});

describe("precedence: localStorage > env > default", () => {
  it("uses env when only env is set — phase 3's dogfood flip surface", () => {
    expect(resolveBucketFillMode({ env: "auto", storage: undefined })).toBe("auto");
  });

  it("lets localStorage OUTRANK env, which is the point of a per-browser override", () => {
    // env is the deployment default; a developer (or the e2e harness) must be able to depart from
    // it without a rebuild. If this inverted, the e2e escape hatch would stop working.
    expect(resolveBucketFillMode({ env: "auto", storage: "raster" })).toBe("raster");
    expect(resolveBucketFillMode({ env: "raster", storage: "vector" })).toBe("vector");
  });

  it("ignores malformed values at either level rather than throwing", () => {
    // A typo must degrade to the safe default, not break the tool.
    const bad = "vecter" as unknown as BucketFillMode;
    expect(resolveBucketFillMode({ env: bad, storage: undefined })).toBe("raster");
    expect(isBucketFillMode("vecter")).toBe(false);
    expect(isBucketFillMode(null)).toBe(false);
    expect(isBucketFillMode(undefined)).toBe(false);
    expect(isBucketFillMode(1)).toBe(false);
    for (const m of ALL_MODES) expect(isBucketFillMode(m)).toBe(true);
  });
});

describe("reading the real localStorage", () => {
  it("picks up a hand-set override", () => {
    window.localStorage.setItem(BUCKET_FILL_MODE_STORAGE_KEY, "vector");
    expect(resolveBucketFillMode({ env: undefined })).toBe("vector");
  });

  it("ignores a garbage entry", () => {
    window.localStorage.setItem(BUCKET_FILL_MODE_STORAGE_KEY, "{}");
    expect(resolveBucketFillMode({ env: undefined })).toBe("raster");
  });

  it("★ survives a browser where storage access THROWS", () => {
    // Safari private mode, embedded webviews and blocked third-party contexts all throw from
    // localStorage rather than returning null. A dev override that can crash the viewer would be
    // strictly worse than no override at all.
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
    expect(() => resolveBucketFillMode({ env: undefined })).not.toThrow();
    expect(resolveBucketFillMode({ env: undefined })).toBe("raster");
  });
});

describe("★ shouldPrefetchGeometry — the property the transport barrier rests on", () => {
  it("NEVER prefetches in a raster session, armed or not", () => {
    // This is the whole mechanism. `e2e/viewer-perf-v2.spec.ts` asserts an exact zero across
    // browserRequestGeneration / browserLifecycleGeneration / upstreamRequestGeneration /
    // upstreamLifecycleGeneration during the bucket window, and PLAN pins the e2e override to
    // `raster`. With `disableAutoFetch: true`, extracting geometry fetches bytes — so if this ever
    // returns true for `raster`, that invariant breaks and the failure will look like a perf
    // regression rather than what it is.
    expect(shouldPrefetchGeometry("raster", true)).toBe(false);
    expect(shouldPrefetchGeometry("raster", false)).toBe(false);
  });

  it("does not prefetch when the tool is not armed, in ANY mode", () => {
    // PLAN: "a user who never arms the tool pays nothing." An op-list parse is ~1.2 s of
    // main-thread work and retains ~25.6 MB per page.
    for (const mode of ALL_MODES) expect(shouldPrefetchGeometry(mode, false)).toBe(false);
  });

  it("prefetches only when armed AND vector may run", () => {
    expect(shouldPrefetchGeometry("auto", true)).toBe(true);
    expect(shouldPrefetchGeometry("vector", true)).toBe(true);
  });

  it("is exhaustive over the mode/armed matrix, so a new mode cannot slip through untested", () => {
    const expected: Record<BucketFillMode, [boolean, boolean]> = {
      // mode: [armed=false, armed=true]
      auto: [false, true],
      vector: [false, true],
      raster: [false, false],
    };
    for (const mode of ALL_MODES) {
      expect([shouldPrefetchGeometry(mode, false), shouldPrefetchGeometry(mode, true)]).toEqual(
        expected[mode],
      );
    }
    // If someone adds a mode, ALL_MODES and the record above both fail to compile/match — the
    // matrix is the tripwire.
    expect(Object.keys(expected).sort()).toEqual([...ALL_MODES].sort());
  });
});

describe("★ the e2e perf spec pins this override to raster — checked, not trusted", () => {
  /**
   * `e2e/viewer-perf-v2.spec.ts` sets this key to `raster` in an `addInitScript`, which is what
   * makes its bucket transport-quiescence gate sound: a raster session extracts no geometry, so
   * the prefetcher cannot issue the PDF range requests that gate forbids.
   *
   * The spec must use a STRING LITERAL — it imports nothing from the app, because one harness
   * checkout runs against two different app SHAs and an app-module import would break on
   * whichever predates it. That literal is therefore a hand-synced duplicate, which is precisely
   * the kind of coupling that rots silently. This test is the sync.
   */
  const spec = readFileSync(
    join(process.cwd(), "e2e/viewer-perf-v2.spec.ts"),
    "utf8",
  );

  it("pins the exact storage key this module reads", () => {
    expect(spec).toContain(`window.localStorage.setItem("${BUCKET_FILL_MODE_STORAGE_KEY}"`);
  });

  it("pins it to raster specifically, not merely to something", () => {
    expect(spec).toContain(
      `window.localStorage.setItem("${BUCKET_FILL_MODE_STORAGE_KEY}", "raster")`,
    );
  });

  it("pins a value this module would actually accept", () => {
    // Guards the other direction: renaming a mode without updating the spec would leave it
    // setting a string that `resolveBucketFillMode` silently ignores, falling back to the
    // default — which would still be raster today, so nothing would fail. It would fail the
    // moment phase 3 flips the env default to `auto`, in the perf suite, months later.
    const match = spec.match(
      new RegExp(`localStorage\\.setItem\\("${BUCKET_FILL_MODE_STORAGE_KEY}",\\s*"([^"]+)"`),
    );
    expect(match).not.toBeNull();
    expect(isBucketFillMode(match![1])).toBe(true);
    expect(resolveBucketFillMode({ env: "auto", storage: match![1] })).toBe("raster");
  });
});

describe("vectorMayRun", () => {
  it("is true for auto and vector, false for raster", () => {
    expect(vectorMayRun("auto")).toBe(true);
    expect(vectorMayRun("vector")).toBe(true);
    expect(vectorMayRun("raster")).toBe(false);
  });
});
