// [refactor jul10 P2.2⑤] ANNOTATION-GROUPS MIGRATION FREEZE NET, part 2/3 — ViewAllPanel
// groups section.
//
// Written GREEN against the CURRENT (zustand-backed) code and MUST stay green byte-for-byte
// after the annotation-groups domain migrates to the TanStack Query cache
// (P2_DESIGN/ANNGROUPS_IMPL/SPEC.md). Single sanctioned divergence point: the SHARED
// `seedAnnotationGroups` helper; annotation rows ride `seedAnnotations` (⑥ owns its flip).
// See GroupActionsBarFreeze.test.tsx for the full doctrine header (anchored-ordering idiom,
// backing-agnostic asserts, probe rationale); this file adds the VAP-specific pins:
//
//  - CHANNEL SPLIT (SPEC §6.2 V-2): ALL ViewAllPanel group writes ride RAW global fetch
//    (:239/:266/:285) — persistFetch is NOT involved — and every VAP failure is CONSOLE-ONLY
//    (no window.alert). GroupActionsBar is the opposite on both counts. A future "unify the
//    error UX / persistence helper" drive-by must fail loudly here.
//  - ADOPT-vs-IGNORE ASYMMETRY (V-3 vs V-5): the SINGLE eye toggle re-upserts the server's
//    response row on ok (:273); the BULK toggle never reads response bodies (:294). Both are
//    FROZEN (GROUPS-W1 tier-2 unification is parked, owner sign-off required).
//  - BOTH bulk rollback branches (V-5): fulfilled-!ok AND rejected each roll back their own
//    group (:292-297); a reject-only mock would leave the !ok half untested.
//  - MASTER-EYE ADJACENCY (SPEC §6.2 V-6 / §8.6): the panel-header master eye ALSO drives
//    group PUTs through setGroupsActiveBulk (snapshot/restore, :193-203). The V-1—V-5 cases
//    still scope eye clicks to the Groups SECTION header or a group ROW. The same-ID lifecycle
//    block below now exercises the master only for its distinct synchronous fanout and retained
//    React-state memento; V-5 remains the owner of group PUT per-item semantics.
//  - Demo inertness is NOT pinned here: all four VAP write sites are UNGUARDED and inert only
//    emergently (demo groups always empty — unreachable-surface exclusions, SPEC §7.1 tripwire).
//
// Known pre-existing nested-<button> React warning on TreeSection headers (④ §8.7) — do NOT
// fix, do NOT assert console cleanliness. console.error is spied (VAP's failure channel) and
// asserted by MESSAGE PREFIX only.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "@testing-library/jest-dom";
import { render, screen, fireEvent, cleanup, waitFor, act, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  captureProjectLifecycle,
  isCurrentProjectLifecycle,
  openProject,
  type OpenProjectHandle,
  type ProjectResponse,
} from "@/lib/project-lifecycle";
import { queryKeys } from "@/queries/queryKeys";
import type { AnnotationGroupsPayload } from "@/queries/useAnnotationGroups";
import {
  EMPTY_ACTIVE_PAGE_WINDOW,
  type ActivePageWindow,
} from "@/queries/pageWindowCore";
import { useToolStore } from "@/stores/toolStore";
import { useUiStore } from "@/stores/uiStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import { seedAnnotationGroups } from "@/test/seed-annotation-groups";
import { seedAnnotations } from "@/test/seed-annotations";
import { seedTakeoff } from "@/test/seed-takeoff";
import type {
  AnnotationGroup,
  ClientAnnotation,
  ClientTakeoffItem,
  ParsedRegion,
  TextAnnotation,
} from "@/types";
import ViewAllPanel from "../ViewAllPanel";
import { resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";

let qc: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function lifecycleJsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function lifecycleProjectResponse(): ProjectResponse {
  return {
    id: "pid",
    dbId: 1,
    name: "Lifecycle project",
    dataUrl: "s3://private/project.json",
    pdfUrl: "s3://private/project.pdf",
    numPages: 2,
    status: "ready",
    summaries: null,
    projectIntelligence: null,
    pages: [{ pageNumber: 1, name: "Page 1", drawingNumber: null }],
  };
}

async function activateLifecycle(): Promise<OpenProjectHandle> {
  const lifecycleFetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/projects/pid") return lifecycleJsonResponse(lifecycleProjectResponse());
    if (url === "/api/projects/pid/pages?from=1&to=15") {
      return lifecycleJsonResponse({ from: 1, to: 2, pages: [], annotations: [] });
    }
    if (url === "/api/annotation-groups?projectId=pid") {
      return lifecycleJsonResponse({ groups: [], memberships: [] });
    }
    throw new Error(`unexpected lifecycle request: ${url}`);
  });
  vi.stubGlobal("fetch", lifecycleFetch);
  const handle = openProject(qc, "pid", { demo: false });
  expect((await handle.result).status).toBe("opened");
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  return handle;
}

function currentGroups(): AnnotationGroup[] {
  return qc.getQueryData<AnnotationGroupsPayload>(
    queryKeys.annotationGroups.all("pid"),
  )?.groups ?? [];
}

function grp(over: Partial<AnnotationGroup> & { id: number; name: string }): AnnotationGroup {
  return {
    projectId: 1,
    csiCode: null,
    notes: null,
    color: null,
    isActive: true,
    createdBy: null,
    createdAt: null,
    updatedAt: null,
    ...over,
  };
}
function ann(id: number): ClientAnnotation {
  return { id, pageNumber: 1, name: `ann-${id}`, bbox: [0, 0, 0.1, 0.1], note: null, source: "user", data: null };
}

function takeoffItem(
  over: Partial<ClientTakeoffItem> & { id: number; name: string },
): ClientTakeoffItem {
  return {
    shape: "circle",
    color: "#ef4444",
    size: 10,
    sortOrder: 0,
    groupId: null,
    ...over,
  };
}

