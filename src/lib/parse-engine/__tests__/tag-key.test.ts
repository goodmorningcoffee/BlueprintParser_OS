// @vitest-environment node
// [table pipeline WP-2.D1] The shared tag key, the TagInstanceV1 → YoloTag instance projection, and
// the server row guard kept in lockstep with the client bootstrap guard (useYoloTags `isYoloTag`,
// reached through `seedYoloTagsFromBootstrap`, which filters rows with it).
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  isYoloTagRow,
  projectTagInstance,
  tagInstanceKey,
  type TagInstanceV1,
  yoloTagServerKey,
} from "@/lib/parse-engine/tag-key";
import { readYoloTags, seedYoloTagsFromBootstrap } from "@/queries/useYoloTags";

const base = {
  id: "t1",
  name: "QX-1",
  tagText: "qx-1",
  yoloClass: "circle",
  yoloModel: "yolo_primitive",
  source: "keynote" as const,
  scope: "page" as const,
  pageNumber: 3,
  instances: [],
};

/** The rows the client guard keeps, by id. */
function clientKeeps(rows: unknown[]): string[] {
  const qc = new QueryClient();
  seedYoloTagsFromBootstrap(qc, "p", { yoloTags: rows });
  return readYoloTags(qc, "p").map((row) => row.id);
}

describe("yoloTagServerKey (PLAN §2.1)", () => {
  it("has the documented shape, upper-cases the text", () => {
    expect(yoloTagServerKey(base)).toBe("keynote|page|3|*|QX-1|circle");
  });

  it("is page-aware for page scope only (K05)", () => {
    expect(yoloTagServerKey({ ...base, pageNumber: 7 })).not.toBe(yoloTagServerKey(base));
    const project = { ...base, scope: "project" };
    expect(yoloTagServerKey({ ...project, pageNumber: 7 })).toBe(yoloTagServerKey(project));
    expect(yoloTagServerKey(project)).toBe("keynote|project|*|*|QX-1|circle");
  });

  it("is region-aware when links.regionId is set", () => {
    const a = { ...base, scope: "project", links: { regionId: "pr-a" } };
    const b = { ...base, scope: "project", links: { regionId: "pr-b" } };
    expect(yoloTagServerKey(a)).toBe("keynote|project|*|pr-a|QX-1|circle");
    expect(yoloTagServerKey(a)).not.toBe(yoloTagServerKey(b));
  });

  it("a page-scoped tag without a page keys as *, never 'undefined'", () => {
    const { pageNumber: _p, ...noPage } = base;
    expect(yoloTagServerKey(noPage)).toBe("keynote|page|*|*|QX-1|circle");
  });

  it("free-floating tags key with an empty class", () => {
    expect(yoloTagServerKey({ ...base, yoloClass: "" })).toBe("keynote|page|3|*|QX-1|");
  });
});

describe("tagInstanceKey", () => {
  it("absorbs float jitter below 1e-4 and separates pages", () => {
    expect(tagInstanceKey(2, [0.1, 0.2, 0.3, 0.4])).toBe(tagInstanceKey(2, [0.100001, 0.2, 0.3, 0.399999]));
    expect(tagInstanceKey(2, [0.1, 0.2, 0.3, 0.4])).not.toBe(tagInstanceKey(3, [0.1, 0.2, 0.3, 0.4]));
  });
});

describe("projectTagInstance (TagInstanceV1 → ScoredMatch)", () => {
  const inst: TagInstanceV1 = {
    id: "i1",
    page: 4,
    b: [0.1, 0.2, 0.15, 0.25],
    anchor: { src: "text" },
    score: 0.82,
    tier: "high",
    status: "auto",
  };

  it("maps the fields and falls back to annotationId -1", () => {
    expect(projectTagInstance(inst)).toEqual({
      pageNumber: 4,
      annotationId: -1,
      bbox: [0.1, 0.2, 0.15, 0.25],
      confidence: 0.82,
      score: 0.82,
      confidenceTier: "high",
      id: "i1",
      status: "auto",
    });
    expect(projectTagInstance({ ...inst, anchor: { src: "yolo", annotationId: 77 } }).annotationId).toBe(77);
  });

  it("a projected instance passes the client isYoloTag guard", () => {
    const row = { ...base, instances: [projectTagInstance(inst)] };
    expect(clientKeeps([row])).toEqual(["t1"]);
    expect(isYoloTagRow(row)).toBe(true);
  });

  it("the bbox is a copy, not the stored array", () => {
    expect(projectTagInstance(inst).bbox).not.toBe(inst.b);
  });
});

describe("isYoloTagRow agrees with the client bootstrap guard", () => {
  const goodInstance = { pageNumber: 1, annotationId: -1, bbox: [0, 0, 1, 1], confidence: 1 };
  const probes: [string, unknown][] = [
    ["minimal", { ...base }],
    ["with instance", { ...base, instances: [goodInstance] }],
    ["with extras", { ...base, description: "d", color: "#fff", csiCodes: ["08 11 13"], mapScope: { strictness: "strict" } }],
    ["bad source", { ...base, source: "legend" }],
    ["bad scope", { ...base, scope: "sheet" }],
    ["missing yoloModel", { ...base, yoloModel: undefined }],
    ["instances not array", { ...base, instances: null }],
    ["NaN annotationId", { ...base, instances: [{ ...goodInstance, annotationId: Number.NaN }] }],
    ["null annotationId", { ...base, instances: [{ ...goodInstance, annotationId: null }] }],
    ["3-number bbox", { ...base, instances: [{ ...goodInstance, bbox: [0, 0, 1] }] }],
    ["string confidence", { ...base, instances: [{ ...goodInstance, confidence: "1" }] }],
    ["null row", null],
    ["number row", 5],
  ];

  for (const [name, row] of probes) {
    it(name, () => {
      const id = (row as { id?: string } | null)?.id;
      const kept = clientKeeps([row]).length === 1 && id !== undefined;
      expect(isYoloTagRow(row)).toBe(kept);
    });
  }

  it("is stricter only on the optional fields this WP adds", () => {
    expect(isYoloTagRow({ ...base, links: { regionId: "pr-1", kind: "legend" } })).toBe(true);
    expect(isYoloTagRow({ ...base, links: { kind: "table" } })).toBe(false);
    expect(isYoloTagRow({ ...base, links: "pr-1" })).toBe(false);
    expect(isYoloTagRow({ ...base, links: { regionId: 5 } })).toBe(false);
    expect(isYoloTagRow({ ...base, instances: [{ ...goodInstance, status: "maybe" }] })).toBe(false);
    expect(isYoloTagRow({ ...base, instances: [{ ...goodInstance, status: "rejected", id: "i" }] })).toBe(true);
  });
});
