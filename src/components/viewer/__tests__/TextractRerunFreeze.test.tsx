// [refactor jul11 P2.2⑧ C1] TEXTRACT RERUN DOM FREEZE (TW1-TW4 + TR-D4).
//
// Written green against the original Zustand-backed writer and kept backing-agnostic when C3 moved
// Textract to one Query entry per publicId/page. `seedTextract` remains the only seed flip point:
// assertions observe the real TextractTab DOM and never inspect viewerStore payload data.
//
// Scope: sanctioned publicId POST/body, server-first authoritative replacement, result stats,
// loading/missing-id/demo gates, old-data retention, and rerun-vs-GET/identity race closure.
// Lazy GET scheduling and coordinator policy remain covered by their own lanes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
import { seedTextract } from "@/test/seed-textract";
import type { TextractPageData } from "@/types";
import { TextractTab } from "../TextPanel";
import { resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";

const PAGE = 7;
const PROJECT_DB_ID = 417;
const PUBLIC_ID = "project-public-id";

let queryClient: QueryClient;
const fetchMock = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
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

function textractFixture(
  wordCount: number,
  lineCount: number,
  tableCount: number,
  prefix: string,
): TextractPageData {
  const words = Array.from({ length: wordCount }, (_, index) => ({
    text: `${prefix}-word-${index}`,
    confidence: 99,
    bbox: [0.1, 0.1, 0.1, 0.1] as [number, number, number, number],
  }));
  const lines = Array.from({ length: lineCount }, (_, index) => ({
    text: `${prefix}-line-${index}`,
    confidence: 98,
    words: words.length > 0 ? [words[index % words.length]] : [],
    bbox: [0.1, 0.2, 0.3, 0.04] as [number, number, number, number],
  }));
  const tables = Array.from({ length: tableCount }, (_, index) => ({
    bbox: [0.2, 0.2, 0.4, 0.3] as [number, number, number, number],
    cells: [
      {
        row: 1,
        col: 1,
        rowSpan: 1,
        colSpan: 1,
        text: `${prefix}-cell-${index}`,
        bbox: [0.2, 0.2, 0.2, 0.1] as [number, number, number, number],
        confidence: 97,
      },
    ],
    rowCount: 1,
    colCount: 1,
  }));
  return { words, lines, tables };
}

function response(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function lifecycleProjectResponse(demo: boolean): ProjectResponse {
  return {
    id: PUBLIC_ID,
    dbId: PROJECT_DB_ID,
    name: demo ? "Demo successor" : "Authenticated project",
    dataUrl: "s3://private/project.json",
    pdfUrl: "s3://private/project.pdf",
    numPages: 20,
    status: "ready",
    summaries: null,
    projectIntelligence: null,
    pages: [{ pageNumber: PAGE, name: `Page ${PAGE}`, drawingNumber: null }],
    ...(demo ? { demoConfig: {} } : {}),
  };
}

async function activateLifecycle(demo = false): Promise<OpenProjectHandle> {
  const lifecycleFetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const prefix = demo ? "/api/demo" : "/api";
    if (url === `${prefix}/projects/${PUBLIC_ID}`) {
      return response(lifecycleProjectResponse(demo));
    }
    if (url === `${prefix}/projects/${PUBLIC_ID}/pages?from=1&to=15`) {
      return response({ from: 1, to: 15, pages: [], annotations: [] });
    }
    if (!demo && url === `/api/annotation-groups?projectId=${PUBLIC_ID}`) {
      return response({ groups: [], memberships: [] });
    }
    throw new Error(`unexpected lifecycle request: ${url}`);
  });
  vi.stubGlobal("fetch", lifecycleFetch);
  const handle = openProject(queryClient, PUBLIC_ID, { demo });
  expect((await handle.result).status).toBe("opened");
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  return handle;
}

function renderTab(pageNumber = PAGE) {
  return render(<TextractTab pageNumber={pageNumber} />, { wrapper });
}

function statsCard(title: string): HTMLElement {
  const heading = screen.getByText(title);
  const card = heading.parentElement;
  if (!card) throw new Error(`missing stats card for ${title}`);
  return card;
}

