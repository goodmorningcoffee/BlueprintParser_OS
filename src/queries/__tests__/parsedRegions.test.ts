// @vitest-environment node
// [refactor jul11 P2.4 C1] Production-dead ParsedRegion command contract.

import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  promoteParsedRegion,
  type PromoteParsedRegionResponse,
  type PromotedParsedRegion,
} from "@/lib/client-persist";
import { queryKeys } from "@/queries/queryKeys";
import { EMPTY_ACTIVE_PAGE_WINDOW } from "@/queries/pageWindowCore";
import {
  readActivePageWindow,
  readPageIntelligence,
} from "@/queries/usePageWindow";
import { saveParsedRegion } from "@/queries/parsedRegions";
import { useSessionStore } from "@/stores/sessionStore";
import type { PageIntelligence, ProjectSummaries } from "@/types";

vi.mock("@/lib/client-persist", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-persist")>();
  return { ...actual, promoteParsedRegion: vi.fn() };
});

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

  it("performs no A/S/X after promotion rejection or the inherited null-success result", async () => {
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

    // persistFetch historically converts a successful non-JSON body to null. The command then
    // throws before adoption; preserve that inherited failure instead of inventing normalization.
    promoteMock.mockResolvedValueOnce(null as unknown as PromoteParsedRegionResponse);
    await expect(invocation()).rejects.toBeInstanceOf(TypeError);
    unsubscribe();
    expect(updatedKeys, "an invalid successful payload must fail before any cache publication")
      .toEqual([]);
    expect(readActivePageWindow(queryClient, PROJECT_A)).toBe(windowBefore);
    expect(queryClient.getQueryData(queryKeys.summaries.all(PROJECT_A))).toBe(stableSummaries);
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
