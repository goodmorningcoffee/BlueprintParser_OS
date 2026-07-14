// @vitest-environment node
// [refactor jul13 P2.5 FREEZE TARGET] This began RED against the production-dead lifecycle
// scaffold. It is now the end-to-end authority/adoption contract shared by both route loaders.

import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureProjectLifecycle,
  isCurrentProjectLifecycle,
  openProject,
  type OpenProjectHandle,
  type ProjectResponse,
} from "@/lib/project-lifecycle";
import { EMPTY_ACTIVE_PAGE_WINDOW } from "@/queries/pageWindowCore";
import { queryKeys } from "@/queries/queryKeys";
import type { AnnotationGroupsPayload } from "@/queries/useAnnotationGroups";
import { useSessionStore } from "@/stores/sessionStore";
import { useUiStore } from "@/stores/uiStore";
import type { ChatMsg, ProjectSummaries, QtoWorkflow } from "@/types";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function metadata(
  id: string,
  overrides: Partial<ProjectResponse> = {},
): ProjectResponse {
  return {
    id,
    dbId: id === "canonical-B" ? 202 : 101,
    name: id,
    assetBaseUrl: `projects/${id}`,
    pdfUrl: `https://example.test/${id}.pdf`,
    numPages: 1,
    status: "completed",
    summaries: null,
    projectIntelligence: null,
    pages: [{ pageNumber: 1, name: "A-101", drawingNumber: null }],
    ...overrides,
  };
}

function summaries(
  overrides: Partial<ProjectSummaries> = {},
): ProjectSummaries {
  return {
    schedules: [],
    parsedTables: [],
    keynoteTablePages: [],
    csiPageIndex: {},
    tradePageIndex: {},
    keynotePageIndex: {},
    textAnnotationPageIndex: {},
    pageClassifications: {},
    annotationSummary: { modelNames: [], categoryCounts: {}, pageAnnotationCounts: {} },
    takeoffTotals: {},
    allTrades: [],
    allCsiCodes: [],
    ...overrides,
  };
}

function jsonResponse(value: unknown, ok = true): Response {
  return { ok, json: async () => value } as Response;
}

function emptyPageWindow(): Response {
  return jsonResponse({ from: 1, to: 1, pages: [], annotations: [] });
}

function abortError(message = "transport aborted"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

async function expectLifecycleError(
  handle: OpenProjectHandle,
  expected: Error | string,
): Promise<Error> {
  const result = await handle.result;
  expect(result.status).toBe("error");
  if (result.status !== "error") {
    throw new Error(`Expected lifecycle error, received ${result.status}`);
  }
  if (typeof expected === "string") {
    expect(result.error.message).toBe(expected);
  } else {
    expect(result.error).toBe(expected);
  }
  return result.error;
}

type AwaitBoundary = "promise-all" | "metadata-json" | "groups-json" | "page-json";

function supersessionBoundaryHarness(id: string, boundary: AwaitBoundary): {
  reached: Promise<void>;
  release(): void;
  fetchMock: ReturnType<typeof vi.fn>;
} {
  const reached = deferred<void>();
  const pendingResponse = deferred<Response>();
  const pendingMetadata = deferred<ProjectResponse>();
  const pendingGroups = deferred<AnnotationGroupsPayload>();
  const pendingPage = deferred<{
    from: number;
    to: number;
    pages: never[];
    annotations: never[];
  }>();
  const staleMetadata = metadata(id, {
    name: `stale-${boundary}`,
    chatMessages: [{
      id: 77,
      role: "user",
      content: `must not publish after ${boundary}`,
      model: null,
    }],
  });

  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `/api/projects/${id}`) {
      if (boundary === "promise-all") {
        reached.resolve(undefined);
        return pendingResponse.promise;
      }
      if (boundary === "metadata-json") {
        return {
          ok: true,
          json: () => {
            reached.resolve(undefined);
            return pendingMetadata.promise;
          },
        } as Response;
      }
      return jsonResponse(staleMetadata);
    }
    if (url === `/api/projects/${id}/pages?from=1&to=15`) {
      if (boundary === "page-json") {
        return {
          ok: true,
          json: () => {
            reached.resolve(undefined);
            return pendingPage.promise;
          },
        } as Response;
      }
      return emptyPageWindow();
    }
    if (url === `/api/annotation-groups?projectId=${id}`) {
      if (boundary === "groups-json") {
        return {
          ok: true,
          json: () => {
            reached.resolve(undefined);
            return pendingGroups.promise;
          },
        } as Response;
      }
      return jsonResponse({ groups: [], memberships: [] });
    }
    if (url === `/api/demo/projects/${id}`) {
      return jsonResponse(metadata(id, { name: `winner-after-${boundary}` }));
    }
    if (url === `/api/demo/projects/${id}/pages?from=1&to=15`) {
      return emptyPageWindow();
    }
    throw new Error(`Unexpected lifecycle request: ${url}`);
  });

  return {
    reached: reached.promise,
    release: () => {
      if (boundary === "promise-all") {
        pendingResponse.resolve(jsonResponse(staleMetadata));
      } else if (boundary === "metadata-json") {
        pendingMetadata.resolve(staleMetadata);
      } else if (boundary === "groups-json") {
        pendingGroups.resolve({ groups: [], memberships: [] });
      } else {
        pendingPage.resolve({ from: 1, to: 1, pages: [], annotations: [] });
      }
    },
    fetchMock,
  };
}

