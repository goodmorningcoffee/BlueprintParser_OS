// @vitest-environment jsdom
// [classifier-builder 2026-10-24] Proposed tables list + canvas focus: grouping (discipline → kind), scope and
// verdict filters, hover outline, click → page + focus (green box, annotation canvas dimmed to .25), Esc /
// Clear / page change end focus, verdict actions post the right body, demo hides verdict buttons, and
// "Parse this table" prefills the Auto Parse region.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const commands = vi.hoisted(() => ({
  navigateViewerPage: vi.fn(),
  transitionTableParseTab: vi.fn(),
  acceptTableParseRegion: vi.fn(),
}));
const persistence = vi.hoisted(() => ({ persistFetch: vi.fn() }));
const project = vi.hoisted(() => ({ value: { publicId: "pub-1", isDemo: false, projectId: 1 } }));

vi.mock("@/stores/viewerCommands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/viewerCommands")>();
  return { ...actual, ...commands };
});
vi.mock("@/lib/client-persist", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-persist")>();
  return { ...actual, persistFetch: persistence.persistFetch };
});
vi.mock("@/stores/sessionStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/sessionStore")>();
  return { ...actual, useProject: () => project.value };
});

import ProposedTablesSection from "@/components/viewer/ProposedTablesSection";
import ProposalFocusLayer, { ProposalDimGroup } from "@/components/viewer/ProposalFocusLayer";
import { buildProposalGroups } from "@/components/viewer/proposals/proposalList";
import { centerDelta, fitScaleForBox } from "@/components/viewer/proposals/proposalViewport";
import { queryKeys } from "@/queries/queryKeys";
import { seedProposalsFromBootstrap } from "@/queries/useProposals";
import { useProposalFocusStore } from "@/stores/proposalFocusStore";
import { useSessionStore } from "@/stores/sessionStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import type { ProjectProposalSummary, ProposalSummaryItem } from "@/lib/classifier-engine/types";

const item = (over: Partial<ProposalSummaryItem> & { id: string }): ProposalSummaryItem => ({
  recipeId: "schedule-kind",
  pageNumber: 1,
  bbox: [0.1, 0.2, 0.5, 0.6],
  target: "schedule",
  classId: "door",
  className: "Door schedule",
  group: "arch",
  displayName: "Door schedule",
  p: 0.9,
  nameP: 0.8,
  ...over,
});

const ITEMS: ProposalSummaryItem[] = [
  item({ id: "a", pageNumber: 1 }),
  item({ id: "b", pageNumber: 1, classId: "panel", className: "Panel schedule", group: "elec", displayName: "Panel schedule", p: 0.7 }),
  item({ id: "c", pageNumber: 2, classId: "window", className: "Window / glazing schedule", displayName: "Window / glazing schedule" }),
  item({ id: "d", pageNumber: 1, classId: null, className: "Other schedule", group: null, displayName: "Louver schedule" }),
  item({ id: "e", pageNumber: 1, verdict: "reject" }),
  item({ id: "f", pageNumber: 2, verdict: "rename" }),
];

const SUMMARY: ProjectProposalSummary = {
  engineVersion: "clf/0.1",
  generatedAt: "2026-10-24T00:00:00.000Z",
  total: ITEMS.length,
  truncated: false,
  items: ITEMS,
};

let qc: QueryClient;

function mount(ui: React.ReactNode) {
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  qc = new QueryClient();
  project.value = { publicId: "pub-1", isDemo: false, projectId: 1 };
  useSessionStore.setState({ publicId: "pub-1" } as never);
  useViewerCoreStore.setState({ pageNumber: 1, scale: 1 } as never);
  useProposalFocusStore.setState({ hover: null, focus: null, fitRequest: 0 });
  seedProposalsFromBootstrap(qc, "pub-1", { proposals: SUMMARY });
  for (const fn of Object.values(commands)) fn.mockReset();
  persistence.persistFetch.mockReset();
});

afterEach(cleanup);

