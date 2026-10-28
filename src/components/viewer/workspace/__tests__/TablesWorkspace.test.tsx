// @vitest-environment jsdom
// [TP-3 WP-3.L] Tables & Notes workspace: store + commands + host + inbox, against the REAL classic panel
// toggles (viewerCommands), uiStore, proposalFocusStore and viewer navigation. Only the network is mocked
// (`fetch` routed by URL: the flags route of WP-2.E, the items and verdict routes of WP-3.F).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SessionContext } from "next-auth/react";
import type { ReactNode } from "react";

import ProposedTablesSection from "@/components/viewer/ProposedTablesSection";
import ViewerToolbar from "@/components/viewer/ViewerToolbar";
import TablesWorkspaceHost from "@/components/viewer/workspace/TablesWorkspaceHost";
import { seedProposalsFromBootstrap } from "@/queries/useProposals";
import { useTableParseHintStore } from "@/stores/tableParseHintStore";
import type { ProjectProposalSummary } from "@/lib/classifier-engine/types";
import EmptyState from "@/components/viewer/workspace/EmptyState";
import { inboxView, itemScore, normalizeItems, sortItems, type WorkspaceItem, type WorkspaceItemsResponse } from "@/queries/useWorkspaceItems";
import { workspaceOn } from "@/queries/useParseEngineFlags";
import { useProposalFocusStore } from "@/stores/proposalFocusStore";
import { useSessionStore } from "@/stores/sessionStore";
import {
  DRAFT_STORAGE_PREFIX,
  resetTablesWorkspaceStore,
  useTablesWorkspaceStore,
} from "@/stores/tablesWorkspaceStore";
import { useUiStore } from "@/stores/uiStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import { toggleSpecsNotesParsePanel, toggleTableParsePanel } from "@/stores/viewerCommands";
import {
  closeWorkspace,
  drawItemKey,
  focusItem,
  next,
  openClassicTools,
  openFromToolbar,
  openItem,
  prev,
  proposalWorkspaceKind,
} from "@/stores/workspaceCommands";
import type { ParseEngineFlags } from "@/lib/parse-engine/types";

const PUB = "pub-ws";

const FLAGS_ON: ParseEngineFlags = {
  killSwitch: false,
  cropCache: true,
  tools: {
    tablesRoute: "legacy", keynoteRoute: "legacy", notesClassifier: "legacy", specClassifier: "legacy",
    notesAuto: "legacy", specAuto: "legacy", workspace: "engine",
  },
};
const FLAGS_OFF: ParseEngineFlags = { ...FLAGS_ON, tools: { ...FLAGS_ON.tools, workspace: "legacy" } };

// `score` is computed the way WP-3.F's items service does: tableP × p (p when there is no table head).
const row = (over: Partial<WorkspaceItem> & { id: string }): WorkspaceItem => {
  const p = over.p ?? 0.8;
  return {
    page: 1,
    b: [0.1, 0.1, 0.4, 0.3],
    kind: "schedule",
    origin: "proposal",
    title: `Synthetic ${over.id}`,
    p,
    score: (over.tableP ?? 1) * p,
    state: "todo",
    ...over,
  };
};

// Synthetic inbox for page 1 (no real drawing text — PLAN §1.6 rule 12).
const PAGE1_ITEMS: WorkspaceItem[] = [
  row({ id: "p-low-table", p: 0.9, tableP: 0.5, proposalId: "p-low-table" }),          // 0.45
  row({ id: "p-high", p: 0.8, tableP: 0.95, proposalId: "p-high", b: [0.5, 0.1, 0.9, 0.3] }), // 0.76
  row({ id: "tr:notes:0.10,0.50,0.40,0.90", kind: "notes", origin: "text-region", p: 0.7 }),
  row({ id: "p-mid", p: 0.6, proposalId: "p-mid", b: [0.1, 0.5, 0.4, 0.7] }),           // 0.6 (tableP unscored)
  row({ id: "p-done", p: 0.99, state: "parsed", regionId: "reg-1", proposalId: "p-done" }),
];
const PAGE1_LOW: WorkspaceItem[] = [row({ id: "p-noise", p: 0.2, tableP: 0.3, proposalId: "p-noise" })];

type Route = (url: string, init?: RequestInit) => { status: number; body: unknown } | undefined;
let routes: Route[] = [];
const calls: { url: string; method: string; body: unknown }[] = [];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    for (const route of routes) {
      const hit = route(url, init);
      if (hit) return json(hit.status, hit.body);
    }
    return json(404, { error: `unrouted ${method} ${url}` });
  }));
}

