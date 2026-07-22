// @vitest-environment jsdom

import { type ReactNode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useUiStore } from "@/stores/uiStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import { resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";

const queryCommands = vi.hoisted(() => ({
  navigateYoloTag: vi.fn(),
}));

const lifecycle = vi.hoisted(() => ({
  openProject: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "route-project" }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { id: "viewer" } }, status: "authenticated" }),
}));

vi.mock("@/hooks/useSearch", () => ({
  useSearch: vi.fn(),
}));

vi.mock("@/lib/project-lifecycle", () => ({
  openProject: lifecycle.openProject,
}));

vi.mock("@/components/viewer/PDFViewer", () => ({
  default: () => null,
}));

vi.mock("@/queries/useYoloTags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/queries/useYoloTags")>();
  return { ...actual, navigateYoloTag: queryCommands.navigateYoloTag };
});

import AuthenticatedProjectPage from "@/app/(dashboard)/project/[id]/page";
import DemoProjectPage from "@/app/demo/project/[id]/page";
import { useOverlayKeyboardDispatcher } from "../useOverlayKeyboardDispatcher";

type DispatcherOptions = Parameters<typeof useOverlayKeyboardDispatcher>[0];
type PageKind = "authenticated" | "demo";
type RegistrationOrder = "page-first" | "dispatcher-first";

const ROUTE_ORDER_CASES = [
  { pageKind: "authenticated", order: "page-first" },
  { pageKind: "authenticated", order: "dispatcher-first" },
  { pageKind: "demo", order: "page-first" },
  { pageKind: "demo", order: "dispatcher-first" },
] as const satisfies readonly {
  pageKind: PageKind;
  order: RegistrationOrder;
}[];

const ARROW_CASES = ROUTE_ORDER_CASES.flatMap((testCase) =>
  (["ArrowLeft", "ArrowRight"] as const).map((key) => ({ ...testCase, key })),
);

const PAGE_KEY_CASES = ROUTE_ORDER_CASES.flatMap((testCase) =>
  (["PageUp", "PageDown"] as const).map((key) => ({ ...testCase, key })),
);

let queryClient: QueryClient;

