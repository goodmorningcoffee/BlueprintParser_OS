// @vitest-environment jsdom
// [table pipeline WP-2.D2] The three Map Tags callers on the tag-ops transport.
//   K39: inline Map Tags (ParsedTableItem, KeynoteItem) skips only a text this region already
//        mapped with this class; a text mapped on another sheet/region/class is mapped again.
//   K05: the new tags are linked to the item's region, so sheet B's keynote "3" never replaces A's.
//   K40: TableParsePanel's Map Tags replaces its region's tags (one `replace-for-region` op), so a
//        tag that now has 0 hits is cleared for this table only, and its legacy row is retired.
// All strings are synthetic.

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import KeynoteItem from "@/components/viewer/KeynoteItem";
import ParsedTableItem from "@/components/viewer/ParsedTableItem";
import TableParsePanel from "@/components/viewer/TableParsePanel";
import { regionIdFor } from "@/lib/client-persist";
import { EMPTY_ACTIVE_PAGE_WINDOW, type ActivePageWindow } from "@/queries/pageWindowCore";
import { queryKeys } from "@/queries/queryKeys";
import {
  clearYoloTagsProject,
  readYoloTags,
  seedYoloTagsFromBootstrap,
  type YoloTagRow,
} from "@/queries/useYoloTags";
import { resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";
import type { YoloTag } from "@/types";

vi.mock("@/components/viewer/AutoParseTab", () => ({
  default: ({ handleMapTags }: { handleMapTags: () => void }) => (
    <button onClick={handleMapTags}>run table map tags</button>
  ),
}));

const PUBLIC_ID = "project-A";
const PAGE = 4;
const TABLE_BOX: [number, number, number, number] = [0.1, 0.2, 0.7, 0.8];

let queryClient: QueryClient;
const fetchMock = vi.fn();
let opsBodies: { ops: Array<Record<string, unknown>> }[];

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function row(id: string, over: Partial<YoloTagRow> = {}): YoloTagRow {
  return {
    id,
    name: id,
    tagText: id,
    yoloClass: "",
    yoloModel: "",
    source: "schedule",
    scope: "project",
    instances: [{ pageNumber: 9, annotationId: -1, bbox: [0.1, 0.1, 0.2, 0.2], confidence: 1 }],
    ...over,
  };
}

function hit(annotationId: number) {
  return { pageNumber: PAGE, annotationId, bbox: [0.2, 0.3, 0.25, 0.35], confidence: 0.9 };
}

/** map-tags-batch answers every requested text present in `hits`; tags/ops records its body. */
function serve(hits: Record<string, number[]>) {
  fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (String(url).endsWith("/map-tags-batch")) {
      const results = Object.fromEntries((body.tags as string[]).map((t) => [t, (hits[t] ?? []).map(hit)]));
      return { ok: true, status: 200, json: async () => ({ results, dropCounts: {} }) } as unknown as Response;
    }
    if (String(url).endsWith("/tags/ops")) {
      opsBodies.push(body);
      return { ok: true, status: 200, json: async () => ({ tags: [], removed: [], replacedRegionIds: [], skipped: [] }) } as unknown as Response;
    }
    throw new Error(`unexpected request ${url}`);
  });
}