const flagsRoute = (flags: ParseEngineFlags): Route => (url) =>
  url.endsWith("/parse-engine/flags") ? { status: 200, body: flags } : undefined;
/** WP-3.F's wire (`types-items.ts`): one group per sheet, each with its items and its low-confidence fold. */
function itemsBody(items: WorkspaceItem[], low: WorkspaceItem[] = []): WorkspaceItemsResponse {
  const pages = [...new Set([...items, ...low].map((i) => i.page))].sort((a, b) => a - b);
  return {
    scope: "sheet", indexReady: true, threshold: 0.3,
    groups: pages.map((page) => ({ page, items: items.filter((i) => i.page === page), lowConfidence: low.filter((i) => i.page === page) })),
  };
}
const itemsRoute = (items: WorkspaceItem[], low: WorkspaceItem[] = []): Route => (url) =>
  url.includes("/parse-engine/items?") ? { status: 200, body: itemsBody(items, low) } : undefined;

let qc: QueryClient;
function Providers({ children, session }: { children: ReactNode; session?: unknown }) {
  const tree = <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return session ? <SessionContext.Provider value={session as never}>{tree}</SessionContext.Provider> : tree;
}
const mountHost = (session?: unknown) => render(<Providers session={session}><TablesWorkspaceHost /></Providers>);

function resetAll() {
  resetTablesWorkspaceStore();
  useUiStore.getState().resetProjectUiState();
  useUiStore.getState().setPanelVisibility({ showTableParsePanel: false, showSpecsNotesPanel: false });
  useProposalFocusStore.setState({ hover: null, focus: null, fitRequest: 0 });
  useSessionStore.setState({ publicId: PUB, isDemo: false, projectId: 7, pageDrawingNumbers: {}, pageNames: {} });
  useViewerCoreStore.setState({ pageNumber: 1, numPages: 5 });
}

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  routes = [];
  calls.length = 0;
  installFetch();
  try { localStorage.clear(); } catch { /* jsdom always has it */ }
  resetAll();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ws = () => useTablesWorkspaceStore.getState();
const ui = () => useUiStore.getState();

describe("toolbar re-point (openFromToolbar)", () => {
  it("workspace off: the classic toggle, exactly as before", () => {
    openFromToolbar("tables");
    expect(ui().showTableParsePanel).toBe(true);
    expect(ws().open).toBe(false);
    openFromToolbar("tables");
    expect(ui().showTableParsePanel).toBe(false);
    openFromToolbar("notes");
    expect(ui().showSpecsNotesPanel).toBe(true);
    expect(ws().open).toBe(false);
  });

  it("Schedules/Tables opens the workspace with the table chips and closes the classic panels", () => {
    ws().setEnabled(true);
    toggleTableParsePanel();
    toggleSpecsNotesParsePanel();
    expect(ui().showTableParsePanel && ui().showSpecsNotesPanel).toBe(true);
    openFromToolbar("tables");
    expect(ws().open).toBe(true);
    expect(ws().group).toBe("tables");
    expect(ws().kinds).toEqual(["schedule", "keynote", "legend"]);
    expect(ui().showTableParsePanel).toBe(false);
    expect(ui().showSpecsNotesPanel).toBe(false);
  });

  it("Specs/Notes opens the workspace with the notes chips; the same button again closes it", () => {
    ws().setEnabled(true);
    openFromToolbar("notes");
    expect(ws().open).toBe(true);
    expect(ws().kinds).toEqual(["notes", "spec"]);
    openFromToolbar("tables");
    expect(ws().group).toBe("tables");
    expect(ws().open).toBe(true);
    openFromToolbar("tables");
    expect(ws().open).toBe(false);
  });

  it("Classic tools ▸ opens the classic panel and closes the workspace", () => {
    ws().setEnabled(true);
    openFromToolbar("notes");
    openClassicTools();
    expect(ws().open).toBe(false);
    expect(ui().showSpecsNotesPanel).toBe(true);
    expect(ui().showTableParsePanel).toBe(false);
  });

  it("disabling the workspace (flags flip, kill switch) closes it", () => {
    ws().setEnabled(true);
    openFromToolbar("tables");
    ws().setEnabled(false);
    expect(ws().open).toBe(false);
  });
});

