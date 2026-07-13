// @vitest-environment node
// [refactor jul13 P2.4 W1] Query-aware ParsedRegion save/delete command contract.

import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  deletePersistedParsedRegion,
  promoteParsedRegion,
  type DeletePersistedParsedRegionResponse,
  type PromoteParsedRegionResponse,
  type PromotedParsedRegion,
} from "@/lib/client-persist";
import { queryKeys } from "@/queries/queryKeys";
import { EMPTY_ACTIVE_PAGE_WINDOW } from "@/queries/pageWindowCore";
import {
  readActivePageWindow,
  readPageIntelligence,
} from "@/queries/usePageWindow";
import { deleteParsedRegion, saveParsedRegion } from "@/queries/parsedRegions";
import { useSessionStore } from "@/stores/sessionStore";
import type { PageIntelligence, ProjectSummaries } from "@/types";

vi.mock("@/lib/client-persist", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-persist")>();
  return {
    ...actual,
    deletePersistedParsedRegion: vi.fn(),
    promoteParsedRegion: vi.fn(),
  };
});

const deleteMock = vi.mocked(deletePersistedParsedRegion);
const promoteMock = vi.mocked(promoteParsedRegion);
const PROJECT_A = "project-A";
const PROJECT_B = "project-B";
const PAGE_A = 4;

function promotedRegion(overrides: Partial<PromotedParsedRegion> = {}): PromotedParsedRegion {
  return {
    id: "region-authoritative",
    type: "schedule",
    category: "door-schedule",
    bbox: [0.1, 0.2, 0.7, 0.8],
    confidence: 0.95,
    csiTags: [{ code: "08 11 13", description: "Hollow Metal Doors" }],
    data: { headers: ["TAG"], rows: [{ TAG: "D-101" }] },
    source: "user",
    ...overrides,
  };
}

function summaries(label: string): ProjectSummaries {
  return { label } as unknown as ProjectSummaries;
}

function promotionResponse(args: {
  region?: PromotedParsedRegion;
  intelligence?: PageIntelligence;
  summaries?: ProjectSummaries | null;
} = {}): PromoteParsedRegionResponse {
  const region = args.region ?? promotedRegion();
  return {
    ok: true,
    parsedRegion: region,
    updatedIntelligence: args.intelligence ?? { parsedRegions: [region as never] },
    summaries: args.summaries === undefined ? summaries("fresh-A") : args.summaries,
  };
}

function deletionResponse(args: {
  deleted?: boolean;
  intelligence?: PageIntelligence;
  summaries?: ProjectSummaries | null;
} = {}): DeletePersistedParsedRegionResponse {
  return {
    ok: true,
    deleted: args.deleted ?? true,
    updatedIntelligence: args.intelligence ?? { parsedRegions: [] },
    summaries: args.summaries === undefined ? summaries("fresh-delete") : args.summaries,
  };
}

function seedWindow(
  qc: QueryClient,
  publicId: string,
  pageNumber: number,
  intelligence: PageIntelligence,
): void {
  qc.setQueryData(queryKeys.pagesWindow.active(publicId), {
    ...EMPTY_ACTIVE_PAGE_WINDOW,
    pageIntelligence: { [pageNumber]: intelligence },
  });
  qc.setQueryData(queryKeys.annotations.all(publicId), []);
  qc.setQueryData(queryKeys.yoloTags.all(publicId), []);
}

let queryClient: QueryClient;

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  deleteMock.mockReset();
  promoteMock.mockReset();
  useSessionStore.setState(useSessionStore.getInitialState(), true);
});

afterEach(() => queryClient.clear());

