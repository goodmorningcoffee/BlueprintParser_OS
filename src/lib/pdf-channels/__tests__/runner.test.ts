// @vitest-environment node
// [census F2 2026-10-24] The python runner's contract, with a fake child process (nothing spawns
// python here — scripts/test_pdf_channels.py covers the script). Pins: the result is the LAST JSON
// line with a `status` (pymupdf can print to STDOUT on import), a script error / no JSON / an ok line
// without pages all throw, the timeout rejects and escalates SIGTERM → SIGKILL, a spawn error
// rejects, the config carries a total budget under the timeout, and PDF_CHANNELS_TIMEOUT_MS parses.
import { EventEmitter } from "events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { channelsTimeoutMs, DEFAULT_CHANNELS_TIMEOUT_MS, parseChannelsOutput, runPdfChannels } from "../runner";

const okLine = JSON.stringify({ status: "ok", v: 1, pageCount: 1, ocgLayers: 0, producer: null, creator: null, encrypted: false, truncated: false, seconds: 0.1, pages: [{ pageNumber: 1, kind: "blank" }] });

class FakeProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  written = "";
  stdin = { write: (s: string) => { this.written += s; }, end: () => {} };
  kill = vi.fn((_sig?: string) => true);
}

function fakeSpawn(behave: (p: FakeProc) => void) {
  const procs: FakeProc[] = [];
  const spawn = vi.fn(() => {
    const p = new FakeProc();
    procs.push(p);
    queueMicrotask(() => behave(p));
    return p;
  });
  return { spawn: spawn as never, procs };
}

afterEach(() => vi.useRealTimers());

describe("parseChannelsOutput", () => {
  it("takes the last JSON status line, ignoring import noise before it and blank lines after", () => {
    const noisy = `DeprecationWarning: something on stdout\n{"not":"a result"}\n[1,2]\n${okLine}\n\n`;
    expect(parseChannelsOutput(noisy).pages).toEqual([{ pageNumber: 1, kind: "blank" }]);
  });
  it("a script error line throws with its error and message", () => {
    expect(() => parseChannelsOutput('{"status":"error","error":"open_failed","message":"broken xref"}')).toThrow(
      "pdf_channels.py: open_failed — broken xref",
    );
  });
  it("no JSON, truncated JSON, or an ok line without pages throw", () => {
    expect(() => parseChannelsOutput("Traceback (most recent call last):\nModuleNotFoundError: fitz")).toThrow(/no JSON result line/);
    expect(() => parseChannelsOutput('{"status":"ok","pages":[')).toThrow(/no JSON result line/);
    expect(() => parseChannelsOutput('{"status":"ok","v":1}')).toThrow(/without pages/);
  });
});

describe("channelsTimeoutMs", () => {
  it("defaults to 60 s; parses digits; clamps to 10 min; junk and < 1 s fall back", () => {
    expect(DEFAULT_CHANNELS_TIMEOUT_MS).toBe(60_000);
    expect(channelsTimeoutMs({})).toBe(60_000);
    expect(channelsTimeoutMs({ PDF_CHANNELS_TIMEOUT_MS: "90000" })).toBe(90_000);
    expect(channelsTimeoutMs({ PDF_CHANNELS_TIMEOUT_MS: "99999999" })).toBe(600_000);
    expect(channelsTimeoutMs({ PDF_CHANNELS_TIMEOUT_MS: "abc" })).toBe(60_000);
    expect(channelsTimeoutMs({ PDF_CHANNELS_TIMEOUT_MS: "500" })).toBe(60_000);
  });
});

describe("runPdfChannels", () => {
  it("resolves the parsed result from noisy stdout and sends pdfPath + a total budget under the timeout", async () => {
    const { spawn, procs } = fakeSpawn((p) => {
      p.stdout.emit("data", Buffer.from("import noise\n"));
      p.stdout.emit("data", Buffer.from(okLine + "\n"));
      p.emit("close", 0);
    });
    const result = await runPdfChannels("/tmp/x.pdf", { spawn, timeoutMs: 30_000, maxPaths: 1000, scriptPath: "/s.py" });
    expect(result.pageCount).toBe(1);
    expect(JSON.parse(procs[0].written)).toEqual({ pdfPath: "/tmp/x.pdf", maxPaths: 1000, totalBudgetMs: 25_000 });
  });

  it("bad JSON on exit rejects; a script error line (exit 1) rejects with its error", async () => {
    const bad = fakeSpawn((p) => {
      p.stdout.emit("data", Buffer.from("{oops"));
      p.emit("close", 1);
    });
    await expect(runPdfChannels("/x.pdf", { spawn: bad.spawn })).rejects.toThrow(/no JSON result line/);
    const err = fakeSpawn((p) => {
      p.stdout.emit("data", Buffer.from('{"status":"error","error":"pdf_encrypted","message":"a password is required"}\n'));
      p.emit("close", 1);
    });
    await expect(runPdfChannels("/x.pdf", { spawn: err.spawn })).rejects.toThrow("pdf_channels.py: pdf_encrypted — a password is required");
    const silent = fakeSpawn((p) => p.emit("close", 1));
    await expect(runPdfChannels("/x.pdf", { spawn: silent.spawn })).rejects.toThrow(/exited with code 1, no output/);
  });

  it("a spawn error rejects", async () => {
    const { spawn } = fakeSpawn((p) => p.emit("error", new Error("ENOENT python3")));
    await expect(runPdfChannels("/x.pdf", { spawn })).rejects.toThrow("ENOENT python3");
  });

  it("times out: rejects, sends SIGTERM, then SIGKILL after the grace period; a late close is ignored", async () => {
    vi.useFakeTimers();
    const { spawn, procs } = fakeSpawn(() => {});
    const run = runPdfChannels("/x.pdf", { spawn, timeoutMs: 2_000 });
    const caught = run.catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(((await caught) as Error).message).toBe("pdf_channels.py timed out (2s)");
    expect(procs[0].kill.mock.calls).toEqual([["SIGTERM"]]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(procs[0].kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    procs[0].stdout.emit("data", Buffer.from(okLine));
    procs[0].emit("close", null); // no double settle, no throw
  });
});