describe("ViewerToolbar buttons (rendered)", () => {
  const renderToolbar = () => {
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    render(<Providers><ViewerToolbar projectName="Synthetic project" /></Providers>);
    return {
      tables: screen.getByTitle("Schedules & Table Parser"),
      notes: screen.getByTitle(/^Specs \/ Notes/),
    };
  };
  const lit = (el: HTMLElement, cls: string) => el.className.split(/\s+/).includes(cls);

  it("workspace on: Schedules/Tables and Specs/Notes open the workspace and light up while it is open", () => {
    ws().setEnabled(true);
    const { tables, notes } = renderToolbar();
    expect(lit(tables, "text-pink-300")).toBe(false);
    fireEvent.click(tables);
    expect(ws().open).toBe(true);
    expect(ws().group).toBe("tables");
    expect(ui().showTableParsePanel).toBe(false);
    expect(lit(tables, "text-pink-300")).toBe(true);
    expect(lit(notes, "text-amber-300")).toBe(false);
    fireEvent.click(notes);
    expect(ws().group).toBe("notes");
    expect(ui().showSpecsNotesPanel).toBe(false);
    expect(lit(notes, "text-amber-300")).toBe(true);
    expect(lit(tables, "text-pink-300")).toBe(false);
    fireEvent.click(notes);
    expect(ws().open).toBe(false);
    expect(lit(notes, "text-amber-300")).toBe(false);
  });

  it("workspace off: the same buttons toggle the classic panels, as before", () => {
    const { tables, notes } = renderToolbar();
    fireEvent.click(tables);
    expect(ui().showTableParsePanel).toBe(true);
    expect(ws().open).toBe(false);
    expect(lit(tables, "text-pink-300")).toBe(true);
    fireEvent.click(notes);
    expect(ui().showSpecsNotesPanel).toBe(true);
    expect(lit(notes, "text-amber-300")).toBe(true);
    fireEvent.click(tables);
    expect(ui().showTableParsePanel).toBe(false);
  });
});

describe("flags → enabled", () => {
  it("workspaceOn needs engine mode, no kill switch, not demo", () => {
    expect(workspaceOn(FLAGS_ON, false)).toBe(true);
    expect(workspaceOn(FLAGS_ON, true)).toBe(false);
    expect(workspaceOn(FLAGS_OFF, false)).toBe(false);
    expect(workspaceOn({ ...FLAGS_ON, killSwitch: true }, false)).toBe(false);
    expect(workspaceOn(undefined, false)).toBe(false);
  });

  it("the host publishes the flag; a demo project stays classic", async () => {
    routes = [flagsRoute(FLAGS_ON)];
    mountHost();
    await waitFor(() => expect(ws().enabled).toBe(true));
    cleanup();
    resetAll();
    useSessionStore.setState({ isDemo: true });
    mountHost();
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/flags"))).toBe(true));
    await act(async () => { await Promise.resolve(); });
    expect(ws().enabled).toBe(false);
  });

  it("a failed flags read keeps the classic toolbar", async () => {
    routes = [(url) => (url.endsWith("/flags") ? { status: 500, body: { error: "boom" } } : undefined)];
    mountHost();
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    await act(async () => { await Promise.resolve(); });
    openFromToolbar("tables");
    expect(ui().showTableParsePanel).toBe(true);
    expect(ws().open).toBe(false);
  });
});

describe("host", () => {
  it("renders nothing while closed; a classic panel opened elsewhere closes the workspace", async () => {
    routes = [flagsRoute(FLAGS_ON), itemsRoute(PAGE1_ITEMS, PAGE1_LOW)];
    const { container } = mountHost();
    expect(container).toBeEmptyDOMElement();
    await waitFor(() => expect(ws().enabled).toBe(true));
    act(() => openFromToolbar("tables"));
    expect(await screen.findByRole("complementary", { name: /tables and notes workspace/i })).toBeInTheDocument();
    act(() => toggleTableParsePanel()); // e.g. Auto QTO opening the classic panel directly
    await waitFor(() => expect(ws().open).toBe(false));
    expect(container).toBeEmptyDOMElement();
    expect(ui().showTableParsePanel).toBe(true);
  });
});

async function openInbox(items = PAGE1_ITEMS, low = PAGE1_LOW, session?: unknown) {
  routes = [flagsRoute(FLAGS_ON), itemsRoute(items, low), ...routes];
  const view = mountHost(session);
  await waitFor(() => expect(ws().enabled).toBe(true));
  act(() => openFromToolbar("tables"));
  const panel = await screen.findByRole("complementary", { name: /tables and notes workspace/i });
  if (items.length + low.length > 0) await screen.findByRole("list", { name: "Inbox" });
  return { panel, ...view };
}

