// @vitest-environment jsdom
// [TP-3 WP-3.M] ItemDetail shell: parse (stamped, prefetched), accept (id + revision + ops), the three 409
// answers (conflict → Replace pre-selected ⏎; rebase → one-click; paid crop expired → paid re-run), the tag
// summary + yoloTags adoption, continuations (`parts`, `links.continues`), verdicts, StepTabs and the bulk
// Notes/Specs accept. The real workspace store, commands, focus store and query caches are used; only `fetch`
// is mocked, routed by URL (the parse route of WP-3.E; the commit route of WP-3.G and the verdict / items routes
// of WP-3.F are mirrored by their PLAN §2.1 / §3.2 shapes). All fixtures are synthetic (PLAN §1.6 rule 12).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import ItemDetail from "@/components/viewer/workspace/ItemDetail";
import BulkAcceptDialog from "@/components/viewer/workspace/BulkAcceptDialog";
import { addContinuationPart } from "@/components/viewer/workspace/ContinuationControls";
import { stepsFor } from "@/components/viewer/workspace/StepTabs";
import type { ParseResult, StructureModel } from "@/lib/parse-engine/types";
import { parseItem } from "@/queries/useEngineParse";
import { classifyCommitResponse } from "@/queries/useCommitStructure";
import { queryKeys } from "@/queries/queryKeys";
import { setPageIntelligenceForPage } from "@/queries/usePageWindow";
import { readYoloTags } from "@/queries/useYoloTags";
import type { WorkspaceItem } from "@/queries/useWorkspaceItems";
import { useProposalFocusStore } from "@/stores/proposalFocusStore";
import { useSessionStore } from "@/stores/sessionStore";
import { resetTablesWorkspaceStore, useTablesWorkspaceStore } from "@/stores/tablesWorkspaceStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import type { PageIntelligence, YoloTag } from "@/types";

const PUB = "pub-ws-m";

const item = (over: Partial<WorkspaceItem> & { id: string }): WorkspaceItem => ({
  page: 1, b: [0.1, 0.1, 0.4, 0.3], kind: "schedule", origin: "proposal", title: `Synthetic ${over.id}`,
  p: 0.9, score: 0.9, state: "todo", ...over,
});

const tableModel = (over: Partial<Extract<StructureModel, { rows: unknown }>> = {}): StructureModel => ({
  v: 1, kind: "schedule", bbox: [0.1, 0.1, 0.4, 0.3], headerRows: 1,
  rows: [
    { id: "r1", y0: 0.1, y1: 0.12, role: "header" },
    { id: "r2", y0: 0.12, y1: 0.2, role: "body", key: { kind: "text", text: "A1" } },
  ],
  cols: [{ id: "c1", x0: 0.1, x1: 0.2, label: "MARK", labelRaw: "MARK" }, { id: "c2", x0: 0.2, x1: 0.4, label: "SIZE", labelRaw: "SIZE" }],
  cells: [], tag: { col: "c1", src: "header", scope: "project" },
  sources: { rows: ["ocr-lines"], cols: ["x-starts"] }, quality: { conf: 0.9, agreement: 0.92, flags: [] }, ...over,
} as StructureModel);

const notesModel = (keyed: boolean, agreement = 0.9): StructureModel => ({
  v: 1, kind: "notes", bbox: [0.1, 0.5, 0.4, 0.9], blocks: [{ id: "b1", header: "SYNTHETIC NOTES", headerNorm: "SYNTHETIC NOTES", b: [0.1, 0.5, 0.4, 0.55] }],
  paragraphs: [{ id: "p1", blockId: "b1", key: keyed ? "1" : null, keyPath: keyed ? ["1"] : [], keyNorm: keyed ? "1" : "", depth: 0, text: "Synthetic note text.", b: [0.1, 0.55, 0.4, 0.6], lineCount: 1 }],
  sources: { segment: ["hanging-indent"] }, quality: { conf: 0.9, agreement, flags: [] },
});

const parseResult = (model: StructureModel, hash = "ev-1", budget: ParseResult["stamp"]["budget"] = "instant"): ParseResult => ({
  model, alternatives: [], words: [],
  evidence: { words: 12, lines: 4, paidCropAvailable: false },
  stamp: { engine: "pe/1.0.0", caps: {}, methods: [], budget, evidenceHash: hash, paramsHash: "p", at: "2026-10-28T00:00:00Z" },
});

