// @vitest-environment jsdom
// [TP-3 WP-3.O] Workspace canvas layer + keyboard isolation, mounted through the REAL ProposalFocusLayer and
// tested against the REAL overlay keyboard dispatcher (useOverlayKeyboardDispatcher, frozen, on `window`), the
// real workspace store/commands (WP-3.L), toolStore and proposalFocusStore. Only `fetch` is mocked. All geometry
// and text is synthetic (PLAN §1.6 rule 12).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import ProposalFocusLayer from "@/components/viewer/ProposalFocusLayer";
import { useOverlayKeyboardDispatcher } from "@/components/viewer/useOverlayKeyboardDispatcher";
import TablesWorkspaceHost from "@/components/viewer/workspace/TablesWorkspaceHost";
import WorkspaceCanvasLayer from "@/components/viewer/workspace/canvas/WorkspaceCanvasLayer";
import { DRAW_CONTINUATION } from "@/components/viewer/workspace/canvas/BoxDrawCapture";
import {
  applyLineOps,
  axisEdges,
  boundaries,
  canvasLines,
  clampLine,
  editableLine,
  modelLines,
  moveOp,
  previewModel,
  removeOp,
} from "@/components/viewer/workspace/canvas/lineModel";
import { DISPATCHER_KEYS, focusScopedKeys, WorkspaceKeyScope } from "@/components/viewer/workspace/keyboard";
import type {
  CorrectionOp,
  ParseEngineFlags,
  ParseResult,
  StructureParagraphDoc,
  StructureTableModel,
} from "@/lib/parse-engine/types";
import type { WorkspaceItem, WorkspaceItemsResponse } from "@/queries/useWorkspaceItems";
import { useProposalFocusStore } from "@/stores/proposalFocusStore";
import { useSessionStore } from "@/stores/sessionStore";
import {
  resetTablesWorkspaceStore,
  useTablesWorkspaceStore,
  type WorkspaceCorrection,
  type WorkspaceDraft,
} from "@/stores/tablesWorkspaceStore";
import { useToolStore } from "@/stores/toolStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import { resetWorkspaceCanvasStore, useWorkspaceCanvasStore } from "@/stores/workspaceCanvasStore";
import { drawItemKey, openFromToolbar, startDraw } from "@/stores/workspaceCommands";

// applyOps is the WP-2.E stub on this branch; a test can make it fail differently (VERIFY F3).
const opsMock = vi.hoisted(() => ({ fail: null as Error | null }));
vi.mock("@/lib/parse-engine/ops", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/parse-engine/ops")>();
  return {
    ...real,
    applyOps: (...args: Parameters<typeof real.applyOps>) => {
      if (opsMock.fail) throw opsMock.fail;
      return real.applyOps(...args);
    },
  };
});

const PUB = "pub-canvas";
const KEY = "p-synth";

// ── synthetic fixtures ───────────────────────────────────────────────────────────────────────────
const TABLE: StructureTableModel = {
  v: 1, kind: "keynote", bbox: [0.1, 0.1, 0.6, 0.5],
  rows: [
    { id: "r0", y0: 0.1, y1: 0.2, role: "header" },
    { id: "r1", y0: 0.2, y1: 0.3, role: "body", key: { kind: "shape-text", text: null, shapeClass: "circle", shapeBbox: [0.11, 0.21, 0.14, 0.29], textSource: "inside" } },
    { id: "r2", y0: 0.3, y1: 0.5, role: "body", key: { kind: "shape-text", text: "K9", shapeClass: "circle", shapeBbox: [0.11, 0.31, 0.14, 0.39], textSource: "inside" } },
  ],
  cols: [
    { id: "c0", x0: 0.1, x1: 0.3, label: "Key", labelRaw: "KEY" },
    { id: "c1", x0: 0.3, x1: 0.6, label: "Text", labelRaw: "TEXT" },
  ],
  cells: [], headerRows: 1,
  sources: { rows: ["shape-centres"], cols: ["x-starts"] },
  quality: { conf: 0.9, agreement: 0.8, flags: [] },
};
const RESULT: ParseResult = {
  model: TABLE,
  alternatives: [
    { method: "textract-cells", rows: 3, cols: 2, agreement: 0.9, conf: 0.8, geometry: { rowLines: [0.1, 0.2, 0.3, 0.5], colLines: [0.1, 0.3, 0.6] } },
    { method: "ocr-lines", rows: 4, cols: 3, agreement: 0.5, conf: 0.5, geometry: { rowLines: [0.1, 0.2, 0.25, 0.3, 0.5], colLines: [0.1, 0.25, 0.4, 0.6] } },
  ],
  evidence: { words: 0, lines: 0, paidCropAvailable: false },
  words: [],
  stamp: { engine: "pe/1.0.0", caps: {}, methods: [], budget: "instant", evidenceHash: "e", paramsHash: "p", at: "2026-10-28T00:00:00.000Z" },
};
const NOTES: StructureParagraphDoc = {
  v: 1, kind: "notes", bbox: [0.1, 0.5, 0.5, 0.9],
  blocks: [{ id: "b1", header: "SYNTHETIC NOTES", headerNorm: "SYNTHETIC NOTES", b: [0.1, 0.5, 0.5, 0.9] }],
  paragraphs: [
    { id: "p1", blockId: "b1", key: null, keyPath: [], keyNorm: "", depth: 0, text: "Lead-in.", b: [0.1, 0.52, 0.5, 0.56], lineCount: 1 },
    { id: "p2", blockId: "b1", key: "1", keyPath: ["1"], keyNorm: "1", depth: 0, text: "First synthetic note.", b: [0.1, 0.56, 0.5, 0.62], lineCount: 2 },
  ],
  sources: { segment: ["hanging-indent"] },
  quality: { conf: 0.8, agreement: 0.7, flags: [] },
};