function expectStat(card: HTMLElement, label: string, value: string | number): void {
  const labelNode = within(card).getByText(label);
  expect(labelNode.nextElementSibling).toHaveTextContent(String(value));
}

function expectCurrentStats(
  words: number,
  lines: number,
  tables: number,
  pageNumber = PAGE,
): void {
  const card = statsCard(`Current cached stats — page ${pageNumber}`);
  expectStat(card, "Words", words);
  expectStat(card, "Lines", lines);
  expectStat(card, "Tables", tables);
}

beforeEach(() => {
  queryClient = new QueryClient();
  resetProjectData();
  setViewerStoreStateForTest({
    projectId: PROJECT_DB_ID,
    publicId: PUBLIC_ID,
    isDemo: false,
    pageNumber: PAGE,
    numPages: 20,
  });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TextractTab rerun writer", () => {
  it("TW1 sends the exact publicId request, stays server-first, then replaces truthy data and shows response stats", async () => {
    const oldPage = textractFixture(1, 2, 0, "old");
    const newPage = textractFixture(3, 4, 1, "new");
    seedTextract(queryClient, { [PAGE]: oldPage });
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    renderTab();

    expectCurrentStats(1, 2, 0);
    fireEvent.click(screen.getByRole("button", { name: "Re-run Textract" }));

    // Anchor beyond the event/notification turn before asserting the server-first absence.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledWith("/api/pages/textract-rerun", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicId: PUBLIC_ID, pageNumber: PAGE }),
    });
    expect(screen.getByRole("button", { name: "Re-running Textract…" })).toBeDisabled();
    expectCurrentStats(1, 2, 0);
    expect(screen.queryByText("Re-run complete")).not.toBeInTheDocument();

    pending.resolve(
      response({
        textractData: newPage,
        durationMs: 2500,
        // Deliberately differ from payload lengths: the result card must display server stats.
        stats: { wordCount: 301, lineCount: 401, tableCount: 101 },
      }),
    );

    await waitFor(() => expect(screen.getByText("Re-run complete")).toBeInTheDocument());
    expectCurrentStats(3, 4, 1);
    const resultCard = statsCard("Re-run complete");
    expectStat(resultCard, "Duration", "2.5s");
    expectStat(resultCard, "New word count", 301);
    expectStat(resultCard, "New line count", 401);
    expectStat(resultCard, "New table count", 101);
  });

  it("TW2 permits only one dispatch while the first request is loading", async () => {
    seedTextract(queryClient, { [PAGE]: textractFixture(1, 1, 0, "old") });
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    renderTab();

    const button = screen.getByRole("button", { name: "Re-run Textract" });
    fireEvent.click(button);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const loadingButton = screen.getByRole("button", { name: "Re-running Textract…" });
    expect(loadingButton).toBeDisabled();
    fireEvent.click(loadingButton);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    pending.resolve(
      response({
        textractData: null,
        durationMs: 10,
        stats: { wordCount: 0, lineCount: 0, tableCount: 0 },
      }),
    );
    await waitFor(() => expect(screen.getByText("Re-run complete")).toBeInTheDocument());
  });

  it("TW2 dispatches nothing without a public project id", () => {
    setViewerStoreStateForTest({ publicId: "" });
    renderTab();

    const button = screen.getByRole("button", { name: "Re-run Textract" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("TR-D4 disables demo reruns, explains read-only mode, and dispatches nothing", () => {
    setViewerStoreStateForTest({ isDemo: true });
    seedTextract(queryClient, { [PAGE]: textractFixture(1, 1, 0, "old") });
    renderTab();

    const button = screen.getByRole("button", { name: "Re-run Textract" });
    expect(button).toBeDisabled();
    expect(
      screen.getByText("Demo projects are read-only. Textract re-runs are unavailable in demo mode."),
    ).toBeInTheDocument();
    fireEvent.click(button);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "non-OK dual-envelope response",
      install: () =>
        fetchMock.mockResolvedValueOnce(
          response({ error: { code: "TEXTRACT_FAILED", message: "AWS refused the rerun" } }, false, 502),
        ),
      message: "AWS refused the rerun",
    },
    {
      name: "network rejection",
      install: () => fetchMock.mockRejectedValueOnce(new Error("network disconnected")),
      message: "network disconnected",
    },
  ])("TW3 retains old page data and displays the existing error for $name", async ({ install, message }) => {
    seedTextract(queryClient, { [PAGE]: textractFixture(2, 3, 1, "old") });
    install();
    renderTab();

    fireEvent.click(screen.getByRole("button", { name: "Re-run Textract" }));

    await waitFor(() => expect(screen.getByText(message)).toBeInTheDocument());
    expect(screen.getByText("Re-run failed")).toBeInTheDocument();
    expectCurrentStats(2, 3, 1);
    expect(screen.queryByText("Re-run complete")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Re-run Textract" })).toBeEnabled();
  });

  it.each([
    { name: "null", textractData: null },
    { name: "omitted", textractData: undefined },
  ])("TW4 keeps old page data but shows stats when OK textractData is $name", async ({ textractData }) => {
    seedTextract(queryClient, { [PAGE]: textractFixture(2, 3, 1, "old") });
    const body: Record<string, unknown> = {
      durationMs: 1234,
      stats: { wordCount: 700, lineCount: 800, tableCount: 900 },
    };
    if (textractData !== undefined) body.textractData = textractData;
    fetchMock.mockResolvedValueOnce(response(body));
    renderTab();

    fireEvent.click(screen.getByRole("button", { name: "Re-run Textract" }));

    await waitFor(() => expect(screen.getByText("Re-run complete")).toBeInTheDocument());
    expectCurrentStats(2, 3, 1);
    const resultCard = statsCard("Re-run complete");
    expectStat(resultCard, "Duration", "1.2s");
    expectStat(resultCard, "New word count", 700);
    expectStat(resultCard, "New line count", 800);
    expectStat(resultCard, "New table count", 900);
    expect(screen.queryByText("Re-run failed")).not.toBeInTheDocument();
  });

  it("I4 cancels GETs both before POST and before adoption so an abort-ignoring stale GET cannot overwrite rerun", async () => {
    const oldPage = textractFixture(1, 1, 0, "old");
    const rerunPage = textractFixture(3, 3, 1, "rerun-authoritative");
    const stalePage = textractFixture(9, 9, 0, "late-get-stale");
    seedTextract(queryClient, { [PAGE]: oldPage });
    const key = queryKeys.textract.page(PUBLIC_ID, PAGE);

    let earlySignal: AbortSignal | undefined;
    const earlyGet = deferred<TextractPageData>();
    const earlyRequest = queryClient.fetchQuery({
      queryKey: key,
      queryFn: ({ signal }) => {
        earlySignal = signal;
        return earlyGet.promise;
      },
      staleTime: 0,
      retry: false,
    }).catch(() => undefined);

    const rerunResponse = deferred<Response>();
    fetchMock.mockReturnValueOnce(rerunResponse.promise);
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: "Re-run Textract" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(earlySignal?.aborted).toBe(true);

    // A new lazy GET may begin while Textract is doing the expensive POST. The facade replacement's
    // second exact cancel must defeat it even when its transport ignores AbortSignal physically.
    let lateSignal: AbortSignal | undefined;
    const lateGet = deferred<TextractPageData>();
    const lateRequest = queryClient.fetchQuery({
      queryKey: key,
      queryFn: ({ signal }) => {
        lateSignal = signal;
        return lateGet.promise;
      },
      staleTime: 0,
      retry: false,
    }).catch(() => undefined);
    expect(lateSignal?.aborted).toBe(false);

    rerunResponse.resolve(
      response({
        textractData: rerunPage,
        durationMs: 100,
        stats: { wordCount: 3, lineCount: 3, tableCount: 1 },
      }),
    );
    await waitFor(() => expect(screen.getByText("Re-run complete")).toBeInTheDocument());
    expect(lateSignal?.aborted).toBe(true);
    expectCurrentStats(3, 3, 1);

    await act(async () => {
      earlyGet.resolve(stalePage);
      lateGet.resolve(stalePage);
      await Promise.all([earlyRequest, lateRequest]);
    });
    expectCurrentStats(3, 3, 1);
  });

  it.each([
    { name: "project", nextPublicId: "other-project", nextPage: PAGE },
    { name: "page", nextPublicId: PUBLIC_ID, nextPage: PAGE + 1 },
  ])("I5 makes a pending rerun a total no-op after a $name switch", async ({ nextPublicId, nextPage }) => {
    const oldPage = textractFixture(2, 2, 0, "old-origin");
    const nextPageData = textractFixture(4, 4, 1, "new-identity");
    const obsoleteResponse = textractFixture(8, 8, 1, "obsolete-response");
    seedTextract(queryClient, { [PAGE]: oldPage }, PUBLIC_ID);
    seedTextract(queryClient, { [nextPage]: nextPageData }, nextPublicId);
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    const view = renderTab();

    fireEvent.click(screen.getByRole("button", { name: "Re-run Textract" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    act(() => {
      setViewerStoreStateForTest({ publicId: nextPublicId, pageNumber: nextPage });
      view.rerender(<TextractTab pageNumber={nextPage} />);
    });
    await waitFor(() => expectCurrentStats(4, 4, 1, nextPage));
    expect(screen.getByRole("button", { name: "Re-run Textract" })).toBeEnabled();

    await act(async () => {
      pending.resolve(
        response({
          textractData: obsoleteResponse,
          durationMs: 200,
          stats: { wordCount: 8, lineCount: 8, tableCount: 1 },
        }),
      );
      await pending.promise;
    });
    expect(screen.queryByText("Re-run complete")).not.toBeInTheDocument();
    expectCurrentStats(4, 4, 1, nextPage);

    // Return to the captured identity: no obsolete cache adoption occurred there either.
    act(() => {
      setViewerStoreStateForTest({ publicId: PUBLIC_ID, pageNumber: PAGE });
      view.rerender(<TextractTab pageNumber={PAGE} />);
    });
    await waitFor(() => expectCurrentStats(2, 2, 0));
  });

  it("I5 rechecks identity after the second cancel so teardown cannot be followed by stale adoption", async () => {
    const oldPage = textractFixture(2, 2, 0, "old-origin");
    const obsoleteResponse = textractFixture(8, 8, 1, "obsolete-response");
    seedTextract(queryClient, { [PAGE]: oldPage }, PUBLIC_ID);
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    const view = renderTab();

    fireEvent.click(screen.getByRole("button", { name: "Re-run Textract" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // The first cancel has already completed because POST started. Hold only the facade's second
    // cancel, then switch identity at that exact async boundary. Without the post-cancel generation
    // guard the obsolete response recreates the old prefix after teardown.
    const secondCancel = deferred<void>();
    const cancelSpy = vi
      .spyOn(queryClient, "cancelQueries")
      .mockImplementationOnce(() => secondCancel.promise);
    pending.resolve(
      response({
        textractData: obsoleteResponse,
        durationMs: 200,
        stats: { wordCount: 8, lineCount: 8, tableCount: 1 },
      }),
    );
    await waitFor(() => expect(cancelSpy).toHaveBeenCalledTimes(1));

    act(() => {
      setViewerStoreStateForTest({ publicId: "other-project", pageNumber: PAGE + 1 });
      view.rerender(<TextractTab pageNumber={PAGE + 1} />);
    });
    await act(async () => {
      secondCancel.resolve();
      await secondCancel.promise;
      await Promise.resolve();
    });
    expect(screen.queryByText("Re-run complete")).not.toBeInTheDocument();

    act(() => {
      setViewerStoreStateForTest({ publicId: PUBLIC_ID, pageNumber: PAGE });
      view.rerender(<TextractTab pageNumber={PAGE} />);
    });
    await waitFor(() => expectCurrentStats(2, 2, 0));
  });

  it.each([
    { successorDemo: false, transition: "auth to auth" },
    { successorDemo: true, transition: "auth to demo" },
  ])(
    "I5 retires rerun cache and UI settlement across a same-ID $transition lifecycle",
    async ({ successorDemo }) => {
      const lifecycleA = await activateLifecycle(false);
      const snapshotA = captureProjectLifecycle(queryClient);
      const oldPage = textractFixture(2, 2, 0, "lifecycle-A");
      seedTextract(queryClient, { [PAGE]: oldPage }, PUBLIC_ID);
      setViewerStoreStateForTest({
        projectId: PROJECT_DB_ID,
        publicId: PUBLIC_ID,
        isDemo: false,
        pageNumber: PAGE,
        numPages: 20,
      });
      const pending = deferred<Response>();
      const successorPending = new Promise<Response>(() => {});
      fetchMock.mockImplementation((input: RequestInfo | URL) => {
        if (String(input) === "/api/pages/textract-rerun") return pending.promise;
        return successorPending;
      });
      renderTab();
      fireEvent.click(screen.getByRole("button", { name: "Re-run Textract" }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
        "/api/pages/textract-rerun",
        expect.any(Object),
      ));

      // Hold B at its first exact cleanup await. This prevents the lifecycle fixture itself from
      // removing B's prepared Textract sentinel while still allowing A's second page cancel.
      const cleanupGate = deferred<void>();
      const originalCancel = queryClient.cancelQueries.bind(queryClient);
      const cancelSpy = vi.spyOn(queryClient, "cancelQueries").mockImplementation(
        (filters, options) => {
          const key = (filters as { queryKey?: readonly unknown[] }).queryKey;
          if (JSON.stringify(key) === JSON.stringify(queryKeys.qtoWorkflows.all(PUBLIC_ID))) {
            return cleanupGate.promise;
          }
          return originalCancel(filters, options);
        },
      );
      const successorPage = textractFixture(4, 5, 1, "successor-B");
      let lifecycleB!: OpenProjectHandle;
      await act(async () => {
        lifecycleB = openProject(queryClient, PUBLIC_ID, { demo: successorDemo });
        // B's lifecycle token is installed now. Preserve the old render's selector values until A
        // settles so the stale callback cannot pass merely by borrowing a snapshot captured late.
        setViewerStoreStateForTest({
          projectId: PROJECT_DB_ID,
          publicId: PUBLIC_ID,
          isDemo: false,
          pageNumber: PAGE,
          numPages: 20,
        });
        seedTextract(queryClient, { [PAGE]: successorPage }, PUBLIC_ID);
        pending.resolve(response({
          textractData: textractFixture(8, 8, 1, "obsolete-A"),
          durationMs: 800,
          stats: { wordCount: 800, lineCount: 800, tableCount: 80 },
        }));
        for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
      });

      expect.soft(isCurrentProjectLifecycle(queryClient, snapshotA)).toBe(false);
      expect.soft(isCurrentProjectLifecycle(
        queryClient,
        captureProjectLifecycle(queryClient),
      )).toBe(true);
      expect.soft(queryClient.getQueryData(
        queryKeys.textract.page(PUBLIC_ID, PAGE),
      )).toEqual(successorPage);
      expect.soft(screen.queryByText("Re-run complete")).not.toBeInTheDocument();
      const currentCard = statsCard(`Current cached stats — page ${PAGE}`);
      expect.soft(within(currentCard).getByText("Words").nextElementSibling)
        .toHaveTextContent("4");
      expect.soft(within(currentCard).getByText("Lines").nextElementSibling)
        .toHaveTextContent("5");
      expect.soft(within(currentCard).getByText("Tables").nextElementSibling)
        .toHaveTextContent("1");

      lifecycleB.dispose();
      cleanupGate.resolve();
      await act(async () => cleanupGate.promise);
      cancelSpy.mockRestore();
      lifecycleA.dispose();
    },
  );

  it("I5 makes a completion after unmount a cache and UI no-op", async () => {
    const oldPage = textractFixture(2, 2, 0, "old");
    seedTextract(queryClient, { [PAGE]: oldPage });
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    const view = renderTab();

    fireEvent.click(screen.getByRole("button", { name: "Re-run Textract" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    view.unmount();

    await act(async () => {
      pending.resolve(
        response({
          textractData: textractFixture(7, 7, 1, "obsolete-unmounted"),
          durationMs: 300,
          stats: { wordCount: 7, lineCount: 7, tableCount: 1 },
        }),
      );
      await pending.promise;
    });

    renderTab();
    await waitFor(() => expectCurrentStats(2, 2, 0));
    expect(screen.queryByText("Re-run complete")).not.toBeInTheDocument();
  });
});