describe("saveParsedRegion persistent command", () => {
  it("captures target identity and publishes parser P -> A -> S -> X against A after switching to B", async () => {
    const initialA = { rejectedTextRegionIds: ["keep-A"] } satisfies PageIntelligence;
    const sentinelB = { rejectedTextRegionIds: ["keep-B"] } satisfies PageIntelligence;
    seedWindow(queryClient, PROJECT_A, PAGE_A, initialA);
    seedWindow(queryClient, PROJECT_B, 9, sentinelB);
    const bWindowBefore = readActivePageWindow(queryClient, PROJECT_B);
    const bSummaries = summaries("stable-B");
    queryClient.setQueryData(queryKeys.summaries.all(PROJECT_B), bSummaries);

    const region = promotedRegion();
    const authoritative = {
      rejectedTextRegionIds: ["server-A"],
      parsedRegions: [region as never],
    } satisfies PageIntelligence;
    const serverSummaries = summaries("fresh-A");
    const response = promotionResponse({ region, intelligence: authoritative, summaries: serverSummaries });
    let resolvePromotion!: (value: PromoteParsedRegionResponse) => void;
    const trace: string[] = [];
    promoteMock.mockImplementationOnce(() => {
      trace.push("persist");
      return new Promise((resolve) => { resolvePromotion = resolve; });
    });

    const pageKey = JSON.stringify(queryKeys.pagesWindow.active(PROJECT_A));
    const summaryKey = JSON.stringify(queryKeys.summaries.all(PROJECT_A));
    const pageSnapshots: PageIntelligence[] = [];
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated") return;
      const key = JSON.stringify(event.query.queryKey);
      if (key === pageKey) {
        const snapshot = readPageIntelligence(queryClient, PROJECT_A, PAGE_A)!;
        pageSnapshots.push(snapshot);
        trace.push(snapshot.csiSpatialMap ? "spatial" : "adopt");
      } else if (key === summaryKey) {
        trace.push("summaries");
      }
    });

    const target = { publicId: PROJECT_A, isDemo: false, pageNumber: PAGE_A };
    const data = { headers: ["TAG"], rows: [{ TAG: "D-101" }] };
    const csiTags = [{ code: "08 11 13", description: "Hollow Metal Doors" }];
    const pending = saveParsedRegion(queryClient, target, {
      via: "parser",
      type: "schedule",
      regionId: "region-authoritative",
      bboxMinMax: [0.1, 0.2, 0.7, 0.8],
      data,
      category: "door-schedule",
      csiTags,
    });

    expect(promoteMock).toHaveBeenCalledWith({
      publicId: PROJECT_A,
      pageNumber: PAGE_A,
      type: "schedule",
      regionId: "region-authoritative",
      bbox: [0.1, 0.2, 0.7, 0.8],
      data,
      category: "door-schedule",
      csiTags,
    });

    // Mutate the exact alias while P is pending, then switch the visible session. Every tail write
    // must still use the synchronously captured A target.
    target.publicId = PROJECT_B;
    target.pageNumber = 9;
    target.isDemo = true;
    useSessionStore.setState({ publicId: PROJECT_B });
    resolvePromotion(response);

    const result = await pending;
    unsubscribe();

    expect(result).toEqual({ status: "persisted", response });
    expect(result.status === "persisted" && result.response).toBe(response);
    expect(trace).toEqual(["persist", "adopt", "summaries", "spatial"]);
    expect(pageSnapshots).toHaveLength(2);
    // TanStack structural sharing may materialize an equivalent object; adoption is authoritative
    // by value, while the command's returned response identity remains exact above.
    expect(pageSnapshots[0]).toEqual(authoritative);
    expect(pageSnapshots[1].parsedRegions).toEqual(authoritative.parsedRegions);
    expect(pageSnapshots[1].csiSpatialMap).toBeDefined();
    const spatialCodes = pageSnapshots[1].csiSpatialMap?.zones.flatMap((zone) =>
      zone.divisions.flatMap((division) => division.codes),
    );
    expect(spatialCodes).toContain("08 11 13");
    expect(queryClient.getQueryData(queryKeys.summaries.all(PROJECT_A))).toBe(serverSummaries);
    expect(readActivePageWindow(queryClient, PROJECT_B)).toBe(bWindowBefore);
    expect(queryClient.getQueryData(queryKeys.summaries.all(PROJECT_B))).toBe(bSummaries);
  });

  it("builds the exact classifier source request, retains null summaries, then recomputes spatial", async () => {
    const priorSummaries = summaries("retain-me");
    const region = promotedRegion({
      id: "classified-spec",
      type: "spec",
      category: "spec-dense-columns",
      sourceTextRegionId: "text-region-7",
    });
    const authoritative = { parsedRegions: [region as never] } satisfies PageIntelligence;
    const response = promotionResponse({ region, intelligence: authoritative, summaries: null });
    seedWindow(queryClient, PROJECT_A, PAGE_A, {});
    queryClient.setQueryData(queryKeys.summaries.all(PROJECT_A), priorSummaries);
    promoteMock.mockResolvedValueOnce(response);

    const summaryEvents: unknown[] = [];
    const summaryKey = JSON.stringify(queryKeys.summaries.all(PROJECT_A));
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === "updated" && JSON.stringify(event.query.queryKey) === summaryKey) {
        summaryEvents.push(event);
      }
    });

    await expect(saveParsedRegion(queryClient, {
      publicId: PROJECT_A,
      isDemo: false,
      pageNumber: PAGE_A,
    }, {
      via: "classifier",
      type: "spec",
      sourceTextRegionId: "text-region-7",
    })).resolves.toEqual({ status: "persisted", response });
    unsubscribe();

    expect(promoteMock).toHaveBeenCalledWith({
      publicId: PROJECT_A,
      pageNumber: PAGE_A,
      type: "spec",
      sourceTextRegionId: "text-region-7",
    });
    expect(summaryEvents).toEqual([]);
    expect(queryClient.getQueryData(queryKeys.summaries.all(PROJECT_A))).toBe(priorSummaries);
    const finalIntelligence = readPageIntelligence(queryClient, PROJECT_A, PAGE_A)!;
    expect(finalIntelligence.parsedRegions).toBe(authoritative.parsedRegions);
    expect(finalIntelligence.csiSpatialMap).toBeDefined();
  });

  it("performs no A/S/X after promotion rejection or any malformed success", async () => {
    const initial = { rejectedTextRegionIds: ["stable"] } satisfies PageIntelligence;
    const stableSummaries = summaries("stable");
    seedWindow(queryClient, PROJECT_A, PAGE_A, initial);
    queryClient.setQueryData(queryKeys.summaries.all(PROJECT_A), stableSummaries);
    const windowBefore = readActivePageWindow(queryClient, PROJECT_A);
    const failure = new Error("HTTP failure");
    promoteMock.mockRejectedValueOnce(failure);
    const updatedKeys: unknown[][] = [];
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === "updated") {
        updatedKeys.push([...event.query.queryKey]);
      }
    });

    const invocation = () => saveParsedRegion(queryClient, {
      publicId: PROJECT_A,
      isDemo: false,
      pageNumber: PAGE_A,
    }, {
      via: "classifier",
      type: "notes",
      sourceTextRegionId: "text-region-9",
    });

    await expect(invocation()).rejects.toBe(failure);
    expect(updatedKeys, "a rejected promotion must not transiently publish then roll back").toEqual([]);
    expect(readActivePageWindow(queryClient, PROJECT_A)).toBe(windowBefore);
    expect(queryClient.getQueryData(queryKeys.summaries.all(PROJECT_A))).toBe(stableSummaries);

    const region = promotedRegion();
    const malformedSuccesses: unknown[] = [
      null,
      {},
      { ok: false, parsedRegion: region, updatedIntelligence: { parsedRegions: [] }, summaries: null },
      { ok: true, parsedRegion: null, updatedIntelligence: { parsedRegions: [] }, summaries: null },
      { ok: true, parsedRegion: [], updatedIntelligence: { parsedRegions: [] }, summaries: null },
      { ok: true, parsedRegion: region, updatedIntelligence: null, summaries: null },
      { ok: true, parsedRegion: region, updatedIntelligence: [], summaries: null },
      { ok: true, parsedRegion: region, updatedIntelligence: {}, summaries: null },
      {
        ok: true,
        parsedRegion: region,
        updatedIntelligence: { parsedRegions: "corrupt" },
        summaries: null,
      },
      { ok: true, parsedRegion: region, updatedIntelligence: { parsedRegions: [] } },
      { ok: true, parsedRegion: region, updatedIntelligence: { parsedRegions: [] }, summaries: [] },
    ];
    for (const malformed of malformedSuccesses) {
      promoteMock.mockResolvedValueOnce(malformed as PromoteParsedRegionResponse);
      await expect(invocation()).rejects.toThrow("Malformed parsed-region promotion response");
    }
    unsubscribe();
    expect(updatedKeys, "an invalid successful payload must fail before any cache publication")
      .toEqual([]);
    expect(readActivePageWindow(queryClient, PROJECT_A)).toBe(windowBefore);
    expect(queryClient.getQueryData(queryKeys.summaries.all(PROJECT_A))).toBe(stableSummaries);
  });
});

