// [refactor jun12 P0.5-G3] Pins the reprocess merge policy: user data survives,
// computed keys are cleared for refresh. If a new computed key is added to the
// pipeline without joining REPROCESS_COMPUTED_KEYS it will (safely) be treated
// as user data and survive reprocess — the conservative failure mode.
import { describe, expect, it } from "vitest";
import {
  REPROCESS_COMPUTED_KEYS,
  carryNonComputedIntelligence,
} from "../intelligence-merge";

describe("carryNonComputedIntelligence", () => {
  it("preserves user parsedRegions and unknown keys (the G3 data-loss class)", () => {
    const existing = {
      parsedRegions: [{ id: "r1", type: "schedule" }],
      someFutureKey: { v: 1 },
      classifiedTables: [{ stale: true }],
      yoloHeatmap: { stale: true },
    };
    const carried = carryNonComputedIntelligence(existing);
    expect(carried.parsedRegions).toEqual([{ id: "r1", type: "schedule" }]);
    expect(carried.someFutureKey).toEqual({ v: 1 });
    expect(carried).not.toHaveProperty("classifiedTables");
    expect(carried).not.toHaveProperty("yoloHeatmap");
  });

  it("[zones T2] pageZones is a computed key: refreshed by the post-YOLO step, cleared on reprocess", () => {
    expect(REPROCESS_COMPUTED_KEYS).toContain("pageZones");
    expect(REPROCESS_COMPUTED_KEYS).toContain("regionsV2"); // [regions v2 2026-10-24] shadow classifier output
    expect(REPROCESS_COMPUTED_KEYS).toContain("shapes"); // [tag-mapping v2 2026-10-24] shape-ensemble summary
    const carried = carryNonComputedIntelligence({ pageZones: { stale: true }, parsedRegions: [] });
    expect(carried).toEqual({ parsedRegions: [] });
  });

  it("[evidence T4] evidence is a computed key: every writer rebuilds it, reprocess clears it", () => {
    expect(REPROCESS_COMPUTED_KEYS).toContain("evidence");
    expect(carryNonComputedIntelligence({ evidence: { v: 1 }, parsedRegions: [] })).toEqual({ parsedRegions: [] });
  });

  it("[census F2 2026-10-24] channels and tiles are NOT computed keys: no reprocess that clears computed keys rebuilds them, so they must survive it", () => {
    expect(REPROCESS_COMPUTED_KEYS).not.toContain("channels");
    expect(REPROCESS_COMPUTED_KEYS).not.toContain("tiles");
    const channels = { v: 1, kind: "vector", vectorPaths: 10 };
    expect(carryNonComputedIntelligence({ channels, tiles: { v: 1 }, classifiedTables: [] })).toEqual({ channels, tiles: { v: 1 } });
  });

  it("clears every computed key so the rebuild refreshes-or-drops them", () => {
    const allComputed = Object.fromEntries(
      REPROCESS_COMPUTED_KEYS.map((k) => [k, { stale: true }]),
    );
    expect(carryNonComputedIntelligence(allComputed)).toEqual({});
  });

  it("tolerates null / non-object / array jsonb states", () => {
    expect(carryNonComputedIntelligence(null)).toEqual({});
    expect(carryNonComputedIntelligence(undefined)).toEqual({});
    expect(carryNonComputedIntelligence("corrupt")).toEqual({});
    expect(carryNonComputedIntelligence([1, 2])).toEqual({});
  });

  it("simulates the full reprocess write: user keys + freshly computed keys", () => {
    const existing = {
      parsedRegions: [{ id: "r1" }],
      classification: { old: true },
      textRegions: [{ old: true }],
    };
    // mirror of the route's rebuild flow
    let pageIntelligence = carryNonComputedIntelligence(existing);
    const intel = { classification: { fresh: true } }; // this run computed only classification
    pageIntelligence = { ...pageIntelligence, ...intel };
    expect(pageIntelligence).toEqual({
      parsedRegions: [{ id: "r1" }],
      classification: { fresh: true },
      // textRegions correctly absent: computed empty this run ⇒ stale copy dropped
    });
  });
});

// [bugfix jul5 H6/DR002] project-level policy — regression for the yoloTags wipe
import { mergeProjectIntelligence } from "@/lib/intelligence-merge";

describe("mergeProjectIntelligence (H6 regression)", () => {
  it("user keys (yoloTags, classCsiOverrides) and UNKNOWN keys survive; computed keys refresh", () => {
    const existing = {
      disciplines: [{ discipline: "A", count: 1 }], // stale computed — must refresh
      yoloTags: { door: ["08 11 00"] }, // user-curated — THE H6 wipe victim
      classCsiOverrides: { window: "08 50 00" }, // user config — old code's only survivor
      someFutureKey: { keep: true }, // unknown — doctrine: never eaten
    };
    const computed = {
      disciplines: [{ discipline: "M", count: 3 }],
      refGraph: { edges: [1] },
      csiGraph: { nodes: [] },
      pageCount: 7,
    };
    const merged = mergeProjectIntelligence(existing, computed);
    expect(merged.yoloTags).toEqual({ door: ["08 11 00"] });
    expect(merged.classCsiOverrides).toEqual({ window: "08 50 00" });
    expect(merged.someFutureKey).toEqual({ keep: true });
    expect(merged.disciplines).toEqual([{ discipline: "M", count: 3 }]);
    expect(merged.pageCount).toBe(7);
  });

  it("this-run-empty computed keys (undefined) still DROP after the jsonb write, matching legacy", () => {
    const merged = mergeProjectIntelligence(
      { disciplines: [{ discipline: "A", count: 1 }], yoloTags: { x: 1 } },
      { disciplines: undefined, refGraph: undefined, csiGraph: undefined, pageCount: 0 },
    );
    // jsonb serialization drops undefined — simulate the round-trip
    const written = JSON.parse(JSON.stringify(merged));
    expect("disciplines" in written).toBe(false); // stale computed key gone (legacy-identical)
    expect(written.yoloTags).toEqual({ x: 1 }); // user key survives
    expect(written.pageCount).toBe(0);
  });

  it("null/garbage existing → just the computed object", () => {
    for (const existing of [null, undefined, "junk", [1, 2]]) {
      const merged = mergeProjectIntelligence(existing, { pageCount: 2 });
      expect(merged).toEqual({ pageCount: 2 });
    }
  });
});
