// @vitest-environment jsdom
// [TP-3 WP-3.N] Click paths A, A2, B and C (PLAN §3.3) end to end through the real panel (TablesWorkspaceHost →
// inbox → ItemDetail → StructureStep → AcceptBar) with mocked routes: flags, items, parse and commit, answering in
// WP-3.E / WP-3.F / WP-3.G shapes. Each path corrects the parse in the Structure step (no fetch per correction) and
// accepts; the commit carries the MACHINE model as `base` plus the ops (the server re-applies them, WP-3.G). The
// canvas gestures themselves are WP-3.O's tests; a drawn continuation box lands through WP-3.M's
// `addContinuationPart`, as the canvas does. All fixtures are synthetic (rule 12).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import TablesWorkspaceHost from "@/components/viewer/workspace/TablesWorkspaceHost";
import { addContinuationPart } from "@/components/viewer/workspace/ContinuationControls";
import { zCorrectionOps, zStructureModel } from "@/lib/parse-engine/schema";
import type { BboxMinMax, ParseEngineFlags, ParseResult, StructureTableModel } from "@/lib/parse-engine/types";
import type { WorkspaceItem } from "@/queries/useWorkspaceItems";
import { useProposalFocusStore } from "@/stores/proposalFocusStore";
import { useSessionStore } from "@/stores/sessionStore";
import { resetTablesWorkspaceStore, useTablesWorkspaceStore } from "@/stores/tablesWorkspaceStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import { resetWorkspaceCanvasStore } from "@/stores/workspaceCanvasStore";
import { openFromToolbar } from "@/stores/workspaceCommands";
import { keynoteResult, notesResult, scheduleResult } from "./structureFixtures";

const PUB = "pub-ws-n-paths";
const FLAGS: ParseEngineFlags = {
  killSwitch: false, cropCache: true,
  tools: { tablesRoute: "legacy", keynoteRoute: "legacy", notesClassifier: "legacy", specClassifier: "legacy", notesAuto: "legacy", specAuto: "legacy", workspace: "engine" },
};
const item = (over: Partial<WorkspaceItem> & { id: string }): WorkspaceItem => ({
  page: 1, b: [0.1, 0.1, 0.5, 0.26], kind: "schedule", origin: "proposal", title: `Synthetic ${over.id}`, p: 0.9, score: 0.9, state: "todo", ...over,
});
const ITEMS: WorkspaceItem[] = [
  item({ id: "p-sched", proposalId: "p-sched", p: 0.95, score: 0.95 }),
  item({ id: "p-key", proposalId: "p-key", kind: "keynote", b: [0.1, 0.3, 0.45, 0.39], p: 0.8, score: 0.8 }),
  item({ id: "tr:notes:syn", origin: "text-region", kind: "notes", b: [0.1, 0.5, 0.4, 0.67], p: 0.7, score: 0.7 }),
];

/** The schedule after a continuation box: two more rows in part 1 (R11). */
function twoPartResult(): ParseResult {
  const r = scheduleResult();
  const m = r.model as StructureTableModel;
  const part: BboxMinMax = [0.55, 0.1, 0.95, 0.18];
  m.parts = [part];
  m.rows.push({ id: "r5", y0: 0.1, y1: 0.14, part: 1, role: "body", key: { kind: "text", text: "A4" } }, { id: "r6", y0: 0.14, y1: 0.18, part: 1, role: "body", key: { kind: "text", text: "A5" } });
  m.cells.push({ row: "r5", col: "c2", text: "W4", src: "ocr-lines" }, { row: "r6", col: "c2", text: "W5", src: "ocr-lines" });
  return r;
}

type Body = Record<string, unknown>;
const calls: { url: string; method: string; body: Body | undefined }[] = [];
let parseAnswer: (body: Body) => ParseResult = () => scheduleResult();
const commits = () => calls.filter((c) => c.url.endsWith("/parse-engine/commit"));
const parses = () => calls.filter((c) => c.url.endsWith("/parse-engine/parse"));
const committedBody = (kind: string) => ({
  ok: true, regionId: `sr-${kind}-1`, revision: 1, kind, parsedRegion: {}, updatedIntelligence: null, csiCodeCount: 0,
  tags: { rows: [], removed: [], replacedRegionIds: [] }, summaries: null,
  tagSummary: { keys: 3, tags: 3, hits: 9, none: 1, noneKeys: ["A3"], scope: kind === "schedule" ? "project" : "sheet" },
});