const visibleIds = (panel: HTMLElement) =>
  within(within(panel).getByRole("list", { name: "Inbox" })).getAllByRole("button").map((b) => b.getAttribute("data-item-id"));

describe("inbox", () => {
  it("sorts by tableP × p (unscored table-ness counts as 1) and honours the kind chips and filter", async () => {
    const { panel } = await openInbox();
    expect(visibleIds(panel)).toEqual(["p-high", "p-mid", "p-low-table"]);
    fireEvent.click(within(panel).getByRole("button", { name: "Notes" }));
    expect(visibleIds(panel)).toEqual(["p-high", "tr:notes:0.10,0.50,0.40,0.90", "p-mid", "p-low-table"]);
    fireEvent.click(within(panel).getByRole("button", { name: /^Parsed 1$/ }));
    expect(visibleIds(panel)).toEqual(["p-done"]);
    expect(itemScore({ p: 0.9, tableP: 0.5 })).toBeCloseTo(0.45);
  });

  it("the items read is the sheet scope of the viewer's page; All sheets reads the project scope", async () => {
    const { panel } = await openInbox();
    expect(calls.some((c) => c.url === `/api/projects/${PUB}/parse-engine/items?scope=sheet&page=1`)).toBe(true);
    fireEvent.click(within(panel).getByRole("button", { name: "All sheets" }));
    await waitFor(() => expect(calls.some((c) => c.url === `/api/projects/${PUB}/parse-engine/items?scope=all`)).toBe(true));
  });

  it("low-confidence items sit in a collapsed fold", async () => {
    const { panel } = await openInbox();
    expect(visibleIds(panel)).not.toContain("p-noise");
    const fold = within(panel).getByRole("button", { name: /Low confidence \(1\)/ });
    expect(fold).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(fold);
    expect(within(panel).getByText("Synthetic p-noise")).toBeInTheDocument();
  });

  it("open → focus fits the box: navigates, focuses with the real or synthetic id, selects", async () => {
    useViewerCoreStore.setState({ pageNumber: 3 });
    const target = row({ id: "tr:notes:0.10,0.50,0.40,0.90", kind: "notes", origin: "text-region", page: 2 });
    ws().setEnabled(true);
    expect(openItem(target)).toBe(true);
    expect(useViewerCoreStore.getState().pageNumber).toBe(2);
    const focus = useProposalFocusStore.getState().focus;
    expect(focus).toEqual({ publicId: PUB, proposalId: target.id, pageNumber: 2, bbox: target.b });
    expect(useProposalFocusStore.getState().fitRequest).toBe(1);
    expect(ws().group).toBe("notes");
    expect(ws().selectedKey).toBe(target.id);
    focusItem(row({ id: "p-1", proposalId: "p-1", page: 2 }));
    expect(useProposalFocusStore.getState().focus?.proposalId).toBe("p-1");
    expect(useProposalFocusStore.getState().fitRequest).toBe(2);
    expect(drawItemKey(2, [0.1, 0.2, 0.333, 0.4])).toBe("draw:2:0.10,0.20,0.33,0.40");
  });

  it("clicking a row focuses it on the canvas", async () => {
    const { panel } = await openInbox();
    fireEvent.click(within(panel).getByText("Synthetic p-mid"));
    expect(useProposalFocusStore.getState().focus?.proposalId).toBe("p-mid");
    expect(ws().selectedKey).toBe("p-mid");
  });

  it("J / K are handled on the panel only, never reach window, and never fire while typing", async () => {
    const { panel } = await openInbox();
    const windowKeys = vi.fn();
    window.addEventListener("keydown", windowKeys);
    try {
      fireEvent.keyDown(panel, { key: "j" });
      expect(ws().selectedKey).toBe("p-high");
      fireEvent.keyDown(panel, { key: "j" });
      expect(ws().selectedKey).toBe("p-mid");
      fireEvent.keyDown(panel, { key: "k" });
      expect(ws().selectedKey).toBe("p-high");
      expect(windowKeys).not.toHaveBeenCalled();
      // A J outside the panel does nothing.
      fireEvent.keyDown(document.body, { key: "j" });
      expect(ws().selectedKey).toBe("p-high");
      // Typing in a field inside the panel is not hijacked.
      const input = document.createElement("input");
      panel.appendChild(input);
      fireEvent.keyDown(input, { key: "j" });
      expect(ws().selectedKey).toBe("p-high");
      // Esc is not the panel's (ProposalFocusLayer owns it).
      fireEvent.keyDown(panel, { key: "Escape" });
      expect(windowKeys).toHaveBeenCalledTimes(3);
    } finally {
      window.removeEventListener("keydown", windowKeys);
    }
  });

  it("Enter opens the selected item only from the panel itself, a focused row opens THAT row, other controls keep Enter", async () => {
    const { panel } = await openInbox();
    act(() => next());
    expect(ws().selectedKey).toBe("p-high");
    // A control inside the panel: Enter is not taken (native activation still works).
    const classic = within(panel).getByRole("button", { name: /Classic tools/ });
    expect(fireEvent.keyDown(classic, { key: "Enter" })).toBe(true); // true = not defaultPrevented
    expect(ws().open).toBe(true);
    const chip = within(panel).getByRole("button", { name: "Notes" });
    expect(fireEvent.keyDown(chip, { key: "Enter" })).toBe(true);
    // A focused row: Enter opens that row, not the selected one.
    const midRow = within(panel).getByText("Synthetic p-mid").closest("button")!;
    expect(fireEvent.keyDown(midRow, { key: "Enter" })).toBe(false);
    expect(ws().selectedKey).toBe("p-mid");
    expect(useProposalFocusStore.getState().focus?.proposalId).toBe("p-mid");
    // The panel itself: Enter opens the selected item.
    act(() => next());
    expect(fireEvent.keyDown(panel, { key: "Enter" })).toBe(false);
    expect(useProposalFocusStore.getState().focus?.proposalId).toBe("p-low-table");
  });

  it("closing the workspace clears its own canvas outline and focus, never another surface's", async () => {
    const { panel } = await openInbox();
    fireEvent.mouseEnter(within(panel).getByText("Synthetic p-mid").closest("button")!);
    fireEvent.click(within(panel).getByText("Synthetic p-mid"));
    expect(useProposalFocusStore.getState().hover?.proposalId).toBe("p-mid");
    expect(useProposalFocusStore.getState().focus?.proposalId).toBe("p-mid");
    act(() => closeWorkspace());
    expect(useProposalFocusStore.getState().hover).toBeNull();
    expect(useProposalFocusStore.getState().focus).toBeNull();
    // A focus another surface set (e.g. the classic proposals list) survives a workspace close.
    act(() => openFromToolbar("tables"));
    const foreign = { publicId: PUB, proposalId: "classic-only", pageNumber: 1, bbox: [0, 0, 0.2, 0.2] as [number, number, number, number] };
    act(() => useProposalFocusStore.getState().focusProposal(foreign));
    act(() => openFromToolbar("tables"));
    expect(ws().open).toBe(false);
    expect(useProposalFocusStore.getState().focus?.proposalId).toBe("classic-only");
  });

  it("a row unmounted under the pointer drops its hover outline", async () => {
    const { panel } = await openInbox();
    fireEvent.mouseEnter(within(panel).getByText("Synthetic p-mid").closest("button")!);
    expect(useProposalFocusStore.getState().hover?.proposalId).toBe("p-mid");
    fireEvent.click(within(panel).getByRole("button", { name: "Notes" })); // keep the list non-empty
    fireEvent.click(within(panel).getByRole("button", { name: "Schedules" })); // schedules off: p-mid unmounts, no mouseleave
    expect(within(panel).queryByText("Synthetic p-mid")).toBeNull();
    expect(useProposalFocusStore.getState().hover).toBeNull();
  });

  it("next / prev walk the visible order (main rows, then the fold) without wrapping; the fold opens on selection", async () => {
    const { panel } = await openInbox();
    act(() => { next(); next(); next(); });
    expect(ws().selectedKey).toBe("p-low-table");
    expect(within(panel).queryByText("Synthetic p-noise")).toBeNull();
    act(() => { next(); next(); });
    expect(ws().selectedKey).toBe("p-noise");
    expect(within(panel).getByText("Synthetic p-noise")).toBeInTheDocument();
    act(() => prev());
    expect(ws().selectedKey).toBe("p-low-table");
  });

  it("bulk 'Not a table: rest of this sheet' rejects only the VISIBLE To-review rows, sequentially", async () => {
    routes = [(url, init) => (url.endsWith("/parse-engine/verdict") && init?.method === "POST" ? { status: 200, body: { inboxRefreshed: true } } : undefined)];
    const items = [...PAGE1_ITEMS, row({ id: "other-page", page: 2 })];
    const { panel } = await openInbox(items);
    fireEvent.click(within(panel).getByText("Synthetic p-high")); // the item being worked on is kept
    // The fold is closed: p-noise is not on screen, so it is not rejected (a reject is a negative label).
    fireEvent.click(within(panel).getByRole("button", { name: /Not a table: rest of this sheet \(2\)/ }));
    fireEvent.click(within(panel).getByRole("button", { name: /Confirm: 2 not a table/ }));
    await within(panel).findByText("Marked 2 as not a table.");
    const posted = calls.filter((c) => c.method === "POST").map((c) => (c.body as { itemId: string }).itemId);
    expect(posted).toEqual(["p-mid", "p-low-table"]);
    expect(calls.filter((c) => c.method === "POST")[0].body).toMatchObject({
      pageNumber: 1, itemId: "p-mid", origin: "proposal", kind: "schedule", proposalId: "p-mid", verdict: "reject",
    });
  });

  it("bulk reject: an open fold adds its rows; classified-table / ensemble items never take a verdict", async () => {
    routes = [(url, init) => (url.endsWith("/parse-engine/verdict") && init?.method === "POST" ? { status: 200, body: { inboxRefreshed: true } } : undefined)];
    const low = [...PAGE1_LOW, row({ id: "ct:0.10,0.60,0.40,0.80", origin: "classified-table", p: 0.5 }),
      row({ id: "ens:0.50,0.60,0.90,0.80", origin: "ensemble", p: 0.4 })];
    const { panel } = await openInbox(PAGE1_ITEMS, low);
    fireEvent.click(within(panel).getByRole("button", { name: /Low confidence \(3\)/ }));
    expect(within(panel).getByText("Synthetic ct:0.10,0.60,0.40,0.80")).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: /Not a table: rest of this sheet \(4\)/ }));
    fireEvent.click(within(panel).getByRole("button", { name: /Confirm: 4 not a table/ }));
    await within(panel).findByText("Marked 4 as not a table.");
    const posted = calls.filter((c) => c.method === "POST").map((c) => (c.body as { itemId: string }).itemId);
    expect(posted).toEqual(["p-high", "p-mid", "p-low-table", "p-noise"]);
  });

  it("All sheets offers no bulk reject (there is no single sheet on screen)", async () => {
    const { panel } = await openInbox();
    fireEvent.click(within(panel).getByRole("button", { name: "All sheets" }));
    await waitFor(() => expect(within(panel).getByRole("list", { name: "Inbox by sheet" })).toBeInTheDocument());
    expect(within(panel).queryByRole("button", { name: /Not a table: rest of this sheet/ })).toBeNull();
  });

  it("bulk reject stops on the first failure", async () => {
    let n = 0;
    routes = [(url, init) => {
      if (!url.endsWith("/parse-engine/verdict") || init?.method !== "POST") return undefined;
      n++;
      return n === 2 ? { status: 409, body: { error: "conflict" } } : { status: 200, body: { ok: true } };
    }];
    const { panel } = await openInbox();
    fireEvent.click(within(panel).getByRole("button", { name: /Not a table: rest of this sheet/ }));
    fireEvent.click(within(panel).getByRole("button", { name: /Confirm:/ }));
    await within(panel).findByText(/Saved 1, then stopped/);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(2);
  });
});