function textAnnotation(
  over: Partial<TextAnnotation> & { type: TextAnnotation["type"]; text: string },
): TextAnnotation {
  return {
    category: "notes",
    bbox: [0.1, 0.2, 0.3, 0.1],
    confidence: 0.9,
    wordIndices: [],
    ...over,
  };
}

function parsedRegion(): ParsedRegion {
  return {
    id: "region-a",
    type: "schedule",
    category: "door-schedule",
    bbox: [0.1, 0.2, 0.3, 0.4],
    confidence: 0.95,
    data: {
      headers: ["Mark"],
      rows: [{ Mark: "D-01" }],
      rowCount: 1,
      columnCount: 1,
    },
  };
}

function visibilityAnnotations(): ClientAnnotation[] {
  return [
    {
      ...ann(201),
      name: "Door",
      source: "yolo",
      data: { modelName: "model-a" },
    },
    {
      ...ann(202),
      name: "Rectangle",
      source: "shape-parse",
      data: { shapeType: "rectangle" },
    },
    {
      ...ann(203),
      name: "Symbol",
      source: "symbol-search",
      data: { templateSourcePage: 1 },
    },
    { ...ann(204), name: "Markup", source: "user" },
  ];
}

function seedPageWindow(overrides: Partial<ActivePageWindow>): void {
  qc.setQueryData(queryKeys.pagesWindow.active("pid"), {
    ...EMPTY_ACTIVE_PAGE_WINDOW,
    ...overrides,
  });
}

function seedCompleteVisibilityGraph(groupActive = true): void {
  seedAnnotations(qc, visibilityAnnotations());
  seedTakeoff(qc, [takeoffItem({ id: 7, name: "Visibility takeoff" })], []);
  seedAnnotationGroups(
    qc,
    [grp({ id: 1, name: "Visibility group", isActive: groupActive })],
    [],
  );
  seedPageWindow({
    textAnnotations: {
      1: [textAnnotation({ type: "general-note", text: "Visibility note" })],
    },
  });
}

// Row-scoping helpers. The group-name button carries title={g.name}; its parent div is the row
// (name/csi/count-badge/eye/pencil all siblings inside it). Re-query per use — rows remount on
// group writes.
const rowFor = (name: string) => screen.getByTitle(name).parentElement as HTMLElement;
// The Groups SECTION header button (TreeSection) — hosts the section eye. NEVER the master eye.
const groupsHeader = () => screen.getByText("Groups").closest("button") as HTMLElement;

function expandGroupsSection() {
  fireEvent.click(screen.getByText("Groups"));
}

const fetchMock = vi.fn();
const alertMock = vi.fn();
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

// Route PUTs per group id; everything else (incl. any post-migration domain GET — SPEC §5-E5)
// stays fail-loud. Returns the RequestInit list for body pins.
function mockGroupPuts(routes: Record<number, Promise<unknown>>) {
  fetchMock.mockImplementation((url: unknown, init?: RequestInit) => {
    const m = /^\/api\/annotation-groups\/(\d+)$/.exec(String(url));
    if (m && init?.method === "PUT" && Number(m[1]) in routes) return routes[Number(m[1])];
    throw new Error(`unexpected raw fetch in anngroups freeze test: ${url}`);
  });
}

beforeEach(() => {
  qc = new QueryClient(); // pure defaults, matching production Providers.tsx
  resetProjectData();
  // P2.5 reset clears selection and hiddenTakeoffItemIds; explicit destination values keep this
  // fixture local, while group/annotation Query entries still require cache-side empty seeds.
  setViewerStoreStateForTest({
    publicId: "pid",
    isDemo: false,
    selectedAnnotationIds: new Set<number>(),
    hiddenTakeoffItemIds: new Set<number>(),
  });
  seedAnnotationGroups(qc, [], []); // AFTER publicId
  seedAnnotations(qc, []);
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: unknown) => {
    throw new Error(`unexpected raw fetch in anngroups freeze test: ${url}`);
  });
  alertMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("alert", alertMock);
  // VAP's failure channel — swallow output, assert by prefix. Also mutes the known
  // nested-<button> warning; console cleanliness is explicitly NOT asserted (④ §8.7).
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  // Navigation DETECTOR temporarily holds Query observer timers so a row click can prove its
  // handler-time cache read. Restore even after a failed assertion to prevent suite leakage.
  if (vi.isFakeTimers()) {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─── V-0: annotation navigation reads the live cache at action time ─────────────────────────

describe("ViewAllPanel annotation navigation — live handler-time row lookup", () => {
  it("uses a same-tick cache replacement's bbox/name when the already-rendered row is clicked", () => {
    const rendered = {
      ...ann(100),
      pageNumber: 4,
      name: "rendered-row",
      bbox: [0.1, 0.2, 0.3, 0.4] as [number, number, number, number],
    };
    seedAnnotations(qc, [rendered]);
    render(<ViewAllPanel />, { wrapper });
    fireEvent.click(screen.getByText("Markup"));
    fireEvent.click(screen.getByText("Page 4"));
    const renderedRow = screen.getByTitle("rendered-row");

    // [refactor jul11 P2.2⑥ DETECTOR] WHY fake only this notification window: the visible button
    // must retain its old render closure while the cache already holds the action-time truth. The
    // production readAnnotations bridge sees LIVE-* below; an `annotations.find(...)` mutation
    // instead publishes the rendered bbox/name and is killed by the llmHighlight assertion.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const live = {
      ...rendered,
      name: "LIVE-cache-row",
      bbox: [0.55, 0.6, 0.75, 0.8] as [number, number, number, number],
    };
    seedAnnotations(qc, [live]);
    fireEvent.click(renderedRow);

    expect(useUiStore.getState().focusAnnotationId).toBe(100);
    expect(useUiStore.getState().llmHighlight).toEqual({
      pageNumber: 4,
      bbox: live.bbox,
      label: live.name,
    });
  });
});

