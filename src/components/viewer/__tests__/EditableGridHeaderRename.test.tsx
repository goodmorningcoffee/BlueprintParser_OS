// @vitest-environment jsdom
// [table pipeline WP-2.A] K06 on rename: renaming a column onto another column's name must not
// merge the two (rows are keyed by header). EditableGrid hands the owner a free name. Synthetic text.

import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import EditableGrid from "@/components/viewer/EditableGrid";

afterEach(cleanup);

function renameVia(headers: string[], from: string, to: string) {
  const onHeaderRename = vi.fn();
  render(
    <EditableGrid headers={headers} rows={[]} onCellChange={vi.fn()} onHeaderRename={onHeaderRename} />,
  );
  fireEvent.doubleClick(screen.getAllByText(from)[0]);
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: to } });
  fireEvent.keyDown(input, { key: "Enter" });
  return onHeaderRename;
}

describe("EditableGrid header rename (K06)", () => {
  it("a rename to another column's name is suffixed, not merged", () => {
    expect(renameVia(["ZA", "ZB", "ZC"], "ZC", "ZA")).toHaveBeenCalledWith(2, "ZA (2)");
  });

  it("a free name passes through unchanged", () => {
    expect(renameVia(["ZA", "ZB"], "ZB", "ZQ")).toHaveBeenCalledWith(1, "ZQ");
  });

  it("a blank name falls back to Column n, and renaming to the current name is a no-op", () => {
    expect(renameVia(["ZA", "ZB"], "ZB", "   ")).toHaveBeenCalledWith(1, "Column 2");
    cleanup();
    expect(renameVia(["ZA", "ZB"], "ZB", "ZB")).not.toHaveBeenCalled();
  });
});
