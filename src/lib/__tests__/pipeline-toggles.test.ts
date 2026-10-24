// [fix 2026-10-24 T1a] The Pipeline tab saved disabledSteps/ensemble under `pipeline.*`; every reader
// read the top level. One accessor now reads both (top level first) and the PUT hoists.
import { describe, expect, it } from "vitest";
import {
  foldPipelineToggles,
  hoistPipelineToggles,
  resolvePipelineToggles,
} from "@/lib/pipeline-toggles";

describe("resolvePipelineToggles", () => {
  it("empty / null config → nothing disabled, no ensemble override", () => {
    for (const pc of [undefined, null, {}]) {
      const t = resolvePipelineToggles(pc);
      expect([...t.disabledSteps]).toEqual([]);
      expect(t.ensembleConfig).toBeUndefined();
    }
  });

  it("reads the top level (where saves land since the fix)", () => {
    const t = resolvePipelineToggles({
      disabledSteps: ["yolo-heatmap"],
      ensemble: { config: { minDistinctVotes: 3 } },
    });
    expect(t.disabledSteps.has("yolo-heatmap")).toBe(true);
    expect(t.ensembleConfig).toEqual({ minDistinctVotes: 3 });
  });

  it("falls back to the LEGACY nested copy the tab used to write", () => {
    const t = resolvePipelineToggles({
      pipeline: { disabledSteps: ["ensemble", "shape-parse"], ensemble: { config: { probabilityThreshold: 0.7 } } },
    });
    expect([...t.disabledSteps].sort()).toEqual(["ensemble", "shape-parse"]);
    expect(t.ensembleConfig).toEqual({ probabilityThreshold: 0.7 });
  });

  it("top level wins over nested, per key (an empty top-level list re-enables everything)", () => {
    const t = resolvePipelineToggles({
      disabledSteps: [],
      pipeline: { disabledSteps: ["ensemble"], ensemble: { config: { minDistinctVotes: 1 } } },
    });
    expect([...t.disabledSteps]).toEqual([]);
    expect(t.ensembleConfig).toEqual({ minDistinctVotes: 1 }); // no top-level ensemble → nested
  });

  it("tolerates garbage without throwing", () => {
    const t = resolvePipelineToggles({ disabledSteps: "ensemble", ensemble: { config: [1] }, pipeline: 5 });
    expect([...t.disabledSteps]).toEqual([]);
    expect(t.ensembleConfig).toBeUndefined();
    expect([...resolvePipelineToggles({ disabledSteps: ["a", 3, null] }).disabledSteps]).toEqual(["a"]);
  });
});

describe("hoistPipelineToggles (PUT) / foldPipelineToggles (GET)", () => {
  it("moves the two keys out of `pipeline`; leaves the rest", () => {
    const body = { disabledSteps: ["ensemble"], ensemble: { config: { minDistinctVotes: 2 } }, csiSpatialGrid: { rows: 3, cols: 3 } };
    const { pipeline, topLevel } = hoistPipelineToggles(body);
    expect(pipeline).toEqual({ csiSpatialGrid: { rows: 3, cols: 3 } });
    expect(topLevel).toEqual({ disabledSteps: ["ensemble"], ensemble: { config: { minDistinctVotes: 2 } } });
    expect(body.disabledSteps).toEqual(["ensemble"]); // input not mutated
  });

  it("an absent key is not emitted (stored top-level value is left alone)", () => {
    expect(hoistPipelineToggles({ pageConcurrency: 4 })).toEqual({ pipeline: { pageConcurrency: 4 }, topLevel: {} });
  });

  it("hoist → stored shape → resolve/fold round-trips what the tab sent", () => {
    const sent = { disabledSteps: ["yolo-heatmap"], pageConcurrency: 2 };
    const { pipeline, topLevel } = hoistPipelineToggles(sent);
    const stored = { pipeline, ...topLevel };
    expect(resolvePipelineToggles(stored).disabledSteps.has("yolo-heatmap")).toBe(true);
    expect(foldPipelineToggles(stored)).toEqual(sent);
  });

  it("fold shows legacy nested values unchanged, and nothing extra for an untouched company", () => {
    expect(foldPipelineToggles({ pipeline: { disabledSteps: ["ensemble"] } })).toEqual({ disabledSteps: ["ensemble"] });
    expect(foldPipelineToggles({ pipeline: { legacyKnob: "on" } })).toEqual({ legacyKnob: "on" });
    expect(foldPipelineToggles(null)).toEqual({});
  });
});
