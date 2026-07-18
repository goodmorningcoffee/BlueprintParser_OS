// @vitest-environment jsdom
//
// [refactor jul18 P3 standalone] Real-overlay freeze for the shared markup dialog/save tail.
// Pointer pencil-edit is intentionally exercised through AnnotationOverlay rather than a callback
// unit: this witnesses the controlled dialog state, live annotations cache, exact PUT body, and
// lifecycle-bound async terminal together. Generic markup create remains on persistCreate.

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { openProject, type OpenProjectHandle } from "@/lib/project-lifecycle";
import { queryKeys } from "@/queries/queryKeys";
import { useToolStore } from "@/stores/toolStore";
import { useUiStore } from "@/stores/uiStore";
import { resetProjectData } from "@/stores/viewerCommands";
import { readSeededAnnotations, seedAnnotations } from "@/test/seed-annotations";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";
import type { ClientAnnotation } from "@/types";

vi.mock("../DrawingPreviewLayer", () => ({ default: () => null }));

type DialogProps = {
  isEditing: boolean;
  name: string;
  note: string;
  csiCode: string;
  onNameChange: (value: string) => void;
  onNoteChange: (value: string) => void;
  onCsiChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
};

let dialogProps: DialogProps | null = null;
vi.mock("../MarkupDialog", () => ({
  default: (props: DialogProps) => {
    dialogProps = props;
    return <div data-testid="markup-save-dialog" />;
  },
}));

import AnnotationOverlay from "../AnnotationOverlay";

const PUBLIC_ID = "markup-save-project";
const PAGE = 1;
const ANNOTATION_ID = 41;

