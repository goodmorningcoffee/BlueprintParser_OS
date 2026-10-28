// @vitest-environment jsdom
// [TP-3 WP-3.N] The Structure step: every correction updates the preview WITHOUT a fetch (WP-3.D's real
// `applyOps` over the returned words and alternatives), including `pin-source` (from `alternatives[].geometry`) and
// `set-col-role`; the column ▾ sets QTY; "Wide view ▸" renders a 20-column grid in the drawer and its edits land in
// the same draft; notes paragraphs split / merge / rekey / mark a block header. The real workspace store and WP-3.M's
// ItemDetail are used; only `fetch` is mocked (the parse route). All fixtures are synthetic (rule 12).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import ItemDetail from "@/components/viewer/workspace/ItemDetail";
import { pinBothOps, sourceChoice } from "@/components/viewer/workspace/CorrectionBar";
import { pinnedSource } from "@/components/viewer/workspace/SourceSwitcher";
import { gridIndex, rowKeyText } from "@/components/viewer/workspace/StructurePreviewGrid";
import { resultSummary, structurePreview } from "@/components/viewer/workspace/StructureStep";
import { shortText } from "@/components/viewer/workspace/ParagraphPreviewList";
import { zCorrectionOps } from "@/lib/parse-engine/schema";
import type { CorrectionOp, ParseResult } from "@/lib/parse-engine/types";
import type { WorkspaceItem } from "@/queries/useWorkspaceItems";
import { useProposalFocusStore } from "@/stores/proposalFocusStore";
import { useSessionStore } from "@/stores/sessionStore";
import { resetTablesWorkspaceStore, useTablesWorkspaceStore } from "@/stores/tablesWorkspaceStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import { resetWorkspaceCanvasStore, useWorkspaceCanvasStore } from "@/stores/workspaceCanvasStore";
import { isTable, notesResult, scheduleResult, wideResult } from "./structureFixtures";

const PUB = "pub-ws-n";
const item = (over: Partial<WorkspaceItem> & { id: string }): WorkspaceItem => ({
  page: 1, b: [0.1, 0.1, 0.5, 0.26], kind: "schedule", origin: "proposal", title: `Synthetic ${over.id}`, p: 0.9, score: 0.9, state: "todo", ...over,
});

const calls: string[] = [];
let answer: ParseResult = scheduleResult();
let commitAnswer: Record<string, unknown> | null = null;
let qc: QueryClient;
const Providers = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;

