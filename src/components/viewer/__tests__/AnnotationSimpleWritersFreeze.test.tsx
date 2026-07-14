// [refactor jul11 P2.2⑥] ANNOTATIONS MIGRATION FREEZE NET — the three small writers.
//
// Written GREEN against the CURRENT zustand-backed annotation domain. It MUST remain green after
// annotations move to the publicId-keyed TanStack cache. `seedAnnotations(qc, rows)` is the ONE
// sanctioned backing divergence: its body changes in C3, while every fixture, interaction, and
// assertion below stays byte-for-byte useful. QueryClientProvider is therefore present NOW even
// though these components do not consume the cache yet.
//
// WHY THIS FILE EXISTS: these handlers look small, but each preserves a different write contract
// that a mechanical store-to-cache import swap could silently alter:
//   - TagBrowseBar renames its YoloTag and every matching annotation locally, then refreshes the
//     browse highlight. Annotation persistence is deliberately absent here.
//   - CalibrationInput is demo-local, but non-demo is server-first: sequential DELETEs of every
//     same-page scale row, one POST, then a wholesale local same-page replacement. A failed POST
//     leaves the captured local rows/calibration gesture intact and reports inline.
//   - AnnotationListItem is server-first on private projects, adopts only `res.ok`, and performs
//     no network/local publication on a demo project.
//
// Backing-agnostic witness discipline: assertions never read `getState().annotations`. Instead,
// AnnotationPanel and DetectionPanel are mounted as real production subscribers, while the few
// ordering assertions that must inspect a row before any subscriber can change use the SHARED
// `readSeededAnnotations(qc)` companion seam. If a writer stops publishing its annotation update,
// the visible row/remounted editor or shared seam fails. C3 therefore flips only the shared helper
// bodies rather than spreading test-only cache-key knowledge through these cases.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { ClientAnnotation, YoloTag } from "@/types";
import {
  captureProjectLifecycle,
  isCurrentProjectLifecycle,
  openProject,
  type OpenProjectHandle,
  type ProjectResponse,
} from "@/lib/project-lifecycle";
import { useUiStore } from "@/stores/uiStore";
import { useToolStore, type ToolTagScanResults } from "@/stores/toolStore";
import { queryKeys } from "@/queries/queryKeys";
import { readSeededAnnotations, seedAnnotations } from "@/test/seed-annotations";
import {
  readYoloTags,
  seedYoloTagsFromBootstrap,
} from "@/queries/useYoloTags";
import AnnotationListItem from "../AnnotationListItem";
import AnnotationPanel from "../AnnotationPanel";
import CalibrationInput from "../CalibrationInput";
import DetectionPanel from "../DetectionPanel";
import TagBrowseBar from "../TagBrowseBar";
import { resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";

let qc: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

// [refactor jul11 P2.2⑥] Full-shape fixtures make type/schema drift fail at this one honest
// boundary. Per-test overrides stay small enough that the write semantics remain readable.
function ann(
  id: number,
  over: Partial<ClientAnnotation> = {},
): ClientAnnotation {
  return {
    id,
    pageNumber: 1,
    name: `ann-${id}`,
    bbox: [0.1, 0.1, 0.2, 0.2],
    note: null,
    source: "user",
    data: null,
    ...over,
  };
}

function scaleAnn(id: number, pageNumber: number, name: string): ClientAnnotation {
  return ann(id, {
    pageNumber,
    name,
    source: "takeoff-scale",
    data: {
      type: "scale-calibration",
      point1: { x: 0.1, y: 0.1 },
      point2: { x: 0.2, y: 0.2 },
      realDistance: 1,
      unit: "ft",
    },
  });
}

function yoloAnn(id: number, over: Partial<ClientAnnotation> = {}): ClientAnnotation {
  return ann(id, {
    name: "Door",
    source: "yolo",
    data: {
      modelName: "Fixture Model",
      confidence: 0.95,
      csiCodes: ["08"],
      keywords: ["opening"],
    },
    ...over,
  });
}

function yoloTag(overrides: Partial<YoloTag> = {}): YoloTag {
  return {
    id: "tag-a",
    name: "Door tag A",
    tagText: "D-01",
    yoloClass: "Door",
    yoloModel: "Fixture Model",
    source: "manual",
    scope: "project",
    instances: [{
      pageNumber: 3,
      annotationId: 70,
      bbox: [0.1, 0.1, 0.2, 0.2],
      confidence: 0.99,
    }],
    ...overrides,
  };
}

function tagScanResults(label: string): ToolTagScanResults {
  return {
    yoloClass: `${label} class`,
    yoloModel: `${label} model`,
    texts: [{
      text: `${label}-01`,
      count: 1,
      pages: [3],
      instances: [{
        pageNumber: 3,
        annotationId: 70,
        bbox: [0.1, 0.1, 0.2, 0.2],
        confidence: 0.99,
      }],
    }],
  };
}

function jsonResponse(
  body: unknown,
  { ok = true, status = ok ? 200 : 500 }: { ok?: boolean; status?: number } = {},
): Response {
  return {
    ok,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function lifecycleProjectResponse(): ProjectResponse {
  return {
    id: "pid",
    dbId: 1,
    name: "Lifecycle project",
    assetBaseUrl: "s3://private/project.json",
    pdfUrl: "s3://private/project.pdf",
    numPages: 10,
    status: "ready",
    summaries: null,
    projectIntelligence: null,
    pages: [{ pageNumber: 3, name: "Page 3", drawingNumber: null }],
  };
}

async function activateLifecycle(demo = false): Promise<OpenProjectHandle> {
  const lifecycleFetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === (demo ? "/api/demo/projects/pid" : "/api/projects/pid")) {
      return jsonResponse(lifecycleProjectResponse());
    }
    if (url === (demo
      ? "/api/demo/projects/pid/pages?from=1&to=15"
      : "/api/projects/pid/pages?from=1&to=15")) {
      return jsonResponse({ from: 1, to: 10, pages: [], annotations: [] });
    }
    if (!demo && url === "/api/annotation-groups?projectId=pid") {
      return jsonResponse({ groups: [], memberships: [] });
    }
    throw new Error(`unexpected lifecycle request: ${url}`);
  });
  vi.stubGlobal("fetch", lifecycleFetch);
  const handle = openProject(qc, "pid", { demo });
  expect((await handle.result).status).toBe("opened");
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  return handle;
}

