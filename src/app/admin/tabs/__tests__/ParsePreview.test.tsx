// [TP-3 WP-3.P] The Classifiers Preview pane's root-only parse preview: the dry run's structure proposals are
// posted to /api/admin/classifiers/parse-preview (page units and non-structure targets skipped, capped), and each
// proposal renders its parse read-only (the StructurePreviewGrid with no edit controls; the paragraph list for
// notes; an error line). A company admin sees no Parse button. Synthetic fixtures only (rule 12).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ClassifierProposal, ClassifierRecipe } from "@/lib/classifier-engine";
import PreviewPane from "@/app/admin/tabs/classifiers/PreviewPane";
import { PARSE_PREVIEW_MAX, PARSE_PREVIEW_URL, ParsePreview, parsePreviewItems } from "@/app/admin/tabs/classifiers/ParsePreview";
import { notesResult, scheduleResult } from "@/components/viewer/workspace/__tests__/structureFixtures";

const PROJECTS = [{ id: "11111111-2222-4333-8444-555555555555", name: "Set 1", numPages: 3, isDemo: false, companyId: 3 }];
const DRAFT = { id: "schedules.v1", version: 1 } as unknown as ClassifierRecipe;

function proposal(id: string, target: string, classId: string | null, bbox: [number, number, number, number], pageNumber = 2): ClassifierProposal {
  return {
    id, pageNumber, bbox, target, classId, displayName: `Name ${id}`, p: 0.9, nameP: 0.8, margin: 0.3,
    detectWhy: [], nameWhy: [],
  } as unknown as ClassifierProposal;
}