describe("ViewAllPanel same-ID lifecycle retirement — synchronous navigation tails", () => {
  it("does not let an annotation row from A focus or highlight same-ID successor B after navigation", async () => {
    const lifecycleA = await activateLifecycle();
    const annotationA: ClientAnnotation = {
      ...ann(100),
      pageNumber: 2,
      name: "A-annotation",
      bbox: [0.1, 0.2, 0.3, 0.4],
    };
    setViewerStoreStateForTest({ pageNumber: 1, numPages: 10 });
    seedAnnotations(qc, [annotationA]);
    render(<ViewAllPanel />, { wrapper });
    fireEvent.click(screen.getByText("Markup"));
    fireEvent.click(screen.getByText("Page 2"));

    const successorPending = new Promise<Response>(() => {});
    fetchMock.mockReturnValue(successorPending);
    const successorHighlight = {
      pageNumber: 7,
      bbox: [0.7, 0.7, 0.8, 0.8] as [number, number, number, number],
      label: "B-highlight",
    };
    let lifecycleB: OpenProjectHandle | undefined;
    const unsubscribe = useViewerCoreStore.subscribe((state, previous) => {
      if (lifecycleB || previous.pageNumber === 2 || state.pageNumber !== 2) return;
      lifecycleB = openProject(qc, "pid", { demo: false });
      setViewerStoreStateForTest({
        publicId: "pid",
        isDemo: false,
        pageNumber: 7,
        numPages: 10,
        focusAnnotationId: 901,
        llmHighlight: successorHighlight,
      });
      // Same cache key and same row id: a stale handler-time read must not make A's authority
      // valid merely because it can see B's row.
      seedAnnotations(qc, [{ ...annotationA, pageNumber: 6, name: "B-live-row" }]);
    });

    fireEvent.click(screen.getByTitle("A-annotation"));
    const admitted = lifecycleB !== undefined;
    const focusAfter = useUiStore.getState().focusAnnotationId;
    const highlightAfter = useUiStore.getState().llmHighlight;
    unsubscribe();
    lifecycleB?.dispose();
    lifecycleA.dispose();

    expect.soft(admitted).toBe(true);
    expect.soft(focusAfter).toBe(901);
    expect.soft(highlightAfter).toEqual(successorHighlight);
  });

  it("does not let A's takeoff activation continue into B's page/focus/highlight state", async () => {
    const lifecycleA = await activateLifecycle();
    const takeoffAnnotation: ClientAnnotation = {
      ...ann(700),
      pageNumber: 2,
      name: "A-takeoff-polygon",
      source: "takeoff",
      data: { takeoffItemId: 7 },
    };
    setViewerStoreStateForTest({ pageNumber: 1, numPages: 10 });
    seedAnnotations(qc, [takeoffAnnotation]);
    seedTakeoff(qc, [takeoffItem({ id: 7, name: "A-takeoff" })], []);
    render(<ViewAllPanel />, { wrapper });
    fireEvent.click(screen.getByText("Takeoffs"));
    fireEvent.click(screen.getByText("count"));
    fireEvent.click(screen.getByText("Ungrouped"));

    const successorPending = new Promise<Response>(() => {});
    fetchMock.mockReturnValue(successorPending);
    const successorHighlight = {
      pageNumber: 7,
      bbox: [0.6, 0.6, 0.7, 0.7] as [number, number, number, number],
      label: "B-takeoff-highlight",
    };
    let lifecycleB: OpenProjectHandle | undefined;
    const unsubscribe = useToolStore.subscribe((state, previous) => {
      if (
        lifecycleB ||
        previous.activeTakeoffItemId === 7 ||
        state.activeTakeoffItemId !== 7
      ) return;
      lifecycleB = openProject(qc, "pid", { demo: false });
      setViewerStoreStateForTest({
        publicId: "pid",
        isDemo: false,
        pageNumber: 7,
        numPages: 10,
        activeTakeoffItemId: 99,
        focusAnnotationId: 902,
        llmHighlight: successorHighlight,
      });
      seedTakeoff(qc, [takeoffItem({ id: 99, name: "B-takeoff" })], []);
      seedAnnotations(qc, [{ ...takeoffAnnotation, pageNumber: 6, name: "B-live-polygon" }]);
    });

    fireEvent.click(screen.getByTitle("A-takeoff"));
    const admitted = lifecycleB !== undefined;
    const pageAfter = useViewerCoreStore.getState().pageNumber;
    const toolAfter = useToolStore.getState().activeTakeoffItemId;
    const focusAfter = useUiStore.getState().focusAnnotationId;
    const highlightAfter = useUiStore.getState().llmHighlight;
    unsubscribe();
    lifecycleB?.dispose();
    lifecycleA.dispose();

    expect.soft(admitted).toBe(true);
    expect.soft(pageAfter).toBe(7);
    expect.soft(toolAfter).toBe(99);
    expect.soft(focusAfter).toBe(902);
    expect.soft(highlightAfter).toEqual(successorHighlight);
  });

  it("does not let a parsed-region row from A highlight B after its navigation publication", async () => {
    const lifecycleA = await activateLifecycle();
    setViewerStoreStateForTest({ pageNumber: 1, numPages: 10 });
    seedPageWindow({ pageIntelligence: { 2: { parsedRegions: [parsedRegion()] } } });
    render(<ViewAllPanel />, { wrapper });
    fireEvent.click(screen.getByText("Tables"));
    fireEvent.click(screen.getByText("p.2"));

    const successorPending = new Promise<Response>(() => {});
    fetchMock.mockReturnValue(successorPending);
    const successorHighlight = {
      pageNumber: 7,
      bbox: [0.5, 0.5, 0.6, 0.6] as [number, number, number, number],
      label: "B-parsed-highlight",
    };
    let lifecycleB: OpenProjectHandle | undefined;
    const unsubscribe = useViewerCoreStore.subscribe((state, previous) => {
      if (lifecycleB || previous.pageNumber === 2 || state.pageNumber !== 2) return;
      lifecycleB = openProject(qc, "pid", { demo: false });
      setViewerStoreStateForTest({
        publicId: "pid",
        isDemo: false,
        pageNumber: 7,
        numPages: 10,
        llmHighlight: successorHighlight,
      });
      seedPageWindow({ pageIntelligence: {} });
    });

    fireEvent.click(screen.getByTitle("schedule · door-schedule"));
    const admitted = lifecycleB !== undefined;
    const highlightAfter = useUiStore.getState().llmHighlight;
    unsubscribe();
    lifecycleB?.dispose();
    lifecycleA.dispose();

    expect.soft(admitted).toBe(true);
    expect.soft(highlightAfter).toEqual(successorHighlight);
  });
});

