// [2026-10-24 master Reprocess tab, phase 1] Component pins: the checklist auto-includes downstream
// stages and says why; a run is preview → (typed phrase | confirm) → TODAY's routes in DAG order
// through the one console; the scope picker drops demo / other-company picks; root-only stages,
// placeholders, Re-OCR and the company picker render in their disabled states.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import ReprocessTab from "@/app/admin/tabs/ReprocessTab";

const SCOPE = {
  companyId: 3,
  companyName: "Acme",
  projects: 2,
  byStatus: { completed: 1, error: 1 },
  description: "every non-demo project of your own company, any status",
};

const PROJECTS = [
  { id: "own-done", name: "Own done", status: "completed", isDemo: false, companyId: 3, companyName: "Acme" },
  { id: "own-err", name: "Own error", status: "error", isDemo: false, companyId: 3, companyName: "Acme" },
  { id: "demo", name: "Demo", status: "completed", isDemo: true, companyId: 3, companyName: "Acme" },
  { id: "foreign", name: "Foreign", status: "completed", isDemo: false, companyId: 4, companyName: "Other" },
];

function ndjson(lines: object[]) {
  const text = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  return {
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(text));
        c.close();
      },
    }),
  };
}

let fetchMock: ReturnType<typeof vi.fn>;
const posts = (prefix: string) => fetchMock.mock.calls.filter(([u, i]) => String(u).startsWith(prefix) && i?.method === "POST");
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));

