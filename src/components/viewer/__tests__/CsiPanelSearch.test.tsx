// [csi-v2 S6] Call-site pin: CsiPanel's search box matches codes across stored formats via
// `csiCodeMatchesQuery`. Before S6, "0811" found only the unspaced code, "08 11" only the spaced
// one, and "08-11-13" found neither; reverting the filter to a raw substring test fails here.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CsiCode } from "@/types";

const CODES: CsiCode[] = [
  { code: "08 11 13", description: "Hollow Metal Doors and Frames", trade: "Openings", division: "08 00 00" },
  { code: "081116", description: "Aluminum Doors and Frames", trade: "Openings", division: "08" },
  { code: "09 29 00", description: "Gypsum Board", trade: "Finishes", division: "09 00 00" },
];

vi.mock("@/queries/usePageWindow", () => ({ useCsiCodesForPage: () => CODES }));
vi.mock("@/queries/useProjectCatalogs", () => ({ useProjectCatalogs: () => ({ allCsiCodes: [] }) }));
vi.mock("@/queries/useCsiGraph", () => ({ useCsiGraph: () => null }));

import CsiPanel from "@/components/viewer/CsiPanel";

function search(q: string): string[] {
  fireEvent.change(screen.getByPlaceholderText("Search CSI codes..."), { target: { value: q } });
  const expand = screen.queryByText("Expand All");
  if (expand) fireEvent.click(expand);
  return CODES.map((c) => c.code).filter((code) => screen.queryAllByText(code).length > 0);
}

afterEach(cleanup);

describe("CsiPanel search", () => {
  it.each([
    ["0811", ["08 11 13", "081116"]],
    ["08 11", ["08 11 13", "081116"]],
    ["08-11-13", ["08 11 13"]],
    ["081113", ["08 11 13"]],
    ["gypsum", ["09 29 00"]],
  ])("%s matches %j", (q, expected) => {
    render(<CsiPanel embedded />);
    expect(search(q)).toEqual(expected);
  });
});