describe("ViewAllPanel same-ID lifecycle retirement — visibility fanouts", () => {
  it("stops the Detections section fanout when its first publication admits successor B", async () => {
    const lifecycleA = await activateLifecycle();
    seedAnnotations(qc, visibilityAnnotations());
    setViewerStoreStateForTest({
      showDetections: true,
      hiddenAnnotationIds: new Set<number>(),
    });
    render(<ViewAllPanel />, { wrapper });

    const successorPending = new Promise<Response>(() => {});
    fetchMock.mockReturnValue(successorPending);
    const successorHidden = new Set([990]);
    let lifecycleB: OpenProjectHandle | undefined;
    const unsubscribe = useUiStore.subscribe((state, previous) => {
      if (lifecycleB || !previous.showDetections || state.showDetections) return;
      lifecycleB = openProject(qc, "pid", { demo: false });
      setViewerStoreStateForTest({
        publicId: "pid",
        isDemo: false,
        showDetections: true,
        hiddenAnnotationIds: successorHidden,
      });
      seedAnnotations(qc, []);
    });

    const header = screen.getByText("Detections").closest("button") as HTMLElement;
    fireEvent.click(within(header).getByLabelText("Hide"));
    const admitted = lifecycleB !== undefined;
    const hiddenAfter = useUiStore.getState().hiddenAnnotationIds;
    const showAfter = useUiStore.getState().showDetections;
    unsubscribe();
    lifecycleB?.dispose();
    lifecycleA.dispose();

    expect.soft(admitted).toBe(true);
    expect.soft(showAfter).toBe(true);
    expect.soft(hiddenAfter).toEqual(successorHidden);
  });

  it.each([
    ["model", "model-a"],
    ["class", "Door"],
  ] as const)(
    "stops the YOLO %s reveal fanout when its first publication admits successor B",
    async (_kind, targetLabel) => {
      const lifecycleA = await activateLifecycle();
      seedAnnotations(qc, [visibilityAnnotations()[0]]);
      setViewerStoreStateForTest({
        showDetections: false,
        activeModels: { "model-a": false },
        hiddenClasses: { "model-a:Door": false },
        hiddenAnnotationIds: new Set([201]),
      });
      render(<ViewAllPanel />, { wrapper });
      fireEvent.click(screen.getByText("Detections"));
      fireEvent.click(screen.getByText("YOLO"));
      if (targetLabel === "Door") fireEvent.click(screen.getByText("model-a"));

      const successorPending = new Promise<Response>(() => {});
      fetchMock.mockReturnValue(successorPending);
      const successorModels = { "model-a": false, "b-only": true };
      const successorClasses = { "model-a:Door": false, "b-only:class": false };
      const successorHidden = new Set([201, 990]);
      let lifecycleB: OpenProjectHandle | undefined;
      const unsubscribe = useUiStore.subscribe((state, previous) => {
        if (lifecycleB || previous.showDetections || !state.showDetections) return;
        lifecycleB = openProject(qc, "pid", { demo: false });
        setViewerStoreStateForTest({
          publicId: "pid",
          isDemo: false,
          showDetections: false,
          activeModels: successorModels,
          hiddenClasses: successorClasses,
          hiddenAnnotationIds: successorHidden,
        });
        seedAnnotations(qc, []);
      });

      const target = screen.getByText(targetLabel).parentElement?.parentElement as HTMLElement;
      fireEvent.click(within(target).getByLabelText("Show"));
      const admitted = lifecycleB !== undefined;
      const stateAfter = useUiStore.getState();
      const modelsAfter = stateAfter.activeModels;
      const classesAfter = stateAfter.hiddenClasses;
      const hiddenAfter = stateAfter.hiddenAnnotationIds;
      unsubscribe();
      lifecycleB?.dispose();
      lifecycleA.dispose();

      expect.soft(admitted).toBe(true);
      expect.soft(modelsAfter).toEqual(successorModels);
      expect.soft(classesAfter).toEqual(successorClasses);
      expect.soft(hiddenAfter).toEqual(successorHidden);
    },
  );

  it("stops the Text annotations reveal fanout when its master publication admits successor B", async () => {
    const lifecycleA = await activateLifecycle();
    seedPageWindow({
      textAnnotations: {
        1: [textAnnotation({ type: "general-note", text: "A note" })],
      },
    });
    setViewerStoreStateForTest({
      showTextAnnotations: false,
      hiddenTextAnnotations: new Set(["1:0"]),
      activeTextAnnotationTypes: { "general-note": false },
    });
    render(<ViewAllPanel />, { wrapper });

    const successorPending = new Promise<Response>(() => {});
    fetchMock.mockReturnValue(successorPending);
    const successorHidden = new Set(["1:0", "9:9"]);
    const successorTypes = { "general-note": false, "b-only": false };
    let lifecycleB: OpenProjectHandle | undefined;
    const unsubscribe = useUiStore.subscribe((state, previous) => {
      if (lifecycleB || previous.showTextAnnotations || !state.showTextAnnotations) return;
      lifecycleB = openProject(qc, "pid", { demo: false });
      setViewerStoreStateForTest({
        publicId: "pid",
        isDemo: false,
        showTextAnnotations: false,
        hiddenTextAnnotations: successorHidden,
        activeTextAnnotationTypes: successorTypes,
      });
      seedPageWindow({ textAnnotations: {} });
    });

    const header = screen.getByText("Text annotations").closest("button") as HTMLElement;
    fireEvent.click(within(header).getByLabelText("Show"));
    const admitted = lifecycleB !== undefined;
    const hiddenAfter = useUiStore.getState().hiddenTextAnnotations;
    const typesAfter = useUiStore.getState().activeTextAnnotationTypes;
    unsubscribe();
    lifecycleB?.dispose();
    lifecycleA.dispose();

    expect.soft(admitted).toBe(true);
    expect.soft(hiddenAfter).toEqual(successorHidden);
    expect.soft(typesAfter).toEqual(successorTypes);
  });

  it("stops the master hide fanout when its first publication admits successor B", async () => {
    const lifecycleA = await activateLifecycle();
    seedCompleteVisibilityGraph();
    setViewerStoreStateForTest({
      showDetections: true,
      showTextAnnotations: true,
      hiddenAnnotationIds: new Set<number>(),
      hiddenTakeoffItemIds: new Set<number>(),
      hiddenTextAnnotations: new Set<string>(),
      activeModels: {},
      hiddenClasses: {},
      activeTextAnnotationTypes: {},
    });
    render(<ViewAllPanel />, { wrapper });

    const successorPending = new Promise<Response>(() => {});
    fetchMock.mockReturnValue(successorPending);
    const successorHiddenAnnotations = new Set([990]);
    const successorHiddenTakeoffs = new Set([991]);
    const successorHiddenText = new Set(["9:9"]);
    let lifecycleB: OpenProjectHandle | undefined;
    const unsubscribe = useUiStore.subscribe((state, previous) => {
      if (lifecycleB || !previous.showDetections || state.showDetections) return;
      lifecycleB = openProject(qc, "pid", { demo: false });
      setViewerStoreStateForTest({
        publicId: "pid",
        isDemo: false,
        showDetections: true,
        showTextAnnotations: true,
        hiddenAnnotationIds: successorHiddenAnnotations,
        hiddenTakeoffItemIds: successorHiddenTakeoffs,
        hiddenTextAnnotations: successorHiddenText,
        activeModels: { "b-only": true },
        hiddenClasses: { "b-only:class": false },
        activeTextAnnotationTypes: { "b-only": false },
      });
      seedAnnotations(qc, []);
      seedTakeoff(qc, [], []);
      seedAnnotationGroups(qc, [], []);
      seedPageWindow({ textAnnotations: {} });
    });

    const header = screen.getByText("View All").parentElement as HTMLElement;
    fireEvent.click(within(header).getByLabelText("Hide everything"));
    const admitted = lifecycleB !== undefined;
    const stateAfter = useUiStore.getState();
    const annotationsAfter = stateAfter.hiddenAnnotationIds;
    const takeoffsAfter = stateAfter.hiddenTakeoffItemIds;
    const textAfter = stateAfter.hiddenTextAnnotations;
    unsubscribe();
    lifecycleB?.dispose();
    lifecycleA.dispose();

    expect.soft(admitted).toBe(true);
    expect.soft(annotationsAfter).toEqual(successorHiddenAnnotations);
    expect.soft(takeoffsAfter).toEqual(successorHiddenTakeoffs);
    expect.soft(textAfter).toEqual(successorHiddenText);
  });

  it("does not restore A's retained masterSnapshot over an all-hidden same-ID successor B", async () => {
    const lifecycleA = await activateLifecycle();
    seedCompleteVisibilityGraph();
    setViewerStoreStateForTest({
      showDetections: true,
      showTextAnnotations: true,
      hiddenAnnotationIds: new Set<number>(),
      hiddenTakeoffItemIds: new Set<number>(),
      hiddenTextAnnotations: new Set<string>(),
      activeModels: {},
      hiddenClasses: {},
      activeTextAnnotationTypes: {},
    });
    fetchMock.mockImplementation((url: unknown, init?: RequestInit) => {
      if (url === "/api/annotation-groups/1" && init?.method === "PUT") {
        return Promise.resolve({ ok: true } as Response);
      }
      throw new Error(`unexpected fetch while creating master snapshot: ${url}`);
    });
    render(<ViewAllPanel />, { wrapper });
    const masterHeader = screen.getByText("View All").parentElement as HTMLElement;
    fireEvent.click(within(masterHeader).getByLabelText("Hide everything"));
    await waitFor(() =>
      expect(within(masterHeader).getByLabelText("Show everything")).toBeInTheDocument(),
    );

    const successorPending = new Promise<Response>(() => {});
    fetchMock.mockReturnValue(successorPending);
    const lifecycleB = openProject(qc, "pid", { demo: false });
    seedCompleteVisibilityGraph(false);
    const successorHiddenAnnotations = new Set([201, 202, 203, 204, 990]);
    const successorHiddenTakeoffs = new Set([7, 991]);
    const successorHiddenText = new Set(["1:0", "9:9"]);
    const successorModels = { "model-a": false, "b-only": false };
    const successorClasses = { "model-a:Door": false, "b-only:class": false };
    const successorTypes = { "general-note": false, "b-only": false };
    setViewerStoreStateForTest({
      publicId: "pid",
      isDemo: false,
      showDetections: false,
      showTextAnnotations: false,
      hiddenAnnotationIds: successorHiddenAnnotations,
      hiddenTakeoffItemIds: successorHiddenTakeoffs,
      hiddenTextAnnotations: successorHiddenText,
      activeModels: successorModels,
      hiddenClasses: successorClasses,
      activeTextAnnotationTypes: successorTypes,
    });
    await waitFor(() =>
      expect(within(masterHeader).getByLabelText("Show everything")).toBeInTheDocument(),
    );

    fireEvent.click(within(masterHeader).getByLabelText("Show everything"));
    const stateAfter = useUiStore.getState();
    const snapshotAfter = {
      showDetections: stateAfter.showDetections,
      showTextAnnotations: stateAfter.showTextAnnotations,
      hiddenAnnotationIds: stateAfter.hiddenAnnotationIds,
      hiddenTakeoffItemIds: stateAfter.hiddenTakeoffItemIds,
      hiddenTextAnnotations: stateAfter.hiddenTextAnnotations,
      activeModels: stateAfter.activeModels,
      hiddenClasses: stateAfter.hiddenClasses,
      activeTextAnnotationTypes: stateAfter.activeTextAnnotationTypes,
    };
    lifecycleB.dispose();
    lifecycleA.dispose();

    expect.soft(snapshotAfter).toEqual({
      showDetections: false,
      showTextAnnotations: false,
      hiddenAnnotationIds: successorHiddenAnnotations,
      hiddenTakeoffItemIds: successorHiddenTakeoffs,
      hiddenTextAnnotations: successorHiddenText,
      activeModels: successorModels,
      hiddenClasses: successorClasses,
      activeTextAnnotationTypes: successorTypes,
    });
  });
});

