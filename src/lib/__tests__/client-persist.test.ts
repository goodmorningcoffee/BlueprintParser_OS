// @vitest-environment node
// [refactor jul13 P2.4 W1] Low-level client persistence freeze. Query-aware ParsedRegion commands
// own orchestration above this module; these exact wire/error semantics stay explicit.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiErrorMessage,
  canPersist,
  deletePersistedParsedRegion,
  persistFetch,
  promoteParsedRegion,
  regionIdFor,
} from "@/lib/client-persist";

const fetchMock = vi.fn();

function response(args: {
  ok: boolean;
  status?: number;
  json?: () => Promise<unknown>;
}): Response {
  return {
    ok: args.ok,
    status: args.status ?? (args.ok ? 200 : 500),
    json: args.json ?? vi.fn().mockResolvedValue({}),
  } as unknown as Response;
}

async function expectExactError(promise: Promise<unknown>, message: string): Promise<void> {
  const rejection = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  expect(rejection).toBeInstanceOf(Error);
  expect((rejection as Error).message).toBe(message);
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("persistFetch wire and result contract", () => {
  it("sends exact JSON, method, content type, and caller AbortSignal", async () => {
    const body = { projectId: "P", nested: { keep: true } };
    const signal = new AbortController().signal;
    const serverObject = { ok: true, row: { id: 7 } };
    fetchMock.mockResolvedValue(response({
      ok: true,
      json: vi.fn().mockResolvedValue(serverObject),
    }));

    const result = await persistFetch("/api/fixture", body, "PATCH", signal);

    expect(result).toBe(serverObject);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/fixture");
    expect(fetchMock.mock.calls[0][1]).toEqual({
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    expect(fetchMock.mock.calls[0][1].signal).toBe(signal);
  });

  it("defaults to POST and leaves an undefined body undefined", async () => {
    fetchMock.mockResolvedValue(response({ ok: true, json: vi.fn().mockResolvedValue(null) }));

    await persistFetch("/api/default", undefined);

    expect(fetchMock).toHaveBeenCalledWith("/api/default", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: undefined,
      signal: undefined,
    });
  });

  it("wraps transport rejection with the stable network prefix", async () => {
    const transportError = new TypeError("socket closed");
    fetchMock.mockRejectedValue(transportError);

    await expectExactError(
      persistFetch("/api/fail", {}),
      "Network error while saving: socket closed",
    );
  });

  it.each([
    [{ error: "legacy detail" }, "legacy detail"],
    [{ error: { code: "VALIDATION", message: "envelope detail" } }, "envelope detail"],
    [{ error: { code: "VALIDATION" } }, "HTTP 422"],
  ])("non-OK body %j selects the exact useful error", async (errorBody, expected) => {
    fetchMock.mockResolvedValue(response({
      ok: false,
      status: 422,
      json: vi.fn().mockResolvedValue(errorBody),
    }));

    await expectExactError(persistFetch("/api/fail", {}), expected);
  });

  it("non-JSON error falls back to status; non-JSON success returns null", async () => {
    fetchMock.mockResolvedValueOnce(response({
      ok: false,
      status: 503,
      json: vi.fn().mockRejectedValue(new SyntaxError("not json")),
    }));
    await expectExactError(persistFetch("/api/fail", {}), "HTTP 503");

    fetchMock.mockResolvedValueOnce(response({
      ok: true,
      json: vi.fn().mockRejectedValue(new SyntaxError("empty")),
    }));
    await expect(persistFetch("/api/no-content", {})).resolves.toBeNull();
  });
});

describe("promoteParsedRegion current parser request", () => {
  it("posts the exact parser override shape and returns the successful JSON object", async () => {
    const serverObject = {
      ok: true,
      parsedRegion: { id: "region-1" },
      updatedIntelligence: { parsedRegions: [{ id: "region-1" }] },
      summaries: { schedules: [] },
    };
    fetchMock.mockResolvedValue(response({
      ok: true,
      json: vi.fn().mockResolvedValue(serverObject),
    }));
    const data = { headers: ["TAG"], rows: [{ TAG: "D-101" }] };
    const csiTags = [{ code: "08 11 13", description: "Hollow Metal Doors" }];

    const result = await promoteParsedRegion({
      publicId: "project-public-id",
      pageNumber: 4,
      type: "schedule",
      regionId: "region-1",
      bbox: [0.1, 0.2, 0.7, 0.8],
      data,
      category: "door-schedule",
      csiTags,
    });

    expect(result).toBe(serverObject);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/regions/promote");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      publicId: "project-public-id",
      pageNumber: 4,
      type: "schedule",
      overrides: {
        regionId: "region-1",
        bbox: [0.1, 0.2, 0.7, 0.8],
        data,
        category: "door-schedule",
        csiTags,
      },
    });
  });

  it("omits optional category/csiTags on the serialized wire body", async () => {
    fetchMock.mockResolvedValue(response({ ok: true, json: vi.fn().mockResolvedValue({ ok: true }) }));

    await promoteParsedRegion({
      publicId: "P",
      pageNumber: 1,
      type: "notes",
      regionId: "R",
      bbox: [0, 0, 1, 1],
      data: {},
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      publicId: "P",
      pageNumber: 1,
      type: "notes",
      overrides: { regionId: "R", bbox: [0, 0, 1, 1], data: {} },
    });
  });

  it("retains explicitly supplied empty optional values instead of treating them as absent", async () => {
    fetchMock.mockResolvedValue(response({ ok: true, json: vi.fn().mockResolvedValue({ ok: true }) }));

    await promoteParsedRegion({
      publicId: "P",
      pageNumber: 1,
      type: "notes",
      regionId: "R",
      bbox: [0, 0, 1, 1],
      data: {},
      category: "",
      csiTags: [],
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      publicId: "P",
      pageNumber: 1,
      type: "notes",
      overrides: {
        regionId: "R",
        bbox: [0, 0, 1, 1],
        data: {},
        category: "",
        csiTags: [],
      },
    });
  });

  it("posts the exact classifier source request without an overrides object", async () => {
    const serverObject = {
      ok: true,
      parsedRegion: { id: "promoted-source" },
      updatedIntelligence: { parsedRegions: [{ id: "promoted-source" }] },
      summaries: null,
    };
    fetchMock.mockResolvedValue(response({
      ok: true,
      json: vi.fn().mockResolvedValue(serverObject),
    }));

    const result = await promoteParsedRegion({
      publicId: "P",
      pageNumber: 9,
      type: "spec",
      sourceTextRegionId: "text-region-4",
    });

    expect(result).toBe(serverObject);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      publicId: "P",
      pageNumber: 9,
      type: "spec",
      sourceTextRegionId: "text-region-4",
    });
  });
});