describe("empty state", () => {
  it("explains an empty sheet and offers + Region", async () => {
    const { panel } = await openInbox([], []);
    expect(await within(panel).findByText(/No tables or notes were detected here yet/)).toBeInTheDocument();
    fireEvent.click(within(within(panel).getByRole("status")).getByRole("button", { name: "+ Region" }));
    expect(ws().correction).toBe("draw-region");
    expect(within(panel).queryByRole("link", { name: "Run detection" })).toBeNull();
  });

  it("a body that is not WP-3.F's grouped shape is an ERROR, never 'nothing detected'", async () => {
    routes = [flagsRoute(FLAGS_ON), (url) => (url.includes("/parse-engine/items?")
      ? { status: 200, body: { items: [row({ id: "flat" })], lowConfidence: [] } } : undefined)];
    mountHost();
    await waitFor(() => expect(ws().enabled).toBe(true));
    act(() => openFromToolbar("tables"));
    const panel = await screen.findByRole("complementary", { name: /tables and notes workspace/i });
    expect(await within(panel).findByText("The inbox could not be loaded.")).toBeInTheDocument();
    expect(within(panel).queryByText(/No tables or notes were detected/)).toBeNull();
  });

  it("everything reviewed reads differently from nothing detected", async () => {
    const { panel } = await openInbox([row({ id: "done", state: "parsed" })], []);
    expect(await within(panel).findByText("Everything here has been reviewed.")).toBeInTheDocument();
  });

  it("a root admin also gets Run detection", () => {
    const session = { status: "authenticated", data: { user: { isRootAdmin: true } }, update: async () => null };
    render(<Providers session={session}><EmptyState reason="none" scope="sheet" /></Providers>);
    expect(screen.getByRole("link", { name: "Run detection" })).toHaveAttribute("href", "/admin?tab=reprocess");
  });
});