// ─── V-1: render — inactive styling, csi badge, memberCount from the live-annotation join ────

describe("ViewAllPanel groups — seeded groups render with badges and inactive styling (V-1)", () => {
  it("csi badge, live-join member count (dangling pair dropped), (inactive) tag + eye states", async () => {
    seedAnnotations(qc, [ann(100), ann(101), ann(102)]);
    seedAnnotationGroups(
      qc,
      [
        grp({ id: 1, name: "Group A", color: "#ff0000", csiCode: "08 11 13" }),
        grp({ id: 2, name: "Group B", isActive: false }),
      ],
      [
        { annotationId: 100, groupId: 1 },
        { annotationId: 101, groupId: 1 },
        { annotationId: 102, groupId: 1 },
        // dangling pair: annotation 103 does NOT exist — the member badge is a LIVE join
        // against ⑥ annotations (ViewAllPanel:775-779), not the raw index size → stays 3.
        { annotationId: 103, groupId: 1 },
      ],
    );
    render(<ViewAllPanel />, { wrapper });
    expandGroupsSection();

    const rowA = (await screen.findByTitle("Group A")).parentElement as HTMLElement;
    expect(within(rowA).getByText("08 11 13")).toBeInTheDocument(); // csi badge (:807-808)
    expect(within(rowA).getByText("3")).toBeInTheDocument(); // memberCount badge (:810-812)
    expect(within(rowA).queryByText("(inactive)")).toBeNull();
    expect(within(rowA).getByLabelText("Hide")).toBeInTheDocument(); // active → eye offers Hide

    const rowB = rowFor("Group B");
    expect(within(rowB).getByText("(inactive)")).toBeInTheDocument(); // inactive styling (:803-805)
    expect(within(rowB).getByLabelText("Show")).toBeInTheDocument(); // inactive → eye offers Show
    expect(within(groupsHeader()).getByText("2")).toBeInTheDocument(); // section count = groups, not members
    expect(fetchMock).not.toHaveBeenCalled(); // render is read-only (and no domain GET post-migration)
  });
});