let qc: QueryClient;
const Providers = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  calls.length = 0;
  parseAnswer = () => scheduleResult();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Body) : undefined;
    calls.push({ url, method, body });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    if (url.endsWith("/parse-engine/flags")) return json(200, FLAGS);
    if (url.includes("/parse-engine/items?")) return json(200, { scope: "sheet", indexReady: true, threshold: 0.3, groups: [{ page: 1, items: ITEMS, lowConfidence: [] }] });
    if (url.endsWith("/parse-engine/parse")) return json(200, parseAnswer(body!));
    if (url.endsWith("/parse-engine/commit")) {
      const kind = ((body!.base as { kind?: string } | undefined)?.kind) ?? "schedule";
      return json(200, committedBody(kind));
    }
    return json(404, { error: { code: "NOT_FOUND", message: url } });
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

/** Toolbar → the group's inbox → click the row → the detail (parsed). */
async function openFromInbox(group: "tables" | "notes", id: string, summary: string | RegExp) {
  render(<Providers><TablesWorkspaceHost /></Providers>);
  await waitFor(() => expect(useTablesWorkspaceStore.getState().enabled).toBe(true));
  act(() => openFromToolbar(group));
  const panel = await screen.findByRole("complementary", { name: /tables and notes workspace/i });
  const row = await waitFor(() => {
    const el = panel.querySelector(`[data-item-id="${id}"]`);
    expect(el).not.toBeNull();
    return el as HTMLElement;
  });
  fireEvent.click(row);
  const detail = await within(panel).findByRole("region", { name: "Item detail" });
  await within(detail).findByText(summary);
  return detail;
}

function expectCommit(n: number) {
  const c = commits()[n];
  expect(c).toBeDefined();
  const body = c.body!;
  expect(zCorrectionOps.safeParse(body.ops).success).toBe(true);
  expect(zStructureModel.safeParse(body.base).success).toBe(true);
  return body as { ops: { op: string }[]; base: { kind: string }; recipe: { request: Record<string, unknown> }; links?: Record<string, string> };
}

