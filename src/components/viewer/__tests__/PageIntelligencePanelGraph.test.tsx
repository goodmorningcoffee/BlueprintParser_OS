// @vitest-environment jsdom
// [graph T8 2026-10-24] The knowledge-graph sections of the Page Intelligence panel: "Refers to" /
// "Referenced by" lists navigate to the target page, unresolved rows are marked and listed in the
// project-wide QA queue, and nothing renders for a project with no graph yet.
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const setPage = vi.fn();
const graphState: { value: ReturnType<typeof import("@/queries/useProjectGraph").usePageGraphLinks> } = {
  value: { built: false, refersTo: [], referencedBy: [], unresolved: [], summary: null },
};

vi.mock("@/stores/viewerCoreStore", () => ({ useNavigation: () => ({ pageNumber: 1, numPages: 3, setPage, setNumPages: vi.fn() }) }));
vi.mock("@/stores/uiStore", () => ({ useUiStore: (sel: (s: { togglePageIntelPanel: () => void }) => unknown) => sel({ togglePageIntelPanel: vi.fn() }) }));
vi.mock("@/queries/usePageWindow", () => ({ usePageIntelligenceForPage: () => ({ classification: { discipline: "Architectural", disciplinePrefix: "A", confidence: 0.9 } }) }));
vi.mock("@/queries/useProjectGraph", () => ({ usePageGraphLinks: () => graphState.value }));

import PageIntelligencePanel from "@/components/viewer/PageIntelligencePanel";

describe("PageIntelligencePanel — knowledge graph sections", () => {
  it("renders nothing graph-related while the project has no graph", () => {
    render(<PageIntelligencePanel embedded />);
    expect(screen.queryByText(/Refers to/)).toBeNull();
    expect(screen.queryByText(/Unresolved references/)).toBeNull();
  });

  it("lists resolved references as page links, marks unresolved ones, and navigates on click", () => {
    graphState.value = {
      built: true,
      summary: null,
      refersTo: [
        { page: 2, sheet: "E-300", kind: "sheet", status: "resolved", confidence: 0.9, seen: 2, text: "SEE SHEET E-300" },
        { page: 3, sheet: "A-501", detail: "3", kind: "detail", status: "resolved", confidence: 0.8, seen: 1 },
        { page: null, sheet: "Z-9", kind: "sheet", status: "unresolved", confidence: 0.85, seen: 1 },
      ],
      referencedBy: [{ page: 3, sheet: "A-501", kind: "sheet", status: "resolved", confidence: 0.8, seen: 1 }],
      unresolved: [{ fromPage: 1, fromSheet: "A-100", sheet: "Z-9", status: "unresolved", confidence: 0.85, text: "SEE SHEET Z-9" }],
    };
    render(<PageIntelligencePanel embedded />);
    expect(screen.getByText("Refers to (3)")).toBeTruthy();
    expect(screen.getByText("Referenced by (1)")).toBeTruthy();
    expect(screen.getByText(/Unresolved references — project \(1\)/)).toBeTruthy();

    fireEvent.click(screen.getByText(/^E-300/));
    expect(setPage).toHaveBeenCalledWith(2);
    fireEvent.click(screen.getByText(/^3\/A-501/));
    expect(setPage).toHaveBeenCalledWith(3);

    // unresolved: plain text + badge, no link
    expect(screen.getByText("Z-9").tagName).toBe("SPAN");
    expect(screen.getAllByText("unresolved").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("×2")).toBeTruthy(); // seen by two extractors

    // the project-wide queue is collapsed by default; opening it lists the source page as a link
    fireEvent.click(screen.getByText(/Unresolved references — project/));
    fireEvent.click(screen.getByText(/p\.1 A-100/));
    expect(setPage).toHaveBeenCalledWith(1);
  });
});
