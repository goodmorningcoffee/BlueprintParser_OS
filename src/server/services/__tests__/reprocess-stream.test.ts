// @vitest-environment node
// [fix 2026-10-21 reprocess-persistence] A client that goes away must not stop the run.
// enqueue() throws on a closed stream; the per-project guards used to call send() again inside
// their catch, so the throw escaped and the run stopped part-way through a project.
import { describe, expect, it, vi } from "vitest";
import { createReprocessStream } from "@/server/services/reprocess-stream";
import { logger } from "@/lib/logger";

function fakeController(opts: { throwAfter?: number } = {}) {
  const chunks: string[] = [];
  let n = 0;
  const controller = {
    enqueue: vi.fn((chunk: Uint8Array) => {
      n++;
      if (opts.throwAfter !== undefined && n > opts.throwAfter) throw new TypeError("Invalid state: Controller is already closed");
      chunks.push(new TextDecoder().decode(chunk));
    }),
    close: vi.fn(),
  } as unknown as ReadableStreamDefaultController<Uint8Array>;
  return { controller, chunks };
}

describe("createReprocessStream", () => {
  it("send() never throws after the client disconnects; later sends are dropped", () => {
    const { controller, chunks } = fakeController({ throwAfter: 1 });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const out = createReprocessStream(controller, { scope: "shape-parse", debug: false });
    out.send({ type: "start" });
    expect(() => out.send({ type: "progress" })).not.toThrow();
    expect(() => out.send({ type: "error", project: "p" })).not.toThrow();
    expect(out.isClosed()).toBe(true);
    expect(chunks).toEqual(['{"type":"start"}\n']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(() => out.close()).not.toThrow();
    warn.mockRestore();
  });

  it("debug() is a no-op when off; when on it streams {type:'debug'} AND logs [reprocess-debug], redacting secrets", () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    const off = fakeController();
    createReprocessStream(off.controller, { scope: "full", debug: false }).debug("page.written", { page: 1 });
    expect(off.chunks).toEqual([]);
    expect(info).not.toHaveBeenCalled();

    const on = fakeController();
    createReprocessStream(on.controller, { scope: "full", debug: true }).debug("page.written", {
      page: 1,
      url: "https://bucket.s3.amazonaws.com/x?X-Amz-Signature=abc",
      secretAccessKey: "shh",
    });
    expect(JSON.parse(on.chunks[0])).toEqual({
      type: "debug", scope: "full", step: "page.written", page: 1, url: "[redacted]", secretAccessKey: "[redacted]",
    });
    expect(info.mock.calls[0][0]).toBe("[reprocess-debug] full page.written");
    info.mockRestore();
  });
});