type Hit = { status: number; body: unknown; wait?: Promise<void> };
type Route = (url: string, method: string, body: Record<string, unknown> | undefined) => Hit | undefined;
let routes: Route[] = [];
const calls: { url: string; method: string; body: Record<string, unknown> | undefined }[] = [];

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ url, method, body });
    for (const route of routes) {
      const hit = route(url, method, body);
      if (hit) {
        if (hit.wait) await hit.wait;
        return new Response(JSON.stringify(hit.body), { status: hit.status, headers: { "Content-Type": "application/json" } });
      }
    }
    return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: `unrouted ${method} ${url}` } }), { status: 404 });
  }));
}

const parseCalls = () => calls.filter((c) => c.url.endsWith("/parse-engine/parse"));
const commitCalls = () => calls.filter((c) => c.url.endsWith("/parse-engine/commit"));
const parseRoute = (model: (body: Record<string, unknown>) => StructureModel = () => tableModel()): Route => (url, _m, body) =>
  url.endsWith("/parse-engine/parse") ? { status: 200, body: parseResult(model(body!), "ev-1", body!.budget as "instant") } : undefined;
const commitRoute = (answer: (n: number, body: Record<string, unknown>) => Hit): Route => (url, _m, body) =>
  url.endsWith("/parse-engine/commit") ? answer(commitCalls().length, body!) : undefined;
const committed = (over: Record<string, unknown> = {}): Hit => ({ status: 200, body: { ok: true, regionId: "sr-schedule-1-x", revision: 1, ...over } });

let qc: QueryClient;
const Providers = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;

function openWith(items: WorkspaceItem[], selected = items[0].id) {
  useTablesWorkspaceStore.setState({ enabled: true, open: true, queue: items, selectedKey: selected, step: "structure" });
  return render(<Providers><ItemDetail /></Providers>);
}

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  routes = [];
  calls.length = 0;
  installFetch();
  try { localStorage.clear(); } catch { /* jsdom */ }
  resetTablesWorkspaceStore();
  useProposalFocusStore.setState({ hover: null, focus: null, fitRequest: 0 });
  useSessionStore.setState({ publicId: PUB, isDemo: false, projectId: 7, pageDrawingNumbers: { 3: "S-301" }, pageNames: {} });
  useViewerCoreStore.setState({ pageNumber: 1, numPages: 5 });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("parse", () => {
  it("parses the open item once at instant with its proposal hint, and shows the result", async () => {
    routes = [parseRoute()];
    openWith([item({ id: "p-1", proposalId: "p-1" })]);
    await screen.findByText(/1 row × 2 columns/);
    expect(parseCalls()).toHaveLength(1);
    expect(parseCalls()[0].body).toEqual({ page: 1, bbox: [0.1, 0.1, 0.4, 0.3], kind: "schedule", budget: "instant", hints: { proposalId: "p-1" } });
  });

  it("a drawn box is parsed with no kind, and the kind suggestion re-parses as that kind", async () => {
    routes = [(url, _m, body) => url.endsWith("/parse") ? {
      status: 200, body: { ...parseResult(tableModel()), kindSuggestion: body!.kind ? undefined : { kind: "keynote", classId: null, p: 0.8 } },
    } : undefined];
    openWith([item({ id: "draw:1:0.10,0.10,0.40,0.30", origin: undefined as never })]);
    fireEvent.click(await screen.findByRole("button", { name: "Use" }));
    await waitFor(() => expect(parseCalls()).toHaveLength(2));
    expect(parseCalls()[0].body).not.toHaveProperty("kind");
    expect(parseCalls()[1].body).toMatchObject({ kind: "keynote" });
  });

  it("a kind the user picks re-parses as that kind and is kept as a set-kind op; Discard draft drops the ops", async () => {
    routes = [parseRoute((b) => tableModel({ kind: (b.kind as "keynote") ?? "schedule" }))];
    openWith([item({ id: "p-1", proposalId: "p-1" })]);
    await screen.findByText(/1 row × 2 columns/);
    fireEvent.change(screen.getByRole("combobox", { name: "Kind" }), { target: { value: "keynote" } });
    await waitFor(() => expect(parseCalls()).toHaveLength(2));
    expect(parseCalls()[1].body).toMatchObject({ kind: "keynote" });
    expect(useTablesWorkspaceStore.getState().drafts["p-1"].ops).toEqual([{ op: "set-kind", kind: "keynote" }]);
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    await waitFor(() => expect(useTablesWorkspaceStore.getState().drafts["p-1"]?.result).toBeTruthy());
    expect(useTablesWorkspaceStore.getState().drafts["p-1"]).toMatchObject({ kind: "schedule", ops: [] });
  });

  it("a stale-stamp result is ignored: the answer to the older request never replaces the newer one", async () => {
    let releaseOld!: () => void;
    const oldGate = new Promise<void>((r) => { releaseOld = r; });
    routes = [(url, _m, body) => url.endsWith("/parse") ? (body!.budget === "instant"
      ? { status: 200, body: parseResult(tableModel(), "old"), wait: oldGate }
      : { status: 200, body: parseResult(tableModel(), "new", "standard") }) : undefined];
    const it1 = item({ id: "p-1", proposalId: "p-1" });
    const first = parseItem(qc, PUB, it1, { budget: "instant" });
    const second = await parseItem(qc, PUB, it1, { budget: "standard" });
    expect(second.status).toBe("applied");
    releaseOld();
    expect((await first).status).toBe("stale");
    expect(useTablesWorkspaceStore.getState().drafts["p-1"].result?.stamp.evidenceHash).toBe("new");
  });

  it("prefetches the next item once, at instant, and opening it needs no second request", async () => {
    routes = [parseRoute()];
    const a = item({ id: "p-a", proposalId: "p-a" });
    const b = item({ id: "p-b", proposalId: "p-b", b: [0.5, 0.1, 0.9, 0.3] });
    openWith([a, b]);
    await screen.findByText(/1 row × 2 columns/);
    const forB = () => parseCalls().filter((c) => (c.body!.hints as { proposalId?: string })?.proposalId === "p-b");
    await waitFor(() => expect(forB()).toHaveLength(1));
    expect(forB()[0].body!.budget).toBe("instant");
    act(() => { useTablesWorkspaceStore.getState().setStep("accept"); });
    act(() => { useTablesWorkspaceStore.getState().setHover("p-a"); });
    await act(async () => { useTablesWorkspaceStore.getState().select("p-b"); });
    await waitFor(() => expect(useTablesWorkspaceStore.getState().drafts["p-b"]?.result).toBeTruthy());
    expect(forB()).toHaveLength(1);
  });
});

