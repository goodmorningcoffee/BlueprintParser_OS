// @vitest-environment jsdom
// [cross-set F3 2026-10-24] "Same sheet in other sets": nothing renders without a pass; rows name the
// other set and link to ITS viewer at the target page (cross-project navigation is a link, not the
// in-project page command); twin / revision badges and the copy_of footer.
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const state: { value: ReturnType<typeof import("@/queries/useCrossSetLinks").usePageCrossSetLinks> } = {
  value: { built: false, links: [], projects: [] },
};
vi.mock("@/queries/useCrossSetLinks", () => ({ usePageCrossSetLinks: () => state.value }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: any) => <a href={href} {...rest}>{children}</a> }));

import CrossSetLinksSection, { crossSetViewerHref } from "@/components/viewer/CrossSetLinksSection";

describe("CrossSetLinksSection", () => {
  it("renders nothing while the project has no cross-set pass", () => {
    const { container } = render(<CrossSetLinksSection pageNumber={1} expanded onToggle={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("lists the other sets as links to their viewer at the target page, with kind + direction", () => {
    state.value = {
      built: true,
      links: [
        { kind: "twin_of", project: { publicId: "pub-old", name: "Set A" }, page: 7, sheet: "A-101", confidence: 1, direction: "older" },
        { kind: "revision_of", project: { publicId: "pub-new", name: "Set B" }, page: 2, sheet: "A101", confidence: 0.734, direction: "newer", titleMatch: true },
      ],
      projects: [{ publicId: "pub-old", name: "Set A", kind: "copy_of", role: "copy", shared: 10, pages: 10 }],
    };
    const onToggle = vi.fn();
    render(<CrossSetLinksSection pageNumber={4} expanded onToggle={onToggle} />);
    expect(screen.getByText("Same sheet in other sets (2)")).toBeTruthy();
    const a = screen.getAllByText(/^Set A/)[0].closest("a")!; // the row link (the copy_of footer names Set A again)
    expect(a.getAttribute("href")).toBe("/project/pub-old?page=7");
    expect(screen.getByText(/^Set B/).closest("a")!.getAttribute("href")).toBe("/project/pub-new?page=2");
    expect(screen.getByText("identical")).toBeTruthy();
    expect(screen.getByText("revision 73%")).toBeTruthy();
    expect(screen.getByText("older set")).toBeTruthy();
    expect(screen.getByText("newer set")).toBeTruthy();
    expect(screen.getByText(/page-for-page copy of/)).toBeTruthy();
    fireEvent.click(screen.getByText("Same sheet in other sets (2)"));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(crossSetViewerHref("a b", 3)).toBe("/project/a%20b?page=3");
  });

  it("collapsed: only the header; expanded with no links: the empty line", () => {
    state.value = { built: true, links: [], projects: [] };
    const { rerender } = render(<CrossSetLinksSection pageNumber={1} expanded={false} onToggle={() => {}} />);
    expect(screen.getByText("Same sheet in other sets (0)")).toBeTruthy();
    expect(screen.queryByText(/No other set/)).toBeNull();
    rerender(<CrossSetLinksSection pageNumber={1} expanded onToggle={() => {}} />);
    expect(screen.getByText(/No other set of your company carries this sheet/)).toBeTruthy();
  });
});
