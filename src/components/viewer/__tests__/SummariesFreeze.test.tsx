// [refactor jul10 P2.2③] SUMMARIES MIGRATION FREEZE NET — per-consumer DOM characterization.
//
// One thin, discriminating case per summaries READ surface (SPEC §6: SI-1/SI-2/NI-1/TPP-1/KP-1/
// VT-1/PS-1; AQT-R lives in AutoQtoTab.test.tsx which already owns that harness; TPP-R added
// post-migration by the DETECTOR closers — the refresher null-retention pin, SPEC §5-S4). Written GREEN
// against the CURRENT (zustand-backed) code and MUST stay green byte-for-byte after the summaries
// domain migrates to the TanStack Query cache (variant a, bootstrap-seeded —
// P2_DESIGN/SUMMARIES_IMPL/SPEC.md). The single sanctioned divergence point is the SHARED
// `seedSummaries` helper (src/test/seed-summaries.ts): pre-migration it writes the zustand field;
// post-migration it writes the query cache. Every test body here stays identical.
//
// Scope discipline: only summaries-DATA-driven behavior is frozen. Each case picks the assertion
// that DISCRIMINATES the summaries source from that component's non-summaries fallback
// (pageIntelligence / annotations / csiCodes), so a broken read-path can't false-pass off the
// fallback. Active page-window state is domain ⑦ and seeded separately only as fallback bait;
// this suite does not assert its loader/range behavior.
//
// Harness gotchas baked in (RECIPE §gotchas + SPEC §6): jest-dom imported per file; jsdom lacks
// scrollIntoView (ParsedTableItem focus effect) AND ResizeObserver (PageSidebar :295 container
// measure — NOT in RECIPE's original list, SPEC §8 erratum) — both stubbed; PageSidebar asserts
// CHIPS ONLY (virtual scroll computes containerHeight 0 in jsdom, tiles never render);
// QueryClientProvider is already in the wrapper NOW (chat precedent) so the migration flip needs
// zero wrapper churn; all post-seed reads go through waitFor (zustand notifies synchronously,
// the query cache notifies via microtask — SPEC §5-S1).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "@testing-library/jest-dom";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  EMPTY_ACTIVE_PAGE_WINDOW,
  type ActivePageWindow,
} from "@/queries/pageWindowCore";
import { queryKeys } from "@/queries/queryKeys";
import { useUiStore } from "@/stores/uiStore";
import { useParseFlowStore as useViewerStore } from "@/stores/parseFlowStore";
import { seedAnnotations } from "@/test/seed-annotations";
import { seedSummaries } from "@/test/seed-summaries";
import type { ProjectSummaries } from "@/types";
import SpecIndex from "../SpecIndex";
import NotesIndex from "../NotesIndex";
import TableParsePanel from "../TableParsePanel";
import KeynotePanel from "../KeynotePanel";
import ViewerToolbar from "../ViewerToolbar";
import PageSidebar from "../PageSidebar";
import { resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";

let qc: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

// [refactor jul11 P2.2⑦ M2] Backing-independent bait for the whole-map summary fallbacks below.
// These consumers now read the project-keyed active window; UI/navigation setup remains in Zustand.
function seedPageWindow(overrides: Partial<ActivePageWindow>): void {
  qc.setQueryData(queryKeys.pagesWindow.active("pid"), {
    ...EMPTY_ACTIVE_PAGE_WINDOW,
    ...overrides,
  });
}

// Full-shape ProjectSummaries fixture — required keys empty, cases override what they read.
// (Full shape, no `as never`: keeps these fixtures honest against the real type so a field
// rename breaks HERE, not silently in a consumer.)
function summariesFixture(over: Partial<ProjectSummaries>): ProjectSummaries {
  return {
    schedules: [],
    parsedTables: [],
    keynoteTablePages: [],
    csiPageIndex: {},
    tradePageIndex: {},
    keynotePageIndex: {},
    textAnnotationPageIndex: {},
    pageClassifications: {},
    annotationSummary: { modelNames: [], categoryCounts: {}, pageAnnotationCounts: {} },
    takeoffTotals: {},
    allTrades: [],
    allCsiCodes: [],
    ...over,
  };
}

beforeEach(() => {
  // PURE-DEFAULTS client, matching production (Providers.tsx has no defaultOptions) — same
  // rationale as the qto freeze net's DETECTOR closer.
  qc = new QueryClient();
  resetProjectData();
  setViewerStoreStateForTest({ publicId: "pid", isDemo: false, pageNames: {} });
  // jsdom gotchas (see header)
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // None of these mounts/interactions may touch the network — fail loudly if one does.
  vi.stubGlobal("fetch", vi.fn((url: unknown) => {
    throw new Error(`unexpected fetch in summaries freeze test: ${url}`);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─── SpecIndex — raw-selector consumer #1 (highest-risk diff: selector→hook rewrite) ─────────

describe("SpecIndex — null summaries shows the empty state (SI-1)", () => {
  // Doubles as the suite-wide null-default DOM case: NO seed at all — pre-migration the reset
  // nulled the store field; post-migration the fresh cache entry's initialData is null.
  it("renders 'No spec regions detected yet' with no seed", async () => {
    render(<SpecIndex onOpenParser={vi.fn()} />, { wrapper });

    await waitFor(() =>
      expect(screen.getByText("No spec regions detected yet")).toBeInTheDocument(),
    );
  });
});

describe("SpecIndex — seeded specRegions render as rows (SI-2)", () => {
  it("two seeded regions both render (sorted/filtered path)", async () => {
    seedSummaries(
      qc,
      summariesFixture({
        specRegions: [
          { pageNum: 4, drawingNumber: "A-101", headerText: "MASONRY SPEC", tier1: "spec", confidence: 0.9, wordCount: 120 },
          { pageNum: 2, drawingNumber: "G-001", headerText: "GENERAL SPEC", confidence: 0.8 },
        ],
      }),
    );
    render(<SpecIndex onOpenParser={vi.fn()} />, { wrapper });

    await waitFor(() => expect(screen.getByText("MASONRY SPEC")).toBeInTheDocument());
    expect(screen.getByText("GENERAL SPEC")).toBeInTheDocument();
    expect(screen.getByText("A-101")).toBeInTheDocument();
    expect(screen.getByText("120 words")).toBeInTheDocument();
    expect(screen.queryByText("No spec regions detected yet")).not.toBeInTheDocument();
  });
});

// ─── NotesIndex — raw-selector consumer #2 (mirror component, independent diff) ──────────────

describe("NotesIndex — seeded notesRegions render as rows (NI-1)", () => {
  it("one seeded region renders with header + row count", async () => {
    seedSummaries(
      qc,
      summariesFixture({
        notesRegions: [
          {
            pageNum: 6,
            drawingNumber: "E-101",
            type: "notes-numbered",
            headerText: "ELECTRICAL NOTES",
            trade: "Electrical",
            confidence: 0.9,
            rowCount: 3,
          },
        ],
      }),
    );
    render(<NotesIndex onOpenParser={vi.fn()} />, { wrapper });

    await waitFor(() => expect(screen.getByText("ELECTRICAL NOTES")).toBeInTheDocument());
    expect(screen.getByText("3 rows")).toBeInTheDocument();
    expect(screen.queryByText("No notes detected yet")).not.toBeInTheDocument();
  });
});

// ─── TableParsePanel — merge + dedupe of summaries.parsedTables vs pageIntelligence ──────────

describe("TableParsePanel — All Tables merges summaries with loaded intel, deduped (TPP-1)", () => {
  it("page-2 intel row wins over its summary twin; page-9 summary-only row appears lightweight", async () => {
    seedPageWindow({
      pageIntelligence: {
        2: {
          parsedRegions: [
            {
              id: "r-p2",
              type: "schedule",
              category: "window-schedule",
              bbox: [0.1, 0.1, 0.9, 0.5],
              confidence: 0.9,
              csiTags: [],
              data: {
                tableName: "Window Schedule",
                headers: ["TAG", "SIZE"],
                rows: [{ TAG: "W1", SIZE: "3050" }],
                tagColumn: "TAG",
                rowCount: 1,
                columnCount: 2,
              },
            },
          ],
        },
      } as never,
    });
    seedSummaries(
      qc,
      summariesFixture({
        parsedTables: [
          // Same page as the loaded intel entry but a DIFFERENT name: if the dedupe (skip pages
          // already in loaded intel) breaks, this name leaks into the DOM and fails below.
          { pageNum: 2, name: "Stale Summary Dup", category: "window-schedule", rowCount: 5, colCount: 2 },
          { pageNum: 9, name: "Door Schedule", category: "door-schedule", rowCount: 12, colCount: 3 },
        ],
      }),
    );
    render(<TableParsePanel />, { wrapper });

    await waitFor(() => expect(screen.getByText("Window Schedule")).toBeInTheDocument());
    // dedupe: page 2 counted ONCE (intel wins), page 9 added from the summary catalog
    expect(screen.getByText("2 table(s)")).toBeInTheDocument();
    expect(screen.queryByText("Stale Summary Dup")).not.toBeInTheDocument();
    // lightweight summary-only row: name + page label (no region detail loaded yet)
    expect(screen.getByText("Door Schedule")).toBeInTheDocument();
    expect(screen.getByText(/p\.9/)).toBeInTheDocument();
  });
});

// ─── TableParsePanel — refresher null-retention: the `if (result.summaries)` guard (TPP-R) ───

// [refactor jul10 P2.2③ closers] THE executable pin for SPEC §5-S4. Before this case, all 6
// promote-refresher guards were deletable with a green suite: the server-side pin
// (regions-promote.route.test.ts:524) only proves the API RETURNS summaries:null on the
// compute-reject swallow, and AQT-R only pins imperative-write→subscribed-read propagation —
// neither exercises the CLIENT's guarded write. This case drives TableParsePanel's REAL save
// handler (detectCsiAndPersist → promoteParsedRegion → fetch("/api/regions/promote")) against a
// mocked response whose summaries is null, then asserts the previously-seeded catalog STILL
// renders. Discrimination (verified against the handler at TableParsePanel.tsx:194): deleting the
// guard makes the seed unconditional → seedSummariesCache(qc, pid, null) nulls the "pid" cache
// entry → allParsedTables loses its summary-only row → the final asserts fail ("No parsed tables
// found." replaces "Door Schedule"). The grid carries non-empty csiTags so the best-effort
// /api/csi/detect pre-fetch is skipped — the ONLY network hop is the promote itself.
describe("TableParsePanel — promote returning summaries:null keeps seeded summaries (TPP-R)", () => {
  it("save flows through the real promote path; guard retains the seeded catalog", async () => {
    // Mocked promote response: success envelope, summaries:null (the compute-reject swallow
    // shape). updatedIntelligence has NO schedule regions so the seeded page-9 summary row stays
    // the single All-Tables entry — "1 table(s)" discriminates cleanly.
    const promoteResponse = {
      ok: true,
      parsedRegion: {},
      updatedIntelligence: { parsedRegions: [] },
      summaries: null,
    };
    const promoteFetch = vi.fn(async (url: unknown) => {
      if (url !== "/api/regions/promote") {
        throw new Error(`unexpected fetch in TPP-R (only the promote may fire): ${url}`);
      }
      return { ok: true, json: async () => promoteResponse } as Response;
    });
    vi.stubGlobal("fetch", promoteFetch); // overrides the beforeEach fail-loud stub for this case

    // Review-step state so AutoParseTab renders its Save button immediately; canPersist("pid",
    // false) is true, so Save takes the promote branch, not the local-only fallback.
    useViewerStore.setState({
      tableParseStep: "review",
      tableParsedGrid: {
        headers: ["TAG", "SIZE"],
        rows: [{ TAG: "D1", SIZE: "3070" }],
        tableName: "Fresh Save",
        csiTags: [{ code: "08 11 13", description: "Hollow Metal Doors" }],
      },
    });
    seedSummaries(
      qc,
      summariesFixture({
        parsedTables: [
          { pageNum: 9, name: "Door Schedule", category: "door-schedule", rowCount: 12, colCount: 3 },
        ],
      }),
    );
    render(<TableParsePanel />, { wrapper });

    // Pre-save: the seeded summary-only row renders on the default All Tables tab.
    await waitFor(() => expect(screen.getByText("Door Schedule")).toBeInTheDocument());
    expect(screen.getByText("1 table(s)")).toBeInTheDocument();

    // Drive the refresher: Auto Parse tab → Save → real detectCsiAndPersist runs.
    fireEvent.click(screen.getByRole("button", { name: "Auto Parse" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // Success-path completion signal: the promote fired AND the review UI reset (on the error
    // path Save stays mounted with an error box — so a silently-failed promote can't false-pass).
    await waitFor(() => expect(promoteFetch).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument(),
    );

    // Back to All Tables: a fresh render pass reads the CURRENT cache entry (no notify race) —
    // the guard held, so the seeded catalog is still there.
    fireEvent.click(screen.getByRole("button", { name: "All Tables" }));
    await waitFor(() => expect(screen.getByText("Door Schedule")).toBeInTheDocument());
    expect(screen.getByText("1 table(s)")).toBeInTheDocument();
    expect(screen.queryByText("No parsed tables found.")).not.toBeInTheDocument();
  });
});

// ─── KeynotePanel — wholesale source-switch over the pageIntelligence fallback ───────────────

describe("KeynotePanel — keynoteTablePages replaces the intel fallback wholesale (KP-1)", () => {
  it("summary page-5 row shown; intel-only page-3 keynote table NOT shown", async () => {
    useViewerStore.setState({
      // guided tab renders the 'Detected Keynote Tables' list (idle-step mount is cheap)
      keynoteParseTab: "guided",
    });
    seedPageWindow({
      // fallback bait: if the source-switch breaks and the component iterates pageIntelligence
      // despite summaries being present, p.3 appears and the negative assert fails.
      pageIntelligence: {
        3: { classifiedTables: [{ category: "keynote-table", confidence: 0.8 }] },
      } as never,
    });
    seedSummaries(qc, summariesFixture({ keynoteTablePages: [{ pageNum: 5, confidence: 0.9 }] }));
    render(<KeynotePanel />, { wrapper });

    await waitFor(() => expect(screen.getByText("Detected Keynote Tables")).toBeInTheDocument());
    expect(screen.getByText(/p\.5/)).toBeInTheDocument();
    expect(screen.getByText(/\(90%\)/)).toBeInTheDocument();
    expect(screen.queryByText(/p\.3/)).not.toBeInTheDocument();
  });
});

// ─── ViewerToolbar — summaries model names win over the annotations fallback ─────────────────

describe("ViewerToolbar — YOLO dropdown lists summaries.modelNames, not the fallback (VT-1)", () => {
  it("dropdown shows 'summaryModel' and NOT the annotation-derived 'annModel'", async () => {
    useUiStore.setState({ showDetections: true });
    // one real yolo annotation: passes the hasYoloAnnotations gate AND baits the fallback —
    // the `summaries?...modelNames || [...]` read must suppress it while summaries exist
    // (incl. the `[] ||` truthiness quirk: even an EMPTY summaries list wins).
    seedAnnotations(qc, [
      {
        id: 1,
        pageNumber: 1,
        name: "door_single",
        bbox: [0, 0, 0.1, 0.1],
        note: null,
        source: "yolo",
        data: { modelName: "annModel" },
      },
    ]);
    seedSummaries(
      qc,
      summariesFixture({
        annotationSummary: { modelNames: ["summaryModel"], categoryCounts: {}, pageAnnotationCounts: {} },
      }),
    );
    render(<ViewerToolbar projectName="Freeze Project" />, { wrapper });

    // the per-model dropdown toggle only renders when yoloModelNames is non-empty
    fireEvent.click(screen.getByRole("button", { name: "▾" }));

    await waitFor(() => expect(screen.getByText("summaryModel")).toBeInTheDocument());
    expect(screen.queryByText("annModel")).not.toBeInTheDocument();
  });
});

// ─── PageSidebar — filter chip counts come from the summary page indexes ─────────────────────

describe("PageSidebar — trade chip uses summaries.tradePageIndex over the csiCodes fallback (PS-1)", () => {
  // ONE chip case covers all seven summaries?.X || fallback memos: they are field-name-only
  // variants behind what will be an import-line-only diff (SPEC §6 PS-1). CHIPS ONLY — the
  // virtual-scroll tile list never renders in jsdom (containerHeight 0).
  it("chip reads 'Trade: Plumbing (2 pg)' from the summary index (fallback would say 1 pg)", async () => {
    setViewerStoreStateForTest({
      numPages: 10,
      activeTradeFilter: "Plumbing",
    });
    seedPageWindow({
      // fallback bait: csiCodes says only page 4 has Plumbing → a broken summaries read
      // renders "(1 pg)" and the exact-text assert fails.
      csiCodes: {
        4: [{ code: "22 11 16", description: "Domestic Water Piping", trade: "Plumbing", division: "22" }],
      },
    });
    seedSummaries(qc, summariesFixture({ tradePageIndex: { Plumbing: [3, 7] } }));
    render(<PageSidebar pdfDoc={null} />, { wrapper });

    await waitFor(() => expect(screen.getByText("Trade: Plumbing (2 pg)")).toBeInTheDocument());
  });
});