describe("accept", () => {
  const region = item({ id: "reg-1", origin: "region", regionId: "reg-1", state: "parsed" });
  const seedRevision = (revision: number) => setPageIntelligenceForPage(qc, PUB, 1, {
    parsedRegions: [{ id: "reg-1", type: "schedule", category: "schedule", bbox: [0.1, 0.1, 0.4, 0.3], confidence: 1, data: { headers: [], rows: [], tagColumn: null, links: { revision } } }],
  } as unknown as PageIntelligence);

  it("sends the item id, the revision it started from and the ops; success discards the draft", async () => {
    seedRevision(3);
    routes = [parseRoute(), commitRoute(() => committed())];
    openWith([region]);
    await screen.findByText(/1 row × 2 columns/);
    act(() => { useTablesWorkspaceStore.getState().setDraftOps("reg-1", [{ op: "set-header-rows", n: 2 }]); });
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(commitCalls()).toHaveLength(1));
    expect(commitCalls()[0].body).toMatchObject({
      pageNumber: 1, itemId: "reg-1", origin: "region", regionId: "reg-1", revision: 3, evidenceHash: "ev-1",
      ops: [{ op: "set-header-rows", n: 2 }],
      recipe: { origin: "saved", request: { page: 1, bbox: [0.1, 0.1, 0.4, 0.3], kind: "schedule", budget: "instant" } },
    });
    expect(commitCalls()[0].body!.secondsToAccept).toEqual(expect.any(Number));
    await screen.findByText(/Saved Synthetic reg-1/);
  });

  it("renders the tag summary from the commit response and adopts the tag rows without a reload", async () => {
    const serverRow = { id: "t-1", name: "A1", tagText: "A1", yoloClass: "", yoloModel: "", source: "schedule", scope: "project", instances: [] } as unknown as YoloTag;
    qc.setQueryData(queryKeys.yoloTags.all(PUB), []);
    routes = [parseRoute(), commitRoute(() => committed({
      tagSummary: { tags: 14, hits: 212, withNone: 3, scope: "project" },
      yoloTags: { rows: [serverRow], replacedRegionIds: ["sr-schedule-1-x"] },
    }))];
    openWith([item({ id: "p-1", proposalId: "p-1" }), item({ id: "p-2", proposalId: "p-2" })]);
    await screen.findByText(/1 row × 2 columns/);
    fireEvent.click(screen.getByRole("button", { name: /Accept & next/ }));
    expect(await screen.findByText(/Mapped 14 tags · 212 hits · 3 with none/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review ▸" })).toBeInTheDocument();
    expect(readYoloTags(qc, PUB).map((t) => t.id)).toEqual(["t-1"]);
    expect(useTablesWorkspaceStore.getState().selectedKey).toBe("p-2");
    expect(useTablesWorkspaceStore.getState().drafts["p-1"]).toBeUndefined();
    expect(commitCalls()[0].body).toMatchObject({ itemId: "p-1", proposalId: "p-1", recipe: { origin: "proposal" } });
  });

  it("⏎ on the detail is Accept & next; ⏎ on a button keeps its own meaning", async () => {
    routes = [parseRoute(), commitRoute(() => committed())];
    openWith([item({ id: "p-1", proposalId: "p-1" }), item({ id: "p-2", proposalId: "p-2" })]);
    await screen.findByText(/1 row × 2 columns/);
    fireEvent.keyDown(screen.getByRole("button", { name: "Discard draft" }), { key: "Enter" });
    expect(commitCalls()).toHaveLength(0);
    fireEvent.keyDown(screen.getByRole("region", { name: "Item detail" }), { key: "Enter" });
    await waitFor(() => expect(useTablesWorkspaceStore.getState().selectedKey).toBe("p-2"));
    expect(commitCalls()).toHaveLength(1);
  });

  it("a conflict opens the dialog with Replace pre-selected, and ⏎ replaces the overlapping region", async () => {
    routes = [parseRoute(), commitRoute((n) => n === 1
      ? { status: 409, body: { error: { code: "CONFLICT", message: "Overlaps a saved region" }, conflict: { regionId: "pr-1-100", revision: 2, origin: "classic" } } }
      : committed())];
    openWith([item({ id: "p-1", proposalId: "p-1" })]);
    await screen.findByText(/1 row × 2 columns/);
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    const dialog = await screen.findByRole("dialog", { name: "Overlapping saved region" });
    expect(within(dialog).getByRole("radio", { name: /Replace/ })).toBeChecked();
    expect(within(dialog).getByText(/classic tools/)).toBeInTheDocument();
    fireEvent.keyDown(within(dialog).getByRole("radio", { name: /Replace/ }), { key: "Enter" });
    await waitFor(() => expect(commitCalls()).toHaveLength(2));
    expect(commitCalls()[1].body).toMatchObject({ onConflict: "replace", regionId: "pr-1-100", revision: 2 });
  });

  it("Keep both is the secondary choice", async () => {
    routes = [parseRoute(), commitRoute((n) => n === 1 ? { status: 409, body: { conflict: { regionId: "pr-1-100" } } } : committed())];
    openWith([item({ id: "p-1", proposalId: "p-1" })]);
    await screen.findByText(/1 row × 2 columns/);
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    fireEvent.click(await screen.findByRole("radio", { name: "Keep both" }));
    fireEvent.click(screen.getByRole("button", { name: /Keep both ⏎/ }));
    await waitFor(() => expect(commitCalls()).toHaveLength(2));
    expect(commitCalls()[1].body).toMatchObject({ onConflict: "keep-both" });
    expect(commitCalls()[1].body).not.toHaveProperty("regionId");
  });

  it("a rebase shows the changed-row note and one click accepts the rebased model", async () => {
    routes = [parseRoute(), commitRoute((n) => n === 1
      ? { status: 409, body: { rebased: { model: tableModel({ headerRows: 2 }), evidenceHash: "ev-2" }, changedRows: 3 } }
      : committed())];
    openWith([item({ id: "p-1", proposalId: "p-1" })]);
    await screen.findByText(/1 row × 2 columns/);
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(await screen.findByText("3 rows changed after re-scan")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Accept again/ }));
    await waitFor(() => expect(commitCalls()).toHaveLength(2));
    expect(commitCalls()[1].body).toMatchObject({ acceptRebased: true, evidenceHash: "ev-2" });
  });

  it("a paid crop that is no longer cached offers the paid re-run", async () => {
    routes = [parseRoute(), commitRoute(() => ({ status: 409, body: { error: { code: "CONFLICT", message: "A paid result is no longer cached (textract)" }, paidExpired: ["textract"] } }))];
    openWith([item({ id: "p-1", proposalId: "p-1" })]);
    await screen.findByText(/1 row × 2 columns/);
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    fireEvent.click(await screen.findByRole("button", { name: "Textract this crop again ($)" }));
    await waitFor(() => expect(parseCalls()).toHaveLength(2));
    expect(parseCalls()[1].body).toMatchObject({ budget: "thorough", hints: { proposalId: "p-1", allowPaidTextract: true } });
  });

  it("classifies a bare 409 as a stale revision and other errors as errors", () => {
    expect(classifyCommitResponse(409, { error: { code: "CONFLICT", message: "Region changed" } })).toEqual({ status: "stale-revision", message: "Region changed" });
    expect(classifyCommitResponse(403, { error: { code: "FORBIDDEN", message: "No" } })).toMatchObject({ status: "error", httpStatus: 403 });
    expect(classifyCommitResponse(409, { error: { code: "CONFLICT", message: "x", details: { conflict: { regionId: "r" } } } }))
      .toMatchObject({ status: "conflict", conflict: { regionId: "r" } });
  });
});

