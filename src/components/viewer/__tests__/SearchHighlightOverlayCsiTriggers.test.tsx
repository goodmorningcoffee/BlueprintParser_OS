// [csi-v2 S6] Call-site pin: the CSI-code and trade highlights draw one box per matched word when
// a stored trigger carries `bboxes`, and the single union `bbox` otherwise (every pre-v2 trigger).
// Reverting either call site to `{text, bbox}` per trigger draws one box per trigger and fails here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { CsiCode } from "@/types";
import { useUiStore } from "@/stores/uiStore";

const CODES = [
  {
    code: "08 11 13", description: "Hollow Metal Doors and Frames", trade: "Openings", division: "08 00 00",
    triggers: [{ text: "hollow metal", bbox: [0.1, 0.1, 0.2, 0.02], bboxes: [[0.1, 0.1, 0.09, 0.02], [0.2, 0.1, 0.1, 0.02]], tier: 1 }],
  },
  {
    code: "08 14 16", description: "Flush Wood Doors", trade: "Openings", division: "08 00 00",
    triggers: [{ text: "wood doors", bbox: [0.5, 0.5, 0.1, 0.02], tier: 2 }],
  },
] as CsiCode[];

vi.mock("@/queries/usePageWindow", () => ({ useCsiCodesForPage: () => CODES }));
vi.mock("@/queries/useTextract", () => ({ useTextractForPage: () => undefined }));

import SearchHighlightOverlay from "@/components/viewer/SearchHighlightOverlay";

let rects: number[][];

beforeEach(() => {
  rects = [];
  vi.stubGlobal("devicePixelRatio", 1);
  const ctx = {
    setTransform() {}, clearRect() {}, strokeRect() {},
    fillRect(x: number, y: number, w: number, h: number) { rects.push([x, y, w, h]); },
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    (() => ctx) as unknown as typeof HTMLCanvasElement.prototype.getContext,
  );
  useUiStore.setState({ searchQuery: "", searchMatches: {}, activeCsiFilter: null, activeTradeFilter: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function drawn(state: Partial<ReturnType<typeof useUiStore.getState>>): number[][] {
  act(() => { useUiStore.setState(state); });
  render(<SearchHighlightOverlay width={1000} height={1000} cssScale={1} />);
  return rects.map((r) => r.map((n) => Math.round(n)));
}

describe("SearchHighlightOverlay CSI trigger boxes", () => {
  it("code filter: one box per word of a v2 trigger", () => {
    expect(drawn({ activeCsiFilter: "08 11 13" })).toEqual([[100, 100, 90, 20], [200, 100, 100, 20]]);
  });

  it("code filter: a pre-v2 trigger (no bboxes) draws its single bbox", () => {
    expect(drawn({ activeCsiFilter: "08 14 16" })).toEqual([[500, 500, 100, 20]]);
  });

  it("trade filter: per-word boxes for v2 triggers, single bbox for the rest", () => {
    expect(drawn({ activeTradeFilter: "Openings" })).toEqual([
      [100, 100, 90, 20], [200, 100, 100, 20], [500, 500, 100, 20],
    ]);
  });
});