describe("drafts", () => {
  it("ops mirror to localStorage per project and are restored after a remount (results are not)", async () => {
    routes = [flagsRoute(FLAGS_ON)];
    const first = mountHost();
    await waitFor(() => expect(ws().draftsProject).toBe(PUB));
    act(() => {
      ws().putDraft("p-high", {
        page: 1, bbox: [0.5, 0.1, 0.9, 0.3], kind: "schedule", result: null, startedAt: 42,
        ops: [{ op: "set-header-rows", n: 2 } as never],
      });
    });
    expect(JSON.parse(localStorage.getItem(DRAFT_STORAGE_PREFIX + PUB) ?? "{}")["p-high"].ops).toHaveLength(1);
    first.unmount();
    resetTablesWorkspaceStore(); // a reload: memory is gone
    expect(ws().drafts).toEqual({});
    mountHost();
    await waitFor(() => expect(Object.keys(ws().drafts)).toEqual(["p-high"]));
    expect(ws().drafts["p-high"]).toMatchObject({ page: 1, kind: "schedule", result: null, startedAt: 0 });
    expect(ws().drafts["p-high"].ops).toHaveLength(1);
    act(() => ws().discardDraft("p-high"));
    expect(localStorage.getItem(DRAFT_STORAGE_PREFIX + PUB)).toBeNull();
  });

  it("blocked storage never throws; drafts live in memory only", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("QuotaExceeded"); });
    try {
      ws().hydrateDrafts(PUB);
      expect(() => ws().putDraft("k", { page: 1, bbox: [0, 0, 1, 1], kind: "notes", result: null, ops: [{ op: "set-title", text: "x" }], startedAt: 1 })).not.toThrow();
      expect(ws().drafts.k).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("a malformed mirror is ignored", () => {
    localStorage.setItem(DRAFT_STORAGE_PREFIX + PUB, "{not json");
    ws().hydrateDrafts(PUB);
    expect(ws().drafts).toEqual({});
    localStorage.setItem(DRAFT_STORAGE_PREFIX + PUB, JSON.stringify({ a: { page: "1" }, b: { page: 1, kind: "notes", bbox: [0, 0, 1, 1], ops: [] } }));
    ws().hydrateDrafts(PUB);
    expect(Object.keys(ws().drafts)).toEqual(["b"]);
  });
});

