// @vitest-environment jsdom
// [table pipeline WP-2.F, K58] "Parse this table" no longer records `accept` before parsing. The hint's
// proposalId rides the Auto Parse request (default row source unless "with tags"), the review grid keeps it,
// and the SAVE of that parse posts `accept` with `via:"parse"` and the saved region (the server takes the
// stored class). A plain parse posts no verdict; a proposal already verdicted is not re-posted; a two-region
// merge carries no proposal. All strings synthetic.

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { regionIdFor } from "@/lib/client-persist";
import type { ProjectProposalSummary } from "@/lib/classifier-engine/types";
import { EMPTY_ACTIVE_PAGE_WINDOW, type ActivePageWindow } from "@/queries/pageWindowCore";
import { queryKeys } from "@/queries/queryKeys";
import { seedProposalsFromBootstrap } from "@/queries/useProposals";
import { clearYoloTagsProject, seedYoloTagsFromBootstrap } from "@/queries/useYoloTags";
import { useParseFlowStore } from "@/stores/parseFlowStore";
import { useTableParseHintStore } from "@/stores/tableParseHintStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import { acceptTableParseRegion, resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";
import type { DetectCsiAndPersist, TableGrid } from "../table-operation-types";

const panelGrid = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/components/viewer/AutoParseTab", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/viewer/AutoParseTab")>();
  const Real = actual.default;
  return {
    default: (props: { detectCsiAndPersist: DetectCsiAndPersist }) =>
      panelGrid.current ? (
        <button onClick={() => void props.detectCsiAndPersist(panelGrid.current as TableGrid)}>save test grid</button>
      ) : (
        <Real {...(props as Parameters<typeof Real>[0])} />
      ),
  };
});

import AutoParseTab from "../AutoParseTab";
import TableParsePanel from "../TableParsePanel";

type Box = [number, number, number, number];
const PUBLIC_ID = "k58-project";
const PAGE = 3;
const BOX: Box = [0.1, 0.1, 0.4, 0.4];
const BOX_2: Box = [0.5, 0.5, 0.9, 0.9];

let queryClient: QueryClient;
const fetchMock = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const json = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

function summary(verdict?: "accept" | "reject"): ProjectProposalSummary {
  return {
    engineVersion: "clf/0.1", generatedAt: "2026-10-27T00:00:00.000Z", total: 1, truncated: false,
    items: [{
      id: "prop-1", recipeId: "schedule-kind", pageNumber: PAGE, bbox: BOX, target: "schedule", classId: "door",
      className: "Door schedule", group: "arch", displayName: "Door schedule", p: 0.9, nameP: 0.8,
      ...(verdict ? { verdict } : {}),
    }],
  };
}

function serve() {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (url === "/api/table-parse") {
      return json({ headers: ["Mark", "Width"], rows: [{ Mark: "QX-1", Width: "10" }], methods: [], methodResults: [], infraErrors: [] });
    }
    if (url === "/api/regions/promote") {
      const o = body.overrides;
      const region = { id: o.regionId, type: "schedule", category: "x", bbox: o.bbox, confidence: 0.9, data: o.data };
      return json({ ok: true, parsedRegion: region, updatedIntelligence: { parsedRegions: [region] }, summaries: null });
    }
    if (String(url).endsWith("/proposals/verdict")) return json({ verdict: { proposalId: body.proposalId, verdict: "accept" } });
    if (String(url).includes("/parse-labels")) return json({ page: PAGE, labels: {} });
    throw new Error(`unexpected request ${url}`);
  });
}

const callsTo = (suffix: string) => fetchMock.mock.calls.filter(([url]) => String(url).endsWith(suffix));

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fetchMock.mockReset();
  serve();
  vi.stubGlobal("fetch", fetchMock);
  panelGrid.current = null;
  resetProjectData();
  useTableParseHintStore.setState({ hint: null });
  setViewerStoreStateForTest({ projectId: 41, publicId: PUBLIC_ID, isDemo: false, pageNumber: PAGE, tableParseTab: "auto", pageDrawingNumbers: {} });
  useViewerCoreStore.setState({ numPages: 10 });
  queryClient.setQueryData(queryKeys.annotations.all(PUBLIC_ID), []);
  queryClient.setQueryData<ActivePageWindow>(queryKeys.pagesWindow.active(PUBLIC_ID), { ...EMPTY_ACTIVE_PAGE_WINDOW });
  seedYoloTagsFromBootstrap(queryClient, PUBLIC_ID, { yoloTags: [] });
});

