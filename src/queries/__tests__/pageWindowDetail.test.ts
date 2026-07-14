// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { ActivePageWindow, PageWindowResponse } from "@/queries/pageWindowCore";
import { queryKeys } from "@/queries/queryKeys";
import {
  ensurePageIntelligence,
  PageWindowHttpError,
  readActivePageWindow,
} from "@/queries/usePageWindow";
import type { ClientAnnotation, KeynoteShapeData, PageIntelligence } from "@/types";

const fetchMock = vi.fn();

function keynote(text: string): KeynoteShapeData {
  return { shape: "circle", text, bbox: [0, 0, 0.1, 0.1] };
}

function annotation(id: number): ClientAnnotation {
  return {
    id,
    pageNumber: 7,
    name: `annotation-${id}`,
    bbox: [0, 0, 0.1, 0.1],
    note: null,
    source: "user",
    data: null,
  };
}

function active(overrides: Partial<ActivePageWindow> = {}): ActivePageWindow {
  return {
    loadedRange: { from: 1, to: 15 },
    keynotes: {},
    csiCodes: {},
    textAnnotations: {},
    pageIntelligence: {},
    ...overrides,
  };
}

function payload(
  pageNumber: number,
  intelligence: PageIntelligence | null | undefined,
  extras: Partial<PageWindowResponse> = {},
): PageWindowResponse {
  return {
    from: pageNumber,
    to: pageNumber,
    pages: [
      {
        pageNumber,
        name: `Page ${pageNumber}`,
        drawingNumber: null,
        keynotes: [keynote("wire-keynotes-must-not-adopt")],
        csiCodes: [],
        textAnnotations: {},
        pageIntelligence: intelligence,
      },
    ],
    annotations: [annotation(999)],
    ...extras,
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ensurePageIntelligence exact-page operation", () => {
  it.each([
    {
      label: "authenticated",
      isDemo: false,
      expected: "/api/projects/pid/pages?from=7&to=7",
    },
    {
      label: "demo",
      isDemo: true,
      expected: "/api/demo/projects/pid/pages?from=7&to=7",
    },
  ])("uses the exact $label URL", async ({ isDemo, expected }) => {
    const client = new QueryClient();
    const intelligence: PageIntelligence = { rejectedTextRegionIds: ["loaded"] };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => payload(7, intelligence),
    } as Response);

    await expect(
      ensurePageIntelligence(client, { publicId: "pid", pageNumber: 7, isDemo }),
    ).resolves.toBe(intelligence);

    expect(fetchMock).toHaveBeenCalledWith(expected);
    expect(fetchMock.mock.calls[0]).toHaveLength(1);
    client.clear();
  });

  it("forwards an optional AbortSignal", async () => {
    const client = new QueryClient();
    const controller = new AbortController();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => payload(3, {}),
    } as Response);

    await ensurePageIntelligence(client, {
      publicId: "pid",
      pageNumber: 3,
      isDemo: false,
      signal: controller.signal,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/pid/pages?from=3&to=3",
      { signal: controller.signal },
    );
    client.clear();
  });

  it.each([
    { boundary: "fetch", decisions: [false], jsonCalls: 0 },
    { boundary: "JSON", decisions: [true, false], jsonCalls: 1 },
    { boundary: "cache write", decisions: [true, true, false], jsonCalls: 1 },
  ])("can decline stale adoption at the $boundary boundary", async ({ decisions, jsonCalls }) => {
    const client = new QueryClient();
    const oldWindow = active({ pageIntelligence: { 7: { rejectedTextRegionIds: ["successor"] } } });
    client.setQueryData(queryKeys.pagesWindow.active("pid"), oldWindow);
    const json = vi.fn(async () => payload(7, { rejectedTextRegionIds: ["stale"] }));
    fetchMock.mockResolvedValueOnce({ ok: true, json } as unknown as Response);
    const pendingDecisions = [...decisions];
    const canAdopt = vi.fn(() => pendingDecisions.shift() ?? false);

    await expect(ensurePageIntelligence(client, {
      publicId: "pid",
      pageNumber: 7,
      isDemo: false,
      canAdopt,
    })).resolves.toBeUndefined();

    expect(canAdopt).toHaveBeenCalledTimes(decisions.length);
    expect(json).toHaveBeenCalledTimes(jsonCalls);
    expect(readActivePageWindow(client, "pid")).toBe(oldWindow);
    client.clear();
  });

  it("adopts only first-row PI and preserves range, all other maps, and annotations", async () => {
    const client = new QueryClient();
    const keynotes = { 7: [keynote("local")] };
    const codes = {};
    const text = {};
    const oldPi = { 2: { rejectedTextRegionIds: ["other-page"] } };
    const oldWindow = active({ keynotes, csiCodes: codes, textAnnotations: text, pageIntelligence: oldPi });
    const oldAnnotations = [annotation(1)];
    client.setQueryData(queryKeys.pagesWindow.active("pid"), oldWindow);
    client.setQueryData(queryKeys.annotations.all("pid"), oldAnnotations);
    const exact: PageIntelligence = { rejectedTextRegionIds: ["first-row"] };
    const secondRow: PageIntelligence = { rejectedTextRegionIds: ["requested-row"] };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      // Fidelity pin: live AutoQto adopts pages[0] after an exact N..N request. Even this malformed
      // two-row response must not silently switch extraction semantics to find(pageNumber).
      json: async () => ({
        ...payload(7, secondRow),
        pages: [payload(6, exact).pages[0], payload(7, secondRow).pages[0]],
      }),
    } as Response);

    const result = await ensurePageIntelligence(client, {
      publicId: "pid",
      pageNumber: 7,
      isDemo: false,
    });
    const next = readActivePageWindow(client, "pid");

    expect(result).toBe(exact);
    expect(next.loadedRange).toBe(oldWindow.loadedRange);
    expect(next.keynotes).toBe(keynotes);
    expect(next.csiCodes).toBe(codes);
    expect(next.textAnnotations).toBe(text);
    expect(next.pageIntelligence[2]).toBe(oldPi[2]);
    expect(next.pageIntelligence[7]).toBe(exact);
    expect(client.getQueryData(queryKeys.annotations.all("pid"))).toBe(oldAnnotations);
    client.clear();
  });

  it("still fetches when the requested page already has cached PI, then replaces it", async () => {
    const client = new QueryClient();
    const cached: PageIntelligence = { rejectedTextRegionIds: ["cached"] };
    const server: PageIntelligence = { rejectedTextRegionIds: ["server"] };
    client.setQueryData(
      queryKeys.pagesWindow.active("pid"),
      active({ pageIntelligence: { 7: cached } }),
    );
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => payload(7, server),
    } as Response);

    await expect(
      ensurePageIntelligence(client, { publicId: "pid", pageNumber: 7, isDemo: false }),
    ).resolves.toBe(server);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]).toHaveLength(1);
    // Default structural sharing may rebuild the replacement against the cached object; the
    // operation's return remains the server reference and the cached value must be server data.
    expect(readActivePageWindow(client, "pid").pageIntelligence[7]).toEqual(server);
    client.clear();
  });

  it("returns undefined and performs no cache write when the exact row has no PI", async () => {
    const client = new QueryClient();
    const oldWindow = active({ pageIntelligence: { 7: { rejectedTextRegionIds: ["local"] } } });
    client.setQueryData(queryKeys.pagesWindow.active("pid"), oldWindow);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => payload(7, null),
    } as Response);

    await expect(
      ensurePageIntelligence(client, { publicId: "pid", pageNumber: 7, isDemo: false }),
    ).resolves.toBeUndefined();
    expect(readActivePageWindow(client, "pid")).toBe(oldWindow);
    client.clear();
  });

  it("exposes HTTP status through PageWindowHttpError and leaves caches untouched", async () => {
    const client = new QueryClient();
    const oldWindow = active();
    client.setQueryData(queryKeys.pagesWindow.active("pid"), oldWindow);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 } as Response);

    const error = await ensurePageIntelligence(client, {
      publicId: "pid",
      pageNumber: 7,
      isDemo: false,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PageWindowHttpError);
    expect((error as PageWindowHttpError).status).toBe(503);
    expect(readActivePageWindow(client, "pid")).toBe(oldWindow);
    client.clear();
  });

  it.each(["network", "json"] as const)("passes the original $label error through unchanged", async (kind) => {
    const client = new QueryClient();
    const original = new Error(`${kind}-failure`);
    if (kind === "network") {
      fetchMock.mockRejectedValueOnce(original);
    } else {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => {
          throw original;
        },
      } as unknown as Response);
    }

    const error = await ensurePageIntelligence(client, {
      publicId: "pid",
      pageNumber: 7,
      isDemo: false,
    }).catch((caught: unknown) => caught);

    expect(error).toBe(original);
    expect(client.getQueryData(queryKeys.pagesWindow.active("pid"))).toBeUndefined();
    client.clear();
  });
});
