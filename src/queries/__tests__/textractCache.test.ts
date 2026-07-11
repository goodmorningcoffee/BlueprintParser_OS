// [refactor jul11 P2.2⑧ C2] Discriminating core suite for the production-dead Textract coordinator.
// P2_DESIGN/TEXTRACT_IMPL/SPEC.md §3-6 is authoritative. These tests pin transport provenance,
// explicit Query policy, same-key dedupe/cancellation, both retention rails, live protection, passive
// revision hygiene, exact-domain teardown, and authoritative replacement ordering before C3 wiring.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  onlineManager,
  QueryClient,
  QueryObserver,
} from "@tanstack/react-query";
import {
  MAX_RETAINED_TEXTRACT_BYTES,
  MAX_RETAINED_TEXTRACT_PAGES,
  TEXTRACT_GC_TIME_MS,
  cancelTextractPage,
  clearTextractProject,
  ensureTextractPage,
  fetchTextractPage,
  getCachedTextractForPages,
  getTextractProjectRevision,
  getTextractRetentionStats,
  readTextractForPage,
  replaceTextractForPage,
  setTextractProtectedPages,
  subscribeTextractProject,
  textractPageQueryOptions,
} from "@/queries/textractCache";
import { queryKeys } from "@/queries/queryKeys";
import type { TextractPageData } from "@/types";

function freshClient(): QueryClient {
  return new QueryClient(); // production Providers.tsx also uses pure defaults
}

function pageData(label: string, textBytes = 0): TextractPageData {
  return {
    lines: [],
    words: [
      {
        text: textBytes > 0 ? `${label}:${"x".repeat(textBytes)}` : label,
        confidence: 99,
        bbox: [0.1, 0.2, 0.3, 0.04],
      },
    ],
  };
}

function response(body: unknown, ok = true, json = vi.fn().mockResolvedValue(body)): Response {
  return { ok, json } as unknown as Response;
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

async function flushCoordinator(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  onlineManager.setOnline(true);
});

describe("Textract page options and transport", () => {
  it("Q1/Q2 pins the exact publicId/page key and every domain option", () => {
    const options = textractPageQueryOptions("project-A", 7);
    expect(MAX_RETAINED_TEXTRACT_BYTES).toBe(8 * 1024 * 1024);
    expect(TEXTRACT_GC_TIME_MS).toBe(600_000);
    expect(options.queryKey).toEqual(["project", "project-A", "textract", 7]);
    expect(options.staleTime).toBe(Infinity);
    expect(options.gcTime).toBe(TEXTRACT_GC_TIME_MS);
    expect(options.retry).toBe(false);
    expect(options.retryOnMount).toBe(false);
    expect(options.refetchOnMount).toBe(false);
    expect(options.refetchOnWindowFocus).toBe(false);
    expect(options.refetchOnReconnect).toBe(false);
    expect(options.refetchInterval).toBe(false);
    expect(options.networkMode).toBe("always");
    expect(options.structuralSharing).toBe(false);
  });

  it("Q3 sends encoded publicId + page + signal + no-store; non-OK never parses JSON", async () => {
    const data = pageData("seven");
    const json = vi.fn().mockResolvedValue({ textractData: data });
    const fetchMock = vi.fn().mockResolvedValue(response(undefined, true, json));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await expect(fetchTextractPage("A/B ?", 7, controller.signal)).resolves.toBe(data);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/pages/textract?publicId=A%2FB%20%3F&pageNumber=7",
      { signal: controller.signal, cache: "no-store" },
    );
    expect(json).toHaveBeenCalledTimes(1);

    const forbiddenJson = vi.fn();
    fetchMock.mockResolvedValueOnce(response(undefined, false, forbiddenJson));
    await expect(fetchTextractPage("A", 8, controller.signal)).resolves.toBeNull();
    expect(forbiddenJson).not.toHaveBeenCalled();
  });

  it("Q2 networkMode always performs one offline attempt; retry remains disabled", async () => {
    onlineManager.setOnline(false);
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("offline"));
    vi.stubGlobal("fetch", fetchMock);
    const qc = freshClient();

    await expect(
      ensureTextractPage(qc, { publicId: "P", pageNumber: 1 }),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      qc.getQueryCache().find({
        queryKey: queryKeys.textract.page("P", 1),
        exact: true,
      }),
    ).toBeUndefined();
  });

  it("Q2 finite 10-minute GC removes an unobserved retained page, not one millisecond early", async () => {
    vi.useFakeTimers();
    const qc = freshClient();
    await replaceTextractForPage(qc, "P", 1, pageData("one"));
    await flushCoordinator();

    vi.advanceTimersByTime(TEXTRACT_GC_TIME_MS - 1);
    expect(qc.getQueryData(queryKeys.textract.page("P", 1))).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(qc.getQueryData(queryKeys.textract.page("P", 1))).toBeUndefined();
  });
});