// The canvas root measures 1000 × 800 px at (100, 50): page y = (clientY − 50) / 800, x = (clientX − 100) / 1000.
const RECT = { left: 100, top: 50, width: 1000, height: 800 };
const cx = (x: number) => RECT.left + x * RECT.width;
const cy = (y: number) => RECT.top + y * RECT.height;

function stubCanvasRect() {
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.hasAttribute("data-workspace-canvas")) {
      return { ...RECT, x: RECT.left, y: RECT.top, right: RECT.left + RECT.width, bottom: RECT.top + RECT.height, toJSON: () => ({}) } as DOMRect;
    }
    return original.call(this);
  });
}

const fetchCalls: { url: string; method: string }[] = [];
const FLAGS_ON: ParseEngineFlags = {
  killSwitch: false, cropCache: true,
  tools: { tablesRoute: "legacy", keynoteRoute: "legacy", notesClassifier: "legacy", specClassifier: "legacy", notesAuto: "legacy", specAuto: "legacy", workspace: "engine" },
};
const ITEM: WorkspaceItem = {
  id: KEY, page: 1, b: [0.1, 0.1, 0.6, 0.5], kind: "keynote", origin: "proposal", title: "Synthetic keynotes", p: 0.9, score: 0.9, state: "todo", proposalId: KEY,
};
function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    fetchCalls.push({ url, method: init?.method ?? "GET" });
    let body: unknown = { error: "unrouted" };
    let status = 404;
    if (url.endsWith("/parse-engine/flags")) { status = 200; body = FLAGS_ON; }
    if (url.includes("/parse-engine/items?")) {
      status = 200;
      body = { scope: "sheet", indexReady: true, threshold: 0.3, groups: [{ page: 1, items: [ITEM], lowConfidence: [] }] } satisfies WorkspaceItemsResponse;
    }
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }));
}

function draft(over: Partial<WorkspaceDraft> = {}): WorkspaceDraft {
  return { page: 1, bbox: [0.1, 0.1, 0.6, 0.5], kind: "keynote", result: RESULT, ops: [], startedAt: 1, ...over };
}
function openWithDraft(d: WorkspaceDraft | null = draft(), page = 1) {
  useTablesWorkspaceStore.setState({
    enabled: true, open: true, selectedKey: KEY,
    queue: [{ id: KEY, page, b: [0.1, 0.1, 0.6, 0.5], kind: "keynote", proposalId: KEY }],
    drafts: d ? { [KEY]: d } : {},
  });
}
const opsOf = (key = KEY): CorrectionOp[] => useTablesWorkspaceStore.getState().drafts[key]?.ops ?? [];
/** WP-3.M's "+ Add continuation box" (it widens `WorkspaceCorrection` with this value). */
const armContinuation = () => useTablesWorkspaceStore.getState().setCorrection(DRAW_CONTINUATION as WorkspaceCorrection);

// ── the real window-level overlay dispatcher, with spies for what it would do ─────────────────────
type DispatcherOptions = Parameters<typeof useOverlayKeyboardDispatcher>[0];
function Dispatcher({ options }: { options: DispatcherOptions }) {
  useOverlayKeyboardDispatcher(options);
  return null;
}
function dispatcherOptions(over: Partial<DispatcherOptions> = {}): DispatcherOptions {
  return {
    canAdoptProjectLifecycle: () => true,
    cancelDeferredDrawing: vi.fn(), acceptSplit: vi.fn(), prepareBucketFillPolygon: vi.fn(), savePolygon: vi.fn(),
    saveLinearPolyline: vi.fn(), setMousePos: vi.fn(), selectedId: null, isDemo: false, removeAnnotation: vi.fn(),
    setSelectedId: vi.fn(), readActiveAnnotationDrag: vi.fn(() => null), finishAnnotationDrag: vi.fn(() => true),
    publishTransientError: vi.fn(),
    ...over,
  };
}

