// [refactor jul13 P2.5 freeze] Search request ownership across project lifecycle generations.
//
// A project can be reopened with the same publicId, including an authenticated -> demo transition.
// URL identity alone therefore cannot authorize an async tail. The effect generation that issued
// the request owns every publication (success, non-ok, error, and finally), and cleanup must abort
// immediately even when the transport ignores AbortSignal.

import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSearch } from "@/hooks/useSearch";
import {
  openProject,
  type OpenProjectHandle,
  type ProjectResponse,
} from "@/lib/project-lifecycle";
import { useSessionStore } from "@/stores/sessionStore";
import { useUiStore } from "@/stores/uiStore";
import type { SearchWordMatch } from "@/types";

function SearchController() {
  useSearch();
  return null;
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

function response(ok: boolean, body: unknown = {}): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function signalForCall(index: number): AbortSignal {
  const init = fetchMock.mock.calls[index]?.[1] as RequestInit | undefined;
  if (!init?.signal) throw new Error(`search fetch ${index} had no AbortSignal`);
  return init.signal;
}

async function flushPromises(turns = 12): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
  });
}

const fetchMock = vi.fn();
let queryClient: QueryClient;
let lifecycleHandle: OpenProjectHandle;
const LIVE_MATCH: SearchWordMatch = {
  text: "live-generation",
  bbox: [0.1, 0.2, 0.3, 0.4],
};
const STALE_MATCH: SearchWordMatch = {
  text: "stale-auth-generation",
  bbox: [0.5, 0.6, 0.2, 0.1],
};

function projectResponse(id: string): ProjectResponse {
  return {
    id,
    dbId: 1,
    name: id,
    dataUrl: `projects/${id}`,
    pdfUrl: `https://example.test/${id}.pdf`,
    numPages: 1,
    status: "completed",
    summaries: null,
    projectIntelligence: null,
    pages: [{ pageNumber: 1, name: "A-101", drawingNumber: null }],
  };
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

async function activateLifecycle(demo: boolean): Promise<OpenProjectHandle> {
  const id = "same-project";
  const bootstrapFetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `/api/${demo ? "demo/" : ""}projects/${id}`) {
      return jsonResponse(projectResponse(id));
    }
    if (url === `/api/${demo ? "demo/" : ""}projects/${id}/pages?from=1&to=15`) {
      return jsonResponse({ from: 1, to: 1, pages: [], annotations: [] });
    }
    if (!demo && url === `/api/annotation-groups?projectId=${id}`) {
      return jsonResponse({ groups: [], memberships: [] });
    }
    throw new Error(`unexpected lifecycle request: ${url}`);
  });
  vi.stubGlobal("fetch", bootstrapFetch);
  const handle = openProject(queryClient, id, {
    demo,
    searchQuery: "doors",
  });
  expect((await handle.result).status).toBe("opened");
  vi.stubGlobal("fetch", fetchMock);
  return handle;
}