const privateChat: ChatMsg[] = [
  { id: 1, role: "user", content: "private auth chat" },
];
const privateGroups: AnnotationGroupsPayload = {
  groups: [{ id: 7, name: "private auth group" } as AnnotationGroupsPayload["groups"][number]],
  memberships: [],
};
const privateQto: QtoWorkflow[] = [
  { id: 9, materialLabel: "private auth workflow" } as QtoWorkflow,
];

describe("project lifecycle target", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    useSessionStore.getState().resetSession();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    queryClient.clear();
    useSessionStore.getState().resetSession();
  });

  it("supersedes every generation, including same-id/same-mode opens", async () => {
    const first = openProject(queryClient, "same-id", { demo: false });
    const firstSnapshot = captureProjectLifecycle(queryClient);
    expect(captureProjectLifecycle(queryClient)).toBe(firstSnapshot);
    const second = openProject(queryClient, "same-id", { demo: false });
    const secondSnapshot = captureProjectLifecycle(queryClient);

    expect(second.generation).toBe(first.generation + 1);
    expect(isCurrentProjectLifecycle(queryClient, firstSnapshot)).toBe(false);
    expect(isCurrentProjectLifecycle(queryClient, secondSnapshot)).toBe(true);
    expect(await first.result).toEqual({ status: "superseded" });
  });

  it("cannot overwrite a successor installed by the previous controller's abort listener", async () => {
    const urls: string[] = [];
    let nested: OpenProjectHandle | null = null;
    let nestedInstalled = false;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      if (url.startsWith("/api/projects/abort-source") ||
        url === "/api/annotation-groups?projectId=abort-source") {
        const signal = init?.signal;
        if (!(signal instanceof AbortSignal)) throw new Error("missing lifecycle AbortSignal");
        if (!nestedInstalled) {
          nestedInstalled = true;
          signal.addEventListener("abort", () => {
            nested = openProject(queryClient, "nested-winner", { demo: true });
          }, { once: true });
        }
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(abortError()), { once: true });
        });
      }
      if (url === "/api/demo/projects/nested-winner") {
        return Promise.resolve(jsonResponse(metadata("nested-winner")));
      }
      if (url === "/api/demo/projects/nested-winner/pages?from=1&to=15") {
        return Promise.resolve(emptyPageWindow());
      }
      if (url === "/api/demo/projects/outer-contender") {
        return Promise.resolve(jsonResponse(metadata("outer-contender")));
      }
      if (url === "/api/demo/projects/outer-contender/pages?from=1&to=15") {
        return Promise.resolve(emptyPageWindow());
      }
      throw new Error(`Unexpected abort-supersession request: ${url}`);
    }));

    const first = openProject(queryClient, "abort-source", { demo: false });
    const outer = openProject(queryClient, "outer-contender", { demo: true });
    const nestedHandle = nested as OpenProjectHandle | null;
    if (!nestedHandle) throw new Error("abort listener did not install nested lifecycle");

    expect.soft(outer.generation).toBe(first.generation + 1);
    expect.soft(nestedHandle.generation).toBe(outer.generation + 1);
    expect.soft(await first.result).toEqual({ status: "superseded" });
    expect.soft(await outer.result).toEqual({ status: "superseded" });
    expect.soft((await nestedHandle.result).status).toBe("opened");
    expect.soft(useSessionStore.getState().publicId).toBe("nested-winner");
    expect.soft(urls).not.toContain("/api/demo/projects/outer-contender");
  });

  it("does not dispatch after reset synchronously installs a successor", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url === "/api/demo/projects/winner") {
        return jsonResponse(metadata("winner"));
      }
      if (url === "/api/demo/projects/winner/pages?from=1&to=15") {
        return emptyPageWindow();
      }
      if (url === "/api/projects/obsolete") {
        return jsonResponse(metadata("obsolete"));
      }
      if (url === "/api/projects/obsolete/pages?from=1&to=15") {
        return emptyPageWindow();
      }
      if (url === "/api/annotation-groups?projectId=obsolete") {
        return jsonResponse({ groups: [], memberships: [] });
      }
      throw new Error(`Unexpected reentrant-reset request: ${url}`);
    }));

    let winner: OpenProjectHandle | null = null;
    let installedWinner = false;
    const unsubscribe = useSessionStore.subscribe((state) => {
      if (!installedWinner && state.publicId === "") {
        installedWinner = true;
        winner = openProject(queryClient, "winner", { demo: true });
        // B is allowed to publish immediately after its own guarded reset returns. Outer A must not
        // resume the remaining reset leaves and erase this successor-owned UI state.
        useUiStore.setState({ searchResults: [777], searchLoading: true });
      }
    });

    try {
      const obsolete = openProject(queryClient, "obsolete", { demo: false });
      expect(installedWinner).toBe(true);
      // TypeScript cannot see the synchronous store-subscriber assignment through openProject().
      const winnerHandle = winner as OpenProjectHandle | null;
      if (!winnerHandle) throw new Error("reset subscriber did not install winner lifecycle");

      expect.soft(await obsolete.result).toEqual({ status: "superseded" });
      expect.soft((await winnerHandle.result).status).toBe("opened");
      expect(urls).toEqual([
        "/api/demo/projects/winner",
        "/api/demo/projects/winner/pages?from=1&to=15",
      ]);
      expect(useUiStore.getState()).toMatchObject({
        searchResults: [777],
        searchLoading: true,
      });
    } finally {
      unsubscribe();
    }
  });

  it("lets only the exact current handle dispose lifecycle authority", () => {
    const first = openProject(queryClient, "same-id", { demo: false });
    const second = openProject(queryClient, "same-id", { demo: true });
    const secondSnapshot = captureProjectLifecycle(queryClient);

    first.dispose();
    expect(isCurrentProjectLifecycle(queryClient, secondSnapshot)).toBe(true);

    second.dispose();
    expect(isCurrentProjectLifecycle(queryClient, secondSnapshot)).toBe(false);
    expect(captureProjectLifecycle(queryClient)).toBeNull();
  });

  it("passes one exact AbortSignal to every request and aborts it on exact disposal", async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) throw new Error("missing lifecycle AbortSignal");
      signals.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(abortError()), { once: true });
      });
    }));

    const handle = openProject(queryClient, "abort-owned", { demo: false });
    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => signal === signals[0])).toBe(true);
    expect(signals[0]!.aborted).toBe(false);

    handle.dispose();

    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(await handle.result).toEqual({ status: "superseded" });
  });

  it("returns an exact current-owned AbortError and aborts its sibling requests", async () => {
    const id = "current-owned-abort-error";
    const ownedError = abortError("current transport aborted itself");
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) throw new Error("missing lifecycle AbortSignal");
      signals.push(signal);
      if (String(input) === `/api/projects/${id}`) return Promise.reject(ownedError);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(abortError("sibling aborted by lifecycle")),
          { once: true },
        );
      });
    }));

    const resultError = await expectLifecycleError(
      openProject(queryClient, id, { demo: false }),
      ownedError,
    );

    expect.soft(resultError).toBe(ownedError);
    expect.soft(signals).toHaveLength(3);
    expect.soft(signals.every((signal) => signal === signals[0])).toBe(true);
    expect.soft(signals.every((signal) => signal.aborted)).toBe(true);
    expect.soft(useSessionStore.getState().publicId).toBe("");
    expect.soft(captureProjectLifecycle(queryClient)).toBeNull();
  });

  it("settles superseded when synchronous abort listeners install a successor", async () => {
    const obsoleteId = "abort-listener-obsolete";
    const winnerId = "abort-listener-winner";
    let winner: OpenProjectHandle | null = null;
    let installedWinner = false;

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith(`/api/projects/${obsoleteId}`) ||
        url === `/api/annotation-groups?projectId=${obsoleteId}`) {
        const signal = init?.signal;
        if (!(signal instanceof AbortSignal)) throw new Error("missing lifecycle AbortSignal");
        signal.addEventListener("abort", () => {
          if (installedWinner) return;
          installedWinner = true;
          winner = openProject(queryClient, winnerId, { demo: true });
        }, { once: true });
        if (url === `/api/projects/${obsoleteId}`) return jsonResponse({}, false);
        if (url === `/api/projects/${obsoleteId}/pages?from=1&to=15`) return emptyPageWindow();
        return jsonResponse({ groups: [], memberships: [] });
      }
      if (url === `/api/demo/projects/${winnerId}`) {
        return jsonResponse(metadata(winnerId));
      }
      if (url === `/api/demo/projects/${winnerId}/pages?from=1&to=15`) {
        return emptyPageWindow();
      }
      throw new Error(`Unexpected abort-listener request: ${url}`);
    }));

    const obsolete = openProject(queryClient, obsoleteId, { demo: false });
    expect.soft(await obsolete.result).toEqual({ status: "superseded" });
    const winnerHandle = winner as OpenProjectHandle | null;
    if (!winnerHandle) throw new Error("abort listener did not install winner lifecycle");
    expect.soft((await winnerHandle.result).status).toBe("opened");
    expect.soft(useSessionStore.getState()).toMatchObject({
      publicId: winnerId,
      isDemo: true,
    });
  });

  it.each([
    [false, "Failed to load project"],
    [true, "Project not found"],
  ] as const)(
    "treats a current-owned %s metadata non-OK as fatal and aborts its siblings",
    async (demo, expectedMessage) => {
      const id = demo ? "demo-metadata-non-ok" : "auth-metadata-non-ok";
      const signals: AbortSignal[] = [];
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const signal = init?.signal;
        if (!(signal instanceof AbortSignal)) throw new Error("missing lifecycle AbortSignal");
        signals.push(signal);
        const url = String(input);
        if (url === `/api/${demo ? "demo/" : ""}projects/${id}`) {
          return jsonResponse({}, false);
        }
        if (url === `/api/${demo ? "demo/" : ""}projects/${id}/pages?from=1&to=15`) {
          return emptyPageWindow();
        }
        if (!demo && url === `/api/annotation-groups?projectId=${id}`) {
          return jsonResponse({ groups: [], memberships: [] });
        }
        throw new Error(`Unexpected lifecycle request: ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      await expectLifecycleError(openProject(queryClient, id, { demo }), expectedMessage);

      expect.soft(signals).toHaveLength(demo ? 2 : 3);
      expect.soft(signals.every((signal) => signal === signals[0])).toBe(true);
      expect.soft(signals.every((signal) => signal.aborted)).toBe(true);
      expect.soft(useSessionStore.getState().publicId).toBe("");
      expect.soft(captureProjectLifecycle(queryClient)).toBeNull();
    },
  );

  it.each([false, true])(
    "treats a current-owned %s metadata JSON failure as fatal",
    async (demo) => {
      const id = demo ? "demo-metadata-json" : "auth-metadata-json";
      const decodeError = new Error(`${id} decode failed`);
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `/api/${demo ? "demo/" : ""}projects/${id}`) {
          return { ok: true, json: async () => { throw decodeError; } } as unknown as Response;
        }
        if (url === `/api/${demo ? "demo/" : ""}projects/${id}/pages?from=1&to=15`) {
          return emptyPageWindow();
        }
        if (!demo && url === `/api/annotation-groups?projectId=${id}`) {
          return jsonResponse({ groups: [], memberships: [] });
        }
        throw new Error(`Unexpected lifecycle request: ${url}`);
      }));

      await expectLifecycleError(openProject(queryClient, id, { demo }), decodeError);
      expect.soft(useSessionStore.getState().publicId).toBe("");
    },
  );

  it("keeps an authenticated annotation-group network failure fatal", async () => {
    const id = "groups-network-fatal";
    const networkError = new Error("groups transport failed");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/projects/${id}`) return jsonResponse(metadata(id));
      if (url === `/api/projects/${id}/pages?from=1&to=15`) return emptyPageWindow();
      if (url === `/api/annotation-groups?projectId=${id}`) throw networkError;
      throw new Error(`Unexpected lifecycle request: ${url}`);
    }));

    await expectLifecycleError(openProject(queryClient, id, { demo: false }), networkError);
    expect.soft(useSessionStore.getState().publicId).toBe("");
    expect.soft(queryClient.getQueryData(queryKeys.annotationGroups.all(id))).toBeUndefined();
  });

  it.each(["non-ok", "unparseable"] as const)(
    "adopts empty authenticated groups when the groups response is %s",
    async (failure) => {
      const id = `groups-${failure}`;
      const groupsJson = vi.fn(async () => {
        if (failure === "unparseable") throw new Error("invalid groups JSON");
        return privateGroups;
      });
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `/api/projects/${id}`) return jsonResponse(metadata(id));
        if (url === `/api/projects/${id}/pages?from=1&to=15`) return emptyPageWindow();
        if (url === `/api/annotation-groups?projectId=${id}`) {
          return { ok: failure !== "non-ok", json: groupsJson } as unknown as Response;
        }
        throw new Error(`Unexpected lifecycle request: ${url}`);
      }));

      const result = await openProject(queryClient, id, { demo: false }).result;

      expect.soft(result.status).toBe("opened");
      expect.soft(queryClient.getQueryData(queryKeys.annotationGroups.all(id))).toEqual({
        groups: [],
        memberships: [],
      });
      expect.soft(groupsJson).toHaveBeenCalledTimes(failure === "non-ok" ? 0 : 1);
    },
  );

  it.each([false, true])(
    "keeps a %s page-window non-OK nonfatal and adopts explicit empty caches",
    async (demo) => {
      const id = demo ? "demo-page-non-ok" : "auth-page-non-ok";
      const pageJson = vi.fn(async () => ({ stale: true }));
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `/api/${demo ? "demo/" : ""}projects/${id}`) {
          return jsonResponse(metadata(id));
        }
        if (url === `/api/${demo ? "demo/" : ""}projects/${id}/pages?from=1&to=15`) {
          return { ok: false, json: pageJson } as unknown as Response;
        }
        if (!demo && url === `/api/annotation-groups?projectId=${id}`) {
          return jsonResponse({ groups: [], memberships: [] });
        }
        throw new Error(`Unexpected lifecycle request: ${url}`);
      }));

      const result = await openProject(queryClient, id, { demo }).result;

      expect.soft(result.status).toBe("opened");
      expect.soft(pageJson).not.toHaveBeenCalled();
      expect.soft(queryClient.getQueryData(queryKeys.annotations.all(id))).toEqual([]);
      expect.soft(queryClient.getQueryData(queryKeys.pagesWindow.active(id))).toBeDefined();
    },
  );

  it.each([false, true])(
    "keeps a %s page-window JSON failure fatal and clears both stale same-id caches",
    async (demo) => {
      const id = demo ? "demo-page-json" : "auth-page-json";
      const decodeError = new Error(`${id} decode failed`);
      queryClient.setQueryData(queryKeys.annotations.all(id), [{ id: "stale-annotation" }]);
      queryClient.setQueryData(queryKeys.pagesWindow.active(id), {
        loadedRange: { from: 1, to: 1 },
        keynotes: {},
        csiCodes: {},
        textAnnotations: {},
        pageIntelligence: { 1: { stale: true } },
      });
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `/api/${demo ? "demo/" : ""}projects/${id}`) {
          return jsonResponse(metadata(id));
        }
        if (url === `/api/${demo ? "demo/" : ""}projects/${id}/pages?from=1&to=15`) {
          return { ok: true, json: async () => { throw decodeError; } } as unknown as Response;
        }
        if (!demo && url === `/api/annotation-groups?projectId=${id}`) {
          return jsonResponse({ groups: [], memberships: [] });
        }
        throw new Error(`Unexpected lifecycle request: ${url}`);
      }));

      await expectLifecycleError(openProject(queryClient, id, { demo }), decodeError);
      expect.soft(useSessionStore.getState().publicId).toBe("");
      expect.soft(queryClient.getQueryData(queryKeys.annotations.all(id))).toEqual([]);
      expect.soft(queryClient.getQueryData(queryKeys.pagesWindow.active(id))).toEqual(
        EMPTY_ACTIVE_PAGE_WINDOW,
      );
    },
  );

  it.each([
    "promise-all",
    "metadata-json",
    "groups-json",
    "page-json",
  ] as const)("makes supersession at the %s await boundary a total no-op", async (boundary) => {
    const id = `same-id-${boundary}`;
    const harness = supersessionBoundaryHarness(id, boundary);
    vi.stubGlobal("fetch", harness.fetchMock);

    const obsolete = openProject(queryClient, id, { demo: false });
    await harness.reached;
    const winner = openProject(queryClient, id, { demo: true });
    expect((await winner.result).status).toBe("opened");

    harness.release();

    expect.soft(await obsolete.result).toEqual({ status: "superseded" });
    expect.soft(useSessionStore.getState()).toMatchObject({ publicId: id, isDemo: true });
    expect.soft(queryClient.getQueryData(queryKeys.chatMessages.all(id))).toEqual([]);
  });

  it("empty-seeds auth-only caches before same-id demo activation", async () => {
    const id = "same-id";
    queryClient.setQueryData(queryKeys.chatMessages.all(id), privateChat);
    queryClient.setQueryData(queryKeys.annotationGroups.all(id), privateGroups);
    queryClient.setQueryData(queryKeys.qtoWorkflows.all(id), privateQto);
    useSessionStore.setState({ projectId: 99, publicId: id, assetBaseUrl: "auth", isDemo: false });

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/demo/projects/${id}`) return jsonResponse(metadata(id));
      if (url === `/api/demo/projects/${id}/pages?from=1&to=15`) return emptyPageWindow();
      throw new Error(`Unexpected lifecycle request: ${url}`);
    }));

    const handle = openProject(queryClient, id, { demo: true });
    const result = await handle.result;

    expect.soft(result.status).toBe("opened");
    expect.soft(queryClient.getQueryData(queryKeys.chatMessages.all(id))).toEqual([]);
    expect.soft(queryClient.getQueryData(queryKeys.annotationGroups.all(id))).toEqual({
      groups: [],
      memberships: [],
    });
    expect.soft(queryClient.getQueryData(queryKeys.qtoWorkflows.all(id))).toEqual([]);
    expect.soft(useSessionStore.getState()).toMatchObject({ publicId: id, isDemo: true });
  });

  it("cancels a signal-ignoring auth QTO GET before same-id demo can activate", async () => {
    const id = "same-id-qto-race";
    const delayedPrivateRows = deferred<QtoWorkflow[]>();
    const qtoSignals: AbortSignal[] = [];
    useSessionStore.setState({ projectId: 99, publicId: id, assetBaseUrl: "auth", isDemo: false });

    // Model the independent-fetch QTO observer. It reads the signal but deliberately ignores the
    // abort, so only TanStack's exact query cancellation can prevent the late retryer settlement
    // from repopulating private rows under the publicId-only key.
    const staleSettlement = queryClient.fetchQuery({
      queryKey: queryKeys.qtoWorkflows.all(id),
      queryFn: ({ signal }) => {
        qtoSignals.push(signal);
        return delayedPrivateRows.promise;
      },
      retry: false,
    }).then(
      (value) => ({ status: "resolved" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/demo/projects/${id}`) return jsonResponse(metadata(id));
      if (url === `/api/demo/projects/${id}/pages?from=1&to=15`) return emptyPageWindow();
      throw new Error(`Unexpected lifecycle request: ${url}`);
    }));

    const result = await openProject(queryClient, id, { demo: true }).result;
    expect.soft(result.status).toBe("opened");
    expect.soft(qtoSignals[0]?.aborted).toBe(true);
    expect.soft(queryClient.getQueryData(queryKeys.qtoWorkflows.all(id))).toEqual([]);

    delayedPrivateRows.resolve(privateQto);
    expect.soft((await staleSettlement).status).toBe("rejected");
    expect.soft(queryClient.getQueryData(queryKeys.qtoWorkflows.all(id))).toEqual([]);
  });

  it("transfers exact QTO cleanup when superseded during its cancellation await", async () => {
    const id = "qto-cancel-await-transfer";
    const firstCancellation = deferred<void>();
    const firstCancellationReached = deferred<void>();
    const originalCancelQueries = queryClient.cancelQueries.bind(queryClient);
    const qtoCancellationCalls: Array<{
      queryKey: readonly unknown[] | undefined;
      exact: boolean | undefined;
    }> = [];
    let qtoCancellationCount = 0;
    vi.spyOn(queryClient, "cancelQueries").mockImplementation((filters, options) => {
      const key = filters?.queryKey;
      const isExactQto =
        Array.isArray(key) &&
        key.length === 3 &&
        key[0] === "project" &&
        key[1] === id &&
        key[2] === "qtoWorkflows";
      if (isExactQto) {
        qtoCancellationCount += 1;
        qtoCancellationCalls.push({
          queryKey: key,
          exact: filters?.exact,
        });
        if (qtoCancellationCount === 1) {
          firstCancellationReached.resolve(undefined);
          return firstCancellation.promise;
        }
      }
      return originalCancelQueries(filters, options);
    });

    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url === `/api/demo/projects/${id}`) return jsonResponse(metadata(id));
      if (url === `/api/demo/projects/${id}/pages?from=1&to=15`) return emptyPageWindow();
      throw new Error(`Unexpected QTO cleanup-transfer request: ${url}`);
    }));

    useSessionStore.setState({ publicId: id, projectId: 7, assetBaseUrl: "old.pdf", isDemo: false });
    const obsolete = openProject(queryClient, id, { demo: false });
    await firstCancellationReached.promise;

    const winner = openProject(queryClient, id, { demo: true });
    expect.soft((await winner.result).status).toBe("opened");
    expect.soft(qtoCancellationCalls).toEqual([
      { queryKey: queryKeys.qtoWorkflows.all(id), exact: true },
      { queryKey: queryKeys.qtoWorkflows.all(id), exact: true },
    ]);
    expect.soft(urls).toEqual([
      `/api/demo/projects/${id}`,
      `/api/demo/projects/${id}/pages?from=1&to=15`,
    ]);

    const winnerYolo = [{ id: "winner-yolo-after-cleanup" }];
    queryClient.setQueryData(queryKeys.yoloTags.all(id), winnerYolo);
    firstCancellation.resolve(undefined);

    expect.soft(await obsolete.result).toEqual({ status: "superseded" });
    expect.soft(queryClient.getQueryData(queryKeys.yoloTags.all(id))).toEqual(winnerYolo);
  });

  it("starts a fresh active QTO GET after a same-id authenticated reopen", async () => {
    const id = "same-id-auth-qto-refetch";
    const obsoleteRows = deferred<QtoWorkflow[]>();
    const currentRows = deferred<QtoWorkflow[]>();
    const signals: AbortSignal[] = [];
    let fetchCount = 0;
    useSessionStore.setState({ projectId: 99, publicId: id, assetBaseUrl: "auth", isDemo: false });

    const observer = new QueryObserver<QtoWorkflow[]>(queryClient, {
      queryKey: queryKeys.qtoWorkflows.all(id),
      queryFn: ({ signal }) => {
        signals.push(signal);
        fetchCount += 1;
        return fetchCount === 1 ? obsoleteRows.promise : currentRows.promise;
      },
      initialData: [],
      staleTime: 0,
      retry: false,
    });
    const unsubscribe = observer.subscribe(() => {});

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/projects/${id}`) return jsonResponse(metadata(id));
      if (url === `/api/projects/${id}/pages?from=1&to=15`) return emptyPageWindow();
      if (url === `/api/annotation-groups?projectId=${id}`) {
        return jsonResponse({ groups: [], memberships: [] });
      }
      throw new Error(`Unexpected lifecycle request: ${url}`);
    }));

    try {
      expect(fetchCount).toBe(1);
      const result = await openProject(queryClient, id, { demo: false }).result;

      expect.soft(result.status).toBe("opened");
      expect.soft(signals[0]?.aborted).toBe(true);
      expect.soft(fetchCount).toBe(2);

      currentRows.resolve([{ ...privateQto[0]!, materialLabel: "fresh authenticated rows" }]);
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
      expect.soft(queryClient.getQueryData(queryKeys.qtoWorkflows.all(id))).toEqual([
        { ...privateQto[0]!, materialLabel: "fresh authenticated rows" },
      ]);
    } finally {
      unsubscribe();
      obsoleteRows.resolve(privateQto);
    }
  });

  it("keys adoption by canonical metadata id and activates the session last", async () => {
    const routeId = "route-alias";
    const canonicalId = "canonical-B";
    const trace: string[] = [];
    const unsubscribeQueries = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated") return;
      const [, publicId, domain] = event.query.queryKey;
      if (publicId === canonicalId) trace.push(`cache:${String(domain)}`);
    });
    const unsubscribeSession = useSessionStore.subscribe((state) => {
      if (state.publicId) trace.push(`session:${state.publicId}`);
    });

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/demo/projects/${routeId}`) {
        return jsonResponse(metadata(canonicalId));
      }
      if (url === `/api/demo/projects/${routeId}/pages?from=1&to=15`) {
        return emptyPageWindow();
      }
      throw new Error(`Unexpected lifecycle request: ${url}`);
    }));

    try {
      const result = await openProject(queryClient, routeId, { demo: true }).result;
      expect.soft(result.status).toBe("opened");
      expect.soft(queryClient.getQueryData(queryKeys.chatMessages.all(routeId))).toBeUndefined();
      expect.soft(queryClient.getQueryData(queryKeys.chatMessages.all(canonicalId))).toEqual([]);
      expect.soft(useSessionStore.getState().publicId).toBe(canonicalId);
      expect.soft(trace.length).toBeGreaterThan(1);
      expect.soft(trace.at(-1)).toBe(`session:${canonicalId}`);
    } finally {
      unsubscribeQueries();
      unsubscribeSession();
    }
  });

  it("empty-seeds the canonical catalog key before replacing it from summaries", async () => {
    const id = "catalog-seed-sequence";
    const key = queryKeys.projectCatalogs.all(id);
    const expectedCatalogs = {
      allTrades: ["Electrical"],
      allCsiCodes: [{ code: "26 00 00", description: "Electrical" }],
    };
    const publications: unknown[] = [];
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated") return;
      if (event.query.queryHash !== queryClient.getQueryCache().find({ queryKey: key })?.queryHash) {
        return;
      }
      publications.push(queryClient.getQueryData(key));
    });

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/demo/projects/${id}`) {
        return jsonResponse(metadata(id, {
          summaries: summaries(expectedCatalogs),
        }));
      }
      if (url === `/api/demo/projects/${id}/pages?from=1&to=15`) {
        return emptyPageWindow();
      }
      throw new Error(`Unexpected lifecycle request: ${url}`);
    }));

    try {
      expect.soft((await openProject(queryClient, id, { demo: true }).result).status).toBe("opened");
      expect(publications).toEqual([
        { allTrades: [], allCsiCodes: [] },
        expectedCatalogs,
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("stops before the derived catalog replacement when the empty seed starts B", async () => {
    const projectA = "catalog-empty-seed-A";
    const projectB = "catalog-empty-seed-B";
    const keyA = queryKeys.projectCatalogs.all(projectA);
    let nestedOpen: OpenProjectHandle | null = null;
    let nestedStarted = false;
    const publicationsA: unknown[] = [];

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/projects/${projectA}`) {
        return jsonResponse(metadata(projectA, {
          summaries: summaries({
            allTrades: ["Stale private trade"],
            allCsiCodes: [{ code: "99 00 00", description: "Stale private code" }],
          }),
        }));
      }
      if (url === `/api/projects/${projectA}/pages?from=1&to=15`) return emptyPageWindow();
      if (url === `/api/annotation-groups?projectId=${projectA}`) {
        return jsonResponse({ groups: [], memberships: [] });
      }
      if (url === `/api/demo/projects/${projectB}`) return jsonResponse(metadata(projectB));
      if (url === `/api/demo/projects/${projectB}/pages?from=1&to=15`) {
        return emptyPageWindow();
      }
      throw new Error(`Unexpected lifecycle request: ${url}`);
    }));

    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || event.query.queryKey[1] !== projectA) return;
      if (event.query.queryKey[2] !== "projectCatalogs") return;
      const published = queryClient.getQueryData(keyA);
      publicationsA.push(published);
      if (!nestedStarted) {
        nestedStarted = true;
        nestedOpen = openProject(queryClient, projectB, { demo: true });
      }
    });

    try {
      const obsolete = openProject(queryClient, projectA, { demo: false });

      expect.soft(await obsolete.result).toEqual({ status: "superseded" });
      expect.soft(nestedOpen).not.toBeNull();
      expect.soft((await nestedOpen!.result).status).toBe("opened");
      expect.soft(publicationsA).toEqual([{ allTrades: [], allCsiCodes: [] }]);
      expect.soft(queryClient.getQueryData(keyA)).toEqual({
        allTrades: [],
        allCsiCodes: [],
      });
      expect.soft(useSessionStore.getState().publicId).toBe(projectB);
    } finally {
      unsubscribe();
    }
  });

  it("makes an ignored-abort stale auth settle a total no-op after demo B opens", async () => {
    const id = "same-id";
    const authMetadata = deferred<ProjectResponse>();
    const demoMetadata = deferred<ProjectResponse>();

    // Deliberately ignores AbortSignal. Exact generation ownership, not transport cooperation,
    // must keep A from publishing after B.
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/projects/${id}`) {
        return { ok: true, json: () => authMetadata.promise } as Response;
      }
      if (url === `/api/projects/${id}/pages?from=1&to=15`) return emptyPageWindow();
      if (url === `/api/annotation-groups?projectId=${id}`) {
        return jsonResponse({ groups: [], memberships: [] });
      }
      if (url === `/api/demo/projects/${id}`) {
        return { ok: true, json: () => demoMetadata.promise } as Response;
      }
      if (url === `/api/demo/projects/${id}/pages?from=1&to=15`) return emptyPageWindow();
      throw new Error(`Unexpected lifecycle request: ${url}`);
    }));

    const auth = openProject(queryClient, id, { demo: false });
    await Promise.resolve();
    const demo = openProject(queryClient, id, { demo: true });
    demoMetadata.resolve(metadata(id, { name: "demo-B", chatMessages: undefined }));

    const demoResult = await demo.result;
    authMetadata.resolve(metadata(id, {
      name: "stale-auth-A",
      chatMessages: [{ id: 44, role: "user", content: "must not publish", model: null }],
    }));
    const authResult = await auth.result;

    expect.soft(demoResult.status).toBe("opened");
    expect.soft(authResult).toEqual({ status: "superseded" });
    expect.soft(useSessionStore.getState()).toMatchObject({ publicId: id, isDemo: true });
    expect.soft(queryClient.getQueryData(queryKeys.chatMessages.all(id))).toEqual([]);
  });

  it("stops adoption when a synchronous cache subscriber opens a newer project", async () => {
    const projectA = "project-A";
    const projectB = "project-B";
    const metadataB = deferred<ProjectResponse>();
    let nestedOpen: OpenProjectHandle | null = null;
    let nestedStarted = false;
    const stalePublications: (readonly unknown[])[] = [];

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/projects/${projectA}`) {
        return jsonResponse(metadata(projectA, {
          takeoffItems: [{
            id: 1,
            name: "A item",
            shape: "circle",
            color: "#fff",
            size: 10,
            sortOrder: 0,
          }],
          takeoffGroups: [{
            id: 2,
            name: "A group",
            kind: "count",
            color: null,
            csiCode: null,
            sortOrder: 0,
          }],
        }));
      }
      if (url === `/api/projects/${projectA}/pages?from=1&to=15`) return emptyPageWindow();
      if (url === `/api/annotation-groups?projectId=${projectA}`) {
        return jsonResponse({ groups: [], memberships: [] });
      }
      if (url === `/api/demo/projects/${projectB}`) {
        return { ok: true, json: () => metadataB.promise } as Response;
      }
      if (url === `/api/demo/projects/${projectB}/pages?from=1&to=15`) return emptyPageWindow();
      throw new Error(`Unexpected lifecycle request: ${url}`);
    }));

    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated") return;
      const key = event.query.queryKey;
      const isAItems = key[1] === projectA && key[2] === "takeoff" && key[3] === "items";
      if (!nestedStarted && isAItems) {
        nestedStarted = true;
        nestedOpen = openProject(queryClient, projectB, { demo: true });
        return;
      }
      if (nestedStarted && key[1] === projectA) stalePublications.push(key);
    });

    const first = openProject(queryClient, projectA, { demo: false });
    const firstResult = await first.result;
    const sessionAfterFirst = useSessionStore.getState().publicId;
    const staleGroups = queryClient.getQueryData(queryKeys.takeoff.groups(projectA));

    metadataB.resolve(metadata(projectB));
    const nestedResult = await nestedOpen!.result;
    unsubscribe();

    expect.soft(firstResult).toEqual({ status: "superseded" });
    expect.soft(sessionAfterFirst).toBe("");
    expect.soft(staleGroups).toBeUndefined();
    expect.soft(stalePublications).toEqual([]);
    expect.soft(nestedResult.status).toBe("opened");
  });

  it("transfers canonical cleanup when adoption is superseded after partial heavy-cache publication", async () => {
    const routeAliasA = "route-alias-A";
    const canonicalA = "canonical-partial-A";
    const projectB = "project-B-after-partial-A";
    let nestedOpen: OpenProjectHandle | null = null;
    let nestedStarted = false;

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/projects/${routeAliasA}`) {
        return jsonResponse(metadata(canonicalA, {
          projectIntelligence: {
            yoloTags: [],
            csiGraph: { nodes: [{ id: "private-A" }], edges: [] },
          },
        }));
      }
      if (url === `/api/projects/${routeAliasA}/pages?from=1&to=15`) {
        return emptyPageWindow();
      }
      if (url === `/api/annotation-groups?projectId=${routeAliasA}`) {
        return jsonResponse({ groups: [], memberships: [] });
      }
      if (url === `/api/demo/projects/${projectB}`) {
        return jsonResponse(metadata(projectB));
      }
      if (url === `/api/demo/projects/${projectB}/pages?from=1&to=15`) {
        return emptyPageWindow();
      }
      throw new Error(`Unexpected lifecycle request: ${url}`);
    }));

    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || nestedStarted) return;
      const key = event.query.queryKey;
      if (
        key.length === 3 &&
        key[0] === "project" &&
        key[1] === canonicalA &&
        key[2] === "csiGraph"
      ) {
        nestedStarted = true;
        nestedOpen = openProject(queryClient, projectB, { demo: true });
      }
    });

    try {
      const obsolete = openProject(queryClient, routeAliasA, { demo: false });
      expect.soft(await obsolete.result).toEqual({ status: "superseded" });
      expect.soft(nestedOpen).not.toBeNull();
      expect.soft((await nestedOpen!.result).status).toBe("opened");

      // B inherits A's canonical cleanup obligation even though A never reached session activation.
      expect.soft(queryClient.getQueryState(queryKeys.yoloTags.all(canonicalA))).toBeUndefined();
      expect.soft(queryClient.getQueryState(queryKeys.csiGraph.all(canonicalA))).toBeUndefined();
    } finally {
      unsubscribe();
    }
  });

  it("transfers same-id Textract cleanup and cannot remove the successor's later data", async () => {
    const id = "same-id";
    const cancellation = deferred<void>();
    const textractCancelReached = deferred<void>();
    const originalCancelQueries = queryClient.cancelQueries.bind(queryClient);
    const cancelQueries = vi.spyOn(queryClient, "cancelQueries");
    let textractCancelCalls = 0;
    cancelQueries.mockImplementation((filters, options) => {
      const key = filters?.queryKey;
      const isTextractPrefix =
        Array.isArray(key) &&
        key.length === 3 &&
        key[0] === "project" &&
        key[1] === id &&
        key[2] === "textract";
      if (isTextractPrefix) {
        textractCancelCalls += 1;
        if (textractCancelCalls === 1) {
          textractCancelReached.resolve(undefined);
          return cancellation.promise;
        }
      }
      return originalCancelQueries(filters, options);
    });
    useSessionStore.setState({ publicId: id, projectId: 1, assetBaseUrl: "old.pdf", isDemo: false });
    const privateAuthTextract = { blocks: [{ id: "private-auth-A" }] };
    queryClient.setQueryData(queryKeys.textract.page(id, 1), privateAuthTextract);

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/demo/projects/${id}`) return jsonResponse(metadata(id, { name: "winner-B" }));
      if (url === `/api/demo/projects/${id}/pages?from=1&to=15`) return emptyPageWindow();
      throw new Error(`Unexpected lifecycle request: ${url}`);
    }));

    const obsolete = openProject(queryClient, id, { demo: false });
    await textractCancelReached.promise;
    expect(textractCancelCalls).toBe(1);
    const winner = openProject(queryClient, id, { demo: true });
    expect((await winner.result).status).toBe("opened");
    expect(queryClient.getQueryData(queryKeys.textract.page(id, 1))).toBeUndefined();

    const winnerTextract = { blocks: [{ id: "winner-B" }] };
    queryClient.setQueryData(queryKeys.textract.page(id, 1), winnerTextract);
    cancellation.resolve();

    expect(await obsolete.result).toEqual({ status: "superseded" });
    expect(queryClient.getQueryData(queryKeys.textract.page(id, 1))).toBe(winnerTextract);
  });
});