const PAGES = [{
  pageNumber: 2, storedCount: 0, errors: [], ms: 5,
  proposals: [
    proposal("sch", "schedule", "door-schedule", [0.1, 0.1, 0.5, 0.3]),
    proposal("nts", "general-notes", null, [0.1, 0.5, 0.4, 0.67]),
    proposal("bad", "keynote-table", "keynotes", [0.6, 0.6, 0.9, 0.9]),
    proposal("sheet", "schedule", null, [0, 0, 1, 1]),
    proposal("plan", "floor-plan", null, [0.2, 0.2, 0.3, 0.3]),
  ],
}];
const PREVIEW = {
  recipeId: "schedules.v1", recipeVersion: 1, pages: PAGES,
  agreement: { rows: [], totals: { labeled: 0, agree: 0, disagree: 0, notProposed: 0 } },
  summary: { pagesRun: 1, pagesWithYolo: 1, proposals: 5, storedProposals: 0, verdicts: 0 },
};
const PARSED = {
  projectId: PROJECTS[0].id, budget: "instant",
  items: [
    { proposalId: "sch", page: 2, kind: "schedule", drawingNumber: "Q-201", result: scheduleResult() },
    { proposalId: "nts", page: 2, kind: "notes", drawingNumber: "Q-201", result: notesResult() },
    { proposalId: "bad", page: 2, kind: "keynote", drawingNumber: "Q-201", error: "failed" },
  ],
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async (url: string) => {
    if (url.startsWith("/api/admin/classifiers/preview")) return { ok: true, status: 200, json: async () => PREVIEW };
    if (url === PARSE_PREVIEW_URL) return { ok: true, status: 200, json: async () => PARSED };
    return { ok: false, status: 404, json: async () => ({ error: { message: "no" } }) };
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function previewed(canParse: boolean) {
  render(<PreviewPane draft={DRAFT} projects={PROJECTS} companyId={3} canRun={false} canParse={canParse} />);
  fireEvent.change(screen.getByLabelText("preview project"), { target: { value: PROJECTS[0].id } });
  fireEvent.click(screen.getByText("Preview draft"));
  await waitFor(() => expect(screen.getByText("Name sch")).toBeInTheDocument());
}

describe("parsePreviewItems", () => {
  it("keeps structure targets (the inbox's kind rule), drops page units and other targets, caps the batch", () => {
    const { items, dropped } = parsePreviewItems(PAGES);
    expect(items).toEqual([
      { page: 2, bbox: [0.1, 0.1, 0.5, 0.3], kind: "schedule", proposalId: "sch" },
      { page: 2, bbox: [0.1, 0.5, 0.4, 0.67], kind: "notes", proposalId: "nts" },
      { page: 2, bbox: [0.6, 0.6, 0.9, 0.9], kind: "keynote", proposalId: "bad" },
    ]);
    expect(dropped).toBe(0);
    const many = [{ pageNumber: 1, proposals: Array.from({ length: PARSE_PREVIEW_MAX + 3 }, (_, i) => proposal(`m${i}`, "symbol-legend", null, [0.1, 0.1, 0.2, 0.2], 1)) }];
    const capped = parsePreviewItems(many);
    expect(capped.items).toHaveLength(PARSE_PREVIEW_MAX);
    expect(capped.items[0].kind).toBe("legend");
    expect(capped.dropped).toBe(3);
  });
});

describe("PreviewPane parse preview (root)", () => {
  it("posts the structure proposals and renders each parse read-only under its proposal", async () => {
    await previewed(true);
    fireEvent.click(screen.getByText("Parse proposals"));
    await waitFor(() => expect(screen.getAllByTestId("parse-preview")).toHaveLength(2));

    const [, init] = fetchMock.mock.calls.find(([u]) => u === PARSE_PREVIEW_URL)!;
    expect(JSON.parse(init.body as string)).toEqual({ projectId: PROJECTS[0].id, items: parsePreviewItems(PAGES).items });
    expect(screen.getByTestId("parse-preview-note")).toHaveTextContent("3 parsed at instant · nothing written");

    // The schedule: a read-only grid (no column ▾, no inline field on click).
    const grid = screen.getByRole("table", { name: "Parse preview sch" });
    expect(within(grid).getAllByRole("columnheader").map((th) => th.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("MARK")]));
    expect(within(grid).getByText("W2")).toBeInTheDocument();
    expect(within(grid).queryAllByRole("button")).toHaveLength(0);
    fireEvent.click(within(grid).getByText("W2"));
    expect(within(grid).queryByRole("textbox")).toBeNull();
    expect(screen.getByText(/parse \(schedule\): 4 rows × 3 columns · 1 header row/u)).toBeInTheDocument();

    // The notes block: the paragraph list, addressed by the page's drawing number, with no edit controls.
    expect(screen.getByText(/parse \(notes\): 3 paragraphs · 1 block/u)).toBeInTheDocument();
    expect(screen.getAllByText(/Synthetic delta/u).length).toBeGreaterThan(0);

    // The failed box is an error line, not a crash; the page-unit and plan proposals have no parse.
    expect(screen.getByText("parse: the parse failed on this box (see the server log)")).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([u]) => u === PARSE_PREVIEW_URL)).toHaveLength(1);
  });

  it("a company admin (canParse false) has no Parse button and never calls the root route", async () => {
    await previewed(false);
    expect(screen.queryByText("Parse proposals")).toBeNull();
    expect(fetchMock.mock.calls.some(([u]) => u === PARSE_PREVIEW_URL)).toBe(false);
  });

  it("a refused parse preview (e.g. 403) shows the server's message", async () => {
    await previewed(true);
    fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 403, json: async () => ({ error: { message: "Root admin only" } }) }));
    fireEvent.click(screen.getByText("Parse proposals"));
    await waitFor(() => expect(screen.getByText("Parse preview: Root admin only")).toBeInTheDocument());
    expect(screen.queryByTestId("parse-preview")).toBeNull();
  });

  it("ParsePreview renders a synthetic table fixture on its own", () => {
    render(<ParsePreview item={{ proposalId: "x", page: 1, kind: "schedule", drawingNumber: null, result: scheduleResult() }} />);
    expect(screen.getByRole("table", { name: "Parse preview x" })).toBeInTheDocument();
    expect(screen.getAllByText("A3").length).toBeGreaterThan(0);
  });
});