beforeEach(() => {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u === "/api/admin/reprocess/scope") return { ok: true, status: 200, json: async () => SCOPE };
    if (u.startsWith("/api/admin/reprocess")) {
      return ndjson([{ type: "start", projects: 2 }, { type: "done", updated: 3, skipped: 0 }]);
    }
    if (u.startsWith("/api/admin/annotation-cleanup")) {
      const body = JSON.parse(String(init?.body));
      const result = {
        dryRun: body.dryRun, mode: body.mode, sources: body.sources, clearPageCsi: body.clearPageCsi, confirmPhrase: "DELETE",
        projects: [{ publicId: "own-done", name: "Own done", annotations: 12, pagesCsiCleared: 0 }], total: 12, pagesCsiCleared: 0,
      };
      return { ok: true, status: 200, json: async () => result };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const renderTab = (props: Partial<React.ComponentProps<typeof ReprocessTab>> = {}) => {
  const onOpenTab = vi.fn();
  render(<ReprocessTab projects={PROJECTS} isRootAdmin={false} presetRequest={null} onOpenTab={onOpenTab} {...props} />);
  return { onOpenTab };
};

const stage = (id: string) => screen.getByTestId(`stage-${id}`);
// The stage checkbox is the row's first; option checkboxes (classifier debug, clear CSI) follow it.
const box = (id: string) => within(stage(id)).getAllByRole("checkbox")[0] as HTMLInputElement;
const planOrder = () => within(screen.getByTestId("plan-order")).getAllByRole("listitem").map((li) => li.textContent);

describe("ReprocessTab", () => {
  it("ticking Page names auto-includes CSI + text annotations and Intelligence, says why, and orders the plan by the DAG", async () => {
    renderTab();
    await screen.findByText(/"All" runs on 2 projects/u);
    fireEvent.click(box("page-names"));
    expect(box("full").checked).toBe(true);
    expect(box("intelligence").checked).toBe(true);
    expect(within(stage("full")).getByText("auto-included")).toBeTruthy();
    expect(within(stage("intelligence")).getByText(/Intelligence added because page intelligence derives from the CSI codes/u)).toBeTruthy();
    expect(planOrder()).toEqual(["1. Page names (drawing numbers)", "2. CSI + text annotations (auto)", "3. Intelligence + project analysis (auto)"]);

    // Unticking an auto-include keeps it out of the run and warns.
    fireEvent.click(box("intelligence"));
    expect(planOrder()).toEqual(["1. Page names (drawing numbers)", "2. CSI + text annotations (auto)"]);
    expect(screen.getByText(/Intelligence \+ project analysis unticked — leaves stale/u)).toBeTruthy();
  });

  it("a handed-over preset ticks its stages; a later request with a new n re-applies", async () => {
    const { rerender } = render(
      <ReprocessTab projects={PROJECTS} isRootAdmin={false} presetRequest={{ preset: "full-refresh", n: 1 }} onOpenTab={() => {}} />,
    );
    expect(planOrder()).toEqual([
      "1. Page names (drawing numbers)", "2. CSI + text annotations", "3. Shape parse (keynotes)", "4. Intelligence + project analysis",
    ]);
    rerender(<ReprocessTab projects={PROJECTS} isRootAdmin={false} presetRequest={{ preset: "rules-changed", n: 2 }} onOpenTab={() => {}} />);
    expect(planOrder()).toEqual(["1. Intelligence + project analysis"]);
    await screen.findByText(/"All" runs on 2 projects/u);
  });

  it("Preview counts the server scope, then Run streams today's routes in order into one console", async () => {
    renderTab();
    await screen.findByText(/"All" runs on 2 projects/u);
    fireEvent.click(box("full"));
    fireEvent.click(screen.getByText("Preview"));
    const preview = await screen.findByTestId("reprocess-preview");
    expect(within(preview).getAllByText(/^2 — every non-demo project of your own company, any status$/u).length).toBe(2);

    fireEvent.click(screen.getByText("Run 2 stages"));
    await waitFor(() => expect(screen.getByText("All stages complete.")).toBeTruthy());
    expect(posts("/api/admin/reprocess").map(([u]) => u)).toEqual(["/api/admin/reprocess?scope=full", "/api/admin/reprocess?scope=intelligence"]);
    // "All" = no body (the server's own predicate), not an empty projectIds list.
    expect(posts("/api/admin/reprocess").every(([, i]) => i?.body === undefined)).toBe(true);
    const console = screen.getByTestId("reprocess-console");
    expect(within(console).getByText("--- Stage 1/2: CSI + text annotations ---")).toBeTruthy();
    expect(within(console).getByText("--- Stage 2/2: Intelligence + project analysis ---")).toBeTruthy();
    expect(within(console).getAllByText("Done! 3 pages updated, 0 skipped.").length).toBe(2);
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(window.confirm).mock.calls[0][0])).toMatch(/^Run CSI \+ text annotations → Intelligence \+ project analysis on 2 projects — every non-demo project of Acme/u);
  });

  it("Select… sends explicit ids and drops demo and other-company projects (root)", async () => {
    renderTab({ isRootAdmin: true });
    await screen.findByText(/"All" runs on 2 projects/u);
    fireEvent.click(screen.getByText("Select…"));
    expect(screen.queryByText("Demo")).toBeNull();
    expect(screen.getByText(/other company: skipped by the server/u)).toBeTruthy();
    fireEvent.click(screen.getByText("Select all"));
    expect(screen.getByText("2 selected")).toBeTruthy();
    fireEvent.click(box("intelligence"));
    fireEvent.click(screen.getByText("Preview"));
    await screen.findByTestId("reprocess-preview");
    fireEvent.click(screen.getByText("Run 1 stage"));
    await waitFor(() => expect(screen.getByText("All stages complete.")).toBeTruthy());
    expect(bodyOf(posts("/api/admin/reprocess")[0])).toEqual({ projectIds: ["own-done", "own-err"] });
  });

  it("classifier debug and the Debug toggle add debug=1 / trace=1 to the intelligence request only", async () => {
    renderTab();
    await screen.findByText(/"All" runs on 2 projects/u);
    fireEvent.click(box("full"));
    fireEvent.click(screen.getByLabelText(/classifier debug/u));
    fireEvent.click(screen.getByLabelText(/Reprocess debug output/u));
    fireEvent.click(screen.getByText("Preview"));
    await screen.findByTestId("reprocess-preview");
    fireEvent.click(screen.getByText("Run 2 stages"));
    await waitFor(() => expect(screen.getByText("All stages complete.")).toBeTruthy());
    expect(posts("/api/admin/reprocess").map(([u]) => u)).toEqual([
      "/api/admin/reprocess?scope=full&trace=1",
      "/api/admin/reprocess?scope=intelligence&debug=1&trace=1",
    ]);
  });

  it("root: a deletion stage needs the dry-run preview and the typed phrase; the cleanup call is pinned to the own company", async () => {
    renderTab({ isRootAdmin: true });
    await screen.findByText(/"All" runs on 2 projects/u);
    fireEvent.click(box("purge-yolo"));
    expect(planOrder()).toEqual(["1. Delete YOLO annotations", "2. CSI + text annotations (auto)", "3. Intelligence + project analysis (auto)"]);
    fireEvent.click(screen.getByLabelText(/also clear page-level CSI codes/u));
    fireEvent.click(screen.getByText("Preview"));
    const preview = await screen.findByTestId("reprocess-preview");
    expect(posts("/api/admin/annotation-cleanup").length).toBe(1);
    expect(posts("/api/admin/annotation-cleanup")[0][0]).toBe("/api/admin/annotation-cleanup?companyId=3");
    expect(bodyOf(posts("/api/admin/annotation-cleanup")[0])).toEqual({ mode: "delete", all: true, sources: ["yolo"], clearPageCsi: true, dryRun: true });
    expect(within(preview).getByText("1 project(s) · 12 annotation(s)")).toBeTruthy();

    const run = screen.getByText("Run 3 stages") as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("confirm phrase"), { target: { value: "DELETE" } });
    expect(run.disabled).toBe(false);
    fireEvent.click(run);
    await waitFor(() => expect(screen.getByText("All stages complete.")).toBeTruthy());
    expect(bodyOf(posts("/api/admin/annotation-cleanup")[1])).toEqual({ mode: "delete", all: true, sources: ["yolo"], clearPageCsi: true, dryRun: false, confirm: "DELETE" });
    expect(posts("/api/admin/reprocess").map(([u]) => u)).toEqual(["/api/admin/reprocess?scope=full", "/api/admin/reprocess?scope=intelligence"]);
    expect(window.confirm).not.toHaveBeenCalled();
    expect(screen.getByText("Done! 12 annotation(s) deleted across 1 project(s).")).toBeTruthy();
  });

  it("non-root cannot tick root-only stages; placeholders and Re-OCR are disabled; the company picker is root-only and disabled; handoffs open their tab", async () => {
    const { onOpenTab } = renderTab();
    expect(box("purge-yolo").disabled).toBe(true);
    expect(box("dedupe").disabled).toBe(true);
    expect(box("evidence").disabled).toBe(true);
    expect(box("tiles").disabled).toBe(true);
    expect(box("re-ocr").disabled).toBe(true);
    expect(within(stage("evidence")).getByText("coming soon")).toBeTruthy();
    expect(within(stage("re-ocr")).getByText("not available")).toBeTruthy();
    expect(screen.queryByText(/coming in phase 2 — own company only/u)).toBeNull();
    expect((screen.getByLabelText(/only projects where output is missing/u) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(within(stage("yolo-load")).getByText(/Run in AI Models/u));
    expect(onOpenTab).toHaveBeenCalledWith("ai-models");
    cleanup();

    renderTab({ isRootAdmin: true });
    expect(box("purge-yolo").disabled).toBe(false);
    const company = await screen.findByDisplayValue("Acme");
    expect((company as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByText(/coming in phase 2 — own company only/u)).toBeTruthy();
  });
});