afterEach(() => {
  cleanup();
  clearYoloTagsProject(queryClient, PUBLIC_ID);
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderAutoTab(detect: DetectCsiAndPersist) {
  render(
    <AutoParseTab
      autoDetectedTables={[]} existingParsed={[]} loadExistingParsed={vi.fn()} detectCsiAndPersist={detect}
      invalidateTableOperation={() => useParseFlowStore.getState().invalidateParseOperation("table")}
      yoloInTableRegion={[]} tagYoloClass={null} setTagYoloClass={vi.fn()} handleMapTags={vi.fn()} tagMappingDone={false}
      tagMappingCount={0} setTagMappingDone={vi.fn()} mapTagsStrictness="balanced" setMapTagsStrictness={vi.fn()}
      drawingNumberPrefixes={[]} setDrawingNumberPrefixes={vi.fn()} availablePrefixes={[]} lastDropCounts={null}
      cellStructureOperation={{ detect: vi.fn(async () => false), clear: vi.fn(), loadingKey: null, busy: false, errorKey: null, error: null }}
    />,
    { wrapper },
  );
}

describe("AutoParseTab carries the proposal (K58)", () => {
  it("a plain parse sends the proposalId with the default row source, and the saved grid keeps it", async () => {
    const detect = vi.fn<DetectCsiAndPersist>(async () => true);
    renderAutoTab(detect);
    useTableParseHintStore.setState({ hint: { publicId: PUBLIC_ID, pageNumber: PAGE, bbox: [...BOX] as Box, proposalId: "prop-1" } });
    act(() => acceptTableParseRegion([...BOX] as Box));
    await waitFor(() => expect(screen.getByRole("button", { name: "Process Region" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Process Region" }));
    await waitFor(() => expect(detect).toHaveBeenCalledTimes(1));
    const request = JSON.parse(String(callsTo("/api/table-parse")[0][1].body));
    expect(request).toMatchObject({ pageNumber: PAGE, regionBbox: BOX, proposalId: "prop-1" });
    expect("rowSource" in request).toBe(false);
    expect(detect.mock.calls[0][0]).toMatchObject({ proposalId: "prop-1", regionId: regionIdFor(PAGE, BOX) });
    expect(useTableParseHintStore.getState().hint).toBeNull(); // consumed
  });

  it("no leak: a two-region merge carries no proposal, and the other region's request has none", async () => {
    const detect = vi.fn<DetectCsiAndPersist>(async () => true);
    renderAutoTab(detect);
    useTableParseHintStore.setState({ hint: { publicId: PUBLIC_ID, pageNumber: PAGE, bbox: [...BOX] as Box, proposalId: "prop-1" } });
    act(() => acceptTableParseRegion([...BOX] as Box));
    act(() => acceptTableParseRegion([...BOX_2] as Box));
    await waitFor(() => expect(screen.getByRole("button", { name: /Process/ })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /Process/ }));
    await waitFor(() => expect(detect).toHaveBeenCalledTimes(1));
    const bodies = callsTo("/api/table-parse").map(([, init]) => JSON.parse(String(init.body)));
    expect(bodies.map((b) => b.proposalId)).toEqual(["prop-1", undefined]);
    expect("proposalId" in detect.mock.calls[0][0]).toBe(false);
  });
});

describe("TableParsePanel save posts the accept (K58)", () => {
  const grid = (over: Partial<TableGrid> = {}): TableGrid => ({
    headers: ["Mark"], rows: [{ Mark: "QX-1" }], tagColumn: "Mark", csiTags: [{ code: "00 00 00", description: "x" }], ...over,
  });

  function mountPanel(g: TableGrid) {
    panelGrid.current = g;
    useParseFlowStore.setState({ tableParseRegion: BOX });
    render(<TableParsePanel />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: "save test grid" }));
  }

  it("a hinted save posts accept via parse with the saved region, and the list shows it accepted", async () => {
    seedProposalsFromBootstrap(queryClient, PUBLIC_ID, { proposals: summary() });
    mountPanel(grid({ proposalId: "prop-1" }));
    await waitFor(() => expect(callsTo("/proposals/verdict")).toHaveLength(1));
    const [url, init] = callsTo("/proposals/verdict")[0];
    expect(url).toBe(`/api/projects/${PUBLIC_ID}/proposals/verdict`);
    expect(JSON.parse(String(init.body))).toEqual({
      pageNumber: PAGE, proposalId: "prop-1", verdict: "accept", via: "parse", regionId: regionIdFor(PAGE, BOX),
    });
    // the promote ran first and never carried the proposal in data (the promotion payload is pinned)
    expect(fetchMock.mock.calls.findIndex(([u]) => u === "/api/regions/promote"))
      .toBeLessThan(fetchMock.mock.calls.findIndex(([u]) => String(u).endsWith("/proposals/verdict")));
    expect(JSON.parse(String(callsTo("/api/regions/promote")[0][1].body)).overrides.data).not.toHaveProperty("proposalId");
    await waitFor(() => expect(queryClient.getQueryData<ProjectProposalSummary>(queryKeys.proposals.all(PUBLIC_ID))!.items[0].verdict).toBe("accept"));
  });

  it("a plain save (no proposal) posts no verdict", async () => {
    mountPanel(grid());
    await waitFor(() => expect(callsTo("/api/regions/promote")).toHaveLength(1));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(callsTo("/proposals/verdict")).toHaveLength(0);
  });

  it("a proposal the list already shows as verdicted is not re-posted", async () => {
    seedProposalsFromBootstrap(queryClient, PUBLIC_ID, { proposals: summary("reject") });
    mountPanel(grid({ proposalId: "prop-1" }));
    await waitFor(() => expect(callsTo("/api/regions/promote")).toHaveLength(1));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(callsTo("/proposals/verdict")).toHaveLength(0);
  });
});