function Providers({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function makeDispatcherOptions(pageKind: PageKind): DispatcherOptions {
  return {
    canAdoptProjectLifecycle: vi.fn(() => true),
    cancelDeferredDrawing: vi.fn(),
    acceptSplit: vi.fn(),
    prepareBucketFillPolygon: vi.fn(),
    savePolygon: vi.fn(),
    saveLinearPolyline: vi.fn(),
    setMousePos: vi.fn(),
    selectedId: null,
    isDemo: pageKind === "demo",
    removeAnnotation: vi.fn(),
    setSelectedId: vi.fn(),
    readActiveAnnotationDrag: vi.fn(() => null),
    finishAnnotationDrag: vi.fn(),
    publishTransientError: vi.fn(),
  };
}

function DispatcherHarness({ pageKind }: { pageKind: PageKind }) {
  useOverlayKeyboardDispatcher(makeDispatcherOptions(pageKind));
  return null;
}

function mountPage(pageKind: PageKind): void {
  const Page = pageKind === "authenticated" ? AuthenticatedProjectPage : DemoProjectPage;
  render(
    <Providers>
      <Page />
    </Providers>,
  );
}

function mountDispatcher(pageKind: PageKind): void {
  render(
    <Providers>
      <DispatcherHarness pageKind={pageKind} />
    </Providers>,
  );
}

function mountInRegistrationOrder(
  pageKind: PageKind,
  order: RegistrationOrder,
): void {
  const addEventListener = vi.spyOn(window, "addEventListener");

  if (order === "page-first") mountPage(pageKind);
  else mountDispatcher(pageKind);

  expect(
    addEventListener.mock.calls.filter(([eventType]) => eventType === "keydown"),
  ).toHaveLength(1);

  if (order === "page-first") mountDispatcher(pageKind);
  else mountPage(pageKind);

  expect(
    addEventListener.mock.calls.filter(([eventType]) => eventType === "keydown"),
  ).toHaveLength(2);
}

function setBrowseState(tagBrowseId: string | null, tagBrowseIndex: number): void {
  act(() => {
    useUiStore.getState().setYoloBrowseState({ tagBrowseId, tagBrowseIndex });
  });
}

function dispatchKey(
  key: string,
  init: Omit<KeyboardEventInit, "key"> = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

beforeEach(() => {
  queryClient = new QueryClient();
  resetProjectData();
  setViewerStoreStateForTest({
    publicId: "live-project",
    pageNumber: 3,
    numPages: 8,
    scale: 1,
    activeTool: null,
    tagBrowseId: null,
    tagBrowseIndex: 0,
  });
  queryCommands.navigateYoloTag.mockReset();
  lifecycle.openProject.mockReset();
  lifecycle.openProject.mockImplementation(() => ({
    dispose: vi.fn(),
    result: new Promise(() => undefined),
  }));
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
});

describe("project-page and overlay modal browse keyboard coordination", () => {
  it.each(ARROW_CASES)(
    "$pageKind $order routes a live modal $key exactly once without changing pages",
    ({ pageKind, order, key }) => {
      mountInRegistrationOrder(pageKind, order);
      setBrowseState("browse-tag", 4);

      const event = dispatchKey(key);

      expect(event.defaultPrevented).toBe(true);
      expect(queryCommands.navigateYoloTag).toHaveBeenCalledTimes(1);
      expect(queryCommands.navigateYoloTag).toHaveBeenCalledWith(
        queryClient,
        "live-project",
        "browse-tag",
        key === "ArrowLeft" ? 3 : 5,
      );
      expect(useViewerCoreStore.getState().pageNumber).toBe(3);
    },
  );

  it.each(ROUTE_ORDER_CASES)(
    "$pageKind $order permits ordinary Arrow navigation after live browse state clears",
    ({ pageKind, order }) => {
      setBrowseState("browse-at-mount", 7);
      mountInRegistrationOrder(pageKind, order);
      setBrowseState(null, 0);

      const event = dispatchKey("ArrowRight");

      expect(event.defaultPrevented).toBe(true);
      expect(queryCommands.navigateYoloTag).not.toHaveBeenCalled();
      expect(useViewerCoreStore.getState().pageNumber).toBe(4);
    },
  );

  it.each(ROUTE_ORDER_CASES)(
    "$pageKind $order treats an empty-string browse id as inactive for Arrow keys",
    ({ pageKind, order }) => {
      // [refactor jul22 P3.4 K3] Green-hole closure: both page guards and the dispatcher
      // admit browse on TRUTHY tagBrowseId; "" must page-navigate, never modal-navigate.
      mountInRegistrationOrder(pageKind, order);
      setBrowseState("", 4);

      const event = dispatchKey("ArrowRight");

      expect(event.defaultPrevented).toBe(true);
      expect(queryCommands.navigateYoloTag).not.toHaveBeenCalled();
      expect(useViewerCoreStore.getState().pageNumber).toBe(4);
    },
  );

  it.each(PAGE_KEY_CASES)(
    "$pageKind $order keeps $key navigation active during modal tag browse",
    ({ pageKind, order, key }) => {
      mountInRegistrationOrder(pageKind, order);
      setBrowseState("browse-tag", 4);

      const event = dispatchKey(key);

      expect(event.defaultPrevented).toBe(true);
      expect(queryCommands.navigateYoloTag).not.toHaveBeenCalled();
      expect(useViewerCoreStore.getState().pageNumber).toBe(key === "PageUp" ? 2 : 4);
    },
  );

  it.each(["page-first", "dispatcher-first"] as const)(
    "authenticated $order keeps Ctrl+= zoom active during modal tag browse",
    (order) => {
      mountInRegistrationOrder("authenticated", order);
      setBrowseState("browse-tag", 4);

      const event = dispatchKey("=", { ctrlKey: true });

      expect(event.defaultPrevented).toBe(true);
      expect(queryCommands.navigateYoloTag).not.toHaveBeenCalled();
      expect(useViewerCoreStore.getState().pageNumber).toBe(3);
      expect(useViewerCoreStore.getState().scale).toBeCloseTo(1 / 0.95);
    },
  );
});