describe("continuations", () => {
  it("+ Add continuation box arms the canvas capture, and the drawn box is sent as parts", async () => {
    routes = [parseRoute()];
    openWith([item({ id: "p-1", proposalId: "p-1" })]);
    await screen.findByText(/1 row × 2 columns/);
    fireEvent.click(screen.getByRole("button", { name: "+ Add continuation box" }));
    expect(useTablesWorkspaceStore.getState().correction).toBe("draw-continuation");
    act(() => { addContinuationPart("p-1", [0.5, 0.1, 0.8, 0.3]); });
    await waitFor(() => expect(parseCalls()).toHaveLength(2));
    expect(parseCalls()[1].body).toMatchObject({ bbox: [0.1, 0.1, 0.4, 0.3], parts: [[0.5, 0.1, 0.8, 0.3]] });
    expect(useTablesWorkspaceStore.getState().correction).toBeNull();
    expect(screen.getByText("Part 2")).toBeInTheDocument();
  });

  it("Merge with ▸ makes another same-kind item on this sheet a part", async () => {
    routes = [parseRoute()];
    openWith([item({ id: "p-1", proposalId: "p-1" }), item({ id: "p-2", proposalId: "p-2", b: [0.5, 0.1, 0.8, 0.3] })]);
    await screen.findByText(/1 row × 2 columns/);
    fireEvent.click(screen.getByRole("button", { name: "Merge with ▸" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "Merge with" })).getByRole("menuitem", { name: "Synthetic p-2" }));
    await waitFor(() => expect(parseCalls().some((c) => Array.isArray(c.body!.parts))).toBe(true));
    expect(parseCalls().find((c) => c.body!.parts)!.body!.parts).toEqual([[0.5, 0.1, 0.8, 0.3]]);
  });

  it("Continues from ▸ sets links.continues on the commit", async () => {
    const saved = item({ id: "reg-9", origin: "region", regionId: "reg-9", page: 3, state: "parsed", title: "Synthetic saved" });
    routes = [
      parseRoute(),
      (url) => url.includes("/parse-engine/items?scope=all")
        ? { status: 200, body: { scope: "all", indexReady: true, threshold: 0.3, groups: [{ page: 3, items: [saved], lowConfidence: [] }] } } : undefined,
      commitRoute(() => committed()),
    ];
    openWith([item({ id: "p-1", proposalId: "p-1" })]);
    await screen.findByText(/1 row × 2 columns/);
    fireEvent.click(screen.getByRole("button", { name: "Continues from ▸" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "S-301 › Synthetic saved" }));
    expect(useTablesWorkspaceStore.getState().drafts["p-1"].continues).toBe("reg-9");
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(commitCalls()).toHaveLength(1));
    expect(commitCalls()[0].body).toMatchObject({ continues: "reg-9" });
  });
});

