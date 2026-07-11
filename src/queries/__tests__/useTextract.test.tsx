// [refactor jul11 P2.2⑧ C2] Hook-level notification topology for the production-dead facade.
// Narrow observers are data-only and disabled; the PageSidebar exception observes a filtered bounded
// snapshot without manufacturing one Query observer per requested project page.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  focusManager,
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  ensureTextractPage,
  replaceTextractForPage,
} from "@/queries/textractCache";
import { queryKeys } from "@/queries/queryKeys";
import {
  useCachedTextractForPages,
  useTextractForPage,
} from "@/queries/useTextract";
import { useViewerStore } from "@/stores/viewerStore";
import type { TextractPageData } from "@/types";

function freshClient(): QueryClient {
  return new QueryClient();
}

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function pageData(label: string): TextractPageData {
  return {
    lines: [],
    words: [{ text: label, confidence: 99, bbox: [0.1, 0.2, 0.3, 0.04] }],
  };
}

function response(body: unknown): Response {
  return { ok: true, json: vi.fn().mockResolvedValue(body) } as unknown as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  useViewerStore.getState().resetProjectData();
  useViewerStore.setState({ publicId: "P" });
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: unknown) => {
    throw new Error(`unexpected fetch from disabled Textract observer: ${String(url)}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
});

describe("useTextractForPage", () => {
  it("Q4 is disabled/data-only: zero mount fetch, matching replacement one render, unrelated/status zero", async () => {
    const qc = freshClient();
    let renders = 0;
    const { result } = renderHook(
      () => {
        renders += 1;
        return useTextractForPage(1);
      },
      { wrapper: wrapper(qc) },
    );
    const baseline = renders;

    expect(result.current).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    const pageOneQuery = qc.getQueryCache().find({
      queryKey: queryKeys.textract.page("P", 1),
      exact: true,
    })!;
    expect(pageOneQuery.getObserversCount()).toBe(1);
    expect(pageOneQuery.state.fetchStatus).toBe("idle");

    await act(async () => {
      await replaceTextractForPage(qc, "P", 2, pageData("unrelated"));
    });
    expect(renders).toBe(baseline);

    const first = pageData("same-json");
    await act(async () => {
      await replaceTextractForPage(qc, "P", 1, first);
    });
    await waitFor(() => expect(result.current).toBe(first));
    expect(renders).toBe(baseline + 1);

    // structuralSharing:false is observable: equal JSON still adopts the server's new page reference.
    const second = pageData("same-json");
    await act(async () => {
      await replaceTextractForPage(qc, "P", 1, second);
    });
    await waitFor(() => expect(result.current).toBe(second));
    expect(second).not.toBe(first);
    expect(renders).toBe(baseline + 2);

    act(() => {
      pageOneQuery.setState({ fetchStatus: "fetching" });
      pageOneQuery.setState({ fetchStatus: "idle" });
    });
    await act(async () => Promise.resolve());
    expect(renders).toBe(baseline + 2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Q5 observed null shell stays idle/undefined, retries only on next explicit ensure, then publishes", async () => {
    const qc = freshClient();
    let renders = 0;
    const { result } = renderHook(
      () => {
        renders += 1;
        return useTextractForPage(1);
      },
      { wrapper: wrapper(qc) },
    );
    const baseline = renders;
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(response({ textractData: null }));

    await expect(
      ensureTextractPage(qc, { publicId: "P", pageNumber: 1 }),
    ).resolves.toBeUndefined();
    expect(result.current).toBeUndefined();
    expect(renders).toBe(baseline);
    const shell = qc.getQueryCache().find({
      queryKey: queryKeys.textract.page("P", 1),
      exact: true,
    })!;
    expect(shell.state.data).toBeUndefined();
    expect(shell.state.fetchStatus).toBe("idle");
    expect(shell.getObserversCount()).toBe(1);

    // Disabled observers cannot turn focus/reconnect into an uncharacterized retry.
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    });
    await act(async () => Promise.resolve());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const recovered = pageData("now-ready");
    fetchMock.mockResolvedValueOnce(response({ textractData: recovered }));
    await expect(
      ensureTextractPage(qc, { publicId: "P", pageNumber: 1 }),
    ).resolves.toBe(recovered);
    await waitFor(() => expect(result.current).toBe(recovered));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(renders).toBe(baseline + 1);
  });

  it("Q1 follows live publicId and never exposes another project's same page", async () => {
    const qc = freshClient();
    const dataA = pageData("A");
    const dataB = pageData("B");
    await replaceTextractForPage(qc, "A", 1, dataA);
    await replaceTextractForPage(qc, "B", 1, dataB);
    useViewerStore.setState({ publicId: "A" });

    const { result } = renderHook(() => useTextractForPage(1), {
      wrapper: wrapper(qc),
    });
    expect(result.current).toBe(dataA);

    act(() => useViewerStore.setState({ publicId: "B" }));
    await waitFor(() => expect(result.current).toBe(dataB));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("useCachedTextractForPages", () => {
  it("Q12 is passive and filtered: zero observers/fetches; irrelevant changes zero renders; relevant exact one", async () => {
    const qc = freshClient();
    let renders = 0;
    const { result, rerender } = renderHook(
      ({ requested }: { requested: readonly number[] }) => {
        renders += 1;
        return useCachedTextractForPages(requested);
      },
      {
        wrapper: wrapper(qc),
        initialProps: { requested: [1] },
      },
    );
    const baseline = renders;
    const initialEmpty = result.current;
    expect(initialEmpty).toEqual({});
    expect(Object.isFrozen(initialEmpty)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();

    const pageTwo = pageData("two");
    await act(async () => {
      await replaceTextractForPage(qc, "P", 2, pageTwo);
    });
    expect(renders).toBe(baseline);
    const pageTwoQuery = qc.getQueryCache().find({
      queryKey: queryKeys.textract.page("P", 2),
      exact: true,
    })!;
    expect(pageTwoQuery.getObserversCount()).toBe(0);

    act(() => {
      pageTwoQuery.setState({ fetchStatus: "fetching" });
      pageTwoQuery.setState({ fetchStatus: "idle" });
    });
    await act(async () => Promise.resolve());
    expect(renders).toBe(baseline);

    const pageOne = pageData("one");
    await act(async () => {
      await replaceTextractForPage(qc, "P", 1, pageOne);
    });
    await waitFor(() => expect(result.current[1]).toBe(pageOne));
    expect(renders).toBe(baseline + 1);
    expect(Object.isFrozen(result.current)).toBe(true);
    expect(
      qc.getQueryCache().find({
        queryKey: queryKeys.textract.page("P", 1),
        exact: true,
      })!.getObserversCount(),
    ).toBe(0);

    const replacement = pageData("one");
    await act(async () => {
      await replaceTextractForPage(qc, "P", 1, replacement);
    });
    await waitFor(() => expect(result.current[1]).toBe(replacement));
    expect(renders).toBe(baseline + 2);

    await act(async () => {
      qc.removeQueries({ queryKey: queryKeys.textract.page("P", 1), exact: true });
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current).toEqual({}));
    expect(renders).toBe(baseline + 3);

    // New array identity with identical normalized content preserves the empty snapshot reference.
    const emptyAfterRemoval = result.current;
    rerender({ requested: [1, 1] });
    expect(result.current).toBe(emptyAfterRemoval);

    rerender({ requested: [2] });
    expect(result.current[2]).toBe(pageTwo);
    expect(pageTwoQuery.getObserversCount()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Q12 publicId and requested-set intersection exclude other project and unrequested retained rows", async () => {
    const qc = freshClient();
    const p1 = pageData("P1");
    const p3 = pageData("P3");
    const other1 = pageData("OTHER1");
    await replaceTextractForPage(qc, "P", 1, p1);
    await replaceTextractForPage(qc, "P", 3, p3);
    await replaceTextractForPage(qc, "OTHER", 1, other1);

    const { result } = renderHook(() => useCachedTextractForPages([1, 2]), {
      wrapper: wrapper(qc),
    });
    expect(result.current).toEqual({ 1: p1 });
    expect(result.current[1]).not.toBe(other1);
    expect(result.current[3]).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
