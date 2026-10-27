// @vitest-environment node
// [table-pipeline WP-2.B] K07: the OpenCV-lines method fills each ruled cell with line-aware text
// (`assembleText`), not an x-only sort. The raster and the line detector are mocked; the cell fill is
// the code under test. Pseudo-words only (rule 12).
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ rasterizePage: vi.fn(), detectTableLines: vi.fn() }));
vi.mock("@/lib/pdf-rasterize", () => ({ rasterizePage: h.rasterizePage }));
vi.mock("@/lib/table-lines", () => ({ detectTableLines: h.detectTableLines }));

import { methodOpenCvLines } from "@/lib/services/table-parse";
import type { TextractWord } from "@/types";

const W = (text: string, x: number, y: number, w: number, hgt = 0.01): TextractWord =>
  ({ text, confidence: 99, bbox: [x, y, w, hgt] }) as TextractWord;

beforeEach(() => {
  h.rasterizePage.mockResolvedValue(Buffer.from("png"));
  // ruled grid: rows at y .1/.14/.18, columns at x .1/.25/.4 (page-normalised, as the method reads them)
  h.detectTableLines.mockResolvedValue({
    rows: [{ y: 0.1, height: 0 }, { y: 0.14, height: 0 }, { y: 0.18, height: 0 }],
    cols: [{ x: 0.1, width: 0 }, { x: 0.25, width: 0 }, { x: 0.4, width: 0 }],
    rowCount: 3,
    colCount: 3,
    confidence: 0.9,
  });
});

describe("methodOpenCvLines cell text (K07)", () => {
  it("reads a two-line cell line by line and keeps single-line cells as they were", async () => {
    const words = [
      // row 0, col 0: two lines starting at the same x (x-only read "ALPHA GAMMA BETA DELTA")
      W("ALPHA", 0.11, 0.105, 0.05), W("BETA", 0.17, 0.105, 0.04),
      W("GAMMA", 0.11, 0.12, 0.05), W("DELTA", 0.17, 0.12, 0.04),
      W("Q1", 0.26, 0.11, 0.02),
      W("RR", 0.11, 0.15, 0.02), W("SS", 0.14, 0.15, 0.02), W("Q2", 0.26, 0.15, 0.02),
    ];
    const r = await methodOpenCvLines(Buffer.from("pdf"), 1, [0.05, 0.05, 0.5, 0.5], words);
    expect(r.error).toBeUndefined();
    expect(r.headers).toEqual(["Column 1", "Column 2"]);
    expect(r.rows).toEqual([
      { "Column 1": "ALPHA BETA GAMMA DELTA", "Column 2": "Q1" },
      { "Column 1": "RR SS", "Column 2": "Q2" },
    ]);
  });
});