beforeEach(async () => {
  queryClient = new QueryClient();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  useSessionStore.getState().resetSession();
  useUiStore.getState().resetProjectUiState();
  fetchMock.mockReset();
  lifecycleHandle = await activateLifecycle(false);
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function advanceDebounce(): void {
  act(() => vi.advanceTimersByTime(300));
}

function renderSearchController() {
  return render(
    <QueryClientProvider client={queryClient}>
      <SearchController />
    </QueryClientProvider>,
  );
}

function expectLiveGenerationUntouched(): void {
  const state = useUiStore.getState();
  expect(state.searchResults).toEqual([777]);
  expect(state.searchMatches).toEqual({ 777: [LIVE_MATCH] });
  // The demo generation is still in flight; an older finally must not end its loading state.
  expect(state.searchLoading).toBe(true);
}

async function beginSameIdAuthToDemo(oldRequest: ReturnType<typeof deferred<Response>>) {
  const liveRequest = new Promise<Response>(() => {});
  fetchMock
    .mockReturnValueOnce(oldRequest.promise)
    .mockReturnValueOnce(liveRequest);

  renderSearchController();
  advanceDebounce();
  expect(fetchMock).toHaveBeenNthCalledWith(
    1,
    "/api/search?projectId=same-project&q=doors",
    { signal: expect.any(AbortSignal) },
  );

  // Same URL identity, different authority/lifecycle generation.
  await act(async () => {
    lifecycleHandle = await activateLifecycle(true);
  });
  advanceDebounce();
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    "/api/demo/search?projectId=same-project&q=doors",
    { signal: expect.any(AbortSignal) },
  );

  // Sentinel state owned by the still-pending demo request.
  act(() => {
    useUiStore.setState({
      searchResults: [777],
      searchMatches: { 777: [LIVE_MATCH] },
      searchLoading: true,
    });
  });
}

describe("useSearch P2.5 lifecycle-generation freeze", () => {
  it("rejects a dequeued debounce from before a real same-id same-mode reopen", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    fetchMock.mockResolvedValue(response(true, { query: "doors", results: [] }));
    renderSearchController();

    const debounceCalls = timeoutSpy.mock.calls.filter((call) => call[1] === 300);
    expect(debounceCalls).toHaveLength(1);
    const runScheduledGeneration = debounceCalls[0]![0] as () => Promise<void>;

    // A browser may already have dequeued A's timer when navigation installs B, so clearing the
    // timeout in A's later passive cleanup is no longer sufficient. Keep the callback itself and
    // complete a real lifecycle generation with the same final selector values before running it.
    await act(async () => {
      lifecycleHandle = await activateLifecycle(false);
    });
    act(() => {
      void runScheduledGeneration();
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed before dispatch without publishing loading into an unowned lifecycle", () => {
    lifecycleHandle.dispose();
    fetchMock.mockResolvedValue(response(true, { query: "doors", results: [] }));
    useUiStore.setState({ searchLoading: true });

    renderSearchController();
    advanceDebounce();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(useUiStore.getState().searchLoading).toBe(true);
  });

  it("does not continue the short-query clear after its atomic publication opens a successor", () => {
    fetchMock.mockReturnValue(new Promise<Response>(() => {}));
    act(() => {
      useUiStore.setState({
        searchQuery: "x",
        searchResults: [91],
        searchMatches: { 91: [STALE_MATCH] },
        searchLoading: true,
      });
    });

    let openedSuccessor = false;
    const unsubscribe = useUiStore.subscribe((state) => {
      if (openedSuccessor || state.searchResults.length !== 0) return;
      openedSuccessor = true;
      lifecycleHandle = openProject(queryClient, "same-project", {
        demo: false,
        searchQuery: "x",
      });

      // Keep the successor's final selector values synchronous so React does not need to commit a
      // second effect before we can observe whether A continues its three-write clear sequence.
      useSessionStore.setState({ publicId: "same-project", isDemo: false });
      useUiStore.setState({
        searchQuery: "x",
        searchResults: [777],
        searchMatches: { 777: [LIVE_MATCH] },
        searchLoading: true,
      });
    });

    try {
      renderSearchController();

      expect(openedSuccessor).toBe(true);
      expectLiveGenerationUntouched();
    } finally {
      unsubscribe();
    }
  });

  it("rechecks lifecycle authority after loading=true publishes synchronously", () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    fetchMock.mockReturnValue(new Promise<Response>(() => {}));

    let openedSuccessor = false;
    const unsubscribe = useUiStore.subscribe((state) => {
      if (openedSuccessor || !state.searchLoading) return;
      openedSuccessor = true;
      lifecycleHandle = openProject(queryClient, "same-project", {
        demo: false,
        searchQuery: "doors",
      });
      useSessionStore.setState({ publicId: "same-project", isDemo: false });
      useUiStore.setState({
        searchQuery: "doors",
        searchResults: [777],
        searchMatches: { 777: [LIVE_MATCH] },
        searchLoading: true,
      });
    });

    try {
      renderSearchController();

      expect(openedSuccessor).toBe(true);
      expect(timeoutSpy.mock.calls.filter((call) => call[1] === 300)).toHaveLength(0);
      expectLiveGenerationUntouched();
    } finally {
      unsubscribe();
    }
  });

  it("aborts an in-flight request synchronously when its effect cleans up", () => {
    fetchMock.mockReturnValue(new Promise<Response>(() => {}));
    const view = renderSearchController();
    advanceDebounce();

    const signal = signalForCall(0);
    expect(signal.aborted).toBe(false);
    view.unmount();

    expect(signal.aborted).toBe(true);
  });

  it("ignores a signal-ignoring stale success after same-publicId auth -> demo", async () => {
    const oldRequest = deferred<Response>();
    await beginSameIdAuthToDemo(oldRequest);

    oldRequest.resolve(
      response(true, {
        query: "doors",
        results: [
          {
            pageNumber: 91,
            pageName: "stale",
            snippet: "stale",
            rank: 1,
            matchCount: 1,
            wordMatches: [STALE_MATCH],
          },
        ],
      }),
    );
    await flushPromises();

    expectLiveGenerationUntouched();
  });

  it("ignores a signal-ignoring stale non-ok response after same-publicId auth -> demo", async () => {
    const oldRequest = deferred<Response>();
    await beginSameIdAuthToDemo(oldRequest);

    oldRequest.resolve(response(false));
    await flushPromises();

    expectLiveGenerationUntouched();
  });

  it("ignores a signal-ignoring stale error and its finally after same-publicId auth -> demo", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const oldRequest = deferred<Response>();
    await beginSameIdAuthToDemo(oldRequest);

    oldRequest.reject(new Error("late auth transport failure"));
    await flushPromises();

    expectLiveGenerationUntouched();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("ignores a delayed success after a real same-publicId same-mode reopen", async () => {
    const oldRequest = deferred<Response>();
    fetchMock.mockReturnValueOnce(oldRequest.promise);
    renderSearchController();
    advanceDebounce();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      lifecycleHandle = await activateLifecycle(false);
    });
    act(() => {
      useUiStore.setState({
        searchResults: [777],
        searchMatches: { 777: [LIVE_MATCH] },
        searchLoading: false,
      });
    });

    oldRequest.resolve(
      response(true, {
        query: "doors",
        results: [{
          pageNumber: 91,
          pageName: "stale",
          snippet: "stale",
          rank: 1,
          matchCount: 1,
          wordMatches: [STALE_MATCH],
        }],
      }),
    );
    await flushPromises();

    expect(useUiStore.getState().searchResults).toEqual([777]);
    expect(useUiStore.getState().searchMatches).toEqual({ 777: [LIVE_MATCH] });
    expect(useUiStore.getState().searchLoading).toBe(false);
  });

  it("stops a success publication when its first store write synchronously opens a successor", async () => {
    const oldRequest = deferred<Response>();
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/search?projectId=same-project&q=doors") {
        return oldRequest.promise;
      }
      if (url === "/api/projects/same-project") {
        return Promise.resolve(jsonResponse(projectResponse("same-project")));
      }
      if (url === "/api/projects/same-project/pages?from=1&to=15") {
        return Promise.resolve(jsonResponse({ from: 1, to: 1, pages: [], annotations: [] }));
      }
      if (url === "/api/annotation-groups?projectId=same-project") {
        return Promise.resolve(jsonResponse({ groups: [], memberships: [] }));
      }
      throw new Error(`unexpected reentrant search request: ${url}`);
    });

    renderSearchController();
    advanceDebounce();

    let successor: OpenProjectHandle | null = null;
    let openedSuccessor = false;
    let leakedMatchesIntoSuccessor = false;
    const unsubscribe = useUiStore.subscribe((state) => {
      if (!openedSuccessor && state.searchResults[0] === 91) {
        openedSuccessor = true;
        successor = openProject(queryClient, "same-project", { demo: false });
      }
      if (openedSuccessor && state.searchMatches[91]?.[0] === STALE_MATCH) {
        leakedMatchesIntoSuccessor = true;
      }
    });

    try {
      oldRequest.resolve(response(true, {
        query: "doors",
        results: [{
          pageNumber: 91,
          pageName: "stale",
          snippet: "stale",
          rank: 1,
          matchCount: 1,
          wordMatches: [STALE_MATCH],
        }],
      }));
      await flushPromises();

      expect(openedSuccessor).toBe(true);
      expect(leakedMatchesIntoSuccessor).toBe(false);
      expect(useUiStore.getState().searchResults).toEqual([]);
      expect(useUiStore.getState().searchMatches).toEqual({});
      if (successor) lifecycleHandle = successor;
    } finally {
      unsubscribe();
    }
  });
});