let qc: QueryClient;
const Providers = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
/** The canvas exactly as PDFPage mounts it: inside ProposalFocusLayer, inside a positioned page box. */
const Page = ({ page = 1 }: { page?: number }) => (
  <Providers><div style={{ position: "relative" }}><ProposalFocusLayer pageNumber={page} /></div></Providers>
);

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fetchCalls.length = 0;
  installFetch();
  try { localStorage.clear(); } catch { /* jsdom */ }
  resetTablesWorkspaceStore();
  resetWorkspaceCanvasStore();
  opsMock.fail = null;
  useToolStore.getState().resetProjectToolState();
  useProposalFocusStore.setState({ hover: null, focus: null, fitRequest: 0 });
  useSessionStore.setState({ publicId: PUB, isDemo: false, projectId: 7, pageDrawingNumbers: {}, pageNames: {} });
  useViewerCoreStore.setState({ pageNumber: 1, numPages: 5 });
  stubCanvasRect();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("lineModel (pure)", () => {
  it("lines are the interior boundaries, keyed by the row/col before them", () => {
    expect(modelLines(TABLE, "rows").map((l) => [l.after, l.at])).toEqual([["r0", 0.2], ["r1", 0.3]]);
    expect(modelLines(TABLE, "cols").map((l) => [l.after, l.at])).toEqual([["c0", 0.3]]);
  });

  it("never draws a line between two continuation parts", () => {
    const twoPart: StructureTableModel = {
      ...TABLE, parts: [[0.1, 0.6, 0.6, 0.8]],
      rows: [...TABLE.rows, { id: "r3", y0: 0.6, y1: 0.7, role: "body", part: 1 }, { id: "r4", y0: 0.7, y1: 0.8, role: "body", part: 1 }],
    };
    expect(modelLines(twoPart, "rows").map((l) => [l.after, l.at, l.part])).toEqual([["r0", 0.2, 0], ["r1", 0.3, 0], ["r3", 0.7, 1]]);
  });

  it("previews line ops locally while applyOps is the WP-2.E stub", () => {
    const ops: CorrectionOp[] = [
      { op: "move-line", axis: "rows", after: "r1", at: 0.42 },
      { op: "add-line", axis: "rows", at: 0.15 },
      { op: "remove-line", axis: "rows", after: "r0" },
    ];
    const preview = previewModel(RESULT, ops);
    expect(preview.exact).toBe(false);
    expect(canvasLines(RESULT, ops, preview, "rows").map((l) => [l.after, l.at, l.src])).toEqual([[null, 0.15, "user"], ["r1", 0.42, "user"]]);
  });

  it("colours untouched lines by the best agreeing method, else fused", () => {
    const lines = canvasLines(RESULT, [], previewModel(RESULT, []), "rows");
    expect(lines.map((l) => l.src)).toEqual(["textract-cells", "textract-cells"]);
    const only = { ...RESULT, alternatives: [] };
    expect(canvasLines(only, [], previewModel(only, []), "rows").map((l) => l.src)).toEqual(["fused", "fused"]);
  });

  it("pin-source shows the method's own lines; un-pinning restores fusion", () => {
    expect(applyLineOps(RESULT, [{ op: "pin-source", axis: "cols", method: "ocr-lines" }], "cols").map((l) => [l.at, l.src])).toEqual([[0.25, "ocr-lines"], [0.4, "ocr-lines"]]);
    expect(applyLineOps(RESULT, [{ op: "pin-source", axis: "cols", method: "ocr-lines" }, { op: "pin-source", axis: "cols", method: null }], "cols").map((l) => l.after)).toEqual(["c0"]);
  });

  it("an id-less line is edited with set-lines (full boundary list); an id-keyed one with move/remove", () => {
    const pin: CorrectionOp[] = [{ op: "pin-source", axis: "cols", method: "ocr-lines" }];
    const pinned = applyLineOps(RESULT, pin, "cols");
    const colEdges = axisEdges(RESULT, pin, previewModel(RESULT, pin), "cols");
    expect(colEdges).toEqual([0.1, 0.6]);
    expect(moveOp(pinned[0], 0.2, pinned, colEdges)).toEqual({ op: "set-lines", axis: "cols", at: [0.1, 0.2, 0.4, 0.6] });
    expect(removeOp(pinned[1], pinned, colEdges)).toEqual({ op: "set-lines", axis: "cols", at: [0.1, 0.25, 0.6] });
    const rows = modelLines(TABLE, "rows");
    const rowEdges = axisEdges(RESULT, [], previewModel(RESULT, []), "rows");
    expect(moveOp(rows[1], 0.4, rows, rowEdges)).toEqual({ op: "move-line", axis: "rows", after: "r1", at: 0.4 });
    expect(removeOp(rows[0], rows, rowEdges)).toEqual({ op: "remove-line", axis: "rows", after: "r0" });
    expect(boundaries("rows", rows, rowEdges)).toEqual([0.1, 0.2, 0.3, 0.5]);
  });

  // VERIFY F2: continuation blocks printed side by side share their y-range; a line's part comes from its row.
  it("side-by-side continuation parts: repeated drags of an added line never move another part's lines", () => {
    const side: StructureTableModel = {
      ...TABLE, bbox: [0.1, 0.1, 0.4, 0.5], parts: [[0.5, 0.1, 0.8, 0.5]],
      rows: [
        { id: "r0", y0: 0.1, y1: 0.2, role: "header" },
        { id: "r1", y0: 0.2, y1: 0.3, role: "body" },
        { id: "r2", y0: 0.3, y1: 0.5, role: "body" },
        { id: "r3", y0: 0.1, y1: 0.25, role: "body", part: 1 },
        { id: "r4", y0: 0.25, y1: 0.5, role: "body", part: 1 },
      ],
      cols: [{ id: "c0", x0: 0.1, x1: 0.25, label: "Key", labelRaw: "KEY" }, { id: "c1", x0: 0.25, x1: 0.4, label: "Text", labelRaw: "TEXT" }],
    };
    const result: ParseResult = { ...RESULT, model: side };
    const ops: CorrectionOp[] = [{ op: "add-line", axis: "rows", at: 0.45 }];
    const linesNow = () => {
      const preview = previewModel(result, ops);
      return { lines: canvasLines(result, ops, preview, "rows"), edges: axisEdges(result, ops, preview, "rows") };
    };
    const asTuples = () => linesNow().lines.map((l) => [l.part, l.after, l.at]);
    // add-line splits the first band holding it (part 0's r2), as WP-3.D does
    expect(asTuples()).toEqual([[0, "r0", 0.2], [0, "r1", 0.3], [0, null, 0.45], [1, "r3", 0.25]]);
    let was = 0.45;
    for (const to of [0.46, 0.47]) {
      const { lines, edges } = linesNow();
      const added = lines.find((l) => l.part === 0 && l.at === was)!;
      was = to;
      const op = moveOp(added, to, lines, edges)!;
      // set-lines carries PART 0's boundary list only (WP-3.D replaces part 0's axis with it)
      expect(op).toEqual({ op: "set-lines", axis: "rows", at: [0.1, 0.2, 0.3, to, 0.5] });
      ops.push(op);
      expect(asTuples()).toEqual([[0, null, 0.2], [0, null, 0.3], [0, null, to], [1, "r3", 0.25]]);
    }
    // pin-source replaces part 0's lines and keeps part 1's
    const pinned = applyLineOps({ ...result, alternatives: [{ ...RESULT.alternatives[1], geometry: { rowLines: [0.1, 0.15, 0.3, 0.5], colLines: [] } }] },
      [{ op: "pin-source", axis: "rows", method: "ocr-lines" }], "rows");
    expect(pinned.map((l) => [l.part, l.after, l.at])).toEqual([[0, null, 0.15], [0, null, 0.3], [1, "r3", 0.25]]);
  });

  it("an id-less line of a later part has no op (set-lines is part 0's) and is not editable", () => {
    const stacked: StructureTableModel = {
      ...TABLE, parts: [[0.1, 0.6, 0.6, 0.8]],
      rows: [...TABLE.rows, { id: "r3", y0: 0.6, y1: 0.8, role: "body", part: 1 }],
    };
    const result: ParseResult = { ...RESULT, model: stacked };
    const ops: CorrectionOp[] = [{ op: "add-line", axis: "rows", at: 0.7 }];
    const preview = previewModel(result, ops);
    const lines = canvasLines(result, ops, preview, "rows");
    const added = lines.find((l) => l.after === null)!;
    expect(added).toMatchObject({ part: 1, at: 0.7 });
    expect(editableLine(added)).toBe(false);
    expect(moveOp(added, 0.72, lines, axisEdges(result, ops, preview, "rows"))).toBeNull();
    expect(removeOp(added, lines, axisEdges(result, ops, preview, "rows"))).toBeNull();
  });

  it("only the not-implemented stub falls back to the local preview; any other applyOps failure is surfaced", () => {
    const ops: CorrectionOp[] = [{ op: "move-line", axis: "rows", after: "r1", at: 0.42 }];
    expect(previewModel(RESULT, ops)).toEqual({ model: TABLE, exact: false });
    opsMock.fail = new Error("synthetic validation failure");
    const preview = previewModel(RESULT, ops);
    expect(preview).toEqual({ model: TABLE, exact: true, error: "synthetic validation failure" });
    // the base model is shown unchanged: no local approximation of the op
    expect(canvasLines(RESULT, ops, preview, "rows").map((l) => l.at)).toEqual([0.2, 0.3]);
  });

  it("a dragged line stays inside its box and between its neighbours", () => {
    const rows = modelLines(TABLE, "rows");
    expect(clampLine(rows[1], 0.9, rows, [TABLE.bbox])).toBe(0.498);
    expect(clampLine(rows[1], 0.05, rows, [TABLE.bbox])).toBe(0.202);
  });
});

