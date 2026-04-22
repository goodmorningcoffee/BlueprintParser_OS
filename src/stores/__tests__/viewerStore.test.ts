import { describe, it, expect, beforeEach } from "vitest";
import { useViewerStore } from "@/stores/viewerStore";

// Reset store before each test
beforeEach(() => {
  useViewerStore.getState().resetProjectData();
});

describe("viewerStore — navigation", () => {
  it("has default page 1", () => {
    expect(useViewerStore.getState().pageNumber).toBe(1);
  });

  it("setPage updates pageNumber (clamped to numPages)", () => {
    useViewerStore.getState().setNumPages(10);
    useViewerStore.getState().setPage(5);
    expect(useViewerStore.getState().pageNumber).toBe(5);
  });

  it("setPage clamps to valid range", () => {
    useViewerStore.getState().setNumPages(3);
    useViewerStore.getState().setPage(10);
    expect(useViewerStore.getState().pageNumber).toBe(3);
    useViewerStore.getState().setPage(0);
    expect(useViewerStore.getState().pageNumber).toBe(1);
  });

  it("setScale updates scale", () => {
    useViewerStore.getState().setScale(2.5);
    expect(useViewerStore.getState().scale).toBe(2.5);
  });

  it("setMode updates mode", () => {
    useViewerStore.getState().setMode("markup");
    expect(useViewerStore.getState().mode).toBe("markup");
  });
});

describe("viewerStore — panels", () => {
  it("toggleTextPanel flips state", () => {
    expect(useViewerStore.getState().showTextPanel).toBe(false);
    useViewerStore.getState().toggleTextPanel();
    expect(useViewerStore.getState().showTextPanel).toBe(true);
    useViewerStore.getState().toggleTextPanel();
    expect(useViewerStore.getState().showTextPanel).toBe(false);
  });

  it("toggleDetectionPanel flips state", () => {
    expect(useViewerStore.getState().showDetectionPanel).toBe(false);
    useViewerStore.getState().toggleDetectionPanel();
    expect(useViewerStore.getState().showDetectionPanel).toBe(true);
  });
});

describe("viewerStore — annotations", () => {
  it("starts with empty annotations", () => {
    expect(useViewerStore.getState().annotations).toEqual([]);
  });

  it("addAnnotation appends to list", () => {
    useViewerStore.getState().addAnnotation({
      id: 1, pageNumber: 1, name: "test", bbox: [0.1, 0.2, 0.3, 0.4],
      note: null, source: "user", data: {},
    });
    expect(useViewerStore.getState().annotations).toHaveLength(1);
    expect(useViewerStore.getState().annotations[0].name).toBe("test");
  });

  it("removeAnnotation removes by id", () => {
    useViewerStore.getState().addAnnotation({
      id: 1, pageNumber: 1, name: "a", bbox: [0, 0, 0.5, 0.5], note: null, source: "user", data: {},
    });
    useViewerStore.getState().addAnnotation({
      id: 2, pageNumber: 1, name: "b", bbox: [0, 0, 0.5, 0.5], note: null, source: "yolo", data: {},
    });
    useViewerStore.getState().removeAnnotation(1);
    expect(useViewerStore.getState().annotations).toHaveLength(1);
    expect(useViewerStore.getState().annotations[0].id).toBe(2);
  });
});

describe("viewerStore — detection visibility", () => {
  it("hiddenAnnotationIds starts empty", () => {
    expect(useViewerStore.getState().hiddenAnnotationIds.size).toBe(0);
  });

  it("toggleAnnotationVisibility adds then removes", () => {
    useViewerStore.getState().toggleAnnotationVisibility(42);
    expect(useViewerStore.getState().hiddenAnnotationIds.has(42)).toBe(true);
    useViewerStore.getState().toggleAnnotationVisibility(42);
    expect(useViewerStore.getState().hiddenAnnotationIds.has(42)).toBe(false);
  });
});

describe("viewerStore — table parse", () => {
  it("setTableParseStep updates step", () => {
    useViewerStore.getState().setTableParseStep("select-region");
    expect(useViewerStore.getState().tableParseStep).toBe("select-region");
  });

  it("resetTableParse clears parse state", () => {
    useViewerStore.getState().setTableParseStep("review");
    useViewerStore.getState().setTableParseRegion([0.1, 0.2, 0.5, 0.6]);
    useViewerStore.getState().resetTableParse();
    expect(useViewerStore.getState().tableParseStep).toBe("idle");
    expect(useViewerStore.getState().tableParseRegion).toBeNull();
  });
});