describe("ensure/read/replace races", () => {
  it("Q1 isolates pages and projects; imperative reads create zero observers", async () => {
    const qc = freshClient();
    const a1 = pageData("A1");
    const a2 = pageData("A2");
    const b1 = pageData("B1");
    await replaceTextractForPage(qc, "A", 1, a1);
    await replaceTextractForPage(qc, "A", 2, a2);
    await replaceTextractForPage(qc, "B", 1, b1);

    const query = qc.getQueryCache().find({
      queryKey: queryKeys.textract.page("A", 1),
      exact: true,
    })!;
    expect(query.getObserversCount()).toBe(0);
    expect(readTextractForPage(qc, "A", 1)).toBe(a1);
    expect(query.getObserversCount()).toBe(0);
    expect(readTextractForPage(qc, "A", 2)).toBe(a2);
    expect(readTextractForPage(qc, "B", 1)).toBe(b1);
    expect(readTextractForPage(qc, "B", 2)).toBeUndefined();
  });

  it("Q5 cleans null, non-OK, JSON, network, and cancellation shells with no retry", async () => {
    const cases: Array<() => Promise<Response>> = [
      async () => response({ ignored: true }, false),
      async () => response({ textractData: null }),
      async () => response({}),
      async () => ({ ok: true, json: vi.fn().mockRejectedValue(new SyntaxError("bad json")) } as unknown as Response),
      async () => Promise.reject(new TypeError("network")),
    ];

    for (let index = 0; index < cases.length; index += 1) {
      const qc = freshClient();
      const fetchMock = vi.fn().mockImplementation(cases[index]);
      vi.stubGlobal("fetch", fetchMock);
      await expect(
        ensureTextractPage(qc, { publicId: "P", pageNumber: index + 1 }),
      ).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(
        qc.getQueryCache().find({
          queryKey: queryKeys.textract.page("P", index + 1),
          exact: true,
        }),
      ).toBeUndefined();
    }

    const qc = freshClient();
    const pending = deferred<Response>();
    let signal: AbortSignal | undefined;
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init?: RequestInit) => {
        signal = init?.signal as AbortSignal | undefined;
        return pending.promise; // deliberately ignores physical abort
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const attempt = ensureTextractPage(qc, { publicId: "P", pageNumber: 9 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await cancelTextractPage(qc, "P", 9);
    await expect(attempt).resolves.toBeUndefined();
    expect(signal?.aborted).toBe(true);
    pending.resolve(response({ textractData: pageData("too-late") }));
    await flushCoordinator();
    expect(qc.getQueryData(queryKeys.textract.page("P", 9))).toBeUndefined();
  });

  it("Q6 concurrent same-key ensure calls dedupe to one network request", async () => {
    const qc = freshClient();
    const pending = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValue(pending.promise);
    vi.stubGlobal("fetch", fetchMock);
    const expected = pageData("deduped");

    const first = ensureTextractPage(qc, { publicId: "P", pageNumber: 3 });
    const second = ensureTextractPage(qc, { publicId: "P", pageNumber: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    pending.resolve(response({ textractData: expected }));

    await expect(Promise.all([first, second])).resolves.toEqual([expected, expected]);
    expect(qc.getQueryData(queryKeys.textract.page("P", 3))).toBe(expected);
  });

  it("Q15 authoritative replacement cancels an abort-ignoring older GET and cannot be overwritten", async () => {
    const qc = freshClient();
    const pending = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValue(pending.promise);
    vi.stubGlobal("fetch", fetchMock);
    const oldAttempt = ensureTextractPage(qc, { publicId: "P", pageNumber: 4 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const authoritative = pageData("rerun-new");
    await replaceTextractForPage(qc, "P", 4, authoritative, [3, 4, 5]);
    expect(qc.getQueryData(queryKeys.textract.page("P", 4))).toBe(authoritative);

    pending.resolve(response({ textractData: pageData("lazy-old") }));
    await expect(oldAttempt).resolves.toBeUndefined();
    await flushCoordinator();
    expect(qc.getQueryData(queryKeys.textract.page("P", 4))).toBe(authoritative);
  });
});

describe("central count/byte retention and live eligibility", () => {
  it("Q7 caps at 12 with exact LRU ordering; action read touches the victim order", async () => {
    const qc = freshClient();
    for (let page = 1; page <= MAX_RETAINED_TEXTRACT_PAGES; page += 1) {
      await replaceTextractForPage(qc, "P", page, pageData(String(page)));
    }
    expect(getTextractRetentionStats(qc, "P").retainedCount).toBe(12);

    // Page 1 was oldest; an invocation-time read makes it newest, so page 2 must be evicted next.
    expect(readTextractForPage(qc, "P", 1)).toBeDefined();
    await replaceTextractForPage(qc, "P", 13, pageData("13"));
    expect(qc.getQueryData(queryKeys.textract.page("P", 1))).toBeDefined();
    expect(qc.getQueryData(queryKeys.textract.page("P", 2))).toBeUndefined();
    expect(getTextractRetentionStats(qc, "P").retainedPageNumbers).toEqual([
      1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
    ]);
  });

  it("Q7 a truthy ensure hit performs no transport and refreshes exact LRU order", async () => {
    const qc = freshClient();
    for (let page = 1; page <= MAX_RETAINED_TEXTRACT_PAGES; page += 1) {
      await replaceTextractForPage(qc, "P", page, pageData(String(page)));
    }
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const pageOne = qc.getQueryData<TextractPageData>(queryKeys.textract.page("P", 1));
    await expect(
      ensureTextractPage(qc, { publicId: "P", pageNumber: 1 }),
    ).resolves.toBe(pageOne);
    expect(fetchMock).not.toHaveBeenCalled();

    await replaceTextractForPage(qc, "P", 13, pageData("13"));
    expect(qc.getQueryData(queryKeys.textract.page("P", 1))).toBe(pageOne);
    expect(qc.getQueryData(queryKeys.textract.page("P", 2))).toBeUndefined();
  });

  it("Q7 passive aggregate reads do not refresh LRU order", async () => {
    const qc = freshClient();
    for (let page = 1; page <= MAX_RETAINED_TEXTRACT_PAGES; page += 1) {
      await replaceTextractForPage(qc, "P", page, pageData(String(page)));
    }
    const pageOne = qc.getQueryData<TextractPageData>(queryKeys.textract.page("P", 1));

    expect(getCachedTextractForPages(qc, "P", new Set([1]))[1]).toBe(pageOne);
    await replaceTextractForPage(qc, "P", 13, pageData("13"));

    expect(qc.getQueryData(queryKeys.textract.page("P", 1))).toBeUndefined();
    expect(qc.getQueryData(queryKeys.textract.page("P", 2))).toBeDefined();
  });

  it("Q8 measures UTF-8 bytes, reports them exactly, and evicts at the literal 8 MiB rail", async () => {
    const qc = freshClient();
    const literalByteLimit = 8 * 1024 * 1024;
    const multibyte = pageData("é".repeat(512));
    const multibyteJson = JSON.stringify(multibyte);
    const multibyteUtf8Bytes = new TextEncoder().encode(multibyteJson).byteLength;
    expect(multibyteUtf8Bytes).toBeGreaterThan(multibyteJson.length);

    // Make the two serialized payloads exactly 8 MiB in UTF-16 code units. A code-unit estimator
    // would retain both, while the required UTF-8 estimator crosses the byte rail and evicts page 1.
    const asciiProbe = pageData("oldest", 1);
    const asciiJsonOverhead = JSON.stringify(asciiProbe).length - 1;
    const asciiPayloadLength =
      literalByteLimit - multibyteJson.length - asciiJsonOverhead;
    const oldest = pageData("oldest", asciiPayloadLength);
    const oldestJson = JSON.stringify(oldest);
    expect(oldestJson.length + multibyteJson.length).toBe(literalByteLimit);
    expect(
      new TextEncoder().encode(oldestJson).byteLength + multibyteUtf8Bytes,
    ).toBeGreaterThan(literalByteLimit);

    await replaceTextractForPage(qc, "P", 1, oldest);
    await replaceTextractForPage(qc, "P", 2, multibyte);

    const stats = getTextractRetentionStats(qc, "P");
    expect(stats.retainedPageNumbers).toEqual([2]);
    expect(stats.estimatedBytes).toBe(multibyteUtf8Bytes);
  });

  it("Q8 byte rail evicts below 12; one oversized protected current page survives honest overage", async () => {
    const qc = freshClient();
    const halfPlus = Math.floor(MAX_RETAINED_TEXTRACT_BYTES / 2) + 4096;
    await replaceTextractForPage(qc, "P", 1, pageData("large-1", halfPlus));
    await replaceTextractForPage(qc, "P", 2, pageData("large-2", halfPlus));
    const afterTwo = getTextractRetentionStats(qc, "P");
    expect(afterTwo.retainedCount).toBe(1);
    expect(afterTwo.retainedPageNumbers).toEqual([2]);
    expect(afterTwo.estimatedBytes).toBeLessThanOrEqual(MAX_RETAINED_TEXTRACT_BYTES);

    setTextractProtectedPages(qc, "P", [9]);
    await replaceTextractForPage(
      qc,
      "P",
      9,
      pageData("oversized-current", MAX_RETAINED_TEXTRACT_BYTES + 1024),
      [9],
    );
    const protectedOverage = getTextractRetentionStats(qc, "P");
    expect(protectedOverage.retainedPageNumbers).toEqual([9]);
    expect(protectedOverage.estimatedBytes).toBeGreaterThan(MAX_RETAINED_TEXTRACT_BYTES);

    setTextractProtectedPages(qc, "P", []);
    expect(qc.getQueryData(queryKeys.textract.page("P", 9))).toBeUndefined();
  });

  it("Q9 observed and fetching oldest pages survive overage, then prune when eligible", async () => {
    const qc = freshClient();
    const observer = new QueryObserver(qc, {
      ...textractPageQueryOptions("P", 1),
      enabled: false,
    });
    const unsubscribe = observer.subscribe(() => {});
    setTextractProtectedPages(qc, "P", Array.from({ length: 12 }, (_, index) => index + 2));

    for (let page = 1; page <= 13; page += 1) {
      await replaceTextractForPage(qc, "P", page, pageData(String(page)));
    }
    expect(getTextractRetentionStats(qc, "P").retainedCount).toBe(13);
    unsubscribe();
    await flushCoordinator();
    expect(qc.getQueryData(queryKeys.textract.page("P", 1))).toBeUndefined();
    expect(getTextractRetentionStats(qc, "P").retainedCount).toBe(12);

    // Drop one protected row so page 1 can be recreated without immediate over-cap pruning. Once its
    // replacement fetch is in flight, restoring page 13 creates an honest 13-row overage in which
    // page 1 is the sole unprotected candidate but remains temporarily ineligible.
    qc.removeQueries({ queryKey: queryKeys.textract.page("P", 13), exact: true });
    await replaceTextractForPage(qc, "P", 1, pageData("old-one"));
    const pageOneQuery = qc.getQueryCache().find({
      queryKey: queryKeys.textract.page("P", 1),
      exact: true,
    })!;
    const pending = deferred<TextractPageData | null>();
    const fetchPromise = qc.fetchQuery({
      ...textractPageQueryOptions("P", 1),
      staleTime: 0,
      queryFn: () => pending.promise,
    });
    expect(pageOneQuery.state.fetchStatus).toBe("fetching");
    await replaceTextractForPage(qc, "P", 13, pageData("thirteen"));
    expect(getTextractRetentionStats(qc, "P").retainedCount).toBe(13);

    pending.resolve(pageData("new-one"));
    await fetchPromise;
    await flushCoordinator();
    expect(qc.getQueryData(queryKeys.textract.page("P", 1))).toBeUndefined();
    expect(getTextractRetentionStats(qc, "P").retainedCount).toBe(12);
  });

  it("Q10 a late old batch prunes against the latest protected set, never its captured set", async () => {
    const qc = freshClient();
    setTextractProtectedPages(qc, "P", [4, 5, 6]);
    await replaceTextractForPage(qc, "P", 4, pageData("four"), [4, 5, 6]);
    await replaceTextractForPage(qc, "P", 6, pageData("six"), [4, 5, 6]);

    const pending = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(pending.promise));
    const lateFive = ensureTextractPage(qc, {
      publicId: "P",
      pageNumber: 5,
      protectedPages: [4, 5, 6],
    });

    for (let page = 70; page <= 79; page += 1) {
      await replaceTextractForPage(qc, "P", page, pageData(String(page)));
    }
    expect(getTextractRetentionStats(qc, "P").retainedCount).toBe(12);
    setTextractProtectedPages(qc, "P", [79, 80, 81]);

    pending.resolve(response({ textractData: pageData("five-late") }));
    await expect(lateFive).resolves.toBeDefined();
    expect(qc.getQueryData(queryKeys.textract.page("P", 4))).toBeUndefined();
    expect(qc.getQueryData(queryKeys.textract.page("P", 6))).toBeDefined();
    expect(getTextractRetentionStats(qc, "P").protectedPageNumbers).toEqual([79, 80, 81]);
  });

  it("Q11 payload references/removal bump revision; status and touch do not", async () => {
    const qc = freshClient();
    const listener = vi.fn();
    const unsubscribe = subscribeTextractProject(qc, "P", listener);
    expect(getTextractProjectRevision(qc, "P")).toBe(0);

    const data = pageData("one");
    await replaceTextractForPage(qc, "P", 1, data);
    expect(getTextractProjectRevision(qc, "P")).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);

    readTextractForPage(qc, "P", 1);
    const query = qc.getQueryCache().find({
      queryKey: queryKeys.textract.page("P", 1),
      exact: true,
    })!;
    query.setState({ fetchStatus: "fetching" });
    query.setState({ fetchStatus: "idle" });
    await flushCoordinator();
    expect(getTextractProjectRevision(qc, "P")).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);

    qc.removeQueries({ queryKey: queryKeys.textract.page("P", 1), exact: true });
    expect(getTextractProjectRevision(qc, "P")).toBe(2);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(getTextractRetentionStats(qc, "P").retainedCount).toBe(0);
    unsubscribe();
  });
});

describe("exact project cleanup", () => {
  it("Q13 cancels/removes only the captured Textract prefix and preserves every sibling domain", async () => {
    const qc = freshClient();
    await replaceTextractForPage(qc, "A", 1, pageData("A1"));
    await replaceTextractForPage(qc, "B", 1, pageData("B1"));
    qc.setQueryData(queryKeys.chatMessages.all("A"), ["chat"]);
    qc.setQueryData(queryKeys.annotations.all("A"), ["annotation"]);
    qc.setQueryData(queryKeys.pagesWindow.active("A"), { range: "window" });
    qc.setQueryData(queryKeys.takeoff.items("A"), ["item"]);

    const pending = deferred<Response>();
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        signal = init?.signal as AbortSignal | undefined;
        return pending.promise;
      }),
    );
    const inFlight = ensureTextractPage(qc, { publicId: "A", pageNumber: 2 });
    await clearTextractProject(qc, "A");
    await expect(inFlight).resolves.toBeUndefined();
    expect(signal?.aborted).toBe(true);

    expect(qc.getQueriesData({ queryKey: queryKeys.textract.all("A") })).toEqual([]);
    expect(qc.getQueryData(queryKeys.textract.page("B", 1))).toBeDefined();
    expect(qc.getQueryData(queryKeys.chatMessages.all("A"))).toEqual(["chat"]);
    expect(qc.getQueryData(queryKeys.annotations.all("A"))).toEqual(["annotation"]);
    expect(qc.getQueryData(queryKeys.pagesWindow.active("A"))).toEqual({ range: "window" });
    expect(qc.getQueryData(queryKeys.takeoff.items("A"))).toEqual(["item"]);

    pending.resolve(response({ textractData: pageData("late-A2") }));
    await flushCoordinator();
    expect(qc.getQueriesData({ queryKey: queryKeys.textract.all("A") })).toEqual([]);
  });
});