describe("deleteParsedRegion persistent command", () => {
  it("stays server-first, captures identity, then publishes P -> A -> S -> X only against A", async () => {
    const targetRegion = promotedRegion({ id: "delete-me" });
    const initialA = {
      rejectedTextRegionIds: ["keep-A"],
      parsedRegions: [targetRegion as never],
    } satisfies PageIntelligence;
    const sentinelB = { rejectedTextRegionIds: ["keep-B"] } satisfies PageIntelligence;
    seedWindow(queryClient, PROJECT_A, PAGE_A, initialA);
    seedWindow(queryClient, PROJECT_B, 9, sentinelB);
    const bWindowBefore = readActivePageWindow(queryClient, PROJECT_B);
    const bSummaries = summaries("stable-B");
    queryClient.setQueryData(queryKeys.summaries.all(PROJECT_B), bSummaries);

    const retainedRegion = promotedRegion({ id: "retained" });
    const authoritative = {
      rejectedTextRegionIds: ["server-A"],
      parsedRegions: [retainedRegion as never],
    } satisfies PageIntelligence;
    const serverSummaries = summaries("fresh-delete-A");
    const response = deletionResponse({ intelligence: authoritative, summaries: serverSummaries });
    let resolveDelete!: (value: DeletePersistedParsedRegionResponse) => void;
    const trace: string[] = [];
    deleteMock.mockImplementationOnce(() => {
      trace.push("persist");
      return new Promise((resolve) => { resolveDelete = resolve; });
    });

    const pageKey = JSON.stringify(queryKeys.pagesWindow.active(PROJECT_A));
    const summaryKey = JSON.stringify(queryKeys.summaries.all(PROJECT_A));
    const pageSnapshots: PageIntelligence[] = [];
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated") return;
      const key = JSON.stringify(event.query.queryKey);
      if (key === pageKey) {
        const snapshot = readPageIntelligence(queryClient, PROJECT_A, PAGE_A)!;
        pageSnapshots.push(snapshot);
        trace.push(snapshot.csiSpatialMap ? "spatial" : "adopt");
      } else if (key === summaryKey) {
        trace.push("summaries");
      }
    });

    const target = {
      publicId: PROJECT_A,
      isDemo: false,
      pageNumber: PAGE_A,
      regionId: "delete-me",
    };
    const pending = deleteParsedRegion(queryClient, target);

    expect(deleteMock).toHaveBeenCalledWith({
      publicId: PROJECT_A,
      pageNumber: PAGE_A,
      regionId: "delete-me",
    });
    expect(readPageIntelligence(queryClient, PROJECT_A, PAGE_A)).toBe(initialA);
    expect(trace).toEqual(["persist"]);

    target.publicId = PROJECT_B;
    target.pageNumber = 9;
    target.regionId = "other-region";
    target.isDemo = true;
    useSessionStore.setState({ publicId: PROJECT_B });
    resolveDelete(response);

    const result = await pending;
    unsubscribe();

    expect(result).toEqual({ status: "persisted", response });
    expect(result.status === "persisted" && result.response).toBe(response);
    expect(trace).toEqual(["persist", "adopt", "summaries", "spatial"]);
    expect(pageSnapshots).toHaveLength(2);
    expect(pageSnapshots[0]).toEqual(authoritative);
    expect(pageSnapshots[1].parsedRegions).toEqual(authoritative.parsedRegions);
    expect(pageSnapshots[1].csiSpatialMap).toBeDefined();
    expect(queryClient.getQueryData(queryKeys.summaries.all(PROJECT_A))).toBe(serverSummaries);
    expect(readActivePageWindow(queryClient, PROJECT_B)).toBe(bWindowBefore);
    expect(queryClient.getQueryData(queryKeys.summaries.all(PROJECT_B))).toBe(bSummaries);
  });

  it("retains prior summaries when the authoritative response has null summaries", async () => {
    const initial = { parsedRegions: [promotedRegion({ id: "delete-me" }) as never] };
    const priorSummaries = summaries("retain-me");
    const authoritative = { parsedRegions: [] } satisfies PageIntelligence;
    const response = deletionResponse({
      deleted: false,
      intelligence: authoritative,
      summaries: null,
    });
    seedWindow(queryClient, PROJECT_A, PAGE_A, initial);
    queryClient.setQueryData(queryKeys.summaries.all(PROJECT_A), priorSummaries);
    deleteMock.mockResolvedValueOnce(response);

    await expect(deleteParsedRegion(queryClient, {
      publicId: PROJECT_A,
      isDemo: false,
      pageNumber: PAGE_A,
      regionId: "delete-me",
    })).resolves.toEqual({ status: "persisted", response });

    expect(queryClient.getQueryData(queryKeys.summaries.all(PROJECT_A))).toBe(priorSummaries);
    expect(readPageIntelligence(queryClient, PROJECT_A, PAGE_A)?.parsedRegions).toEqual([]);
  });

  it("serializes different-row deletes per project/page before transport and cache adoption", async () => {
    const deleteA = promotedRegion({ id: "delete-a" });
    const deleteB = promotedRegion({ id: "delete-b" });
    const keep = promotedRegion({ id: "keep" });
    seedWindow(queryClient, PROJECT_A, PAGE_A, {
      parsedRegions: [deleteA, deleteB, keep] as never[],
    });

    let resolveA!: (value: DeletePersistedParsedRegionResponse) => void;
    let resolveB!: (value: DeletePersistedParsedRegionResponse) => void;
    deleteMock
      .mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveB = resolve; }));

    const first = deleteParsedRegion(queryClient, {
      publicId: PROJECT_A,
      isDemo: false,
      pageNumber: PAGE_A,
      regionId: "delete-a",
    });
    const second = deleteParsedRegion(queryClient, {
      publicId: PROJECT_A,
      isDemo: false,
      pageNumber: PAGE_A,
      regionId: "delete-b",
    });

    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(deleteMock).toHaveBeenNthCalledWith(1, {
      publicId: PROJECT_A,
      pageNumber: PAGE_A,
      regionId: "delete-a",
    });

    const responseA = deletionResponse({
      intelligence: { parsedRegions: [deleteB, keep] as never[] },
      summaries: null,
    });
    resolveA(responseA);
    await expect(first).resolves.toEqual({ status: "persisted", response: responseA });
    await vi.waitFor(() => expect(deleteMock).toHaveBeenCalledTimes(2));
    expect(deleteMock).toHaveBeenNthCalledWith(2, {
      publicId: PROJECT_A,
      pageNumber: PAGE_A,
      regionId: "delete-b",
    });

    const responseB = deletionResponse({
      intelligence: { parsedRegions: [keep] as never[] },
      summaries: null,
    });
    resolveB(responseB);
    await expect(second).resolves.toEqual({ status: "persisted", response: responseB });
    expect(readPageIntelligence(queryClient, PROJECT_A, PAGE_A)?.parsedRegions).toEqual([keep]);
  });

  it("releases the project/page delete queue after a failed predecessor", async () => {
    const keep = promotedRegion({ id: "keep" });
    seedWindow(queryClient, PROJECT_A, PAGE_A, {
      parsedRegions: [promotedRegion({ id: "delete-a" }), keep] as never[],
    });
    let rejectA!: (error: Error) => void;
    deleteMock
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectA = reject; }))
      .mockResolvedValueOnce(deletionResponse({
        intelligence: { parsedRegions: [keep] as never[] },
        summaries: null,
      }));

    const first = deleteParsedRegion(queryClient, {
      publicId: PROJECT_A,
      isDemo: false,
      pageNumber: PAGE_A,
      regionId: "delete-a",
    });
    const second = deleteParsedRegion(queryClient, {
      publicId: PROJECT_A,
      isDemo: false,
      pageNumber: PAGE_A,
      regionId: "delete-a",
    });
    expect(deleteMock).toHaveBeenCalledTimes(1);

    rejectA(new Error("offline"));
    await expect(first).rejects.toThrow("offline");
    await expect(second).resolves.toMatchObject({ status: "persisted" });
    expect(deleteMock).toHaveBeenCalledTimes(2);
    expect(readPageIntelligence(queryClient, PROJECT_A, PAGE_A)?.parsedRegions).toEqual([keep]);
  });

  it("does not serialize deletes for independent project/page targets", async () => {
    const resolvers: Array<(value: DeletePersistedParsedRegionResponse) => void> = [];
    deleteMock.mockImplementation(() => new Promise((resolve) => {
      resolvers.push(resolve);
    }));

    const requests = [
      deleteParsedRegion(queryClient, {
        publicId: PROJECT_A,
        isDemo: false,
        pageNumber: PAGE_A,
        regionId: "delete-a",
      }),
      deleteParsedRegion(queryClient, {
        publicId: PROJECT_A,
        isDemo: false,
        pageNumber: PAGE_A + 1,
        regionId: "delete-b",
      }),
      deleteParsedRegion(queryClient, {
        publicId: PROJECT_B,
        isDemo: false,
        pageNumber: PAGE_A,
        regionId: "delete-c",
      }),
    ];

    expect(deleteMock).toHaveBeenCalledTimes(3);
    expect(resolvers).toHaveLength(3);
    resolvers.forEach((resolve) => resolve(deletionResponse({ summaries: null })));
    await expect(Promise.all(requests)).resolves.toHaveLength(3);
  });

  it("performs no A/S/X after transport rejection or malformed success", async () => {
    const initial = {
      rejectedTextRegionIds: ["stable"],
      parsedRegions: [promotedRegion({ id: "delete-me" }) as never],
    } satisfies PageIntelligence;
    const stableSummaries = summaries("stable");
    seedWindow(queryClient, PROJECT_A, PAGE_A, initial);
    queryClient.setQueryData(queryKeys.summaries.all(PROJECT_A), stableSummaries);
    const windowBefore = readActivePageWindow(queryClient, PROJECT_A);
    const updatedKeys: unknown[][] = [];
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === "updated") updatedKeys.push([...event.query.queryKey]);
    });
    const target = {
      publicId: PROJECT_A,
      isDemo: false,
      pageNumber: PAGE_A,
      regionId: "delete-me",
    };
    const failure = new Error("HTTP failure");

    deleteMock.mockRejectedValueOnce(failure);
    await expect(deleteParsedRegion(queryClient, target)).rejects.toBe(failure);
    expect(updatedKeys).toEqual([]);

    const malformedSuccesses: unknown[] = [
      null,
      { ok: false, deleted: true, updatedIntelligence: {}, summaries: null },
      { ok: true, deleted: "yes", updatedIntelligence: {}, summaries: null },
      { ok: true, deleted: true, updatedIntelligence: null, summaries: null },
      { ok: true, deleted: true, updatedIntelligence: [], summaries: null },
      { ok: true, deleted: true, updatedIntelligence: {}, summaries: null },
      { ok: true, deleted: false, updatedIntelligence: { parsedRegions: "corrupt" }, summaries: null },
      { ok: true, deleted: true, updatedIntelligence: { parsedRegions: "corrupt" }, summaries: null },
      { ok: true, deleted: false, updatedIntelligence: {} },
      { ok: true, deleted: true, updatedIntelligence: {} },
      { ok: true, deleted: true, updatedIntelligence: {}, summaries: [] },
    ];
    for (const malformed of malformedSuccesses) {
      deleteMock.mockResolvedValueOnce(
        malformed as DeletePersistedParsedRegionResponse,
      );
      await expect(deleteParsedRegion(queryClient, target))
        .rejects.toThrow("Malformed parsed-region deletion response");
    }
    unsubscribe();

    expect(updatedKeys).toEqual([]);
    expect(readActivePageWindow(queryClient, PROJECT_A)).toBe(windowBefore);
    expect(queryClient.getQueryData(queryKeys.summaries.all(PROJECT_A))).toBe(stableSummaries);
  });
});

