// Admin data tools §1.3 — worker webhook retry: checks res.ok, retries 5xx/network errors with
// backoff and a fresh timestamp, stops on a non-retryable 4xx, never throws.
import { describe, expect, it, vi } from "vitest";
import { notifyProcessingWebhook } from "@/lib/processing-webhook-notify";

function response(status: number): Response {
  return new Response(null, { status });
}

function setup(results: (number | Error)[]) {
  const fetchImpl = vi.fn(async () => {
    const next = results.shift();
    if (next instanceof Error) throw next;
    return response(next ?? 500);
  });
  const sleeps: number[] = [];
  let clock = 1_000;
  return {
    fetchImpl,
    sleeps,
    options: {
      url: "http://test.local/api/processing/webhook",
      secret: "synthetic-secret",
      body: { projectId: 1, pages: [], status: "completed" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
      log: () => undefined,
    },
  };
}

describe("notifyProcessingWebhook", () => {
  it("delivers on the first 2xx", async () => {
    const t = setup([200]);
    expect(await notifyProcessingWebhook(t.options)).toEqual({ delivered: true, attempts: 1, lastStatus: 200 });
    expect(t.sleeps).toEqual([]);
  });

  it("retries 5xx and network errors with 1 s / 4 s / 15 s and a fresh timestamp each time", async () => {
    const t = setup([503, new TypeError("fetch failed"), 502, 200]);
    const result = await notifyProcessingWebhook(t.options);
    expect(result).toEqual({ delivered: true, attempts: 4, lastStatus: 200 });
    expect(t.sleeps).toEqual([1_000, 4_000, 15_000]);
    const stamps = t.fetchImpl.mock.calls.map(
      (call) => ((call as unknown as [string, RequestInit])[1].headers as Record<string, string>)["x-webhook-timestamp"],
    );
    expect(new Set(stamps).size).toBe(4);
  });

  it("gives up after the last retry without throwing", async () => {
    const t = setup([500, 500, 500, 500]);
    expect(await notifyProcessingWebhook(t.options)).toEqual({ delivered: false, attempts: 4, lastStatus: 500 });
  });

  it("does not retry a non-retryable 4xx, but does retry 429", async () => {
    const t = setup([401]);
    expect(await notifyProcessingWebhook(t.options)).toEqual({ delivered: false, attempts: 1, lastStatus: 401 });
    const r = setup([429, 200]);
    expect((await notifyProcessingWebhook(r.options)).delivered).toBe(true);
  });
});
