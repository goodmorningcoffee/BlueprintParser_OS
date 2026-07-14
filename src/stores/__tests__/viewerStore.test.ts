import { describe, it, expect, beforeEach } from "vitest";
import { useUiStore } from "@/stores/uiStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import { useToolStore } from "@/stores/toolStore";
import { useParseFlowStore } from "@/stores/parseFlowStore";
import { resetProjectData, setTableParseStep, toggleDetectionPanel } from "@/stores/viewerCommands";
import { useSessionStore } from "@/stores/sessionStore";

// Reset store before each test
beforeEach(() => {
  resetProjectData();
  // P2.5 intentionally preserves presentation choices across project switches. Each independent
  // test starts from construction UI state so one case cannot leak an approved survivor to the next.
  useUiStore.setState(useUiStore.getInitialState(), true);
});

describe("viewerCoreStore — navigation", () => {
  it("has default page 1", () => {
    expect(useViewerCoreStore.getState().pageNumber).toBe(1);
  });

  it("setPage updates pageNumber (clamped to numPages)", () => {
    useViewerCoreStore.getState().setNumPages(10);
    useViewerCoreStore.getState().setPage(5);
    expect(useViewerCoreStore.getState().pageNumber).toBe(5);
  });

  it("setPage clamps to valid range", () => {
    useViewerCoreStore.getState().setNumPages(3);
    useViewerCoreStore.getState().setPage(10);
    expect(useViewerCoreStore.getState().pageNumber).toBe(3);
    useViewerCoreStore.getState().setPage(0);
    expect(useViewerCoreStore.getState().pageNumber).toBe(1);
  });

  it("setScale updates scale", () => {
    useViewerCoreStore.getState().setScale(2.5);
    expect(useViewerCoreStore.getState().scale).toBe(2.5);
  });

  it("setMode updates mode", () => {
    useToolStore.getState().setMode("markup");
    expect(useToolStore.getState().mode).toBe("markup");
  });
});

describe("uiStore — panels", () => {
  it("toggleTextPanel flips state", () => {
    expect(useUiStore.getState().showTextPanel).toBe(false);
    useUiStore.getState().toggleTextPanel();
    expect(useUiStore.getState().showTextPanel).toBe(true);
    useUiStore.getState().toggleTextPanel();
    expect(useUiStore.getState().showTextPanel).toBe(false);
  });

  it("toggleDetectionPanel flips state", () => {
    expect(useUiStore.getState().showDetectionPanel).toBe(false);
    toggleDetectionPanel();
    expect(useUiStore.getState().showDetectionPanel).toBe(true);
  });
});

// [refactor jul11 P2.2⑥] Annotation CRUD/reset cases retired with the deleted store collection.
// Cache/action coverage now lives in queries/__tests__/useAnnotations.test.tsx (including guards,
// project isolation, structural sharing, bucket fill, and takeoff undo/redo).

describe("uiStore — detection visibility", () => {
  it("hiddenAnnotationIds starts empty", () => {
    expect(useUiStore.getState().hiddenAnnotationIds.size).toBe(0);
  });

  it("toggleAnnotationVisibility adds then removes", () => {
    useUiStore.getState().toggleAnnotationVisibility(42);
    expect(useUiStore.getState().hiddenAnnotationIds.has(42)).toBe(true);
    useUiStore.getState().toggleAnnotationVisibility(42);
    expect(useUiStore.getState().hiddenAnnotationIds.has(42)).toBe(false);
  });
});

describe("parseFlowStore — table parse", () => {
  it("setTableParseStep updates step", () => {
    setTableParseStep("select-region");
    expect(useParseFlowStore.getState().tableParseStep).toBe("select-region");
  });

  it("resetTableParse clears parse state", () => {
    setTableParseStep("review");
    useParseFlowStore.getState().setTableParseRegion([0.1, 0.2, 0.5, 0.6]);
    useParseFlowStore.getState().resetTableParse();
    expect(useParseFlowStore.getState().tableParseStep).toBe("idle");
    expect(useParseFlowStore.getState().tableParseRegion).toBeNull();
  });
});

// [refactor jul11 P2.2⑨] Collection/CRUD/dedup/persistence cases moved to
// queries/__tests__/useYoloTags.test.tsx with the Query ownership flip. Zustand retains UI only.
describe("uiStore — YOLO tag UI state", () => {
  it("visibility defaults to empty, toggles, and reset clears all browse/table state", () => {
    expect(useUiStore.getState().yoloTagVisibility).toEqual({});
    useUiStore.getState().setYoloTagVisibility("tag-1", false);
    expect(useUiStore.getState().yoloTagVisibility["tag-1"]).toBe(false);
    useUiStore.setState({
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
    expect(useUiStore.getState()).toMatchObject({
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
    useViewerCoreStore.getState().setNumPages(20);
    useViewerCoreStore.getState().setPage(10);

    resetProjectData();

    expect(useViewerCoreStore.getState().pageNumber).toBe(1);
    expect(useParseFlowStore.getState().tableParseStep).toBe("idle");
  });
});

describe("uiStore — active Auto-QTO workflow", () => {
  it("owns the active selection and clears it with project data", () => {
    useUiStore.getState().setActiveQtoWorkflow(
      { id: 91 } as ReturnType<typeof useUiStore.getState>["activeQtoWorkflow"],
    );
    expect(useUiStore.getState().activeQtoWorkflow).toMatchObject({ id: 91 });

    resetProjectData();
    expect(useUiStore.getState().activeQtoWorkflow).toBeNull();
  });
});

// [refactor jul9 P2.2①] Chat slice characterization (SPEC §2.C). After the migration ONLY the
// chatScope UI knob remains in zustand — the message DATA (list + add/set/clear) moved to the
// TanStack Query cache (covered by src/queries/__tests__/useChatMessages.test.tsx). T-C1 and the
// chatMessages half of T-C2 were RETIRED here in the same commit that deleted those store fields.
describe("uiStore — chat scope (data lives in the query cache)", () => {
  // ── T-C2 (scope half — chatMessages assertion retired with the field) ──────
  it("resetProjectData preserves chatScope as an approved presentation choice", () => {
    useUiStore.getState().setChatScope("project");
    resetProjectData();
    expect(useUiStore.getState().chatScope).toBe("project");
  });

  // ── T-C3 (chatScope default + toggle) ──────────────────────────────────────
  it("chatScope defaults to 'page' and toggles", () => {
    expect(useUiStore.getState().chatScope).toBe("page");
    useUiStore.getState().setChatScope("project");
    expect(useUiStore.getState().chatScope).toBe("project");
    useUiStore.getState().setChatScope("page");
    expect(useUiStore.getState().chatScope).toBe("page");
  });
});
