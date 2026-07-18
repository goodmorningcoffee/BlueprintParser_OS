// @vitest-environment node
//
// [refactor jul18 P3.2] Direct contract for the registered symbolSearch controller. Controller
// identity is symbolSearch while activation identity is symbolTemplate. The retained starter owns
// authority and its boolean is ignored: accepted and rejected attempts are both terminal claims.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MouseEvent as ReactMouseEvent } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  claimToolTailAuthority,
  consumeToolTailAuthority,
  ownsToolTailAuthority,
} from "@/lib/parse-tool-authority";
import type { ToolStoreState } from "@/stores/toolStore";
import { TOOL_STORE_CAPABILITIES } from "../tools/capabilities";
import { dispatchToolMouseDown, TOOLS } from "../tools/registry";
import { symbolSearchController } from "../tools/symbolSearch";
import type { ToolContext, ToolPressSnapshot } from "../tools/types";

function toolState(
  activeTool: unknown,
  mode: ToolStoreState["mode"] = "move",
): Readonly<ToolStoreState> {
  return { activeTool, mode } as unknown as Readonly<ToolStoreState>;
}

function contextFor(options: {
  activeTool?: unknown;
  mode?: ToolStoreState["mode"];
  startResult?: boolean;
} = {}) {
  const position = { x: 73, y: 41 };
  const press: ToolPressSnapshot = {
    toolAtDown: toolState(
      options.activeTool ?? { kind: "symbolTemplate" },
      options.mode ?? "move",
    ),
    position,
    publicId: "symbol-search-controller",
    pageNumber: 2,
  };
  const deferredDrawing = {
    start: vi.fn((_position: { x: number; y: number }) =>
      options.startResult ?? true),
  };
  const context: ToolContext = {
    press,
    page: { publicId: press.publicId, number: 2, width: 200, height: 100 },
    stores: TOOL_STORE_CAPABILITIES,
    canAdoptProjectLifecycle: () => true,
    deferredDrawing,
  };
  return { context, deferredDrawing, position };
}

function eventWith(
  options: {
    button?: number;
    stopPropagation?: ReturnType<typeof vi.fn>;
    preventDefault?: ReturnType<typeof vi.fn>;
  } = {},
) {
  return {
    button: options.button ?? 0,
    stopPropagation: options.stopPropagation ?? vi.fn(),
    preventDefault: options.preventDefault ?? vi.fn(),
  } as unknown as ReactMouseEvent & {
    button: number;
    stopPropagation: ReturnType<typeof vi.fn>;
    preventDefault: ReturnType<typeof vi.fn>;
  };
}

describe("symbolSearchController identity and eligibility", () => {
  it("is the frozen symbolSearch identity with kind-only symbolTemplate eligibility", () => {
    expect(symbolSearchController.kind).toBe("symbolSearch");
    expect(Object.isFrozen(symbolSearchController)).toBe(true);
    const symbolA = { kind: "symbolTemplate" };
    const symbolB = { kind: "symbolTemplate" };
    expect(symbolB).not.toBe(symbolA);
    expect(symbolB).toEqual(symbolA);

    for (const mode of ["move", "pointer", "markup"] as const) {
      for (const activation of [symbolA, symbolB]) {
        const state = toolState(activation, mode);
        const press = { ...contextFor().context.press, toolAtDown: state };
        expect(symbolSearchController.matches(press)).toBe(true);
        expect(symbolSearchController.wantsEvents(state)).toBe(true);
      }
    }
  });

  it("rejects controller-name bait, other activations, and null", () => {
    for (const activeTool of [
      { kind: "symbolSearch" },
      { kind: "parseRect", flow: "keynote" },
      { kind: "tagAdd", tagId: "tag" },
      { kind: "calibration" },
      null,
    ]) {
      const state = toolState(activeTool);
      const press = { ...contextFor().context.press, toolAtDown: state };
      expect(symbolSearchController.matches(press)).toBe(false);
      expect(symbolSearchController.wantsEvents(state)).toBe(false);
    }
  });
});

describe("symbolSearchController exact terminal claim", () => {
  it("fails before event effects when deferredDrawing is missing", () => {
    const { context } = contextFor();
    const event = eventWith();
    expect(() => symbolSearchController.onMouseDown(
      event,
      { ...context, deferredDrawing: undefined },
    )).toThrow("symbolSearch controller requires the deferredDrawing capability");
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it.each([
    { startResult: true, button: 0 },
    { startResult: false, button: 2 },
  ])(
    "stops then starts once and claims when start=$startResult/button=$button",
    ({ startResult, button }) => {
      const token = claimToolTailAuthority({});
      const journal: string[] = [];
      const { context, deferredDrawing, position } = contextFor({ startResult });
      deferredDrawing.start.mockImplementation((received) => {
        journal.push(`start:same=${received === position}:owns=${ownsToolTailAuthority(token)}`);
        return startResult;
      });
      const event = eventWith({
        button,
        stopPropagation: vi.fn(() =>
          journal.push(`stop:owns=${ownsToolTailAuthority(token)}`)),
      });

      try {
        expect(symbolSearchController.onMouseDown(event, context)).toBe(true);
        expect(journal).toEqual([
          "stop:owns=true",
          "start:same=true:owns=true",
        ]);
        expect(event.stopPropagation).toHaveBeenCalledTimes(1);
        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(deferredDrawing.start).toHaveBeenCalledTimes(1);
        expect(deferredDrawing.start.mock.calls[0]).toEqual([position]);
        expect(ownsToolTailAuthority(token)).toBe(true);
      } finally {
        consumeToolTailAuthority(token, () => {});
      }
    },
  );

  it("contains no controller-owned authority, store, button, or default-prevention path", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/viewer/tools/symbolSearch.ts"),
      "utf8",
    );
    expect(source).not.toContain("invalidateToolTailAuthority");
    expect(source).not.toContain("stores.");
    expect(source).not.toContain("getState(");
    expect(source).not.toContain("preventDefault");
    expect(source).not.toContain("event.button");
    expect(source).not.toContain("context.press.position, false");
  });
});

describe("symbolSearch real registry integration", () => {
  it("occupies the exact slot and claims a rejected start through one lazy context", () => {
    const index = TOOLS.indexOf(symbolSearchController);
    expect(index).toBeGreaterThan(0);
    expect(TOOLS[index]).toBe(symbolSearchController);
    expect(TOOLS[index - 1].kind).toBe("keynotePick");
    expect(TOOLS[index + 1].kind).toBe("parseRect");

    const { context, deferredDrawing, position } = contextFor({ startResult: false });
    const createContext = vi.fn(() => context);
    const event = eventWith();

    expect(dispatchToolMouseDown(
      TOOLS,
      event,
      context.press,
      createContext,
    )).toBe(true);
    expect(createContext).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(deferredDrawing.start.mock.calls).toEqual([[position]]);
  });
});