// ─── V-2: edit — raw-fetch PUT, server row adopted, CONSOLE-ONLY failure channel ─────────────

describe("ViewAllPanel groups — edit saves via raw fetch and adopts the server row (V-2)", () => {
  it("PUT body carries edited fields; dialog open while pending; server-marker name lands", async () => {
    seedAnnotationGroups(qc, [grp({ id: 1, name: "Group A", color: "#ff0000" })], []);
    const d = deferred<unknown>();
    mockGroupPuts({ 1: d.promise });
    render(<ViewAllPanel />, { wrapper });
    expandGroupsSection();

    const rowA = (await screen.findByTitle("Group A")).parentElement as HTMLElement;
    fireEvent.click(within(rowA).getByTitle("Edit group"));
    const nameInput = await screen.findByDisplayValue("Group A");
    fireEvent.change(nameInput, { target: { value: "Group B" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // ── anchored idiom (server-first: no upsert until the PUT resolves) ──
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/annotation-groups/1");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({
      name: "Group B",
      notes: null,
      csiCode: null,
      color: "#ff0000",
      isActive: true,
    });
    await act(async () => {});
    expect(screen.getByDisplayValue("Group B")).toBeInTheDocument(); // dialog STILL open (:253 post-await)
    expect(screen.getByTitle("Group A")).toBeInTheDocument(); // row not yet renamed

    // marker field: server responds with a DIFFERENT name — :252 upserts data.group verbatim
    d.resolve({ ok: true, json: async () => ({ group: grp({ id: 1, name: "SRV-EDITED", color: "#ff0000" }) }) });

    await waitFor(() => expect(screen.getByTitle("SRV-EDITED")).toBeInTheDocument()); // adopted
    expect(screen.queryByTitle("Group A")).not.toBeInTheDocument(); // replaced, not appended
    expect(screen.queryByDisplayValue(/Group B|SRV-EDITED/)).not.toBeInTheDocument(); // dialog closed
  });

  it("rejection: CONSOLE-ONLY (no alert — the channel-split pin vs GAB) + dialog stays open", async () => {
    seedAnnotationGroups(qc, [grp({ id: 1, name: "Group A", color: "#ff0000" })], []);
    const d = deferred<unknown>();
    mockGroupPuts({ 1: d.promise });
    render(<ViewAllPanel />, { wrapper });
    expandGroupsSection();

    const rowA = (await screen.findByTitle("Group A")).parentElement as HTMLElement;
    fireEvent.click(within(rowA).getByTitle("Edit group"));
    const nameInput = await screen.findByDisplayValue("Group A");
    fireEvent.change(nameInput, { target: { value: "Group B" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    d.reject(new Error("boom"));

    await waitFor(() =>
      expect(consoleErrorSpy).toHaveBeenCalledWith("[ViewAllPanel] Edit group failed:", expect.any(Error)),
    );
    expect(alertMock).not.toHaveBeenCalled(); // VAP failures NEVER alert (:255)
    expect(screen.getByDisplayValue("Group B")).toBeInTheDocument(); // dialog stays open (:253 inside try)
    expect(screen.getByTitle("Group A")).toBeInTheDocument(); // no upsert happened
  });
});

// ─── V-3: single eye toggle — OPTIMISTIC flip, server row ADOPTED on ok (:273) ───────────────

describe("ViewAllPanel groups — single toggle is optimistic and ADOPTS the server row (V-3)", () => {
  it("(inactive) visible while PUT pending; ok response's marker name lands (adopt, contrast V-5)", async () => {
    seedAnnotations(qc, [ann(100)]);
    seedAnnotationGroups(qc, [grp({ id: 1, name: "Group A", color: "#ff0000" })], [{ annotationId: 100, groupId: 1 }]);
    const d = deferred<unknown>();
    mockGroupPuts({ 1: d.promise });
    render(<ViewAllPanel />, { wrapper });
    expandGroupsSection();

    const rowA = (await screen.findByTitle("Group A")).parentElement as HTMLElement;
    fireEvent.click(within(rowA).getByLabelText("Hide")); // active → toggling hides (isActive:false)

    // optimistic pin: the flip is visible while the deferred PUT is STILL pending (:264 pre-await)
    await waitFor(() => expect(screen.getByText("(inactive)")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/annotation-groups/1");
    expect(JSON.parse(String(init.body))).toEqual({ isActive: false }); // isActive-only body (:269)

    d.resolve({
      ok: true,
      json: async () => ({ group: grp({ id: 1, name: "SRV-MARKER", color: "#ff0000", isActive: false }) }),
    });

    // ok path RE-UPSERTS the server row (:273) — the marker name must surface
    await waitFor(() => expect(screen.getByTitle("SRV-MARKER")).toBeInTheDocument());
    expect(screen.getByText("(inactive)")).toBeInTheDocument(); // still inactive
    expect(alertMock).not.toHaveBeenCalled();
  });
});

// ─── V-4: single eye toggle failure — ROLLBACK to the captured row (:276), console-only ──────

describe("ViewAllPanel groups — single toggle rejection rolls back (V-4)", () => {
  it("optimistic (inactive) reverts to the captured pre-toggle row; console-only", async () => {
    seedAnnotationGroups(qc, [grp({ id: 1, name: "Group A", color: "#ff0000" })], []);
    const d = deferred<unknown>();
    mockGroupPuts({ 1: d.promise });
    render(<ViewAllPanel />, { wrapper });
    expandGroupsSection();

    const rowA = (await screen.findByTitle("Group A")).parentElement as HTMLElement;
    fireEvent.click(within(rowA).getByLabelText("Hide"));

    await waitFor(() => expect(screen.getByText("(inactive)")).toBeInTheDocument()); // optimistic flip held while pending

    d.reject(new Error("boom"));

    // ROLLBACK pin: upsert(captured g) restores the ACTIVE row (:276) — deleting the rollback
    // line leaves "(inactive)" in the DOM and fails here (DETECTOR mutation §8.1).
    await waitFor(() => expect(screen.queryByText("(inactive)")).not.toBeInTheDocument());
    expect(screen.getByTitle("Group A")).toBeInTheDocument();
    await waitFor(() =>
      expect(consoleErrorSpy).toHaveBeenCalledWith("[ViewAllPanel] Toggle group active failed:", expect.any(Error)),
    );
    expect(alertMock).not.toHaveBeenCalled(); // console-only channel
  });
});

// ─── V-5: bulk toggle, mixed outcomes — BOTH rollback branches + response bodies IGNORED ─────

describe("ViewAllPanel groups — bulk toggle rolls back per-item and IGNORES bodies (V-5)", () => {
  it("[ok, fulfilled-!ok, rejected]: only the ok group stays flipped; no body adoption; fully silent", async () => {
    seedAnnotationGroups(
      qc,
      [grp({ id: 1, name: "G1" }), grp({ id: 2, name: "G2" }), grp({ id: 3, name: "G3" })],
      [],
    );
    const d1 = deferred<unknown>();
    const d2 = deferred<unknown>();
    const d3 = deferred<unknown>();
    mockGroupPuts({ 1: d1.promise, 2: d2.promise, 3: d3.promise });
    render(<ViewAllPanel />, { wrapper });
    expandGroupsSection();
    await screen.findByTitle("G1");

    // the Groups SECTION eye — all three active → "Hide" → setGroupsActiveBulk(…, false).
    // Scoped to the section header: the panel MASTER eye drives the same helper through the
    // snapshot/restore path and must stay out of this case (V-6 adjacency note, file header).
    fireEvent.click(within(groupsHeader()).getByLabelText("Hide"));

    // optimistic pin: ALL THREE flip while every PUT is still pending (:282 pre-allSettled)
    await waitFor(() => expect(screen.getAllByText("(inactive)")).toHaveLength(3));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of fetchMock.mock.calls as [string, RequestInit][]) {
      expect(JSON.parse(String(call[1].body))).toEqual({ isActive: false });
    }

    // mixed settlement — BOTH rollback branches of :292-297 must fire:
    d1.resolve({
      ok: true, // stays flipped; body must be IGNORED (bulk never reads json — :294 asymmetry vs V-3)
      json: async () => ({ group: grp({ id: 1, name: "SRV-MARKER", isActive: false }) }),
    });
    d2.resolve({ ok: false }); // fulfilled-!ok → rollback (a reject-only mock leaves this half untested)
    d3.reject(new Error("boom")); // rejected → rollback

    await waitFor(() => expect(screen.getAllByText("(inactive)")).toHaveLength(1));
    expect(within(rowFor("G1")).getByText("(inactive)")).toBeInTheDocument(); // ok → kept flipped
    expect(within(rowFor("G2")).queryByText("(inactive)")).toBeNull(); // !ok → rolled back
    expect(within(rowFor("G3")).queryByText("(inactive)")).toBeNull(); // rejected → rolled back
    // adopt-vs-ignore pin: the ok body's marker must NOT surface anywhere
    expect(screen.queryByTitle("SRV-MARKER")).not.toBeInTheDocument();
    expect(screen.getByTitle("G1")).toBeInTheDocument(); // still the OPTIMISTIC row, not the server's
    // bulk is fully silent: no alert, and no console assert either (there is no catch — SPEC V-5)
    expect(alertMock).not.toHaveBeenCalled();
  });
});

describe("ViewAllPanel groups — same-ID lifecycle settlement retirement", () => {
  it("does not adopt an edit success into a same-ID auth successor", async () => {
    const lifecycleA = await activateLifecycle();
    const snapshotA = captureProjectLifecycle(qc);
    seedAnnotationGroups(qc, [grp({ id: 1, name: "A-EDIT", color: "#ff0000" })], []);
    const edit = deferred<unknown>();
    const successorPending = new Promise<Response>(() => {});
    fetchMock.mockImplementation((url: unknown, init?: RequestInit) => {
      if (url === "/api/annotation-groups/1" && init?.method === "PUT") return edit.promise;
      return successorPending;
    });
    render(<ViewAllPanel />, { wrapper });
    expandGroupsSection();
    const row = (await screen.findByTitle("A-EDIT")).parentElement as HTMLElement;
    fireEvent.click(within(row).getByTitle("Edit group"));
    fireEvent.change(await screen.findByDisplayValue("A-EDIT"), {
      target: { value: "A-DRAFT" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const successorGroups = [
      grp({ id: 1, name: "B-EDIT-SENTINEL", color: "#00ff00", notes: "B" }),
      grp({ id: 9, name: "B-ONLY" }),
    ];
    let lifecycleB!: OpenProjectHandle;
    await act(async () => {
      lifecycleB = openProject(qc, "pid", { demo: false });
      setViewerStoreStateForTest({ publicId: "pid", isDemo: false });
      seedAnnotationGroups(qc, successorGroups, []);
      edit.resolve({
        ok: true,
        json: async () => ({ group: grp({ id: 1, name: "OBSOLETE-A-EDIT" }) }),
      });
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    });

    expect.soft(isCurrentProjectLifecycle(qc, snapshotA)).toBe(false);
    expect.soft(currentGroups()).toEqual(successorGroups);
    lifecycleB.dispose();
    lifecycleA.dispose();
  });

  it("does not roll a failed single toggle over a same-ID demo successor", async () => {
    const lifecycleA = await activateLifecycle();
    const snapshotA = captureProjectLifecycle(qc);
    seedAnnotationGroups(qc, [grp({ id: 1, name: "A-TOGGLE", isActive: true })], []);
    const toggle = deferred<unknown>();
    const successorPending = new Promise<Response>(() => {});
    fetchMock.mockImplementation((url: unknown, init?: RequestInit) => {
      if (url === "/api/annotation-groups/1" && init?.method === "PUT") return toggle.promise;
      return successorPending;
    });
    render(<ViewAllPanel />, { wrapper });
    expandGroupsSection();
    const row = (await screen.findByTitle("A-TOGGLE")).parentElement as HTMLElement;
    fireEvent.click(within(row).getByLabelText("Hide"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const successorGroups = [
      grp({ id: 1, name: "B-TOGGLE-SENTINEL", isActive: false, notes: "B" }),
      grp({ id: 9, name: "B-ONLY" }),
    ];
    let lifecycleB!: OpenProjectHandle;
    await act(async () => {
      lifecycleB = openProject(qc, "pid", { demo: true });
      // B's demo token is authoritative before activation; preserve the stale DOM selectors so
      // the A callback cannot evade this freeze by borrowing B's snapshot after the click.
      setViewerStoreStateForTest({ publicId: "pid", isDemo: false });
      seedAnnotationGroups(qc, successorGroups, []);
      toggle.reject(new Error("obsolete A toggle failed"));
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    });

    expect.soft(isCurrentProjectLifecycle(qc, snapshotA)).toBe(false);
    expect.soft(currentGroups()).toEqual(successorGroups);
    lifecycleB.dispose();
    lifecycleA.dispose();
  });

  it("does not roll failed bulk items over a same-ID auth successor", async () => {
    const lifecycleA = await activateLifecycle();
    const snapshotA = captureProjectLifecycle(qc);
    seedAnnotationGroups(qc, [
      grp({ id: 1, name: "A-BULK-1", isActive: true }),
      grp({ id: 2, name: "A-BULK-2", isActive: true }),
    ], []);
    const failedResponse = deferred<unknown>();
    const rejectedRequest = deferred<unknown>();
    const successorPending = new Promise<Response>(() => {});
    fetchMock.mockImplementation((url: unknown, init?: RequestInit) => {
      if (init?.method !== "PUT") return successorPending;
      if (url === "/api/annotation-groups/1") return failedResponse.promise;
      if (url === "/api/annotation-groups/2") return rejectedRequest.promise;
      return successorPending;
    });
    render(<ViewAllPanel />, { wrapper });
    expandGroupsSection();
    await screen.findByTitle("A-BULK-1");
    fireEvent.click(within(groupsHeader()).getByLabelText("Hide"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const successorGroups = [
      grp({ id: 1, name: "B-BULK-1", isActive: false, notes: "B1" }),
      grp({ id: 2, name: "B-BULK-2", isActive: false, notes: "B2" }),
      grp({ id: 9, name: "B-ONLY" }),
    ];
    let lifecycleB!: OpenProjectHandle;
    await act(async () => {
      lifecycleB = openProject(qc, "pid", { demo: false });
      setViewerStoreStateForTest({ publicId: "pid", isDemo: false });
      seedAnnotationGroups(qc, successorGroups, []);
      failedResponse.resolve({ ok: false });
      rejectedRequest.reject(new Error("obsolete A bulk rejected"));
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    });

    expect.soft(isCurrentProjectLifecycle(qc, snapshotA)).toBe(false);
    expect.soft(currentGroups()).toEqual(successorGroups);
    lifecycleB.dispose();
    lifecycleA.dispose();
  });
});