describe("deletePersistedParsedRegion wire contract", () => {
  it("sends the sole exact DELETE request and returns the successful JSON object", async () => {
    const serverObject = {
      ok: true,
      deleted: true,
      updatedIntelligence: { parsedRegions: [] },
      summaries: { schedules: [] },
    };
    fetchMock.mockResolvedValue(response({
      ok: true,
      json: vi.fn().mockResolvedValue(serverObject),
    }));

    const requestWithRuntimeResidue = {
      publicId: "project-public-id",
      pageNumber: 7,
      regionId: "region-7",
      ignoredByStrictWire: true,
    };
    const result = await deletePersistedParsedRegion(requestWithRuntimeResidue);

    expect(result).toBe(serverObject);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/regions");
    expect(fetchMock.mock.calls[0][1]).toEqual({
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        publicId: "project-public-id",
        pageNumber: 7,
        regionId: "region-7",
      }),
      signal: undefined,
    });
  });

  it("propagates the useful persistFetch error without normalization", async () => {
    fetchMock.mockResolvedValue(response({
      ok: false,
      status: 404,
      json: vi.fn().mockResolvedValue({
        error: { code: "NOT_FOUND", message: "Page not found" },
      }),
    }));

    await expectExactError(deletePersistedParsedRegion({
      publicId: "P",
      pageNumber: 99,
      regionId: "R",
    }), "Page not found");
  });
});

describe("client persistence pure helpers", () => {
  it("reads both API error envelopes without inventing fallbacks", () => {
    expect(apiErrorMessage({ error: "legacy" })).toBe("legacy");
    expect(apiErrorMessage({ error: { code: "X", message: "modern" } })).toBe("modern");
    expect(apiErrorMessage({ error: { code: "X" } })).toBeUndefined();
    expect(apiErrorMessage(null)).toBeUndefined();
  });

  it("gates writes on publicId + non-demo and freezes bbox region-id quantization", () => {
    expect(canPersist("P", false)).toBe(true);
    expect(canPersist("", false)).toBe(false);
    expect(canPersist(null, false)).toBe(false);
    expect(canPersist("P", true)).toBe(false);
    expect(regionIdFor(4, [0.12349, 0.56751, 0.9996, 0.0004])).toBe(
      "pr-4-123-568-1000-0",
    );
  });
});
