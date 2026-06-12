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