describe("keyboard.ts", () => {
  it("handles a key on focus only, never in a field, never Esc; stops the dispatcher keys", () => {
    const del = vi.fn();
    const handler = focusScopedKeys({ Delete: del, Escape: vi.fn() });
    const ev = (key: string, target: EventTarget = document.createElement("div")) => {
      const e = { key, target, altKey: false, ctrlKey: false, metaKey: false, preventDefault: vi.fn(), stopPropagation: vi.fn() };
      handler(e as never);
      return e;
    };
    expect(ev("Delete").stopPropagation).toHaveBeenCalled();
    expect(del).toHaveBeenCalledTimes(1);
    const typed = ev("Delete", document.createElement("input"));
    expect(del).toHaveBeenCalledTimes(1);
    expect(typed.preventDefault).not.toHaveBeenCalled();
    expect(typed.stopPropagation).toHaveBeenCalled(); // still never reaches the dispatcher
    expect(ev("Escape").stopPropagation).not.toHaveBeenCalled();
    expect(ev("Enter").stopPropagation).toHaveBeenCalled();
    expect(ev("j").stopPropagation).not.toHaveBeenCalled();
    expect([...DISPATCHER_KEYS].sort()).toEqual(["Backspace", "Delete", "Enter"]);
  });
});

describe("WorkspaceCanvasLayer: when it renders", () => {
  it("renders nothing while the workspace is closed", () => {
    useTablesWorkspaceStore.setState({ enabled: true, open: false, selectedKey: KEY, drafts: { [KEY]: draft() } });
    const { container } = render(<Page />);
    expect(container.querySelector("[data-workspace-canvas]")).toBeNull();
  });

  it("renders nothing on another page than the selected item's", () => {
    openWithDraft(draft({ page: 2 }), 2);
    const { container } = render(<Page page={1} />);
    expect(container.querySelector("[data-workspace-canvas]")).toBeNull();
    cleanup();
    const again = render(<Page page={2} />);
    expect(again.container.querySelector("[data-workspace-canvas='2']")).not.toBeNull();
  });

  it("renders nothing when the workspace flag is off, even if the store says open", () => {
    openWithDraft();
    useTablesWorkspaceStore.setState({ enabled: false });
    const { container } = render(<Page />);
    expect(container.querySelector("[data-workspace-canvas]")).toBeNull();
  });

  it("draws the item's lines coloured by source, its key markers and focusable handles; adds no window key listener", () => {
    const spy = vi.spyOn(window, "addEventListener");
    openWithDraft();
    const { container } = render(<WorkspaceCanvasLayer pageNumber={1} />);
    expect(container.querySelector("[data-structure-line='rows:r1']")).toHaveAttribute("data-src", "textract-cells");
    expect(screen.getAllByRole("slider")).toHaveLength(3);
    expect(container.querySelector("[data-key-marker='r1']")).toHaveAttribute("data-key-state", "missing");
    expect(container.querySelector("[data-key-marker='r2']")).toHaveAttribute("data-key-state", "known");
    expect(spy.mock.calls.filter(([type]) => type === "keydown" || type === "keyup")).toEqual([]);
    expect((container.querySelector("[data-workspace-canvas]") as HTMLElement).style.pointerEvents).toBe("none");
    expect(screen.getByRole("slider", { name: "Row line 2" }).style.pointerEvents).toBe("auto");
  });

  it("draws paragraph boxes and key badges for a notes item", () => {
    openWithDraft(draft({ kind: "notes", result: { ...RESULT, model: NOTES, alternatives: [] } }));
    const { container } = render(<Page />);
    expect(container.querySelectorAll("[data-paragraph]")).toHaveLength(2);
    expect(container.querySelector("[data-paragraph-key='p2']")).toHaveTextContent("1");
    expect(container.querySelector("[data-paragraph-key='p1']")).toBeNull();
    expect(screen.queryAllByRole("slider")).toHaveLength(0);
  });
});