function annotation(overrides: Partial<ClientAnnotation> = {}): ClientAnnotation {
  return {
    id: ANNOTATION_ID,
    pageNumber: PAGE,
    name: "Door markup",
    bbox: [0.2, 0.2, 0.6, 0.8],
    note: "Original note",
    source: "user",
    data: {
      csiCodes: ["08", "08 11 16", "09 91 00", "08 71 00"],
      keywords: ["door", "opening"],
      sentinel: "preserve",
    },
    ...overrides,
  };
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function noopContext(): CanvasRenderingContext2D {
  const target = { measureText: () => ({ width: 0 }) };
  return new Proxy(target, {
    get(object, property) {
      if (property in object) return object[property as keyof typeof object];
      return () => {};
    },
    set(object, property, value) {
      Reflect.set(object, property, value);
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

function canvasRect(): DOMRect {
  return {
    x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 100, width: 100, height: 100,
    toJSON: () => ({}),
  } as DOMRect;
}

let queryClient: QueryClient;
let lifecycleHandles: OpenProjectHandle[];
const fetchMock = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

async function openPencilEditor(row: ClientAnnotation): Promise<HTMLCanvasElement> {
  seedAnnotations(queryClient, [row]);
  useUiStore.setState({ focusAnnotationId: row.id });
  const { container } = render(
    <AnnotationOverlay width={100} height={100} cssScale={1} />,
    { wrapper },
  );
  const canvas = await waitFor(() => {
    const candidate = container.querySelector("canvas");
    if (!(candidate instanceof HTMLCanvasElement)) throw new Error("Expected overlay canvas");
    return candidate;
  });
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(canvasRect());
  await waitFor(() => expect(useUiStore.getState().focusAnnotationId).toBeNull());

  // bbox starts at (20,20); zero-width text puts the pencil zone at x=[28,44), label y=[2,20].
  fireEvent.mouseDown(canvas, { clientX: 30, clientY: 10, button: 0, detail: 1 });
  await waitFor(() => expect(screen.getByTestId("markup-save-dialog")).toBeInTheDocument());
  return canvas;
}

function changeDialog(values: { name?: string; note?: string; csi?: string }): void {
  act(() => {
    if (values.name !== undefined) dialogProps!.onNameChange(values.name);
    if (values.note !== undefined) dialogProps!.onNoteChange(values.note);
    if (values.csi !== undefined) dialogProps!.onCsiChange(values.csi);
  });
}

function saveDialog(): void {
  act(() => dialogProps!.onSave());
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  lifecycleHandles = [];
  dialogProps = null;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(noopContext());

  resetProjectData();
  setViewerStoreStateForTest({
    projectId: 901,
    publicId: PUBLIC_ID,
    isDemo: false,
    pageNumber: PAGE,
    numPages: 1,
    pageNames: { [PAGE]: "A-101" },
    mode: "pointer",
    activeTool: null,
    focusAnnotationId: null,
    selectedAnnotationIds: new Set<number>(),
    bucketFillError: null,
    _drawing: false,
    _drawStart: { x: 0, y: 0 },
    _drawEnd: { x: 0, y: 0 },
  });
});

afterEach(() => {
  cleanup();
  for (const handle of lifecycleHandles) handle.dispose();
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AnnotationOverlay markup edit persistence", () => {
  it("preserves the CSI tail in the optimistic row/PUT and CAS-adopts returned auto codes", async () => {
    const request = deferred<Response>();
    fetchMock.mockReturnValue(request.promise);
    const origin = annotation();
    await openPencilEditor(origin);

    expect(dialogProps).toMatchObject({
      isEditing: true,
      name: "Door markup",
      note: "Original note",
      csiCode: "08",
    });
    changeDialog({
      name: "  Revised door  ",
      note: "  Revised note  ",
      csi: " 09 91 00 ",
    });
    saveDialog();

    const optimistic = readSeededAnnotations(queryClient)[0];
    expect(optimistic).toMatchObject({ name: "Revised door", note: "Revised note" });
    expect(optimistic.data).toEqual({
      csiCodes: ["09 91 00", "08 11 16", "08 71 00"],
      keywords: ["door", "opening"],
      sentinel: "preserve",
    });
    expect(screen.queryByTestId("markup-save-dialog")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/annotations/${ANNOTATION_ID}`);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({
      name: "Revised door",
      note: "Revised note",
      data: optimistic.data,
    });

    request.resolve(jsonResponse({
      success: true,
      autoCsiCodes: ["08 11 16", 42, "10 10 10", null, "10 10 10"],
    }));
    await waitFor(() => expect(readSeededAnnotations(queryClient)[0]?.data?.csiCodes).toEqual([
      "09 91 00", "08 11 16", "08 71 00", "10 10 10",
    ]));
  });

  it("blank CSI retains existing data and preserves the sparse PUT body", async () => {
    const request = deferred<Response>();
    fetchMock.mockReturnValue(request.promise);
    const origin = annotation();
    await openPencilEditor(origin);
    changeDialog({ name: "Renamed only", csi: "   " });
    saveDialog();

    const optimistic = readSeededAnnotations(queryClient)[0];
    expect(optimistic.data).toBe(origin.data);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      name: "Renamed only",
      note: "Original note",
    });
    request.resolve(jsonResponse({ success: true, autoCsiCodes: [] }));
    await act(async () => { await request.promise; });
  });

  it("rejected PUT restores the exact origin row without dropping an interleaved row", async () => {
    const request = deferred<Response>();
    fetchMock.mockReturnValue(request.promise);
    const origin = annotation();
    await openPencilEditor(origin);
    changeDialog({ name: "Rejected rename", csi: "09 91 00" });
    saveDialog();
    expect(readSeededAnnotations(queryClient)[0]).not.toBe(origin);

    const interleaved = annotation({ id: 42, name: "Interleaved neighbor" });
    queryClient.setQueryData<ClientAnnotation[]>(queryKeys.annotations.all(PUBLIC_ID), (old = []) => [
      ...old,
      interleaved,
    ]);
    let rowsAtErrorPublication: readonly ClientAnnotation[] | null = null;
    const unsubscribe = useToolStore.subscribe((state, previous) => {
      if (state.bucketFillError && state.bucketFillError !== previous.bucketFillError) {
        rowsAtErrorPublication = readSeededAnnotations(queryClient);
      }
    });
    request.reject(new Error("offline"));

    await waitFor(() => expect(readSeededAnnotations(queryClient)[0]).toEqual(origin));
    unsubscribe();
    expect(readSeededAnnotations(queryClient)[0]).not.toBe(origin);
    expect(readSeededAnnotations(queryClient)[1]).toBe(interleaved);
    expect(rowsAtErrorPublication?.[0]).toEqual(origin);
    expect(useToolStore.getState().bucketFillError).toBe(
      "Failed to save markup: Network error while saving: offline",
    );
  });

  it.each(["success", "failure"] as const)(
    "late %s terminal cannot overwrite a newer exact row",
    async (terminal) => {
      const request = deferred<Response>();
      fetchMock.mockReturnValue(request.promise);
      const origin = annotation();
      await openPencilEditor(origin);
      changeDialog({ name: "Older optimistic edit", csi: "09 91 00" });
      saveDialog();
      const optimistic = readSeededAnnotations(queryClient)[0]!;
      const successor = {
        ...optimistic,
        name: "Newer exact successor",
        note: "must survive either terminal",
      };
      queryClient.setQueryData(queryKeys.annotations.all(PUBLIC_ID), [successor]);
      const canonicalSuccessor = readSeededAnnotations(queryClient)[0]!;
      act(() => useToolStore.setState({ bucketFillError: "newer edit error sentinel" }));

      if (terminal === "success") {
        request.resolve(jsonResponse({ success: true, autoCsiCodes: ["99 99 99"] }));
      } else {
        request.reject(new Error("older failure"));
      }
      await act(async () => {
        try { await request.promise; } catch { /* expected */ }
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(readSeededAnnotations(queryClient)[0]).toBe(canonicalSuccessor);
      expect(readSeededAnnotations(queryClient)[0]?.data?.csiCodes).not.toContain("99 99 99");
      expect(useToolStore.getState().bucketFillError).toBe("newer edit error sentinel");
    },
  );

  it("a synchronous successor publication blocks the stale PUT before the wire", async () => {
    const origin = annotation();
    await openPencilEditor(origin);
    changeDialog({ name: "Reentrant older edit", csi: "09 91 00" });

    let successor: ClientAnnotation | null = null;
    let installed = false;
    const targetQuery = queryClient.getQueryCache().find({
      queryKey: queryKeys.annotations.all(PUBLIC_ID),
      exact: true,
    });
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (installed || event.type !== "updated" || event.query !== targetQuery) return;
      const row = readSeededAnnotations(queryClient)[0];
      if (row?.name !== "Reentrant older edit") return;
      installed = true;
      queryClient.setQueryData(queryKeys.annotations.all(PUBLIC_ID), [{
        ...row,
        name: "Synchronous successor",
        note: "published during setQueryData notification",
      }]);
      successor = readSeededAnnotations(queryClient)[0]!;
    });

    saveDialog();
    unsubscribe();

    expect(installed).toBe(true);
    expect(readSeededAnnotations(queryClient)[0]).toBe(successor);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("markup-save-dialog")).not.toBeInTheDocument();
  });

  it.each(["success", "failure"] as const)(
    "retired same-id lifecycle adopts neither an old %s terminal nor its error",
    async (terminal) => {
    const request = deferred<Response>();
    fetchMock.mockImplementation((url: unknown) =>
      String(url).startsWith("/api/annotations/") ? request.promise : new Promise<Response>(() => {}));
    const origin = annotation();
    await openPencilEditor(origin);
    changeDialog({ name: "Lifecycle A edit", csi: "09 91 00" });
    saveDialog();

    act(() => {
      const successorHandle = openProject(queryClient, PUBLIC_ID, { demo: false });
      lifecycleHandles.push(successorHandle);
      setViewerStoreStateForTest({
        projectId: 902,
        publicId: PUBLIC_ID,
        isDemo: false,
        pageNumber: PAGE,
        numPages: 1,
        bucketFillError: "successor error sentinel",
      });
      const successor = annotation({ name: "Same-id lifecycle B", note: "must survive" });
      seedAnnotations(queryClient, [successor]);
    });
    const successor = readSeededAnnotations(queryClient)[0]!;

    if (terminal === "success") {
      request.resolve(jsonResponse({ success: true, autoCsiCodes: ["99 99 99"] }));
    } else {
      request.reject(new Error("retired A failure"));
    }
    await act(async () => {
      try { await request.promise; } catch { /* expected */ }
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(readSeededAnnotations(queryClient)[0]).toBe(successor);
    expect(useToolStore.getState().bucketFillError).toBe("successor error sentinel");
    },
  );

  it("page transition retires an open edit dialog before it can target the next page", async () => {
    const origin = annotation();
    await openPencilEditor(origin);
    expect(dialogProps?.isEditing).toBe(true);

    act(() => setViewerStoreStateForTest({ pageNumber: 2 }));

    await waitFor(() => expect(screen.queryByTestId("markup-save-dialog")).not.toBeInTheDocument());
    expect(readSeededAnnotations(queryClient)[0]).toBe(origin);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("demo edit remains local-only and never enters rollback", async () => {
    setViewerStoreStateForTest({ isDemo: true });
    const origin = annotation();
    await openPencilEditor(origin);
    changeDialog({ name: "Demo rename", csi: "09 91 00" });
    saveDialog();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(readSeededAnnotations(queryClient)[0]).toMatchObject({ name: "Demo rename" });
    expect(readSeededAnnotations(queryClient)[0]?.data?.csiCodes).toEqual([
      "09 91 00", "08 11 16", "08 71 00",
    ]);
  });
});
