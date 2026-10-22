// @vitest-environment node
// [fix 2026-10-21 reprocess-persistence] The admin reprocess console renders EVERY event type.
// The old inline reader printed only start/project/progress/done, so per-project errors,
// "Lambda failed" warnings and config lines never reached the owner.
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatReprocessEvent, reprocessUrl, runReprocess } from "@/app/admin/reprocess-client";

afterEach(() => vi.unstubAllGlobals());

describe("reprocessUrl", () => {
  it("a click event passed as scope (onClick={onReprocess}) means no scope, never [object Object]", () => {
    expect(reprocessUrl({ type: "click" }, false)).toBe("/api/admin/reprocess");
    expect(reprocessUrl(undefined, false)).toBe("/api/admin/reprocess");
    expect(reprocessUrl("shape-parse", false)).toBe("/api/admin/reprocess?scope=shape-parse");
  });
  it("the Debug toggle adds trace=1 (not debug=1, which writes classifier bundles to S3)", () => {
    expect(reprocessUrl("shape-parse", true)).toBe("/api/admin/reprocess?scope=shape-parse&trace=1");
    expect(reprocessUrl(undefined, true)).toBe("/api/admin/reprocess?trace=1");
  });
});

describe("formatReprocessEvent", () => {
  it("renders warning, error, config, analysis, summaries, debug — and the split done counters", () => {
    expect(formatReprocessEvent({ type: "warning", project: "P1", message: "Lambda could not scan 3/3 pages" }))
      .toBe("  WARNING [P1]: Lambda could not scan 3/3 pages");
    expect(formatReprocessEvent({ type: "error", project: "P1", error: "lease held" })).toBe("  ERROR [P1]: lease held");
    expect(formatReprocessEvent({ type: "config", useLambda: true })).toBe("Shape parse engine: Lambda fan-out");
    expect(formatReprocessEvent({ type: "project-analysis", project: "P1" })).toBe("  project analysis saved (P1)");
    expect(formatReprocessEvent({ type: "project-summaries", project: "P1" })).toBe("  project summaries saved (P1)");
    expect(formatReprocessEvent({ type: "debug", scope: "shape-parse", step: "lambda.invoke", ok: false, functionError: "Unhandled" }))
      .toBe('  [debug shape-parse] lambda.invoke ok=false functionError=Unhandled');
    expect(formatReprocessEvent({ type: "heartbeat", invocations: 1, of: 3 })).toBeNull();
    expect(formatReprocessEvent({ type: "done", updated: 4, skipped: 3, empty: 2, failed: 1, total: 7 }))
      .toBe("Done! 4 pages updated, 3 skipped. (2 scanned with no shapes, 1 failed — failed pages kept their previous shapes)");
    expect(formatReprocessEvent({ type: "done", updated: 1, skipped: 0, total: 1 })).toBe("Done! 1 pages updated, 0 skipped.");
  });
});

describe("runReprocess", () => {
  it("streams every line, including a final line without a trailing newline, and flags a missing done", async () => {
    const body = [
      JSON.stringify({ type: "start", projects: 1 }),
      JSON.stringify({ type: "warning", project: "P", message: "m" }),
      JSON.stringify({ type: "error", project: "P", error: "e" }),
    ].join("\n");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));
    const lines: string[] = [];
    await runReprocess({ scope: "shape-parse", debug: true }, (l) => lines.push(l));
    expect(lines).toEqual([
      "Found 1 projects",
      "  WARNING [P]: m",
      "  ERROR [P]: e",
      "Stream ended without a 'done' line — the run may have been cut off; check the server log.",
    ]);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("/api/admin/reprocess?scope=shape-parse&trace=1");
  });
});