function openWith(it: WorkspaceItem, result: ParseResult) {
  answer = result;
  useTablesWorkspaceStore.setState({ enabled: true, open: true, queue: [it], selectedKey: it.id, step: "structure" });
  return render(<Providers><ItemDetail /></Providers>);
}
const ops = (key: string): CorrectionOp[] => useTablesWorkspaceStore.getState().drafts[key]?.ops ?? [];
const grid = () => screen.getByRole("table", { name: "Structure preview" });
const cellText = (id: string) => grid().querySelector(`[data-cell="${id}"]`)?.textContent;

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  calls.length = 0;
  commitAnswer = null;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/parse-engine/parse")) return new Response(JSON.stringify(answer), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.endsWith("/parse-engine/commit") && commitAnswer) return new Response(JSON.stringify(commitAnswer), { status: 409, headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: url } }), { status: 404 });
  }));
  try { localStorage.clear(); } catch { /* jsdom */ }
  resetTablesWorkspaceStore();
  resetWorkspaceCanvasStore();
  useProposalFocusStore.setState({ hover: null, focus: null, fitRequest: 0 });
  useSessionStore.setState({ publicId: PUB, isDemo: false, projectId: 7, pageDrawingNumbers: { 1: "X-101" }, pageNames: {} });
  useViewerCoreStore.setState({ pageNumber: 1, numPages: 3 });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("pure helpers", () => {
  it("pin-source previews from alternatives[].geometry; lost ops are counted; a rebased model is shown as is", () => {
    const r = scheduleResult();
    const pinned = structurePreview(r, [{ op: "pin-source", axis: "rows", method: "shape-centres" }], null);
    expect(isTable(pinned.model) && pinned.model.rows.map((x) => [x.y0, x.y1])).toEqual([[0.1, 0.14], [0.14, 0.2], [0.2, 0.26]]);
    expect(pinned.lost).toBe(0);
    const lost = structurePreview(r, [{ op: "edit-cell", row: "r99", col: "c1", text: "x" }], null);
    expect(lost.lost).toBe(1);
    const rebased = structurePreview(r, [{ op: "set-header-rows", n: 2 }], r.model);
    expect(rebased.model).toBe(r.model);
  });

  it("Source ▾ pins each axis the method has lines on, and reads back one method, Fused or mixed", () => {
    const r = scheduleResult();
    expect(pinBothOps(r, "shape-centres")).toEqual([{ op: "pin-source", axis: "rows", method: "shape-centres" }]);
    expect(pinBothOps(r, "textract-cells")).toHaveLength(2);
    expect(pinBothOps(r, null).every((o) => o.op === "pin-source" && o.method === null)).toBe(true);
    expect(sourceChoice([])).toBe("fused");
    expect(sourceChoice(pinBothOps(r, "textract-cells"))).toBe("textract-cells");
    expect(sourceChoice(pinBothOps(r, "shape-centres"))).toBe("mixed");
    expect(pinnedSource([...pinBothOps(r, "textract-cells"), { op: "pin-source", axis: "rows", method: null }], "rows")).toBeNull();
  });

  it("grid spans cover their positions; unknown shape keys read '?'; long paragraph text is shortened", () => {
    const r = scheduleResult();
    const m = structurePreview(r, [{ op: "merge-cells", row: "r2", col: "c2", rs: 2, cs: 2 }], null).model;
    expect(isTable(m)).toBe(true);
    if (!isTable(m)) return;
    const { at, covered } = gridIndex(m);
    expect(at.get("r2|c2")?.rs).toBe(2);
    expect([...covered].sort()).toEqual(["r2|c3", "r3|c2", "r3|c3"]);
    expect(rowKeyText({ id: "r1", y0: 0, y1: 1, role: "body", key: { kind: "shape-text", text: null, shapeClass: "c", shapeBbox: [0, 0, 1, 1], textSource: "inside" } })).toEqual({ text: "?", unknown: true });
    expect(shortText("a ".repeat(100)).length).toBeLessThanOrEqual(90);
  });
});