describe("WorkspaceCanvasLayer: gestures become ops", () => {
  it("a drag emits move-line with page-normalised coordinates", () => {
    openWithDraft();
    render(<Page />);
    const handle = screen.getByRole("slider", { name: "Row line 2" });
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: cx(0.3), clientY: cy(0.3) });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: cx(0.3), clientY: cy(0.4) });
    expect(handle).toHaveAttribute("data-dragging");
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: cx(0.3), clientY: cy(0.42) });
    expect(opsOf()).toEqual([{ op: "move-line", axis: "rows", after: "r1", at: 0.42 }]);
    // the line is re-drawn where it was dropped (local preview while applyOps is the stub)
    expect(screen.getByRole("slider", { name: "Row line 2" })).toHaveAttribute("aria-valuenow", "0.42");

    const col = screen.getByRole("slider", { name: "Column line 1" });
    fireEvent.pointerDown(col, { button: 0, pointerId: 2, clientX: cx(0.3), clientY: cy(0.2) });
    fireEvent.pointerUp(col, { pointerId: 2, clientX: cx(0.35), clientY: cy(0.2) });
    expect(opsOf()[1]).toEqual({ op: "move-line", axis: "cols", after: "c0", at: 0.35 });
  });

  it("a click without movement emits nothing; double-click on a rail adds a line", () => {
    openWithDraft();
    const { container } = render(<Page />);
    const handle = screen.getByRole("slider", { name: "Row line 1" });
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: cx(0.3), clientY: cy(0.2) });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: cx(0.3), clientY: cy(0.2) });
    expect(opsOf()).toEqual([]);
    fireEvent.doubleClick(container.querySelector("[data-line-rail='rows']")!, { clientX: cx(0.09), clientY: cy(0.45) });
    fireEvent.doubleClick(container.querySelector("[data-line-rail='cols']")!, { clientX: cx(0.5), clientY: cy(0.09) });
    expect(opsOf()).toEqual([{ op: "add-line", axis: "rows", at: 0.45 }, { op: "add-line", axis: "cols", at: 0.5 }]);
  });

  it("a red key marker takes a typed key as set-row-key", () => {
    openWithDraft();
    const { container } = render(<Page />);
    fireEvent.click(container.querySelector("[data-key-marker='r1']")!);
    const input = screen.getByRole("textbox", { name: "Key for row r1" });
    fireEvent.change(input, { target: { value: " K4 " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(opsOf()).toEqual([{ op: "set-row-key", row: "r1", text: "K4" }]);
    expect(container.querySelector("[data-key-marker='r1']")).toHaveAttribute("data-key-state", "known");
  });

  it('"+ Region" → a draw: item on this page, opened and focused, with an unparsed draft (WP-3.M parses it)', () => {
    useTablesWorkspaceStore.setState({ enabled: true });
    render(<Page />);
    act(() => startDraw());
    const capture = document.querySelector("[data-workspace-capture='draw-region']") as HTMLElement;
    expect(capture).not.toBeNull();
    expect(document.activeElement).toBe(capture);
    fireEvent.pointerDown(capture, { button: 0, pointerId: 1, clientX: cx(0.2), clientY: cy(0.6) });
    fireEvent.pointerMove(capture, { pointerId: 1, clientX: cx(0.4), clientY: cy(0.7) });
    fireEvent.pointerUp(capture, { pointerId: 1, clientX: cx(0.5), clientY: cy(0.8) });
    const bbox = [0.2, 0.6, 0.5, 0.8];
    const key = drawItemKey(1, bbox as never);
    const ws = useTablesWorkspaceStore.getState();
    expect(ws.correction).toBeNull();
    expect(ws.selectedKey).toBe(key);
    expect(ws.drafts[key]).toMatchObject({ page: 1, bbox, ops: [], result: null });
    expect(useProposalFocusStore.getState().focus).toMatchObject({ proposalId: key, pageNumber: 1, bbox });
    expect(useWorkspaceCanvasStore.getState()).not.toHaveProperty("parseRequest"); // no side channel (VERIFY F1)
    expect(document.querySelector("[data-workspace-capture]")).toBeNull();

    // VERIFY F6: the same box again re-opens that draft and keeps its ops
    const op: CorrectionOp = { op: "set-title", text: "Synthetic" };
    act(() => useTablesWorkspaceStore.getState().setDraftOps(key, [op]));
    act(() => startDraw());
    const again = document.querySelector("[data-workspace-capture='draw-region']") as HTMLElement;
    fireEvent.pointerDown(again, { button: 0, pointerId: 2, clientX: cx(0.2), clientY: cy(0.6) });
    fireEvent.pointerUp(again, { pointerId: 2, clientX: cx(0.5), clientY: cy(0.8) });
    expect(useTablesWorkspaceStore.getState().drafts[key].ops).toEqual([op]);
    expect(useTablesWorkspaceStore.getState().selectedKey).toBe(key);
  });

  it("a tiny drag (a click) draws nothing", () => {
    useTablesWorkspaceStore.setState({ enabled: true });
    render(<Page />);
    act(() => startDraw());
    const capture = document.querySelector("[data-workspace-capture='draw-region']") as HTMLElement;
    fireEvent.pointerDown(capture, { button: 0, pointerId: 1, clientX: cx(0.2), clientY: cy(0.6) });
    fireEvent.pointerUp(capture, { pointerId: 1, clientX: cx(0.201), clientY: cy(0.601) });
    expect(useTablesWorkspaceStore.getState().drafts).toEqual({});
    expect(useTablesWorkspaceStore.getState().correction).toBe("draw-region");
  });

  it('"+ Add continuation box" (WP-3.M\'s correction) → the box joins the selected item\'s parts and clears its result', () => {
    openWithDraft();
    render(<Page />);
    act(() => armContinuation());
    expect(screen.queryAllByRole("slider")).toHaveLength(0); // handles step aside while a box draw is armed
    const capture = document.querySelector("[data-workspace-capture='draw-continuation']") as HTMLElement;
    expect(document.activeElement).toBe(capture);
    fireEvent.pointerDown(capture, { button: 0, pointerId: 1, clientX: cx(0.1), clientY: cy(0.6) });
    fireEvent.pointerUp(capture, { pointerId: 1, clientX: cx(0.6), clientY: cy(0.8) });
    const d = useTablesWorkspaceStore.getState().drafts[KEY];
    expect(d.parts).toEqual([[0.1, 0.6, 0.6, 0.8]]);
    expect(d.result).toBeNull(); // useEngineParse (WP-3.M) re-parses a draft with no result, parts included
    expect(useTablesWorkspaceStore.getState().correction).toBeNull();

    // a box already in the table is refused (de-duplicated) and the draw stays armed
    act(() => {
      useTablesWorkspaceStore.getState().putDraft(KEY, { ...d, result: RESULT });
      armContinuation();
    });
    const again = document.querySelector("[data-workspace-capture='draw-continuation']") as HTMLElement;
    fireEvent.pointerDown(again, { button: 0, pointerId: 2, clientX: cx(0.1), clientY: cy(0.6) });
    fireEvent.pointerUp(again, { pointerId: 2, clientX: cx(0.6), clientY: cy(0.8) });
    expect(useTablesWorkspaceStore.getState().drafts[KEY].parts).toEqual([[0.1, 0.6, 0.6, 0.8]]);
    expect(useTablesWorkspaceStore.getState().drafts[KEY].result).toBe(RESULT);
    expect(useTablesWorkspaceStore.getState().correction).toBe(DRAW_CONTINUATION);
  });

  it("an item-bound draw ends on close and on a selection change, and never comes back armed (VERIFY F4)", () => {
    openWithDraft();
    render(<Page />);
    act(() => useWorkspaceCanvasStore.getState().arm("draw-rows", KEY));
    expect(document.querySelector("[data-workspace-capture='draw-rows']")).not.toBeNull();
    act(() => useTablesWorkspaceStore.getState().closeWorkspace());
    expect(useWorkspaceCanvasStore.getState().armed).toBeNull();
    act(() => openWithDraft());
    expect(document.querySelector("[data-workspace-capture]")).toBeNull();

    act(() => armContinuation());
    expect(document.querySelector("[data-workspace-capture='draw-continuation']")).not.toBeNull();
    act(() => useTablesWorkspaceStore.getState().select("p-other"));
    expect(useTablesWorkspaceStore.getState().correction).toBeNull();
    act(() => useTablesWorkspaceStore.getState().select(KEY));
    expect(document.querySelector("[data-workspace-capture]")).toBeNull();

    act(() => useWorkspaceCanvasStore.getState().arm("draw-cols", KEY));
    act(() => useTablesWorkspaceStore.getState().discardDraft(KEY));
    expect(useWorkspaceCanvasStore.getState().armed).toBeNull();
  });

  it("the canvas sits above the parsed-table cell overlay (z-index 15) so its handles take the clicks (VERIFY F5)", () => {
    openWithDraft();
    const { container } = render(<Page />);
    expect(Number((container.querySelector("[data-workspace-canvas]") as HTMLElement).style.zIndex)).toBeGreaterThan(15);
  });

  it('"Draw cells" boxes become user-boxes ops and the draw stays armed', () => {
    openWithDraft();
    render(<Page />);
    act(() => useWorkspaceCanvasStore.getState().arm("draw-cols", KEY));
    const capture = document.querySelector("[data-workspace-capture='draw-cols']") as HTMLElement;
    fireEvent.pointerDown(capture, { button: 0, pointerId: 1, clientX: cx(0.1), clientY: cy(0.1) });
    fireEvent.pointerUp(capture, { pointerId: 1, clientX: cx(0.3), clientY: cy(0.5) });
    expect(opsOf()).toEqual([{ op: "user-boxes", rows: [], cols: [[0.1, 0.1, 0.3, 0.5]] }]);
    expect(useWorkspaceCanvasStore.getState().armed).toEqual({ mode: "draw-cols", itemKey: KEY });
  });

  it("the capture refuses while a viewer tool is active", () => {
    useTablesWorkspaceStore.setState({ enabled: true });
    act(() => useToolStore.getState().setBucketFillActive(true));
    expect(useToolStore.getState().activeTool).not.toBeNull();
    render(<Page />);
    act(() => startDraw());
    expect(document.querySelector("[data-workspace-capture='refused']")).not.toBeNull();
    expect(document.querySelector("[data-workspace-capture='draw-region']")).toBeNull();
    act(() => useToolStore.getState().setBucketFillActive(false));
    expect(document.querySelector("[data-workspace-capture='draw-region']")).not.toBeNull();
  });
});

describe("keyboard isolation against the real overlay dispatcher (§1.6 rule 14, C2-M11)", () => {
  it("Del on a focused line handle with an annotation selected removes the line and leaves the annotation intact (no DELETE request)", () => {
    const options = dispatcherOptions({ selectedId: 42 });
    openWithDraft();
    render(<Providers><Dispatcher options={options} /><Page /></Providers>);
    const handle = screen.getByRole("slider", { name: "Row line 1" });
    handle.focus();
    expect(document.activeElement).toBe(handle);
    fireEvent.keyDown(handle, { key: "Delete" });
    expect(opsOf()).toEqual([{ op: "remove-line", axis: "rows", after: "r0" }]);
    fireEvent.keyDown(screen.getByRole("slider", { name: "Row line 1" }), { key: "Backspace" });
    expect(opsOf()[1]).toEqual({ op: "remove-line", axis: "rows", after: "r1" });
    expect(options.removeAnnotation).not.toHaveBeenCalled();
    expect(options.setSelectedId).not.toHaveBeenCalled();
    expect(fetchCalls.filter((c) => c.method === "DELETE")).toEqual([]);
    // control: the same key outside the workspace still deletes the selected annotation
    fireEvent.keyDown(document.body, { key: "Delete" });
    expect(options.removeAnnotation).toHaveBeenCalledWith(42);
  });

  it("Enter on the canvas (handle, red key marker) never finishes an annotation drag", () => {
    const options = dispatcherOptions({ readActiveAnnotationDrag: vi.fn(() => ({ operation: { kind: "bbox" } }) as never) });
    openWithDraft();
    const { container } = render(<Providers><Dispatcher options={options} /><Page /></Providers>);
    fireEvent.keyDown(screen.getByRole("slider", { name: "Row line 1" }), { key: "Enter" });
    fireEvent.keyDown(container.querySelector("[data-key-marker='r1']")!, { key: "Enter" });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Key for row r1" }), { key: "Enter" });
    expect(options.finishAnnotationDrag).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(options.finishAnnotationDrag).toHaveBeenCalledTimes(1);
  });

  it("⏎ in the panel does not finish an annotation drag (panel, inbox row, any button)", async () => {
    const options = dispatcherOptions({ readActiveAnnotationDrag: vi.fn(() => ({ operation: { kind: "vertex" } }) as never) });
    render(<Providers><Dispatcher options={options} /><TablesWorkspaceHost /></Providers>);
    await waitFor(() => expect(useTablesWorkspaceStore.getState().enabled).toBe(true));
    act(() => openFromToolbar("tables"));
    const panel = await screen.findByRole("complementary", { name: "Tables and notes workspace" });
    await waitFor(() => expect(within(panel).getByText("Synthetic keynotes")).toBeInTheDocument());
    fireEvent.keyDown(panel, { key: "Enter" });
    fireEvent.keyDown(within(panel).getByText("Synthetic keynotes"), { key: "Enter" });
    for (const button of within(panel).getAllByRole("button")) fireEvent.keyDown(button, { key: "Enter" });
    expect(options.finishAnnotationDrag).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(options.finishAnnotationDrag).toHaveBeenCalledTimes(1);
  });

  it("WorkspaceKeyScope keeps a button's Enter click but stops Enter/Del, and lets Esc through", () => {
    const options = dispatcherOptions({ selectedId: 7, readActiveAnnotationDrag: vi.fn(() => ({ operation: { kind: "bbox" } }) as never) });
    const click = vi.fn();
    const onWindowEsc = vi.fn();
    window.addEventListener("keydown", onWindowEsc);
    render(<Providers><Dispatcher options={options} /><WorkspaceKeyScope><button type="button" onClick={click}>Synthetic</button></WorkspaceKeyScope></Providers>);
    const button = screen.getByRole("button", { name: "Synthetic" });
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.keyDown(button, { key: "Delete" });
    expect(options.finishAnnotationDrag).not.toHaveBeenCalled();
    expect(options.removeAnnotation).not.toHaveBeenCalled();
    fireEvent.keyDown(button, { key: "Escape" });
    expect(onWindowEsc.mock.calls.map(([e]) => (e as KeyboardEvent).key)).toEqual(["Escape"]);
    window.removeEventListener("keydown", onWindowEsc);
  });

  it("Esc still clears the focus box from a focused handle and from an armed capture", () => {
    openWithDraft();
    useProposalFocusStore.getState().focusProposal({ publicId: PUB, proposalId: KEY, pageNumber: 1, bbox: [0.1, 0.1, 0.6, 0.5] });
    render(<Page />);
    expect(document.querySelector(`[data-proposal-focus='${KEY}']`)).not.toBeNull();
    fireEvent.keyDown(screen.getByRole("slider", { name: "Row line 1" }), { key: "Escape" });
    expect(useProposalFocusStore.getState().focus).toBeNull();

    act(() => {
      useProposalFocusStore.getState().focusProposal({ publicId: PUB, proposalId: KEY, pageNumber: 1, bbox: [0.1, 0.1, 0.6, 0.5] });
      armContinuation();
    });
    fireEvent.keyDown(document.querySelector("[data-workspace-capture='draw-continuation']")!, { key: "Escape" });
    expect(useTablesWorkspaceStore.getState().correction).toBeNull();
    expect(useProposalFocusStore.getState().focus).toBeNull();
  });
});