// [refactor jul11 P2.2⑥] WHY this wrapper stays tiny: pre-response ordering pins need a direct
// domain witness, but the test must not know whether that domain is zustand (C1) or Query cache
// (C3). The shared companion helper is the sole backing switch; this file only supplies its qc.
function readAnnotationRows(): readonly ClientAnnotation[] {
  return readSeededAnnotations(qc);
}

// [refactor jul11 P2.2⑥] Fake-timer Query notification barrier. RTL 16's waitFor hangs under
// Vitest fake timers, while C3's setQueryData observers notify on a timer task. Advancing inside
// async act flushes that task plus microtasks before the TagBrowse DOM assertions. The helper is
// intentionally used only by the one debounce test that installs fake timers.
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  // [refactor jul11 P2.2⑥] Production-equivalent QueryClient defaults matter under C3: these
  // visible subscriber witnesses must observe the same notification schedule as the real viewer.
  qc = new QueryClient();
  resetProjectData();
  setViewerStoreStateForTest({ publicId: "pid", isDemo: false });
  seedAnnotations(qc, []); // AFTER publicId — the post-C3 cache key derives from it.
  seedYoloTagsFromBootstrap(qc, "pid", { yoloTags: [] });

  fetchMock.mockReset();
  fetchMock.mockImplementation((url: unknown) => {
    throw new Error(`unexpected raw fetch in annotation simple-writers freeze test: ${String(url)}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  qc.clear();
  // TagBrowseBar's YoloTag save uses a module-level 500ms debounce. Tests drain that timer, but
  // this guard prevents a failed assertion from leaking it into the next raw-fetch mock channel.
  if (vi.isFakeTimers()) {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─── TagBrowseBar: local YoloTag + matching annotation rename ───────────────────────────────

describe("TagBrowseBar annotation edit freeze", () => {
  it("renames id/free-floating instance rows locally, preserves unrelated rows, and refreshes the highlight", async () => {
    // [refactor jul11 P2.2⑥] Fake only the debounce timers. There is no waitFor under fake time
    // (RTL 16 + Vitest hangs there); `advance(0)` is the C3-safe Query notification barrier.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    setViewerStoreStateForTest({ isDemo: true }); // drain the YoloTag debounce with zero persistence

    const freeBbox: [number, number, number, number] = [0.4, 0.5, 0.6, 0.7];
    const tag: YoloTag = {
      id: "tag-door",
      name: "D-01",
      tagText: "D-01",
      yoloClass: "door",
      yoloModel: "Fixture Model",
      source: "manual",
      scope: "project",
      instances: [
        { pageNumber: 2, annotationId: 101, bbox: [0.1, 0.2, 0.3, 0.4], confidence: 0.99 },
        { pageNumber: 3, annotationId: -1, bbox: freeBbox, confidence: 0.88 },
      ],
    };
    seedAnnotations(qc, [
      ann(101, { pageNumber: 2, name: "D-01", source: "takeoff" }),
      ann(102, { pageNumber: 3, name: "D-01", bbox: freeBbox }),
      ann(103, { pageNumber: 3, name: "Unrelated" }),
    ]);
    seedYoloTagsFromBootstrap(qc, "pid", { yoloTags: [tag] });
    setViewerStoreStateForTest({
      tagBrowseId: tag.id,
      tagBrowseIndex: 0,
      pageNames: { 2: "A-102" },
    });

    // AnnotationPanel is the production annotation subscriber/witness; its two old D-01 groups
    // (QTO + MARKUPS) must both react to TagBrowseBar's single bulk replacement.
    render(
      <>
        <TagBrowseBar />
        <AnnotationPanel />
      </>,
      { wrapper },
    );
    expect(screen.getAllByRole("button", { name: "D-01 1" })).toHaveLength(2);

    // The pencil has visible glyph text; `title` documents its intent but does not replace that
    // accessible name. Target the stable production title instead of coupling to the glyph.
    fireEvent.click(screen.getByTitle("Edit tag text"));
    const edit = screen.getByRole("textbox");
    fireEvent.change(edit, { target: { value: "  D-02  " } });

    // [refactor jul11 P2.2⑥ DETECTOR] WHY this write lands after the edit render but before
    // Enter: saveEdit historically performed a handler-time getState() transform. TanStack cache
    // notifications are deferred, so the mounted input still owns the pre-sentinel render while
    // the functional writeAnns bridge must read this newer cache value synchronously. Replacing
    // writeAnns with `setAnnotations(annotations.map(...))` drops id 104 and fails this pin.
    seedAnnotations(qc, [...readAnnotationRows(), ann(104, { name: "Same-tick sentinel" })]);
    fireEvent.keyDown(edit, { key: "Enter" });

    // AnnotationPanel now receives the cache notification on a timer task. Keep the same
    // byte-stable behavioral assertion horizon used across both backing implementations.
    await advance(0);

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "D-01 1" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "D-02 1" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Unrelated 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Same-tick sentinel 1" })).toBeInTheDocument();
    expect(readYoloTags(qc, "pid")[0]).toMatchObject({ name: "D-02", tagText: "D-02" });
    expect(useUiStore.getState().llmHighlight?.label).toBe("D-02 — 1 of 2");

    // WHY advance: updateYoloTag schedules its separate project-intelligence debounce even though
    // the annotation rename itself is local. Draining under demo prevents cross-test timer bleed.
    await advance(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── CalibrationInput: demo-local vs non-demo server-first replacement ─────────────────────

describe("CalibrationInput annotation replacement freeze", () => {
  it("demo replaces only the current page's scale row locally, calibrates, and never fetches", async () => {
    setViewerStoreStateForTest({
      isDemo: true,
      pageNumber: 3,
      activeTool: { kind: "calibration" },
      calibrationMode: "input",
      calibrationPoints: { p1: { x: 0.2, y: 0.3 }, p2: { x: 0.7, y: 0.8 } },
    });
    seedAnnotations(qc, [
      scaleAnn(10, 3, "Old pg3 scale"),
      scaleAnn(11, 4, "Keep pg4 scale"),
      ann(12, { name: "Keep markup" }),
    ]);
    render(
      <>
        <CalibrationInput />
        <AnnotationPanel />
      </>,
      { wrapper },
    );

    fireEvent.change(screen.getByPlaceholderText("Distance..."), { target: { value: "25" } });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "m" } });
    fireEvent.click(screen.getByRole("button", { name: "OK" }));

    // [refactor jul11 P2.2⑥] DOM rows prove the cache/store collection replacement without a
    // backing read: current-page old scale is removed, cross-page scale + markup are retained.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Scale (pg 3) 1" })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: "Old pg3 scale 1" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep pg4 scale 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep markup 1" })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useToolStore.getState().scaleCalibrations[3]).toEqual({
      type: "scale-calibration",
      point1: { x: 0.2, y: 0.3 },
      point2: { x: 0.7, y: 0.8 },
      realDistance: 25,
      unit: "m",
    });
    expect(useToolStore.getState().calibrationPoints).toEqual({});
    expect(screen.getByPlaceholderText("Distance...")).toHaveValue(null);
  });

  it("non-demo awaits same-page DELETEs in array order, then POSTs and replaces only after success", async () => {
    setViewerStoreStateForTest({
      pageNumber: 3,
      activeTool: { kind: "calibration" },
      calibrationMode: "input",
      calibrationPoints: { p1: { x: 0.2, y: 0.3 }, p2: { x: 0.2, y: 0.8 } },
    });
    const capturedRows = [
      scaleAnn(20, 3, "Old scale A"),
      scaleAnn(21, 3, "Old scale B"),
      scaleAnn(22, 4, "Keep other page"),
      ann(23, { name: "Keep user row" }),
    ];
    seedAnnotations(qc, capturedRows);

    const deleteA = deferred<Response>();
    const deleteB = deferred<Response>();
    const create = deferred<Response>();
    fetchMock
      .mockReturnValueOnce(deleteA.promise)
      .mockReturnValueOnce(deleteB.promise)
      .mockReturnValueOnce(create.promise);

    render(
      <>
        <CalibrationInput />
        <AnnotationPanel />
      </>,
      { wrapper },
    );
    fireEvent.change(screen.getByPlaceholderText("Distance..."), { target: { value: "12.5" } });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "m" } });
    fireEvent.click(screen.getByRole("button", { name: "OK" }));

    // [refactor jul11 P2.2⑥] Mock-call-anchored ordering pin: each DELETE is awaited by the
    // for-of loop. Nothing local changes while either DELETE or the POST is outstanding.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]).toEqual([
      "/api/annotations/20",
      { method: "DELETE" },
    ]);
    expect(screen.getByRole("button", { name: "..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Old scale A 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Old scale B 1" })).toBeInTheDocument();

    deleteA.resolve(jsonResponse(null));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]).toEqual([
      "/api/annotations/21",
      { method: "DELETE" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2); // POST cannot overtake DELETE B

    deleteB.resolve(jsonResponse(null));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const [postUrl, postInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(postUrl).toBe("/api/annotations");
    expect(postInit.method).toBe("POST");
    expect(postInit.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(postInit.body))).toEqual({
      projectId: "pid",
      pageNumber: 3,
      name: "Scale (pg 3)",
      bbox: [0.2, 0.3, 0.201, 0.8], // vertical line gets the API's non-zero-width EPS
      note: null,
      source: "takeoff-scale",
      data: {
        type: "scale-calibration",
        point1: { x: 0.2, y: 0.3 },
        point2: { x: 0.2, y: 0.8 },
        realDistance: 12.5,
        unit: "m",
      },
    });
    expect(screen.getByRole("button", { name: "Old scale A 1" })).toBeInTheDocument();
    expect(useToolStore.getState().scaleCalibrations[3]).toBeUndefined();

    // [refactor jul11 P2.2⑥] Captured VALUE-REPLACE concurrency pin. handleOk closed over
    // `capturedRows` when the user clicked OK. Publish a genuine concurrent domain row while the
    // POST is pending and prove subscribers see it BEFORE the response. On success, today's
    // `setAnnotations([...annotations.filter(...), saved])` intentionally rebuilds from that old
    // capture and therefore drops the concurrent row. This lost-update quirk is characterization,
    // not endorsement: C3 must preserve it unless ANNOTATIONS-W1 is deliberately sanctioned.
    const concurrentRow = ann(24, { name: "Concurrent in-flight row" });
    act(() => seedAnnotations(qc, [...capturedRows, concurrentRow]));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Concurrent in-flight row 1" })).toBeInTheDocument(),
    );

    create.resolve(jsonResponse(scaleAnn(90, 3, "Server scale")));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Server scale 1" })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: "Old scale A 1" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Old scale B 1" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep other page 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep user row 1" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Concurrent in-flight row 1" })).not.toBeInTheDocument();
    expect(useToolStore.getState().scaleCalibrations[3]?.realDistance).toBe(12.5);
    expect(useToolStore.getState().calibrationPoints).toEqual({});
    expect(screen.getByPlaceholderText("Distance...")).toHaveValue(null);
  });

  it("does not adopt a saved calibration into a same-ID successor lifecycle", async () => {
    const lifecycleA = await activateLifecycle();
    const snapshotA = captureProjectLifecycle(qc);
    setViewerStoreStateForTest({
      publicId: "pid",
      isDemo: false,
      pageNumber: 3,
      numPages: 10,
      activeTool: { kind: "calibration" },
      calibrationMode: "input",
      calibrationPoints: { p1: { x: 0.2, y: 0.3 }, p2: { x: 0.7, y: 0.8 } },
    });
    seedAnnotations(qc, [ann(40, { name: "Lifecycle A row" })]);
    const savedA = scaleAnn(90, 3, "Obsolete A scale");
    const pending = deferred<Response>();
    const successorPending = new Promise<Response>(() => {});
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      if (String(input) === "/api/annotations") return pending.promise;
      return successorPending;
    });
    render(<CalibrationInput />, { wrapper });
    fireEvent.change(screen.getByPlaceholderText("Distance..."), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/annotations",
      expect.any(Object),
    ));

    const successorRows = [ann(140, { name: "Successor B row" })];
    const successorScale = {
      type: "scale-calibration" as const,
      point1: { x: 0, y: 0 },
      point2: { x: 1, y: 0 },
      realDistance: 140,
      unit: "ft" as const,
    };
    let lifecycleB!: OpenProjectHandle;
    await act(async () => {
      lifecycleB = openProject(qc, "pid", { demo: false });
      setViewerStoreStateForTest({
        publicId: "pid",
        isDemo: false,
        pageNumber: 3,
        numPages: 10,
      });
      seedAnnotations(qc, successorRows);
      useToolStore.setState({ scaleCalibrations: { 3: successorScale } });
      pending.resolve(jsonResponse(savedA));
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    });

    expect.soft(isCurrentProjectLifecycle(qc, snapshotA)).toBe(false);
    expect.soft(readAnnotationRows()).toEqual(successorRows);
    expect.soft(useToolStore.getState().scaleCalibrations[3]).toBe(successorScale);
    lifecycleB.dispose();
    lifecycleA.dispose();
  });

  it("surfaces the shell error message and keeps local rows plus the calibration gesture on POST failure", async () => {
    setViewerStoreStateForTest({
      pageNumber: 5,
      activeTool: { kind: "calibration" },
      calibrationMode: "input",
      calibrationPoints: { p1: { x: 0.1, y: 0.2 }, p2: { x: 0.9, y: 0.2 } },
    });
    seedAnnotations(qc, [
      scaleAnn(30, 5, "Failed scale A"),
      scaleAnn(31, 5, "Failed scale B"),
      scaleAnn(32, 6, "Keep pg6 scale"),
      ann(33, { name: "Still here" }),
    ]);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(null)) // DELETE /30 succeeds remotely
      .mockResolvedValueOnce(jsonResponse(null)) // DELETE /31 succeeds remotely
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { code: "VALIDATION", message: "Calibration rejected" } },
          { ok: false, status: 422 },
        ),
      );

    render(
      <>
        <CalibrationInput />
        <AnnotationPanel />
      </>,
      { wrapper },
    );
    fireEvent.change(screen.getByPlaceholderText("Distance..."), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "OK" }));

    // [refactor jul11 P2.2⑥] This pins CalibrationInput's inline channel (not alert/console) and
    // the no-local-commit/no-clear failure semantics that the cache migration must preserve.
    // Critically, both remote DELETEs already succeeded: the failed POST leaves the captured
    // same-page scale rows visible locally anyway, so server and client temporarily diverge.
    expect(await screen.findByText("Calibration rejected")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]).toEqual(["/api/annotations/30", { method: "DELETE" }]);
    expect(fetchMock.mock.calls[1]).toEqual(["/api/annotations/31", { method: "DELETE" }]);
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/annotations");
    expect(screen.getByRole("button", { name: "Failed scale A 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Failed scale B 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep pg6 scale 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Still here 1" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Scale (pg 5) 1" })).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("Distance...")).toHaveValue(10);
    expect(useToolStore.getState().calibrationPoints).toEqual({
      p1: { x: 0.1, y: 0.2 },
      p2: { x: 0.9, y: 0.2 },
    });
    expect(useToolStore.getState().scaleCalibrations[5]).toBeUndefined();
    expect(screen.getByRole("button", { name: "OK" })).toBeEnabled();
  });
});

// ─── AnnotationListItem: raw PUT + local note/data update ──────────────────────────────────

function renderAnnotationListItem(annotation: ClientAnnotation) {
  return render(
    <AnnotationListItem
      annotation={annotation}
      isActive={false}
      onToggleFilter={vi.fn()}
      onSearchKeyword={vi.fn()}
    />,
    { wrapper },
  );
}

function openDirectAnnotationEditor() {
  fireEvent.click(screen.getByRole("button", { name: "▶" }));
  return {
    note: screen.getByPlaceholderText("Add notes..."),
    csi: screen.getByPlaceholderText("e.g. 08, 08 11 16, 080000"),
  };
}

function openFirstDetectionEditor() {
  // DetectionPanel hierarchy: model ▶, class ▶, then AnnotationListItem ▶.
  // Clicking one at a time avoids coupling the witness to CSS or implementation-only keys.
  fireEvent.click(screen.getByRole("button", { name: "▶" }));
  fireEvent.click(screen.getByRole("button", { name: "▶" }));
  fireEvent.click(screen.getByRole("button", { name: "▶" }));
  return {
    note: screen.getByPlaceholderText("Add notes..."),
    csi: screen.getByPlaceholderText("e.g. 08, 08 11 16, 080000"),
  };
}

describe("AnnotationListItem note-save freeze", () => {
  it("PUTs normalized note/data, merges server CSI codes, and publishes the saved row locally", async () => {
    const row = yoloAnn(70);
    seedAnnotations(qc, [row]);
    const save = deferred<Response>();
    fetchMock.mockReturnValueOnce(save.promise);
    const view = renderAnnotationListItem(row);
    const editor = openDirectAnnotationEditor();
    fireEvent.change(editor.note, { target: { value: "Revised hardware note" } });
    fireEvent.change(editor.csi, { target: { value: "8, 081116" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/annotations/70");
    expect(init.method).toBe("PUT");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(init.body))).toEqual({
      note: "Revised hardware note",
      data: {
        modelName: "Fixture Model",
        confidence: 0.95,
        csiCodes: ["08", "08 11 16"],
        keywords: ["opening"],
        note: "Revised hardware note",
      },
    });
    expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();

    // [refactor jul11 P2.2⑥] Server-response-first pin: editor useState already shows the draft,
    // so it is NOT a domain witness. The shared backing seam proves no optimistic annotation write
    // occurs while fetch/JSON is pending; C3 must not accidentally publish before the response.
    expect(readAnnotationRows()).toHaveLength(1);
    expect(readAnnotationRows()[0]).toBe(row);
    expect(readAnnotationRows()[0]?.note).toBeNull();
    expect(readAnnotationRows()[0]?.data?.csiCodes).toEqual(["08"]);

    save.resolve(jsonResponse({ autoCsiCodes: ["09 91 00", "08 11 16"] }));
    await waitFor(() => expect(readAnnotationRows()[0]?.note).toBe("Revised hardware note"));
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(editor.csi).toHaveValue("08, 08 11 16, 09 91 00");

    // [refactor jul11 P2.2⑥] Unmount the local editor, then remount through DetectionPanel's real
    // annotation subscription. Freshly initialized fields prove updateAnnotation published to the
    // shared domain; merely asserting the first component's local useState would false-pass.
    view.unmount();
    render(<DetectionPanel embedded lockedTab="models" />, { wrapper });
    const remounted = openFirstDetectionEditor();
    expect(remounted.note).toHaveValue("Revised hardware note");
    expect(remounted.csi).toHaveValue("08, 08 11 16, 09 91 00");
  });

  it("L5 freeze: demo save performs zero network and leaves the shared annotation unchanged", async () => {
    setViewerStoreStateForTest({ isDemo: true });
    const row = yoloAnn(71, { note: "Before" });
    seedAnnotations(qc, [row]);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: { code: "FORBIDDEN", message: "Demo projects are read-only" } },
        { ok: false, status: 403 },
      ),
    );
    const view = renderAnnotationListItem(row);
    const editor = openDirectAnnotationEditor();
    fireEvent.change(editor.note, { target: { value: "Demo-local edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readAnnotationRows()[0]).toBe(row);

    view.unmount();
    render(<DetectionPanel embedded lockedTab="models" />, { wrapper });
    const remounted = openFirstDetectionEditor();
    expect(remounted.note).toHaveValue("Before");
  });

  it("L5 freeze: a resolved HTTP error is not adopted into the shared annotation", async () => {
    const row = yoloAnn(73, { note: "Persisted before" });
    seedAnnotations(qc, [row]);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: { code: "FORBIDDEN", message: "Denied" } },
        { ok: false, status: 403 },
      ),
    );
    const view = renderAnnotationListItem(row);
    const editor = openDirectAnnotationEditor();
    fireEvent.change(editor.note, { target: { value: "Rejected draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readAnnotationRows()[0]).toBe(row);

    view.unmount();
    render(<DetectionPanel embedded lockedTab="models" />, { wrapper });
    expect(openFirstDetectionEditor().note).toHaveValue("Persisted before");
  });

  it("silently keeps the editor draft but leaves the shared annotation untouched on network reject", async () => {
    const row = yoloAnn(72, { note: "Persisted before" });
    seedAnnotations(qc, [row]);
    const save = deferred<Response>();
    fetchMock.mockReturnValueOnce(save.promise);

    const view = renderAnnotationListItem(row);
    const editor = openDirectAnnotationEditor();
    fireEvent.change(editor.note, { target: { value: "Offline retry draft" } });
    fireEvent.change(editor.csi, { target: { value: "09 91 00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
    expect(readAnnotationRows()[0]).toBe(row); // no optimistic publication before rejection

    save.reject(new Error("offline"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());

    // [refactor jul11 P2.2⑥] Faithful silent-failure contract: handleSave's catch publishes no
    // error and performs no shared-domain update, but it also does not discard the local editor
    // draft, allowing the user to press Save again. Remounting through a real subscriber proves
    // the persisted/shared row still has its original note + CSI rather than the retry draft.
    expect(editor.note).toHaveValue("Offline retry draft");
    expect(editor.csi).toHaveValue("09 91 00");
    expect(readAnnotationRows()[0]).toBe(row);
    expect(screen.queryByText(/network error/i)).not.toBeInTheDocument();

    view.unmount();
    render(<DetectionPanel embedded lockedTab="models" />, { wrapper });
    const remounted = openFirstDetectionEditor();
    expect(remounted.note).toHaveValue("Persisted before");
    expect(remounted.csi).toHaveValue("08");
  });
});

describe("DetectionPanel CSI override security freeze", () => {
  function openCsiOverrideEditor() {
    render(<DetectionPanel embedded lockedTab="models" />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: /CSI Tags/ }));
    const input = screen.getByPlaceholderText("CSI codes...");
    fireEvent.change(input, { target: { value: "09 91 00" } });
    return screen.getByRole("button", { name: "Save to Project" });
  }

  it("L5 freeze: demo CSI override performs zero network", async () => {
    setViewerStoreStateForTest({ isDemo: true });
    seedAnnotations(qc, [yoloAnn(80)]);
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 403 }));
    fireEvent.click(openCsiOverrideEditor());

    await waitFor(() => expect(screen.getByRole("button", { name: "Save to Project" })).toBeEnabled());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("adopts success messaging only when the CSI response is ok", async () => {
    seedAnnotations(qc, [yoloAnn(81)]);
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "denied" }, { ok: false, status: 403 }));
    fireEvent.click(openCsiOverrideEditor());

    expect(await screen.findByText("Save failed")).toBeInTheDocument();
    expect(screen.queryByText("Saved to project")).not.toBeInTheDocument();
  });
});

describe("DetectionPanel synchronous publication tails — same-ID lifecycle retirement", () => {
  const successorSearch = "successor B search";
  const successorAnnotationFilter = "successor B annotation filter";
  const successorTagId = "successor-b-tag";
  const successorTagFilter = "successor-b-tag-filter";

  function installSameIdSuccessor(seed: () => void): OpenProjectHandle {
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    const lifecycleB = openProject(qc, "pid", { demo: true });
    setViewerStoreStateForTest({
      projectId: 0,
      publicId: "pid",
      isDemo: true,
      pageNumber: 3,
      numPages: 10,
    });
    seed();
    return lifecycleB;
  }

  function renderModelRow(active: boolean) {
    setViewerStoreStateForTest({
      pageNumber: 3,
      activeAnnotationFilter: active ? "Door" : null,
      searchQuery: active ? "A search" : "",
    });
    seedAnnotations(qc, [yoloAnn(170, { pageNumber: 3 })]);
    render(<DetectionPanel embedded lockedTab="models" />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: "▶" }));
  }

  function renderTagPanel({ active = false }: { active?: boolean } = {}) {
    seedYoloTagsFromBootstrap(qc, "pid", { yoloTags: [yoloTag()] });
    setViewerStoreStateForTest({
      activeYoloTagId: active ? "tag-a" : null,
      activeYoloTagFilter: active ? "tag-a" : null,
    });
    render(<DetectionPanel embedded lockedTab="tags" />, { wrapper });
  }

  it("AnnotationListItem row filtering does not publish A search text into successor B", async () => {
    const lifecycleA = await activateLifecycle();
    renderModelRow(false);
    fireEvent.click(screen.getByRole("button", { name: "▶" }));

    let admittedB = false;
    let lifecycleB!: OpenProjectHandle;
    const unsubscribe = useUiStore.subscribe((state, previous) => {
      if (admittedB || previous.activeAnnotationFilter === "Door" ||
          state.activeAnnotationFilter !== "Door") return;
      admittedB = true;
      lifecycleB = installSameIdSuccessor(() => {
        useUiStore.setState({
          activeAnnotationFilter: successorAnnotationFilter,
          searchQuery: successorSearch,
        });
      });
    });

    const row = screen.getAllByTitle("Door").at(-1);
    expect(row).toBeDefined();
    fireEvent.click(row!);
    unsubscribe();

    expect.soft(admittedB).toBe(true);
    expect.soft(useUiStore.getState().activeAnnotationFilter).toBe(successorAnnotationFilter);
    expect.soft(useUiStore.getState().searchQuery).toBe(successorSearch);
    lifecycleB?.dispose();
    lifecycleA.dispose();
  });

  it("clearing an active detection class does not clear successor B's search", async () => {
    const lifecycleA = await activateLifecycle();
    renderModelRow(true);

    let admittedB = false;
    let lifecycleB!: OpenProjectHandle;
    const unsubscribe = useUiStore.subscribe((state, previous) => {
      if (admittedB || previous.activeAnnotationFilter !== "Door" ||
          state.activeAnnotationFilter !== null) return;
      admittedB = true;
      lifecycleB = installSameIdSuccessor(() => {
        useUiStore.setState({
          activeAnnotationFilter: successorAnnotationFilter,
          searchQuery: successorSearch,
        });
      });
    });

    fireEvent.click(screen.getByTitle("Door"));
    unsubscribe();

    expect.soft(admittedB).toBe(true);
    expect.soft(useUiStore.getState().activeAnnotationFilter).toBe(successorAnnotationFilter);
    expect.soft(useUiStore.getState().searchQuery).toBe(successorSearch);
    lifecycleB?.dispose();
    lifecycleA.dispose();
  });

  it("selecting a tag does not publish A's filter or search into successor B", async () => {
    const lifecycleA = await activateLifecycle(true);
    renderTagPanel();

    let admittedB = false;
    let lifecycleB!: OpenProjectHandle;
    const unsubscribe = useUiStore.subscribe((state, previous) => {
      if (admittedB || previous.activeYoloTagId === "tag-a" ||
          state.activeYoloTagId !== "tag-a") return;
      admittedB = true;
      lifecycleB = installSameIdSuccessor(() => {
        useUiStore.setState({
          activeYoloTagId: successorTagId,
          activeYoloTagFilter: successorTagFilter,
          searchQuery: successorSearch,
        });
      });
    });

    fireEvent.click(screen.getByText("D-01"));
    unsubscribe();

    expect.soft(admittedB).toBe(true);
    expect.soft(useUiStore.getState().activeYoloTagId).toBe(successorTagId);
    expect.soft(useUiStore.getState().activeYoloTagFilter).toBe(successorTagFilter);
    expect.soft(useUiStore.getState().searchQuery).toBe(successorSearch);
    lifecycleB?.dispose();
    lifecycleA.dispose();
  });

  it("active-tag indicator clear does not clear successor B's tag filter", async () => {
    const lifecycleA = await activateLifecycle(true);
    renderTagPanel({ active: true });

    let admittedB = false;
    let lifecycleB!: OpenProjectHandle;
    const unsubscribe = useUiStore.subscribe((state, previous) => {
      if (admittedB || previous.activeYoloTagId !== "tag-a" ||
          state.activeYoloTagId !== null) return;
      admittedB = true;
      lifecycleB = installSameIdSuccessor(() => {
        useUiStore.setState({
          activeYoloTagId: successorTagId,
          activeYoloTagFilter: successorTagFilter,
        });
      });
    });

    const activeIndicator = screen.getByText("Active: D-01").parentElement;
    const clear = activeIndicator?.querySelector("button");
    expect(clear).not.toBeNull();
    fireEvent.click(clear!);
    unsubscribe();

    expect.soft(admittedB).toBe(true);
    expect.soft(useUiStore.getState().activeYoloTagId).toBe(successorTagId);
    expect.soft(useUiStore.getState().activeYoloTagFilter).toBe(successorTagFilter);
    lifecycleB?.dispose();
    lifecycleA.dispose();
  });

  it("Add Missing does not publish A's active tag after successor B owns the tool", async () => {
    const lifecycleA = await activateLifecycle(true);
    renderTagPanel();
    fireEvent.click(screen.getByRole("button", { name: "▶" }));

    let admittedB = false;
    let lifecycleB!: OpenProjectHandle;
    const unsubscribe = useToolStore.subscribe((state, previous) => {
      if (admittedB || previous.activeTool?.kind === "tagAdd" ||
          state.activeTool?.kind !== "tagAdd" || state.activeTool.tagId !== "tag-a") return;
      admittedB = true;
      lifecycleB = installSameIdSuccessor(() => {
        useToolStore.setState({ activeTool: { kind: "tagAdd", tagId: successorTagId } });
        useUiStore.setState({ activeYoloTagId: successorTagId });
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "+ Add Missing" }));
    unsubscribe();

    expect.soft(admittedB).toBe(true);
    expect.soft(useToolStore.getState().activeTool).toEqual({
      kind: "tagAdd",
      tagId: successorTagId,
    });
    expect.soft(useUiStore.getState().activeYoloTagId).toBe(successorTagId);
    lifecycleB?.dispose();
    lifecycleA.dispose();
  });

  it("Accept Selected does not clear successor B's scan preview", async () => {
    const lifecycleA = await activateLifecycle(true);
    const scanA = tagScanResults("A");
    setViewerStoreStateForTest({ pageNumber: 3, tagScanResults: scanA });
    render(<DetectionPanel embedded lockedTab="tags" />, { wrapper });

    const scanB = tagScanResults("successor B");
    let admittedB = false;
    let lifecycleB!: OpenProjectHandle;
    const expectedKey = JSON.stringify(queryKeys.yoloTags.all("pid"));
    const unsubscribe = qc.getQueryCache().subscribe((event) => {
      if (admittedB || event.type !== "updated" ||
          JSON.stringify(event.query.queryKey) !== expectedKey) return;
      admittedB = true;
      lifecycleB = installSameIdSuccessor(() => {
        useToolStore.setState({ tagScanResults: scanB });
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Accept Selected" }));
    unsubscribe();

    expect.soft(admittedB).toBe(true);
    expect.soft(useToolStore.getState().tagScanResults).toBe(scanB);
    lifecycleB?.dispose();
    lifecycleA.dispose();
  });
});