describe("buildProposalGroups", () => {
  it("groups by discipline order, then kind; scope and verdict filters apply", () => {
    const page = buildProposalGroups(ITEMS, { scope: "page", pageNumber: 1, filter: "unreviewed" });
    expect(page.map((g) => g.label)).toEqual(["Architectural", "Electrical", "Other"]);
    expect(page[0].kinds.map((k) => k.label)).toEqual(["Door schedule"]);
    expect(page[2].kinds[0]).toMatchObject({ key: "other-schedule", label: "Other schedule" });
    expect(page[2].kinds[0].items[0].displayName).toBe("Louver schedule");
    const all = buildProposalGroups(ITEMS, { scope: "all", pageNumber: 1, filter: "unreviewed" });
    expect(all[0].kinds.map((k) => k.label)).toEqual(["Door schedule", "Window / glazing schedule"]);
    expect(buildProposalGroups(ITEMS, { scope: "all", pageNumber: 1, filter: "rejected" })[0].count).toBe(1);
    expect(buildProposalGroups(ITEMS, { scope: "all", pageNumber: 1, filter: "accepted" })[0].kinds[0].items[0].id).toBe("f");
    const kept = buildProposalGroups(ITEMS, { scope: "page", pageNumber: 1, filter: "unreviewed", keepId: "e" });
    expect(kept[0].kinds[0].items.map((x) => x.id)).toEqual(["a", "e"]);
  });

  it("viewport math: fit scale clamps and centres", () => {
    expect(fitScaleForBox({ width: 1000, height: 1000 }, [0.4, 0.4, 0.5, 0.5], { width: 500, height: 500 }, 1, 0)).toBeCloseTo(5, 9);
    expect(fitScaleForBox({ width: 1000, height: 1000 }, [0.4, 0.4, 0.401, 0.401], { width: 500, height: 500 }, 1)).toBe(10);
    expect(fitScaleForBox({ width: 1000, height: 1000 }, [0, 0, 0, 0], { width: 500, height: 500 }, 1.5)).toBe(1.5);
    expect(centerDelta({ left: 0, top: 0, width: 1000, height: 1000 }, { left: 0, top: 0, width: 200, height: 200 }, [0.4, 0.4, 0.6, 0.6]))
      .toEqual({ dx: 400, dy: 400 });
  });
});

