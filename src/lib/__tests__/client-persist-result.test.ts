// @vitest-environment node
// [table pipeline WP-2.0b, C1-M9] The sanctioned paths for a mutation whose caller must read a 409
// body (`persistFetchResult`) and for client GETs (`getJson`). `persistFetch` itself is frozen by
// `client-persist.test.ts` and is not changed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getJson, HttpError, persistFetchResult } from "@/lib/client-persist";

const fetchMock = vi.fn();

function response(args: { ok: boolean; status: number; json?: () => Promise<unknown> }): Response {
  return {
    ok: args.ok,
    status: args.status,
    json: args.json ?? vi.fn().mockResolvedValue({}),
  } as unknown as Response;
}

function abortError(): Error {
  const e = new Error("The operation was aborted.");
  e.name = "AbortError";
  return e;
}

/** A fetch that honours its AbortSignal the way the platform does. */
function abortableFetch(_url: string, init?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) return reject(abortError());
    signal?.addEventListener("abort", () => reject(abortError()));
  });
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => null, (error: unknown) => error);
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("persistFetchResult", () => {
  it("sends the same wire request as persistFetch", async () => {
    const signal = new AbortController().signal;
    fetchMock.mockResolvedValue(response({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ ok: true }) }));
    const result = await persistFetchResult("/api/fixture", { a: 1 }, "PUT", signal);
    expect(result).toEqual({ ok: true, status: 200, body: { ok: true } });
    expect(fetchMock).toHaveBeenCalledWith("/api/fixture", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ a: 1 }),
      signal,
    });
  });

  it("defaults to POST and omits an undefined body", async () => {
    fetchMock.mockResolvedValue(response({ ok: true, status: 200 }));
    await persistFetchResult("/api/fixture", undefined);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST", body: undefined });
  });

  it("resolves a 409 with its body instead of throwing", async () => {
    const conflict = { conflict: { regionId: "pr-1", serverRev: 3 } };
    fetchMock.mockResolvedValue(response({ ok: false, status: 409, json: vi.fn().mockResolvedValue(conflict) }));
    const result = await persistFetchResult<typeof conflict>("/api/fixture", {});
    expect(result).toEqual({ ok: false, status: 409, body: conflict });
  });

  it("resolves a non-JSON body as null, on success and on error", async () => {
    fetchMock.mockResolvedValueOnce(response({ ok: false, status: 502, json: vi.fn().mockRejectedValue(new SyntaxError("x")) }));
    expect(await persistFetchResult("/api/fixture", {})).toEqual({ ok: false, status: 502, body: null });
    fetchMock.mockResolvedValueOnce(response({ ok: true, status: 204, json: vi.fn().mockRejectedValue(new SyntaxError("x")) }));
    expect(await persistFetchResult("/api/fixture", {})).toEqual({ ok: true, status: 204, body: null });
  });

  it("throws only on a network error, with persistFetch's message", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const err = await rejectionOf(persistFetchResult("/api/fixture", {}));
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("Network error while saving: Failed to fetch");
  });

  it("rethrows an abort untouched", async () => {
    fetchMock.mockImplementation(abortableFetch);
    const controller = new AbortController();
    const pending = rejectionOf(persistFetchResult("/api/fixture", {}, "POST", controller.signal));
    controller.abort();
    expect((await pending as Error).name).toBe("AbortError");
  });
});

describe("getJson", () => {
  it("GETs with the caller's signal and returns the parsed body", async () => {
    const signal = new AbortController().signal;
    fetchMock.mockResolvedValue(response({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ rows: [1] }) }));
    expect(await getJson<{ rows: number[] }>("/api/fixture?page=3", signal)).toEqual({ rows: [1] });
    expect(fetchMock).toHaveBeenCalledWith("/api/fixture?page=3", { signal });
  });

  it("aborts: an aborted signal rejects with AbortError", async () => {
    fetchMock.mockImplementation(abortableFetch);
    const controller = new AbortController();
    const pending = rejectionOf(getJson("/api/fixture", controller.signal));
    controller.abort();
    expect((await pending as Error).name).toBe("AbortError");

    const already = new AbortController();
    already.abort();
    expect((await rejectionOf(getJson("/api/fixture", already.signal)) as Error).name).toBe("AbortError");
  });

  it("throws HttpError with the status and the API error message", async () => {
    fetchMock.mockResolvedValueOnce(response({ ok: false, status: 404, json: vi.fn().mockResolvedValue({ error: { code: "NOT_FOUND", message: "No such page" } }) }));
    const e1 = await rejectionOf(getJson("/api/fixture"));
    expect(e1).toBeInstanceOf(HttpError);
    expect(e1).toMatchObject({ status: 404, message: "No such page" });

    fetchMock.mockResolvedValueOnce(response({ ok: false, status: 500, json: vi.fn().mockRejectedValue(new SyntaxError("x")) }));
    expect(await rejectionOf(getJson("/api/fixture"))).toMatchObject({ status: 500, message: "HTTP 500" });
  });

  it("throws when a 2xx body is not JSON", async () => {
    fetchMock.mockResolvedValue(response({ ok: true, status: 200, json: vi.fn().mockRejectedValue(new SyntaxError("x")) }));
    const err = await rejectionOf(getJson("/api/fixture"));
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(200);
  });
});
