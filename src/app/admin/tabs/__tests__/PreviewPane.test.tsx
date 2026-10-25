// [clf visibility 2026-10-25] The Classifiers tab's "Run saved recipes on project" box prints every streamed
// line (project, per-project classifiers counts, warnings, errors, done with totals) and, when the run ends
// with 0 proposals, says why when the server said why.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import PreviewPane, { runVerdictLines } from "@/app/admin/tabs/classifiers/PreviewPane";

const PROJECTS = [{ id: "set-1", name: "Set 1", numPages: 3, isDemo: false, companyId: 3 }];

function ndjson(lines: object[]) {
  const text = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  return { ok: true, status: 200, body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } }) };
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const log = () => (document.querySelector("pre")?.textContent ?? "").split("\n");

async function runOn(lines: object[]) {
  fetchMock.mockResolvedValue(ndjson(lines));
  render(<PreviewPane draft={null} projects={PROJECTS} companyId={3} canRun />);
  fireEvent.change(screen.getByLabelText("preview project"), { target: { value: "set-1" } });
  fireEvent.click(screen.getByText("Run saved recipes on project"));
  await waitFor(() => expect(document.querySelector("pre")).not.toBeNull());
  await waitFor(() => expect(screen.getByText("Run saved recipes on project")).not.toBeDisabled());
  expect(fetchMock).toHaveBeenCalledWith("/api/admin/classifiers/run", expect.objectContaining({ method: "POST", body: JSON.stringify({ projectId: "set-1" }) }));
}

describe("PreviewPane run log", () => {
  it("prints every line and explains a 0-proposal run with the server's warning", async () => {
    await runOn([
      { type: "start", projects: 1 },
      { type: "project", name: "Set 1", pages: 3 },
      { type: "warning", project: "Set 1", message: "no YOLO detections — run YOLO load first" },
      { type: "classifiers", project: "Set 1", pages: 3, yoloPages: 0, regionsComputed: 0, proposals: 0, truncated: false },
      { type: "done", updated: 0, skipped: 3, total: 3, proposals: 0 },
    ]);
    expect(log()).toEqual([
      "Found 1 projects",
      "Processing: Set 1 (3 pages)",
      "  WARNING [Set 1]: no YOLO detections — run YOLO load first",
      "  Set 1: 3 pages, 0 with YOLO, regions computed now on 0, 0 proposals",
      "Done! 0 pages updated, 3 skipped. 0 proposals.",
      "No proposals were written. Why: no YOLO detections — run YOLO load first.",
    ]);
  });

  it("a run with proposals ends on the done totals; errors are printed", async () => {
    await runOn([
      { type: "project", name: "Set 1", pages: 3 },
      { type: "error", project: "Set 1", error: "lease held" },
      { type: "classifiers", project: "Set 1", pages: 3, yoloPages: 2, regionsComputed: 2, proposals: 5, truncated: false },
      { type: "done", updated: 2, skipped: 1, total: 3, proposals: 5 },
    ]);
    expect(log().slice(1)).toEqual([
      "  ERROR [Set 1]: lease held",
      "  Set 1: 3 pages, 2 with YOLO, regions computed now on 2, 5 proposals",
      "Done! 2 pages updated, 1 skipped. 5 proposals.",
    ]);
  });

  it("runVerdictLines: no done line, 0 proposals without a reason, >0 proposals", () => {
    expect(runVerdictLines(null, [])[0]).toMatch(/without a done line/u);
    expect(runVerdictLines({ type: "done", proposals: 0 }, [])[0]).toMatch(/no table candidate cleared/u);
    expect(runVerdictLines({ type: "done", proposals: 0 }, ["a", "", "b"])).toEqual(["No proposals were written. Why: a; b."]);
    expect(runVerdictLines({ type: "done", proposals: 3 }, ["a"])).toEqual([]);
  });
});