describe("click paths (PLAN §3.3)", () => {
  it("A · schedule from a proposal: pin a source, set header rows and QTY, Accept → the ops ride on the machine base", async () => {
    const detail = await openFromInbox("tables", "p-sched", "3 rows × 3 columns · 1 header row");
    expect(parses().find((c) => (c.body!.hints as { proposalId?: string } | undefined)?.proposalId === "p-sched")?.body)
      .toMatchObject({ kind: "schedule", budget: "instant" });
    await waitFor(() => expect(parses()).toHaveLength(2)); // + the next item's prefetch (WP-3.M)
    const fetched = calls.length;
    fireEvent.change(within(detail).getByRole("combobox", { name: "Source" }), { target: { value: "textract-cells" } });
    fireEvent.change(within(detail).getByRole("combobox", { name: "Header rows" }), { target: { value: "1" } });
    fireEvent.click(within(detail).getByRole("button", { name: "Role of Column 4" })); // the column only Textract found
    fireEvent.click(within(detail).getByRole("menuitemradio", { name: "QTY" }));
    expect(within(detail).getByText("3 rows × 4 columns · 1 header row")).toBeInTheDocument();
    expect(calls).toHaveLength(fetched); // no correction fetched
    fireEvent.click(within(detail).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(commits()).toHaveLength(1));
    const body = expectCommit(0);
    expect(body.ops.map((o) => o.op)).toEqual(["pin-source", "pin-source", "set-header-rows", "set-col-role"]);
    expect(body.base).toEqual(scheduleResult().model); // the machine model, not the preview
    expect(body.links).toMatchObject({ proposalId: "p-sched" });
    expect(await screen.findByText(/Mapped 3 tags · 9 hits · 1 with none/)).toBeInTheDocument();
  });

  it("A2 · two-block schedule: the continuation box re-parses with parts, a part-2 cell is edited, Accept sends parts + ops", async () => {
    parseAnswer = (b) => (Array.isArray(b.parts) ? twoPartResult() : scheduleResult());
    const detail = await openFromInbox("tables", "p-sched", "3 rows × 3 columns · 1 header row");
    fireEvent.click(within(detail).getByRole("button", { name: "+ Add continuation box" }));
    act(() => { addContinuationPart("p-sched", [0.55, 0.1, 0.95, 0.18]); });
    await within(detail).findByText("5 rows × 3 columns · 1 header row");
    expect(parses().at(-1)!.body).toMatchObject({ parts: [[0.55, 0.1, 0.95, 0.18]] });
    fireEvent.click(within(detail).getByRole("button", { name: "Edit cells" }));
    const grid = within(detail).getByRole("table", { name: "Structure preview" });
    fireEvent.click(grid.querySelector('[data-cell="r6|c2"]')!);
    const field = within(detail).getByRole("textbox", { name: /Cell r6 SIZE/ });
    fireEvent.change(field, { target: { value: "W5B" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(grid.querySelector('[data-cell="r6|c2"]')).toHaveTextContent("W5B");
    fireEvent.click(within(detail).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(commits()).toHaveLength(1));
    const body = expectCommit(0);
    expect(body.recipe.request).toMatchObject({ parts: [[0.55, 0.1, 0.95, 0.18]] });
    expect(body.ops).toEqual([{ op: "edit-cell", row: "r6", col: "c2", text: "W5B" }]);
  });

  it("B · keynote with shape keys: the unknown key is red; type it, keep This sheet scope, Accept", async () => {
    parseAnswer = () => keynoteResult();
    const detail = await openFromInbox("tables", "p-key", "3 rows × 2 columns");
    const grid = within(detail).getByRole("table", { name: "Structure preview" });
    const unknown = grid.querySelector("[data-unknown-key]") as HTMLElement;
    expect(unknown).toHaveTextContent("?");
    expect(within(detail).getByRole("combobox", { name: "Tag scope" })).toHaveValue("sheet");
    fireEvent.click(within(detail).getByRole("button", { name: "Edit cells" }));
    fireEvent.click(unknown);
    const field = within(detail).getByRole("textbox", { name: "Key of row r2" });
    fireEvent.change(field, { target: { value: "2" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(grid.querySelector("[data-unknown-key]")).toBeNull();
    expect(within(grid).getByRole("rowheader", { name: "2" })).toBeInTheDocument();
    fireEvent.click(within(detail).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(commits()).toHaveLength(1));
    const body = expectCommit(0);
    expect(body.base.kind).toBe("keynote");
    expect(body.ops).toEqual([{ op: "set-row-key", row: "r2", text: "2" }]);
  });

  it("C · notes block: split a paragraph, rekey one, Accept → the paragraph ops ride on the machine base", async () => {
    parseAnswer = () => notesResult();
    const detail = await openFromInbox("notes", "tr:notes:syn", "3 paragraphs in 1 block");
    expect(within(detail).getByText("X-101 › SYNTHETIC NOTES › 2")).toBeInTheDocument();
    fireEvent.click(within(detail).getByRole("button", { name: "Split/merge ¶" }));
    fireEvent.click(within(within(detail).getByRole("list", { name: "Lines of p1" })).getByRole("button", { name: /beta gamma/ }));
    fireEvent.click(within(detail).getByRole("button", { name: "Key 2: rekey" }));
    const field = within(detail).getByRole("textbox", { name: "Key of paragraph p2" });
    fireEvent.change(field, { target: { value: "2.1" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(within(detail).getByText("4 paragraphs in 1 block")).toBeInTheDocument();
    expect(within(detail).getByText("X-101 › SYNTHETIC NOTES › 2.1")).toBeInTheDocument();
    fireEvent.click(within(detail).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(commits()).toHaveLength(1));
    const body = expectCommit(0);
    expect(body.base.kind).toBe("notes");
    expect(body.ops).toEqual([{ op: "split-paragraph", p: "p1", atLine: 1 }, { op: "set-paragraph-key", p: "p2", key: "2.1" }]);
    expect(body.recipe.request).toMatchObject({ kind: "notes" });
  });
});
