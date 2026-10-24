// [classifier builder track 3] Component smoke: the tab loads GET /api/admin/classifiers, lists the
// recipes with their badges, opens the editor, a weight edit marks the recipe modified and Save PUTs
// an overlay carrying exactly that patch (feature-keyed), preview posts the draft and renders the
// proposals + agreement table, and the empty / error states render.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import ClassifiersTab from "@/app/admin/tabs/ClassifiersTab";
import { BUILT_IN_RECIPES, staticCatalog } from "@/lib/classifier-engine";

const PAYLOAD = {
  companyId: 3, companyName: "Acme", builtIns: BUILT_IN_RECIPES, builtInsHash: "abc", overlay: null, effective: BUILT_IN_RECIPES,
  catalog: staticCatalog([{ id: 1, name: "acme-yolo", classes: ["tables", "door_tag"], shared: false }]),
};
const PROJECTS = [
  { id: "set-1", name: "Set 1", numPages: 12, isDemo: false, companyId: 3 },
  { id: "demo", name: "Demo", numPages: 2, isDemo: true, companyId: 3 },
];
const PREVIEW = {
  recipeId: "schedules.v1", recipeVersion: 2,
  pages: [{
    pageNumber: 3, storedCount: 1, errors: [], ms: 4,
    proposals: [{
      id: "schedules.v1:p3:0.5,0.2,0.9,0.45", recipeId: "schedules.v1", recipeVersion: 2, engineVersion: "clf/0.1", pageNumber: 3, bbox: [0.5, 0.2, 0.9, 0.45],
      target: "schedule", p: 0.93, classId: "door", className: "Door schedule", group: "arch", nameP: 0.81, margin: 0.4, displayName: "Door schedule",
      detectWhy: [{ signalId: "detect.structure", label: "region v2 structure score", value: 0.8, weight: 6, delta: 4.8 }],
      nameWhy: [{ signalId: "door.csiDiv", label: "Div 08 share", value: 0.82, weight: 2, delta: 1.64, detail: "82% of 11 codes" }],
      features: {},
    }],
  }],
  agreement: { rows: [{ classId: "door", name: "Door schedule", labeled: 2, agree: 1, disagree: 1, notProposed: 0 }], totals: { labeled: 2, agree: 1, disagree: 1, notProposed: 0 } },
  summary: { pagesRun: 1, pagesWithYolo: 1, proposals: 1, storedProposals: 1, verdicts: 2 },
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/admin/classifiers/overlay")) return { ok: true, status: 200, json: async () => ({ success: true, versions: { "schedules.v1": 3 }, overlay: {}, effective: BUILT_IN_RECIPES }) };
    if (url.startsWith("/api/admin/classifiers/preview")) return { ok: true, status: 200, json: async () => PREVIEW };
    if (url.startsWith("/api/admin/classifiers")) return { ok: true, status: 200, json: async () => PAYLOAD };
    return { ok: false, status: 404, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("ClassifiersTab", () => {
  it("lists recipes, edits a weight, saves the feature-keyed patch, previews the draft", async () => {
    render(<ClassifiersTab projects={PROJECTS} isRootAdmin={false} />);
    expect(await screen.findByText("Schedules (kind)")).toBeTruthy();
    expect(screen.getByText("Legends / notes / keynotes")).toBeTruthy();
    expect(screen.getAllByText("built-in")).toHaveLength(2);
    expect(screen.queryByText("modified from built-in")).toBeNull();
    // the editor shows the selected recipe with its classes grouped; open the door class and edit its header weight
    fireEvent.click(screen.getByText(/▶ Door schedule/));
    const header = screen.getByLabelText("weight of header") as HTMLInputElement;
    expect(header.value).toBe("3");
    fireEvent.change(header, { target: { value: "4.5" } });
    expect(await screen.findByText("modified from built-in")).toBeTruthy();
    expect(screen.getByText(/Diff vs built-in \(1\)/)).toBeTruthy();
    fireEvent.click(screen.getByText("Save for company"));
    await waitFor(() => expect(fetchMock.mock.calls.some(([u, i]) => String(u).includes("/overlay") && i?.method === "PUT")).toBe(true));
    const [, putInit] = fetchMock.mock.calls.find(([u, i]) => String(u).includes("/overlay") && i?.method === "PUT")!;
    const sent = JSON.parse(putInit.body as string);
    expect(sent.overlay.custom).toEqual([]);
    expect(sent.overlay.patches["schedules.v1"]).toEqual({ version: BUILT_IN_RECIPES[0].version, signals: { "door.header": { weight: 4.5 } } });
    expect(sent.overlay.patches["regions.v1"]).toBeUndefined();
    expect((await screen.findByRole("status")).textContent).toMatch(/Saved — schedules.v1 v3/);

    // preview: demo project is not offered; the draft is posted; proposals + agreement render
    const pane = within(screen.getByTestId("preview-pane"));
    const select = pane.getByLabelText("preview project") as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["", "set-1"]);
    fireEvent.change(select, { target: { value: "set-1" } });
    fireEvent.change(pane.getByLabelText("preview pages"), { target: { value: "3" } });
    fireEvent.click(pane.getByText("Preview draft"));
    expect(await pane.findByText("Door schedule", { selector: "span.font-medium" })).toBeTruthy();
    const [, previewInit] = fetchMock.mock.calls.find(([u]) => String(u).includes("/preview"))!;
    const previewBody = JSON.parse(previewInit!.body as string);
    expect(previewBody).toMatchObject({ projectId: "set-1", pages: [3] });
    expect(previewBody.recipe.id).toBe("schedules.v1");
    expect(pane.getByText("Div 08 share +1.64 (82% of 11 codes)")).toBeTruthy();
    expect(pane.getByText(/1 proposals now vs 1 stored · 2 labels compared/)).toBeTruthy();
    expect(pane.getByText("your label")).toBeTruthy();
    expect(pane.getByText("1 (50%)")).toBeTruthy();
  });

  it("renders the error state when the load fails", async () => {
    fetchMock.mockImplementation(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    render(<ClassifiersTab projects={[]} isRootAdmin={false} />);
    expect((await screen.findByRole("status")).textContent).toMatch(/HTTP 500/);
    expect(screen.getByText(/Nothing to show/)).toBeTruthy();
  });
});