describe("deleteParsedRegion local and skipped decisions", () => {
  it("demo mode functionally filters every duplicate, preserves siblings/intelligence, then runs X", async () => {
    const siblingA = promotedRegion({ id: "sibling-A" });
    const duplicateA = promotedRegion({ id: "delete-me", category: "duplicate-A" });
    const duplicateB = promotedRegion({ id: "delete-me", category: "duplicate-B" });
    const siblingB = promotedRegion({ id: "sibling-B" });
    const initial = {
      rejectedTextRegionIds: ["preserve-me"],
      unknownFutureKey: { preserve: true },
      parsedRegions: [siblingA, duplicateA, duplicateB, siblingB] as never[],
    } as PageIntelligence;
    seedWindow(queryClient, PROJECT_A, PAGE_A, initial);
    const pageKey = JSON.stringify(queryKeys.pagesWindow.active(PROJECT_A));
    const snapshots: PageIntelligence[] = [];
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === "updated" && JSON.stringify(event.query.queryKey) === pageKey) {
        snapshots.push(readPageIntelligence(queryClient, PROJECT_A, PAGE_A)!);
      }
    });

    await expect(deleteParsedRegion(queryClient, {
      publicId: PROJECT_A,
      isDemo: true,
      pageNumber: PAGE_A,
      regionId: "delete-me",
    })).resolves.toEqual({ status: "local", reason: "demo" });
    unsubscribe();

    expect(deleteMock).not.toHaveBeenCalled();
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].parsedRegions).toEqual([siblingA, siblingB]);
    expect(snapshots[0].rejectedTextRegionIds).toBe(initial.rejectedTextRegionIds);
    expect((snapshots[0] as PageIntelligence & { unknownFutureKey: unknown }).unknownFutureKey)
      .toBe((initial as PageIntelligence & { unknownFutureKey: unknown }).unknownFutureKey);
    expect(snapshots[1].parsedRegions).toEqual([siblingA, siblingB]);
    expect(snapshots[1].csiSpatialMap).toBeDefined();
  });

  it.each([
    [
      { publicId: null, isDemo: false, pageNumber: PAGE_A, regionId: "R" },
      { status: "skipped", reason: "missing-public-id" },
    ],
    [
      { publicId: "", isDemo: true, pageNumber: PAGE_A, regionId: "R" },
      { status: "skipped", reason: "missing-public-id" },
    ],
    [
      { publicId: PROJECT_A, isDemo: false, pageNumber: PAGE_A, regionId: null },
      { status: "skipped", reason: "missing-region-id" },
    ],
    [
      { publicId: PROJECT_A, isDemo: true, pageNumber: PAGE_A, regionId: "" },
      { status: "skipped", reason: "missing-region-id" },
    ],
  ] as const)("returns %j with zero transport or cache publication", async (target, expected) => {
    const cacheEvents: unknown[] = [];
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => cacheEvents.push(event));

    await expect(deleteParsedRegion(queryClient, target)).resolves.toEqual(expected);
    unsubscribe();

    expect(deleteMock).not.toHaveBeenCalled();
    expect(cacheEvents).toEqual([]);
    expect(queryClient.getQueryCache().getAll()).toEqual([]);
  });
});

describe("saveParsedRegion non-persistent decisions", () => {
  it.each([
    [{ publicId: PROJECT_A, isDemo: true, pageNumber: PAGE_A }, { status: "local", reason: "demo" }],
    [{ publicId: null, isDemo: false, pageNumber: PAGE_A }, { status: "skipped", reason: "missing-public-id" }],
    [{ publicId: "", isDemo: false, pageNumber: PAGE_A }, { status: "skipped", reason: "missing-public-id" }],
    // Demo policy wins when both conditions are true.
    [{ publicId: null, isDemo: true, pageNumber: PAGE_A }, { status: "local", reason: "demo" }],
  ] as const)("returns %j with no transport/cache work", async (target, expected) => {
    const cacheEvents: unknown[] = [];
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => cacheEvents.push(event));

    await expect(saveParsedRegion(queryClient, target, {
      via: "parser",
      type: "notes",
      regionId: "R",
      bboxMinMax: [0, 0, 1, 1],
      data: {},
    })).resolves.toEqual(expected);
    unsubscribe();

    expect(promoteMock).not.toHaveBeenCalled();
    expect(cacheEvents).toEqual([]);
    expect(queryClient.getQueryCache().getAll()).toEqual([]);
  });
});