describe("pure inbox model", () => {
  it("normalizeItems flattens WP-3.F's groups, drops malformed rows, and throws on any other shape", () => {
    const body = itemsBody([row({ id: "a" }), row({ id: "b", page: 3 })], [row({ id: "low", page: 3, p: 0.1 })]);
    (body.groups[0].items as unknown[]).push({ id: 1 });
    const data = normalizeItems(body);
    expect(data.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(data.lowConfidence.map((i) => i.id)).toEqual(["low"]);
    expect(normalizeItems({ scope: "all", indexReady: false, threshold: 0.3, groups: [] })).toEqual({ items: [], lowConfidence: [] });
    expect(() => normalizeItems(null)).toThrow();
    expect(() => normalizeItems({ items: [row({ id: "flat" })], lowConfidence: [] })).toThrow();
  });

  it("the server's score is the sort key when present", () => {
    expect(itemScore({ p: 0.9, tableP: 0.5, score: 0.2 })).toBeCloseTo(0.2);
    expect(itemScore({ p: 0.9, tableP: 0.5 })).toBeCloseTo(0.45);
  });

  it("the Stale filter is hidden while no item is stale (the read has no stale field until WP-5.A)", async () => {
    const { panel } = await openInbox();
    expect(within(panel).queryByRole("button", { name: /^Stale/ })).toBeNull();
    cleanup();
    resetAll();
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }); // a fresh read, not the cached one
    routes = [];
    const again = await openInbox([...PAGE1_ITEMS, row({ id: "old", stale: true, state: "parsed" })]);
    expect(within(again.panel).getByRole("button", { name: /^Stale 1$/ })).toBeInTheDocument();
  });

  it("sort is deterministic on ties (page, then top, then id)", () => {
    const tie = [row({ id: "b", page: 2 }), row({ id: "c", page: 1, b: [0, 0.5, 1, 0.6] }), row({ id: "a", page: 1, b: [0, 0.5, 1, 0.6] })];
    expect(sortItems(tie).map((i) => i.id)).toEqual(["a", "c", "b"]);
    const view = inboxView({ items: tie, lowConfidence: [] }, ["schedule"], "todo");
    expect(view.counts.todo).toBe(3);
  });
});