describe("table corrections preview locally", () => {
  it("every op updates the preview without a fetch, and the ops are schema-valid", async () => {
    openWith(item({ id: "p-1", proposalId: "p-1" }), scheduleResult());
    await screen.findByText("3 rows × 3 columns · 1 header row");
    const fetched = calls.length;
    expect(fetched).toBe(1);
    const sources = screen.getByLabelText("Sources");
    const rowsSrc = within(sources).getByRole("group", { name: "Rows source" });
    expect(within(rowsSrc).getByRole("button", { name: "Fused ✓ (4)" })).toHaveAttribute("aria-pressed", "true");
    expect(within(within(sources).getByRole("group", { name: "Columns source" })).getByRole("button", { name: /Shape centres/ })).toBeDisabled();

    // pin-source rows → Shape centres (3 bands: 1 header + 2 body)
    fireEvent.click(within(rowsSrc).getByRole("button", { name: "Shape centres 3" }));
    expect(screen.getByText("2 rows × 3 columns · 1 header row")).toBeInTheDocument();
    expect(within(rowsSrc).getByRole("button", { name: "Shape centres ✓ 3" })).toHaveAttribute("aria-pressed", "true");
    // back to Fused
    fireEvent.click(within(rowsSrc).getByRole("button", { name: "Fused (4)" }));
    expect(screen.getByText("3 rows × 3 columns · 1 header row")).toBeInTheDocument();
    // Source ▾ → Textract on both axes (4 columns), then ONE Undo removes both pins
    fireEvent.change(screen.getByRole("combobox", { name: "Source" }), { target: { value: "textract-cells" } });
    expect(screen.getByText("3 rows × 4 columns · 1 header row")).toBeInTheDocument();
    const before = ops("p-1").length;
    fireEvent.click(screen.getByRole("button", { name: "Undo correction" }));
    expect(ops("p-1")).toHaveLength(before - 2);
    expect(screen.getByText("3 rows × 3 columns · 1 header row")).toBeInTheDocument();
    // Header rows ▾ 2
    fireEvent.change(screen.getByRole("combobox", { name: "Header rows" }), { target: { value: "2" } });
    expect(screen.getByText("2 rows × 3 columns · 2 header rows")).toBeInTheDocument();
    expect(within(grid()).getByRole("columnheader", { name: /SIZE W1/ })).toBeInTheDocument(); // labels re-read
    fireEvent.change(screen.getByRole("combobox", { name: "Header rows" }), { target: { value: "1" } });
    expect(screen.getByText("3 rows × 3 columns · 1 header row")).toBeInTheDocument();
    // Key column ▾ → SIZE
    fireEvent.change(screen.getByRole("combobox", { name: "Key column" }), { target: { value: "c2" } });
    expect(within(grid()).getByRole("columnheader", { name: /⬡ SIZE/ })).toBeInTheDocument();
    // Tag scope
    fireEvent.change(screen.getByRole("combobox", { name: "Tag scope" }), { target: { value: "sheet" } });
    expect(ops("p-1").at(-1)).toEqual({ op: "set-tag-scope", scope: "sheet" });
    // set-col-role via the column ▾: SIZE → QTY (the re-assembled header already guessed `size`)
    expect(grid().querySelector('[data-col="c2"] [data-role="size"]')).not.toBeNull();
    fireEvent.click(within(grid()).getByRole("button", { name: "Role of SIZE" }));
    expect(screen.getByRole("menuitemradio", { name: "Size" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "QTY" }));
    expect(ops("p-1").at(-1)).toEqual({ op: "set-col-role", col: "c2", role: "qty" });
    expect(grid().querySelector('[data-col="c2"] [data-role="qty"]')).toHaveTextContent("QTY");
    expect(screen.queryByRole("menu")).toBeNull();
    // Edit cells: a cell, a row key and a column label
    fireEvent.click(screen.getByRole("button", { name: "Edit cells" }));
    fireEvent.click(grid().querySelector('[data-cell="r3|c2"]')!);
    const field = screen.getByRole("textbox", { name: /Cell r3 SIZE/ });
    fireEvent.change(field, { target: { value: "W9" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(cellText("r3|c2")).toBe("W9");
    expect(grid().querySelector('[data-cell="r3|c2"]')).toHaveAttribute("data-src", "edit");
    fireEvent.click(within(grid()).getByRole("rowheader", { name: "A3" }));
    const keyField = screen.getByRole("textbox", { name: "Key of row r4" });
    fireEvent.change(keyField, { target: { value: "A9" } });
    fireEvent.keyDown(keyField, { key: "Enter" });
    expect(within(grid()).getByRole("rowheader", { name: "A9" })).toBeInTheDocument();
    fireEvent.click(grid().querySelector('[data-col="c1"] span')!);
    const label = screen.getByRole("textbox", { name: "Label of MARK" });
    fireEvent.change(label, { target: { value: "TAG NO" } });
    fireEvent.blur(label);
    expect(within(grid()).getByRole("columnheader", { name: /TAG NO/ })).toBeInTheDocument();
    // Esc cancels an edit without an op
    const n = ops("p-1").length;
    fireEvent.click(grid().querySelector('[data-cell="r2|c3"]')!);
    fireEvent.keyDown(screen.getByRole("textbox", { name: /Cell r2 COUNT/ }), { key: "Escape" });
    expect(ops("p-1")).toHaveLength(n);

    expect(zCorrectionOps.safeParse(ops("p-1")).success).toBe(true);
    expect(ops("p-1").map((o) => o.op)).toEqual([
      "pin-source", "pin-source", "set-header-rows", "set-header-rows", "set-tag-col", "set-tag-scope", "set-col-role", "edit-cell", "set-row-key", "rename-col",
    ]);
    // Reset → the machine result again
    fireEvent.click(screen.getByRole("button", { name: "Reset corrections" }));
    expect(screen.getByText("3 rows × 3 columns · 1 header row")).toBeInTheDocument();
    expect(cellText("r3|c2")).toBe("W2");
    expect(calls).toHaveLength(fetched);
  });

  it("low-confidence cells are outlined and tinted by source; an op that no longer lands is reported", async () => {
    openWith(item({ id: "p-2", proposalId: "p-2" }), scheduleResult());
    await screen.findByText("3 rows × 3 columns · 1 header row");
    expect(grid().querySelector('[data-cell="r4|c3"]')!.getAttribute("style")).toMatch(/outline/);
    act(() => useTablesWorkspaceStore.getState().setDraftOps("p-2", [{ op: "set-row-key", row: "r42", text: "x" }]));
    expect(screen.getByText(/1 correction no longer applies/)).toBeInTheDocument();
  });

  it("Draw rows / Draw columns arm the canvas capture for this item; Adjust lines explains the handles", async () => {
    openWith(item({ id: "p-3", proposalId: "p-3" }), scheduleResult());
    await screen.findByText("3 rows × 3 columns · 1 header row");
    fireEvent.click(screen.getByRole("button", { name: "Draw rows" }));
    expect(useWorkspaceCanvasStore.getState().armed).toEqual({ mode: "draw-rows", itemKey: "p-3" });
    fireEvent.click(screen.getByRole("button", { name: "Draw columns" }));
    expect(useWorkspaceCanvasStore.getState().armed).toEqual({ mode: "draw-cols", itemKey: "p-3" });
    fireEvent.click(screen.getByRole("button", { name: "Draw columns" }));
    expect(useWorkspaceCanvasStore.getState().armed).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Adjust lines" }));
    expect(screen.getByText(/drag a line to move it/)).toBeInTheDocument();
    expect(useProposalFocusStore.getState().focus).toMatchObject({ proposalId: "p-3" });
    // a canvas gesture (WP-3.O) lands in the same draft and the preview follows it
    act(() => {
      const s = useTablesWorkspaceStore.getState();
      s.setDraftOps("p-3", [...s.drafts["p-3"].ops, { op: "remove-line", axis: "rows", after: "r2" }]);
    });
    expect(screen.getByText("2 rows × 3 columns · 1 header row")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Undo correction" }));
    expect(screen.getByText("3 rows × 3 columns · 1 header row")).toBeInTheDocument();
    expect(calls).toHaveLength(1);
  });
});

describe("grouped Undo", () => {
  it("a Source ▾ pin undone after a later correction removes both pins (verifier PROBE-1)", async () => {
    openWith(item({ id: "u-1", proposalId: "u-1" }), scheduleResult());
    await screen.findByText("3 rows × 3 columns · 1 header row");
    fireEvent.change(screen.getByRole("combobox", { name: "Source" }), { target: { value: "textract-cells" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Header rows" }), { target: { value: "2" } });
    expect(ops("u-1")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Undo correction" }));
    expect(ops("u-1")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Undo correction" }));
    expect(ops("u-1")).toHaveLength(0);
    expect(screen.getByText("3 rows × 3 columns · 1 header row")).toBeInTheDocument();
  });

  it("walks back several groups, each one correction at a time, down to an empty list", async () => {
    openWith(item({ id: "u-2", proposalId: "u-2" }), scheduleResult());
    await screen.findByText("3 rows × 3 columns · 1 header row");
    fireEvent.change(screen.getByRole("combobox", { name: "Source" }), { target: { value: "textract-cells" } }); // 2 ops
    fireEvent.change(screen.getByRole("combobox", { name: "Header rows" }), { target: { value: "2" } }); // 1 op
    fireEvent.change(screen.getByRole("combobox", { name: "Source" }), { target: { value: "shape-centres" } }); // 1 op (rows only)
    fireEvent.change(screen.getByRole("combobox", { name: "Header rows" }), { target: { value: "1" } }); // 1 op
    const lengths = [ops("u-2").length];
    for (let i = 0; i < 4; i++) {
      fireEvent.click(screen.getByRole("button", { name: "Undo correction" }));
      lengths.push(ops("u-2").length);
    }
    expect(lengths).toEqual([5, 4, 3, 2, 0]);
    expect(screen.getByText("3 rows × 3 columns · 1 header row")).toBeInTheDocument();
  });
});

describe("rebase", () => {
  it("while a rebase waits on its confirm, the rebased model (ops already applied) is shown as is and corrections pause", async () => {
    openWith(item({ id: "p-r", proposalId: "p-r" }), scheduleResult());
    await screen.findByText("3 rows × 3 columns · 1 header row");
    fireEvent.change(screen.getByRole("combobox", { name: "Header rows" }), { target: { value: "2" } });
    expect(screen.getByText("2 rows × 3 columns · 2 header rows")).toBeInTheDocument();
    // a canvas gesture removes a row line (not idempotent, so applying the ops twice would show)
    act(() => {
      const s = useTablesWorkspaceStore.getState();
      s.setDraftOps("p-r", [...s.drafts["p-r"].ops, { op: "remove-line", axis: "rows", after: "r3" }]);
    });
    expect(screen.getByText("1 row × 3 columns · 2 header rows")).toBeInTheDocument();
    // the server's rebased model is authoritative and already carries the ops: here its re-scan kept the row the
    // draft removed, so applying the draft's remove-line again on top would show one row fewer
    const rebased = structurePreview(scheduleResult(), [{ op: "set-header-rows", n: 2 }], null).model;
    commitAnswer = { error: { code: "CONFLICT", message: "Refused" }, reason: "rebased", rebased, changedRows: 1, evidenceHash: "ev-2" };
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(await screen.findByText(/Showing the re-scanned result/)).toBeInTheDocument();
    expect(screen.getByText("2 rows × 3 columns · 2 header rows")).toBeInTheDocument(); // not the ops applied again on top
    expect(resultSummary({ model: rebased })).toBe("2 rows × 3 columns · 2 header rows");
    expect(screen.getByRole("combobox", { name: "Header rows" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Undo correction" })).toBeDisabled();
    expect(within(grid()).queryByRole("button", { name: /Role of/ })).toBeNull();
    expect(ops("p-r")).toEqual([{ op: "set-header-rows", n: 2 }, { op: "remove-line", axis: "rows", after: "r3" }]);
  });
});

describe("Wide view", () => {
  it("renders a 20-column grid in the drawer, and its edits round-trip to the draft", async () => {
    openWith(item({ id: "p-w", proposalId: "p-w", b: [0.05, 0.1, 0.95, 0.19] }), wideResult());
    await screen.findByText("2 rows × 20 columns · 1 header row");
    fireEvent.click(screen.getByRole("button", { name: "Wide view ▸" }));
    const drawer = screen.getByRole("dialog", { name: "Wide view" });
    const wide = within(drawer).getByRole("table", { name: "Wide structure preview" });
    expect(within(wide).getAllByRole("columnheader")).toHaveLength(20);
    fireEvent.click(within(drawer).getByRole("button", { name: "Edit cells" }));
    fireEvent.click(wide.querySelector('[data-cell="r3|c17"]')!);
    const field = within(drawer).getByRole("textbox", { name: /Cell r3 H17/ });
    fireEvent.change(field, { target: { value: "Z17" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(ops("p-w")).toEqual([{ op: "edit-cell", row: "r3", col: "c17", text: "Z17" }]);
    expect(wide.querySelector('[data-cell="r3|c17"]')).toHaveTextContent("Z17");
    expect(cellText("r3|c17")).toBe("Z17"); // the panel grid shows the same draft
    // the column ▾ in the drawer too
    fireEvent.click(within(wide).getByRole("button", { name: "Role of H5" }));
    fireEvent.click(within(drawer).getByRole("menuitemradio", { name: "QTY" }));
    expect(ops("p-w").at(-1)).toEqual({ op: "set-col-role", col: "c5", role: "qty" });
    fireEvent.click(within(drawer).getByRole("button", { name: "Close wide view" }));
    expect(screen.queryByRole("dialog", { name: "Wide view" })).toBeNull();
    expect(cellText("r3|c17")).toBe("Z17");
    expect(calls).toHaveLength(1);
  });

  it("Esc in a cell field or an open column ▾ ends only that; Esc on the drawer itself closes it", async () => {
    openWith(item({ id: "p-e", proposalId: "p-e", b: [0.05, 0.1, 0.95, 0.19] }), wideResult());
    await screen.findByText("2 rows × 20 columns · 1 header row");
    fireEvent.click(screen.getByRole("button", { name: "Wide view ▸" }));
    const drawer = screen.getByRole("dialog", { name: "Wide view" });
    const wide = within(drawer).getByRole("table", { name: "Wide structure preview" });
    fireEvent.click(within(drawer).getByRole("button", { name: "Edit cells" }));
    fireEvent.click(wide.querySelector('[data-cell="r3|c17"]')!);
    fireEvent.keyDown(within(drawer).getByRole("textbox", { name: /Cell r3 H17/ }), { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Wide view" })).toBeInTheDocument();
    expect(within(drawer).queryByRole("textbox", { name: /Cell r3 H17/ })).toBeNull();
    fireEvent.click(within(wide).getByRole("button", { name: "Role of H5" }));
    fireEvent.keyDown(within(drawer).getByRole("menuitemradio", { name: "QTY" }), { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Wide view" })).toBeInTheDocument();
    expect(within(drawer).queryByRole("menu")).toBeNull();
    expect(ops("p-e")).toEqual([]);
    fireEvent.keyDown(drawer, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Wide view" })).toBeNull();
  });
});

describe("paragraphs", () => {
  const notesItem = () => item({ id: "tr:notes:1", origin: "text-region", kind: "notes", b: [0.1, 0.5, 0.4, 0.67] });
  const para = (id: string) => document.querySelector(`[data-paragraph="${id}"]`) as HTMLElement;

  it("shows addresses; split / merge / rekey / block header update the list without a fetch", async () => {
    openWith(notesItem(), notesResult());
    await screen.findByText("3 paragraphs in 1 block");
    const list = screen.getByLabelText("Paragraphs");
    expect(within(list).getByText("X-101 › SYNTHETIC NOTES › 1")).toBeInTheDocument();
    expect(para("p1")).toHaveTextContent("Synthetic alpha beta gamma (2 lines)");
    fireEvent.click(screen.getByRole("button", { name: "Split/merge ¶" }));
    // split ¶1 before its second line
    fireEvent.click(within(within(list).getByRole("list", { name: "Lines of p1" })).getByRole("button", { name: /beta gamma/ }));
    expect(screen.getByText("4 paragraphs in 1 block")).toBeInTheDocument();
    expect(ops("tr:notes:1").at(-1)).toEqual({ op: "split-paragraph", p: "p1", atLine: 1 });
    expect(para("p1")).toHaveTextContent("(1 line)");
    // shift-click ¶1 merges the next paragraph back into it
    fireEvent.click(para("p1"), { shiftKey: true });
    expect(screen.getByText("3 paragraphs in 1 block")).toBeInTheDocument();
    // Merge ↑ joins ¶2 to ¶1
    fireEvent.click(within(para("p2")).getByRole("button", { name: "Merge ↑" }));
    expect(screen.getByText("2 paragraphs in 1 block")).toBeInTheDocument();
    expect(within(para("p1")).getByRole("button", { name: "Merge ↑" })).toBeDisabled();
    // rekey ¶3
    fireEvent.click(within(para("p3")).getByRole("button", { name: "Key 3: rekey" }));
    const keyField = screen.getByRole("textbox", { name: "Key of paragraph p3" });
    fireEvent.change(keyField, { target: { value: "3A" } });
    fireEvent.keyDown(keyField, { key: "Enter" });
    expect(within(list).getByText("X-101 › SYNTHETIC NOTES › 3A")).toBeInTheDocument();
    // the line of ¶3 becomes a block header → 2 blocks
    const p3Lines = within(para("p3")).getByRole("list", { name: "Lines of p3" });
    fireEvent.click(within(p3Lines).getByRole("button", { name: /as a block header/ }));
    expect(screen.getByText(/in 2 blocks/)).toBeInTheDocument();
    expect(ops("tr:notes:1").map((o) => o.op)).toEqual(["split-paragraph", "merge-paragraph", "merge-paragraph", "set-paragraph-key", "mark-block-header"]);
    expect(zCorrectionOps.safeParse(ops("tr:notes:1")).success).toBe(true);
    // Undo walks back one correction at a time
    fireEvent.click(screen.getByRole("button", { name: "Undo correction" }));
    expect(screen.getByText("2 paragraphs in 1 block")).toBeInTheDocument();
    expect(calls).toHaveLength(1);
  });

  it("controls stay read-only until Split/merge ¶ is on", async () => {
    openWith(notesItem(), notesResult());
    await screen.findByText("3 paragraphs in 1 block");
    expect(within(para("p1")).getByRole("button", { name: "Key 1: rekey" })).toBeDisabled();
    expect(within(para("p1")).queryByRole("list")).toBeNull();
    fireEvent.click(para("p1"), { shiftKey: true });
    expect(ops("tr:notes:1")).toEqual([]);
    await waitFor(() => expect(calls).toHaveLength(1));
  });
});