describe("viewerStore — YOLO tags", () => {
  it("starts with empty tags", () => {
    expect(useViewerStore.getState().yoloTags).toEqual([]);
  });

  it("addYoloTag appends tag", () => {
    useViewerStore.getState().addYoloTag({
      id: "tag-1", name: "T-1", tagText: "T-1",
      yoloClass: "door", yoloModel: "model-v1",
      source: "schedule", scope: "project",
      description: "Test door", instances: [],
    });
    expect(useViewerStore.getState().yoloTags).toHaveLength(1);
  });

  it("removeYoloTag removes by id", () => {
    useViewerStore.getState().addYoloTag({
      id: "tag-1", name: "T-1", tagText: "T-1",
      yoloClass: "", yoloModel: "", source: "keynote", scope: "page",
      description: "", instances: [],
    });
    useViewerStore.getState().removeYoloTag("tag-1");
    expect(useViewerStore.getState().yoloTags).toHaveLength(0);
  });

  it("yoloTagVisibility defaults to empty, toggles work", () => {
    expect(useViewerStore.getState().yoloTagVisibility).toEqual({});
    useViewerStore.getState().setYoloTagVisibility("tag-1", false);
    expect(useViewerStore.getState().yoloTagVisibility["tag-1"]).toBe(false);
    useViewerStore.getState().setYoloTagVisibility("tag-1", true);
    expect(useViewerStore.getState().yoloTagVisibility["tag-1"]).toBe(true);
  });

  it("addYoloTagsBulk appends in one store update (batch Map Tags path)", () => {
    const mk = (id: string) => ({
      id, name: id, tagText: id,
      yoloClass: "door", yoloModel: "v1",
      source: "schedule" as const, scope: "project" as const,
      description: "", instances: [],
    });
    useViewerStore.getState().addYoloTagsBulk([mk("D-101"), mk("D-102"), mk("D-103")]);
    const tags = useViewerStore.getState().yoloTags;
    expect(tags).toHaveLength(3);
    expect(tags.map((t) => t.id)).toEqual(["D-101", "D-102", "D-103"]);
  });

  it("addYoloTagsBulk coexists with addYoloTag (preserves order)", () => {
    useViewerStore.getState().addYoloTag({
      id: "first", name: "first", tagText: "first",
      yoloClass: "", yoloModel: "", source: "keynote", scope: "page",
      description: "", instances: [],
    });
    useViewerStore.getState().addYoloTagsBulk([{
      id: "second", name: "second", tagText: "second",
      yoloClass: "", yoloModel: "", source: "schedule", scope: "project",
      description: "", instances: [],
    }, {
      id: "third", name: "third", tagText: "third",
      yoloClass: "", yoloModel: "", source: "schedule", scope: "project",
      description: "", instances: [],
    }]);
    expect(useViewerStore.getState().yoloTags.map((t) => t.id))
      .toEqual(["first", "second", "third"]);
  });

  it("addYoloTagsBulk with empty array is a no-op", () => {
    useViewerStore.getState().addYoloTagsBulk([]);
    expect(useViewerStore.getState().yoloTags).toEqual([]);
  });

  it("addYoloTagsBulk replaces entries with the same (source, tagText, scope, yoloClass) tuple", () => {
    // Simulate the real bug: user runs Map Tags twice with different strictness.
    // First batch finds 3 instances; second batch finds 5 for the same tag.
    // Under append semantics, yoloTags had two entries for "D-101" and
    // find(...) returned the first (stale) one with 3 instances.
    // Under dedup semantics, the second batch replaces the first.
    const mkSchedule = (id: string, tagText: string, instanceCount: number) => ({
      id, name: tagText, tagText,
      yoloClass: "door", yoloModel: "v1",
      source: "schedule" as const, scope: "project" as const,
      description: "", instances: Array.from({ length: instanceCount }, (_, i) => ({
        pageNumber: i + 1, annotationId: -1,
        bbox: [0, 0, 0.1, 0.1] as [number, number, number, number],
        confidence: 1.0,
      })),
    });

    useViewerStore.getState().addYoloTagsBulk([mkSchedule("first-map-D-101", "D-101", 3)]);
    expect(useViewerStore.getState().yoloTags).toHaveLength(1);
    expect(useViewerStore.getState().yoloTags[0].instances).toHaveLength(3);

    useViewerStore.getState().addYoloTagsBulk([mkSchedule("second-map-D-101", "D-101", 5)]);
    const after = useViewerStore.getState().yoloTags;
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe("second-map-D-101");
    expect(after[0].instances).toHaveLength(5);
  });

  it("addYoloTagsBulk keeps distinct tuples — different source, scope, or yoloClass do not collide", () => {
    const base = { tagText: "D-101", description: "", instances: [] };
    useViewerStore.getState().addYoloTagsBulk([
      { ...base, id: "a", name: "D-101", source: "schedule", scope: "project", yoloClass: "door", yoloModel: "v1" },
      { ...base, id: "b", name: "D-101", source: "keynote",  scope: "project", yoloClass: "door", yoloModel: "v1" },
      { ...base, id: "c", name: "D-101", source: "schedule", scope: "page",    yoloClass: "door", yoloModel: "v1", pageNumber: 2 },
      { ...base, id: "d", name: "D-101", source: "schedule", scope: "project", yoloClass: "window", yoloModel: "v1" },
    ]);
    const tags = useViewerStore.getState().yoloTags;
    expect(tags).toHaveLength(4);
    expect(tags.map((t) => t.id).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("addYoloTagsBulk dedup is case-insensitive on tagText", () => {
    const mk = (id: string, tagText: string) => ({
      id, name: tagText, tagText,
      yoloClass: "door", yoloModel: "v1",
      source: "schedule" as const, scope: "project" as const,
      description: "", instances: [],
    });
    useViewerStore.getState().addYoloTagsBulk([mk("upper", "D-101"), mk("lower", "d-101")]);
    const tags = useViewerStore.getState().yoloTags;
    expect(tags).toHaveLength(1);
    expect(tags[0].id).toBe("lower"); // later one wins
  });

  it("addYoloTag (single) replaces on identity-tuple match", () => {
    const mk = (id: string) => ({
      id, name: "D-101", tagText: "D-101",
      yoloClass: "door", yoloModel: "v1",
      source: "schedule" as const, scope: "project" as const,
      description: "", instances: [],
    });
    useViewerStore.getState().addYoloTag(mk("first"));
    useViewerStore.getState().addYoloTag(mk("second"));
    const tags = useViewerStore.getState().yoloTags;
    expect(tags).toHaveLength(1);
    expect(tags[0].id).toBe("second");
  });
});

describe("viewerStore — page drawing numbers", () => {
  it("setPageDrawingNumbers replaces the map", () => {
    expect(useViewerStore.getState().pageDrawingNumbers).toEqual({});
    useViewerStore.getState().setPageDrawingNumbers({
      1: "E-101",
      2: "E-102",
      3: null,
    });
    expect(useViewerStore.getState().pageDrawingNumbers).toEqual({
      1: "E-101",
      2: "E-102",
      3: null,
    });
  });

  it("resetProjectData clears pageDrawingNumbers", () => {
    useViewerStore.getState().setPageDrawingNumbers({ 1: "A-501" });
    useViewerStore.getState().resetProjectData();
    expect(useViewerStore.getState().pageDrawingNumbers).toEqual({});
  });
});

describe("viewerStore — resetProjectData", () => {
  it("clears project state back to defaults", () => {
    useViewerStore.getState().setNumPages(20);
    useViewerStore.getState().setPage(10);
    useViewerStore.getState().addAnnotation({
      id: 1, pageNumber: 1, name: "test", bbox: [0, 0, 0.5, 0.5],
      note: null, source: "user", data: {},
    });

    useViewerStore.getState().resetProjectData();

    expect(useViewerStore.getState().pageNumber).toBe(1);
    expect(useViewerStore.getState().annotations).toEqual([]);
    expect(useViewerStore.getState().yoloTags).toEqual([]);
    expect(useViewerStore.getState().tableParseStep).toBe("idle");
  });
});