describe("ProposedTablesSection", () => {
  it("renders nothing without a summary", () => {
    seedProposalsFromBootstrap(qc, "pub-1", {});
    const { container } = mount(<ProposedTablesSection />);
    expect(container.innerHTML).toBe("");
  });

  it("lists this page's unreviewed proposals as buttons with page and score; toggles scope and filter", () => {
    mount(<ProposedTablesSection />);
    expect(screen.getByText("Proposed tables (6)")).toBeInTheDocument();
    const rows = () => screen.getAllByRole("button").filter((b) => b.hasAttribute("data-proposal-row"));
    expect(rows().map((r) => r.getAttribute("data-proposal-row"))).toEqual(["a", "b", "d"]);
    expect(within(rows()[0]).getByText("p.1")).toBeInTheDocument();
    expect(within(rows()[0]).getByText("90%")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "All pages" }));
    expect(rows().map((r) => r.getAttribute("data-proposal-row"))).toEqual(["a", "c", "b", "d"]);
    fireEvent.click(screen.getByRole("button", { name: "Accepted (1)" }));
    expect(rows().map((r) => r.getAttribute("data-proposal-row"))).toEqual(["f"]);
    expect(screen.getByText("renamed")).toBeInTheDocument();
  });

  it("hover sets the soft outline on the current page only", () => {
    mount(<><ProposedTablesSection /><div style={{ position: "relative" }}><ProposalFocusLayer pageNumber={1} /></div></>);
    const row = screen.getByText("Panel schedule", { selector: "span" }).closest("button")!;
    fireEvent.mouseEnter(row);
    expect(document.querySelector('[data-proposal-hover="b"]')).not.toBeNull();
    fireEvent.mouseLeave(row);
    expect(document.querySelector("[data-proposal-hover]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "All pages" }));
    fireEvent.mouseEnter(screen.getByText("Window / glazing schedule", { selector: "span" }).closest("button")!);
    expect(useProposalFocusStore.getState().hover?.proposalId).toBe("c");
    expect(document.querySelector("[data-proposal-hover]")).toBeNull();
  });

  it("click focuses: navigates when off-page, green box, dimmed annotation group; Esc and Clear end it", () => {
    mount(
      <>
        <ProposedTablesSection />
        <div style={{ position: "relative" }}>
          <ProposalDimGroup pageNumber={1}><canvas data-testid="annotations" /></ProposalDimGroup>
          <ProposalFocusLayer pageNumber={1} />
        </div>
      </>,
    );
    const dim = () => document.querySelector("[data-proposal-dim]") as HTMLElement;
    expect(dim().style.opacity).toBe("");
    fireEvent.click(screen.getByText("Door schedule", { selector: "span" }).closest("button")!);
    expect(commands.navigateViewerPage).not.toHaveBeenCalled();
    const box = document.querySelector('[data-proposal-focus="a"]') as HTMLElement;
    expect(box).not.toBeNull();
    expect(box.style.border).toContain("4px solid");
    expect(box.style.left).toBe("10%");
    expect(dim().style.opacity).toBe("0.25");
    expect(screen.getByText("Door schedule", { selector: "span" }).closest("button")).toHaveAttribute("aria-pressed", "true");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(useProposalFocusStore.getState().focus).toBeNull();
    expect(dim().style.opacity).toBe("");

    fireEvent.click(screen.getByText("Door schedule", { selector: "span" }).closest("button")!);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(useProposalFocusStore.getState().focus).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "All pages" }));
    fireEvent.click(screen.getByText("Window / glazing schedule", { selector: "span" }).closest("button")!);
    expect(commands.navigateViewerPage).toHaveBeenCalledWith(2);
  });

  it("focus clears when the viewer leaves the focused page", () => {
    mount(<><ProposedTablesSection /><ProposalFocusLayer pageNumber={1} /></>);
    fireEvent.click(screen.getByText("Door schedule", { selector: "span" }).closest("button")!);
    expect(useProposalFocusStore.getState().focus?.proposalId).toBe("a");
    cleanup();
    mount(<ProposalFocusLayer pageNumber={3} />);
    expect(useProposalFocusStore.getState().focus).toBeNull();
  });

  it("verdict actions: Not a table posts reject, Rename posts the kind, Undo deletes; cache follows", async () => {
    persistence.persistFetch.mockResolvedValue({ verdict: {} });
    mount(<ProposedTablesSection />);
    fireEvent.click(screen.getByText("Door schedule", { selector: "span" }).closest("button")!);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Not a table" })); });
    expect(persistence.persistFetch).toHaveBeenLastCalledWith(
      "/api/projects/pub-1/proposals/verdict",
      { pageNumber: 1, proposalId: "a", verdict: "reject" },
      "POST",
    );
    const cached = () => qc.getQueryData<ProjectProposalSummary>(queryKeys.proposals.all("pub-1"))!.items.find((x) => x.id === "a");
    expect(cached()?.verdict).toBe("reject");
    // still listed (focused) under the unreviewed filter, so Undo is reachable
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Undo" })); });
    expect(persistence.persistFetch).toHaveBeenLastCalledWith(
      "/api/projects/pub-1/proposals/verdict", { pageNumber: 1, proposalId: "a" }, "DELETE",
    );
    expect(cached()?.verdict).toBeUndefined();

    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("Schedule kind"), { target: { value: "other-schedule" } });
    fireEvent.change(screen.getByLabelText("Schedule name"), { target: { value: "Louver schedule" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save kind" })); });
    expect(persistence.persistFetch).toHaveBeenLastCalledWith(
      "/api/projects/pub-1/proposals/verdict",
      { pageNumber: 1, proposalId: "a", verdict: "rename", classId: "other-schedule", name: "Louver schedule" },
      "POST",
    );
    expect(cached()?.verdict).toBe("rename");
  });

  it("a failed verdict shows the server message and leaves the cache alone", async () => {
    persistence.persistFetch.mockRejectedValue(new Error("Proposal not found"));
    mount(<ProposedTablesSection />);
    fireEvent.click(screen.getByText("Door schedule", { selector: "span" }).closest("button")!);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Not a table" })); });
    expect(screen.getByRole("alert")).toHaveTextContent("Proposal not found");
    expect(qc.getQueryData<ProjectProposalSummary>(queryKeys.proposals.all("pub-1"))!.items[0].verdict).toBeUndefined();
  });

  it("Parse this table prefills the Auto Parse region and records accept", async () => {
    persistence.persistFetch.mockResolvedValue({ verdict: {} });
    mount(<ProposedTablesSection />);
    fireEvent.click(screen.getByText("Door schedule", { selector: "span" }).closest("button")!);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Parse this table" })); });
    expect(commands.transitionTableParseTab).toHaveBeenCalledWith("auto");
    expect(commands.acceptTableParseRegion).toHaveBeenCalledWith([0.1, 0.2, 0.5, 0.6]);
    expect(persistence.persistFetch).toHaveBeenCalledWith(
      "/api/projects/pub-1/proposals/verdict", { pageNumber: 1, proposalId: "a", verdict: "accept" }, "POST",
    );
  });

  it("demo: proposals are listed read-only — no verdict buttons, parse prefill without a verdict", () => {
    project.value = { publicId: "pub-1", isDemo: true, projectId: 1 };
    mount(<ProposedTablesSection />);
    fireEvent.click(screen.getByText("Door schedule", { selector: "span" }).closest("button")!);
    expect(screen.queryByRole("button", { name: "Not a table" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Parse this table" }));
    expect(commands.acceptTableParseRegion).toHaveBeenCalled();
    expect(persistence.persistFetch).not.toHaveBeenCalled();
  });
});
