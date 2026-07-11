import { describe, it, expect, beforeEach } from "vitest";
import { useViewerStore } from "@/stores/viewerStore";
import { resetProjectData } from "@/stores/viewerCommands";
import { useSessionStore } from "@/stores/sessionStore";

// Reset store before each test
beforeEach(() => {
  resetProjectData();
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

// [refactor jul11 P2.2⑥] Annotation CRUD/reset cases retired with the deleted store collection.
// Cache/action coverage now lives in queries/__tests__/useAnnotations.test.tsx (including guards,
// project isolation, structural sharing, bucket fill, and takeoff undo/redo).

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

// [refactor jul11 P2.2⑨] Collection/CRUD/dedup/persistence cases moved to
// queries/__tests__/useYoloTags.test.tsx with the Query ownership flip. Zustand retains UI only.
describe("viewerStore — YOLO tag UI state", () => {
  it("visibility defaults to empty, toggles, and reset clears all browse/table state", () => {
    expect(useViewerStore.getState().yoloTagVisibility).toEqual({});
    useViewerStore.getState().setYoloTagVisibility("tag-1", false);
    expect(useViewerStore.getState().yoloTagVisibility["tag-1"]).toBe(false);
    useViewerStore.setState({
      activeYoloTagId: "tag-1",
      activeYoloTagFilter: "tag-1",
      tagBrowseId: "tag-1",
      tagBrowseIndex: 4,
      activeTableTagViews: {
        region: {
          regionId: "region",
          pageNum: 1,
          bbox: [0, 0, 1, 1],
          tagTexts: ["D-101"],
          source: "schedule",
        },
      },
    });

    resetProjectData();
    expect(useViewerStore.getState()).toMatchObject({
      yoloTagVisibility: {},
      activeYoloTagId: null,
      activeYoloTagFilter: null,
      tagBrowseId: null,
      tagBrowseIndex: 0,
      activeTableTagViews: {},
    });
  });
});

describe("viewerStore — page drawing numbers", () => {
  it("setPageDrawingNumbers replaces the map", () => {
    expect(useSessionStore.getState().pageDrawingNumbers).toEqual({});
    useSessionStore.getState().setPageDrawingNumbers({
      1: "E-101",
      2: "E-102",
      3: null,
    });
    expect(useSessionStore.getState().pageDrawingNumbers).toEqual({
      1: "E-101",
      2: "E-102",
      3: null,
    });
  });

  it("resetProjectData clears pageDrawingNumbers", () => {
    useSessionStore.getState().setPageDrawingNumbers({ 1: "A-501" });
    resetProjectData();
    expect(useSessionStore.getState().pageDrawingNumbers).toEqual({});
  });
});

describe("viewerStore — resetProjectData", () => {
  it("clears project state back to defaults", () => {
    useViewerStore.getState().setNumPages(20);
    useViewerStore.getState().setPage(10);

    resetProjectData();

    expect(useViewerStore.getState().pageNumber).toBe(1);
    expect(useViewerStore.getState().tableParseStep).toBe("idle");
  });
});

// [refactor jul9 P2.2①] Chat slice characterization (SPEC §2.C). After the migration ONLY the
// chatScope UI knob remains in zustand — the message DATA (list + add/set/clear) moved to the
// TanStack Query cache (covered by src/queries/__tests__/useChatMessages.test.tsx). T-C1 and the
// chatMessages half of T-C2 were RETIRED here in the same commit that deleted those store fields.
describe("viewerStore — chat scope (UI state; data lives in the query cache)", () => {
  // ── T-C2 (scope half — chatMessages assertion retired with the field) ──────
  it("resetProjectData re-defaults chatScope to 'page'", () => {
    useViewerStore.getState().setChatScope("project");
    resetProjectData();
    expect(useViewerStore.getState().chatScope).toBe("page"); // scope is zustand-owned UI
  });

  // ── T-C3 (chatScope default + toggle) ──────────────────────────────────────
  it("chatScope defaults to 'page' and toggles", () => {
    expect(useViewerStore.getState().chatScope).toBe("page");
    useViewerStore.getState().setChatScope("project");
    expect(useViewerStore.getState().chatScope).toBe("project");
    useViewerStore.getState().setChatScope("page");
    expect(useViewerStore.getState().chatScope).toBe("page");
  });
});