describe("classic 'Parse this table' (ProposedTablesSection)", () => {
  const summary: ProjectProposalSummary = {
    engineVersion: "clf/0.1", generatedAt: "2026-10-27T00:00:00.000Z", total: 1, truncated: false,
    items: [{
      id: "prop-a", recipeId: "schedule-kind", pageNumber: 1, bbox: [0.1, 0.2, 0.5, 0.6], target: "schedule",
      classId: "door", className: "Door schedule", group: "arch", displayName: "Door schedule", p: 0.9, nameP: 0.8,
    }],
  };

  const parseThis = async (s: ProjectProposalSummary = summary, label = "Door schedule", button = "Parse this table") => {
    seedProposalsFromBootstrap(qc, PUB, { proposals: s });
    render(<Providers><ProposedTablesSection /></Providers>);
    fireEvent.click(screen.getByText(label, { selector: "span" }).closest("button")!);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: button })); });
  };

  it("the proposal opens as its OWN kind (same table as WP-3.F's proposalInboxKind)", async () => {
    expect(proposalWorkspaceKind("schedule", "door")).toBe("schedule");
    expect(proposalWorkspaceKind("keynote-table", null)).toBe("keynote");
    expect(proposalWorkspaceKind("symbol-legend", null)).toBe("legend");
    expect(proposalWorkspaceKind("general-notes", null)).toBe("notes");
    expect(proposalWorkspaceKind("text-region", "keynotes")).toBe("keynote");
    expect(proposalWorkspaceKind("text-region", "abbreviations")).toBe("legend");
    expect(proposalWorkspaceKind("text-region", "general")).toBe("notes");
    expect(proposalWorkspaceKind("page-unit", null)).toBeNull();
    ws().setEnabled(true);
    const notes: ProjectProposalSummary = { ...summary, items: [{ ...summary.items[0], id: "prop-n", target: "general-notes", classId: null, className: "General notes", displayName: "General notes" }] };
    await parseThis(notes, "General notes");
    expect(ws().group).toBe("notes");
    expect(ws().queue.find((q) => q.id === "prop-n")?.kind).toBe("notes");
  });

  it("'Accept with tags' opens the workspace at the Tags step", async () => {
    ws().setEnabled(true);
    const tagged: ProjectProposalSummary = { ...summary, items: [{ ...summary.items[0], tagRows: 4, tagShape: "circle" } as never] };
    await parseThis(tagged, "Door schedule", "Accept with tags");
    expect(ws().selectedKey).toBe("prop-a");
    expect(ws().step).toBe("tags");
  });

  it("workspace on: opens the proposal as a workspace item and closes the classic panel", async () => {
    ws().setEnabled(true);
    toggleTableParsePanel();
    useTableParseHintStore.setState({ hint: null });
    await parseThis();
    expect(ws().open).toBe(true);
    expect(ws().group).toBe("tables");
    expect(ws().selectedKey).toBe("prop-a");
    expect(ws().step).toBe("structure");
    expect(ui().showTableParsePanel).toBe(false);
    expect(useProposalFocusStore.getState().focus?.proposalId).toBe("prop-a");
    expect(useTableParseHintStore.getState().hint).toBeNull(); // the classic hint path did not run
  });

  it("workspace off: the classic hint path, unchanged", async () => {
    useTableParseHintStore.setState({ hint: null });
    await parseThis();
    expect(ws().open).toBe(false);
    expect(useTableParseHintStore.getState().hint).toMatchObject({ publicId: PUB, pageNumber: 1, proposalId: "prop-a" });
  });
});