function mapRequestTags(): string[] {
  const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/map-tags-batch"));
  return JSON.parse(String((call![1] as RequestInit).body)).tags;
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  resetProjectData();
  setViewerStoreStateForTest({
    projectId: 41,
    publicId: PUBLIC_ID,
    isDemo: false,
    pageNumber: PAGE,
    pageDrawingNumbers: {},
  });
  queryClient.setQueryData(queryKeys.annotations.all(PUBLIC_ID), []);
  queryClient.setQueryData<ActivePageWindow>(queryKeys.pagesWindow.active(PUBLIC_ID), { ...EMPTY_ACTIVE_PAGE_WINDOW });
  fetchMock.mockReset();
  opsBodies = [];
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  clearYoloTagsProject(queryClient, PUBLIC_ID);
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("inline Map Tags (K39, K05)", () => {
  it("ParsedTableItem maps a text another table already mapped, links it to this table, and persists an upsert", async () => {
    const otherTable = row("other-D1", { tagText: "D1", links: { regionId: "pr-other" } });
    const sameTableLegacy = row("legacy-D2", { tagText: "D2" });
    seedYoloTagsFromBootstrap(queryClient, PUBLIC_ID, { yoloTags: [otherTable, sameTableLegacy] });
    serve({ D1: [31] });

    render(
      <ParsedTableItem
        table={{
          pageNum: PAGE,
          name: "Synthetic Schedule",
          category: "door-schedule",
          rowCount: 2,
          colCount: 2,
          csiTags: [],
          region: {
            id: "pr-this",
            type: "schedule",
            category: "door-schedule",
            bbox: TABLE_BOX,
            csiTags: [],
            data: {
              headers: ["Tag", "Description"],
              rows: [{ Tag: "D1", Description: "alpha" }, { Tag: "D2", Description: "beta" }],
              tagColumn: "Tag",
              tableName: "Synthetic Schedule",
            },
          },
        }}
        pageNames={{}}
        isCurrentPage
        onNavigate={vi.fn()}
        yoloTags={[otherTable, sameTableLegacy]}
        pageNumber={PAGE}
        publicId={PUBLIC_ID}
        isDemo={false}
        cellStructureOperation={{
          detect: vi.fn(async () => false),
          clear: vi.fn(),
          loadingKey: null,
          busy: false,
          errorKey: null,
          error: null,
        }}
      />,
      { wrapper },
    );
    fireEvent.click(screen.getByRole("button", { name: "▶" }));
    fireEvent.click(screen.getByRole("button", { name: /Map Tags/ }));
    fireEvent.click(screen.getByRole("button", { name: "Run Mapping" }));

    await waitFor(() => expect(readYoloTags(queryClient, PUBLIC_ID)).toHaveLength(3));
    // D1 is mapped although another table holds a D1; D2 (this table's unlinked legacy tag) is skipped.
    expect(mapRequestTags()).toEqual(["D1"]);
    const rows = readYoloTags(queryClient, PUBLIC_ID) as YoloTagRow[];
    expect(rows[0]).toBe(otherTable);
    expect(rows[2]).toMatchObject({ tagText: "D1", links: { regionId: "pr-this" }, instances: [{ annotationId: 31 }] });

    await waitFor(() => expect(opsBodies).toHaveLength(1), { timeout: 3_000 });
    expect(opsBodies[0].ops).toEqual([{ op: "upsert", tag: rows[2] }]);
  });

  it("KeynoteItem maps sheet B's keynote 3 although sheet A's is mapped; both survive", async () => {
    const sheetA = row("kn-a-3", { tagText: "3", source: "keynote", pageNumber: 2, links: { regionId: "pr-sheet-a" } });
    seedYoloTagsFromBootstrap(queryClient, PUBLIC_ID, { yoloTags: [sheetA] });
    serve({ "3": [41], "4": [42] });

    render(
      <KeynoteItem
        keynote={{
          pageNumber: PAGE,
          tableName: "Keynotes",
          keys: [{ key: "3", description: "gamma" }, { key: "4", description: "delta" }],
        }}
        region={{ id: "pr-sheet-b" }}
        pageNames={{}}
        isCurrentPage
        onNavigate={vi.fn()}
        activeHighlight={null}
        onHighlight={vi.fn()}
        onDelete={vi.fn()}
        publicId={PUBLIC_ID}
        yoloTags={[sheetA]}
      />,
      { wrapper },
    );
    fireEvent.click(screen.getByRole("button", { name: "▶" }));
    fireEvent.click(screen.getByRole("button", { name: /Map Tags/ }));
    fireEvent.click(screen.getByRole("button", { name: "Run Mapping" }));

    await waitFor(() => expect(readYoloTags(queryClient, PUBLIC_ID)).toHaveLength(3));
    expect(mapRequestTags()).toEqual(["3", "4"]);
    const rows = readYoloTags(queryClient, PUBLIC_ID) as YoloTagRow[];
    expect(rows.map((r) => [r.tagText, r.links?.regionId])).toEqual([
      ["3", "pr-sheet-a"],
      ["3", "pr-sheet-b"],
      ["4", "pr-sheet-b"],
    ]);
    expect(rows[0]).toBe(sheetA);
  });
});

describe("TableParsePanel Map Tags (K40)", () => {
  it("replaces this region's re-mapped tags with one replace-for-region op: 0-hit cleared, legacy retired, other classes/columns/tables kept", async () => {
    const regionId = regionIdFor(PAGE, TABLE_BOX);
    const staleZeroHit = row("stale-D3", { tagText: "D3", links: { regionId } });
    const legacyD1 = row("legacy-D1", { tagText: "D1" });
    const otherTableD3 = row("other-D3", { tagText: "D3", links: { regionId: "pr-other" } });
    // Fix round MED-1: this region's tags of another class and of another column (an inline map) survive.
    const otherClassD1 = row("window-D1", { tagText: "D1", yoloClass: "window", links: { regionId } });
    const otherColumnH1 = row("inline-H1", { tagText: "H1", links: { regionId } });
    seedYoloTagsFromBootstrap(queryClient, PUBLIC_ID, {
      yoloTags: [staleZeroHit, legacyD1, otherTableD3, otherClassD1, otherColumnH1],
    });
    const longText = `L${"x".repeat(299)}`;
    setViewerStoreStateForTest({
      tableParseTab: "auto",
      tableParseRegion: TABLE_BOX,
      tableParsedGrid: {
        headers: ["Tag", "Description"],
        rows: [{ Tag: "D1", Description: "alpha" }, { Tag: "D3", Description: "gamma" }, { Tag: longText, Description: "" }],
        tagColumn: "Tag",
        tableName: "Synthetic Schedule",
      },
    });
    serve({ D1: [51, 52], [longText]: [53] }); // D3 now has 0 hits

    render(<TableParsePanel />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: "run table map tags" }));

    await waitFor(() => expect(readYoloTags(queryClient, PUBLIC_ID).map((r) => r.id)).not.toContain("stale-D3"));
    const rows = readYoloTags(queryClient, PUBLIC_ID) as YoloTagRow[];
    expect(rows.map((r) => [r.tagText, r.yoloClass, r.links?.regionId ?? null])).toEqual([
      ["D3", "", "pr-other"],
      ["D1", "window", regionId],
      ["H1", "", regionId],
      ["D1", "", regionId],
      [longText, "", regionId],
    ]);
    expect(rows[1]).toMatchObject({ id: "window-D1", instances: otherClassD1.instances });
    expect(rows[2]).toMatchObject({ id: "inline-H1", instances: otherColumnH1.instances });
    // LOW-3: a long tag text no longer mints an id the ops route refuses (> 300 characters).
    expect(rows[4].id.length).toBeLessThanOrEqual(100);

    await waitFor(() => expect(opsBodies).toHaveLength(1), { timeout: 3_000 });
    expect(opsBodies[0].ops).toHaveLength(1);
    expect(opsBodies[0].ops[0]).toMatchObject({ op: "replace-for-region", regionId, retireIds: ["legacy-D1"] });
    expect((opsBodies[0].ops[0].tags as YoloTag[]).map((t) => [t.id, t.tagText])).toEqual([
      ["window-D1", "D1"],
      ["inline-H1", "H1"],
      [rows[3].id, "D1"],
      [rows[4].id, longText],
    ]);
  });
});
