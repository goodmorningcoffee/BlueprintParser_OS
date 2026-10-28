// @vitest-environment node
// [table pipeline WP-3.H, C1-B3] viewerProjectIntelligence: the signed-in (and demo) bootstrap strips
// large / server-only project keys. publicProjectIntelligence and its own test stay untouched.

import { describe, expect, it } from "vitest";
import { publicProjectIntelligence, viewerProjectIntelligence } from "@/lib/knowledge-graph";

describe("viewerProjectIntelligence", () => {
  const index = {
    v: 1, at: "t",
    regions: { "1": [{ regionId: "r", kind: "schedule", title: "T", bbox: [0, 0, 1, 1], rows: 1, origin: "classic" }] },
    keys: { "1": { A: [["r", "schedule", "r1", null]] } },
    specSections: { "087100": [[1, "r"]] },
    inbox: { "1": [] },
  };

  it("strips tagMaps and the server-only index slices, keeps regions and every other key", () => {
    const pi = { summaries: { a: 1 }, tagMaps: { r: { big: true } }, structureIndex: index, crossSetLinks: { keep: 1 } };
    const out = viewerProjectIntelligence(pi);
    expect(out).toEqual({ summaries: { a: 1 }, structureIndex: { v: 1, at: "t", regions: index.regions }, crossSetLinks: { keep: 1 } });
    expect(pi.tagMaps).toBeDefined(); // the input is not mutated
    expect(pi.structureIndex.keys).toBeDefined();
  });

  it("returns the input itself when there is nothing to strip (existing bootstraps byte-identical)", () => {
    const pi = { summaries: { a: 1 }, structureIndex: { v: 1, at: "t", regions: {} } };
    expect(viewerProjectIntelligence(pi)).toBe(pi);
    const bare = { summaries: null };
    expect(viewerProjectIntelligence(bare)).toBe(bare);
  });

  it("composes with publicProjectIntelligence on the demo path", () => {
    const pi = { summaries: {}, crossSetLinks: { v: 2 }, tagMaps: {}, structureIndex: index };
    const out = viewerProjectIntelligence(publicProjectIntelligence(pi));
    expect(Object.keys(out).sort()).toEqual(["structureIndex", "summaries"]);
  });
});