describe("verdicts", () => {
  it("Not a table records a reject; Undo deletes it; Table, not a schedule sends the class", async () => {
    routes = [parseRoute(), (url, method) => url.endsWith("/parse-engine/verdict") ? { status: 200, body: { inboxRefreshed: true, method } } : undefined];
    openWith([item({ id: "p-1", proposalId: "p-1" })]);
    fireEvent.click(await screen.findByRole("button", { name: "Not a table" }));
    await screen.findByText("Marked not a table.");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    fireEvent.click(await screen.findByRole("button", { name: "Table, not a schedule" }));
    await screen.findByText("Marked a table, not a schedule.");
    const v = calls.filter((c) => c.url.endsWith("/parse-engine/verdict"));
    expect(v.map((c) => [c.method, c.body])).toEqual([
      ["POST", { pageNumber: 1, proposalId: "p-1", verdict: "reject" }],
      ["DELETE", { pageNumber: 1, proposalId: "p-1" }],
      ["POST", { pageNumber: 1, proposalId: "p-1", verdict: "accept", classId: "not-a-schedule" }],
    ]);
  });

  it("a text region takes Not a table only", async () => {
    routes = [parseRoute(() => notesModel(true))];
    openWith([item({ id: "tr:notes-numbered:0.10,0.50,0.40,0.90", origin: "text-region", kind: "notes" })]);
    expect(await screen.findByRole("button", { name: "Not a table" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Table, not a schedule" })).not.toBeInTheDocument();
  });
});

describe("StepTabs", () => {
  it("shows Tags and References together for a keyed notes block", async () => {
    expect(stepsFor(notesModel(true))).toEqual(["structure", "tags", "refs", "accept"]);
    expect(stepsFor(notesModel(false))).toEqual(["structure", "accept"]);
    expect(stepsFor(tableModel())).toEqual(["structure", "tags", "accept"]);
    expect(stepsFor(tableModel({ kind: "keynote" }))).toEqual(["structure", "tags", "refs", "accept"]);
    routes = [parseRoute(() => notesModel(true))];
    openWith([item({ id: "tr:notes-numbered:0.10,0.50,0.40,0.90", origin: "text-region", kind: "notes" })]);
    const tabs = await screen.findByRole("tablist", { name: "Steps" });
    await waitFor(() => expect(within(tabs).getAllByRole("tab").map((t) => t.textContent)).toEqual(["1 Structure", "2 Tags", "3 References", "Accept"]));
  });
});

describe("bulk accept", () => {
  it("commits Notes/Specs at or above the agreement bar one at a time and stops on the first conflict", async () => {
    const notes = [1, 2, 3, 4].map((n) => item({ id: `tr:notes-numbered:0.${n}0,0.50,0.40,0.90`, origin: "text-region", kind: "notes", b: [n / 10, 0.5, 0.4, 0.9] }));
    const agreementOf = (b: Record<string, unknown>) => ((b.bbox as number[])[0] === 0.2 ? 0.5 : 0.95);
    routes = [
      parseRoute((b) => notesModel(true, agreementOf(b))),
      commitRoute((n) => (n === 2 ? { status: 409, body: { conflict: { regionId: "pr-x" } } } : committed())),
    ];
    useTablesWorkspaceStore.setState({ enabled: true, open: true, scope: "sheet", kinds: ["notes", "spec"] });
    render(<Providers><BulkAcceptDialog items={notes} pageNumber={1} /></Providers>);
    fireEvent.click(screen.getByRole("button", { name: /Accept all Notes\/Specs/ }));
    fireEvent.click(screen.getByRole("button", { name: "Accept 4 on this sheet" }));
    expect(await screen.findByText(/Accepted 1 of 4 · 1 left for review · stopped at "Synthetic tr:notes-numbered:0.30,0.50,0.40,0.90"/)).toBeInTheDocument();
    expect(commitCalls().map((c) => c.body!.itemId)).toEqual([notes[0].id, notes[2].id]);
    // Sequential: each item's parse comes after the previous item's commit.
    const order = calls.filter((c) => c.method === "POST").map((c) => `${c.url.endsWith("/commit") ? "C" : "P"}:${c.body!.itemId ?? (c.body!.bbox as number[])[0]}`);
    expect(order).toEqual(["P:0.1", `C:${notes[0].id}`, "P:0.2", "P:0.3", `C:${notes[2].id}`]);
  });
});
