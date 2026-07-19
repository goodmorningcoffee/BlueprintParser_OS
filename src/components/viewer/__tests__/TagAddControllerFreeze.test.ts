// @vitest-environment node
//
// [refactor jul19 P3.2] Direct TagAdd controller contract. Eligibility is kind-only: the exact
// activation payload remains captured by the shared rectangle lease, while every admitted press
// is a terminal claim even when the retained starter rejects it.

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
import { tagAddController } from "../tools/tagAdd";
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
      options.activeTool ?? { kind: "tagAdd", tagId: "tag-a" },
      options.mode ?? "move",
    ),
    position,
    publicId: "tag-add-controller",
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

function eventWith(options: {
  button?: number;
  stopPropagation?: ReturnType<typeof vi.fn>;
  preventDefault?: ReturnType<typeof vi.fn>;
} = {}) {
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

describe("tagAddController identity and eligibility", () => {
  it("is frozen and matches every TagAdd payload in every legacy-relevant mode", () => {
    expect(tagAddController.kind).toBe("tagAdd");
    expect(Object.isFrozen(tagAddController)).toBe(true);
    const tagA = { kind: "tagAdd", tagId: "tag-a" };
    const equalTagA = { kind: "tagAdd", tagId: "tag-a" };
    const tagB = { kind: "tagAdd", tagId: "tag-b" };
    const emptyTag = { kind: "tagAdd", tagId: "" };
    expect(equalTagA).not.toBe(tagA);
    expect(equalTagA).toEqual(tagA);

    for (const mode of ["move", "pointer", "markup", "group"] as const) {
      for (const activation of [tagA, equalTagA, tagB, emptyTag]) {
        const state = toolState(activation, mode);
        const press = { ...contextFor().context.press, toolAtDown: state };
        expect(tagAddController.matches(press)).toBe(true);
        expect(tagAddController.wantsEvents(state)).toBe(true);
      }
    }
  });

  it("rejects every different activation without consulting mode or payload", () => {
    for (const activeTool of [
      { kind: "symbolTemplate" },
      { kind: "parseRect", flow: "keynote" },
      { kind: "tagPick" },
      { kind: "tagAddController", tagId: "tag-a" },
      null,
    ]) {
      const state = toolState(activeTool, "pointer");
      const press = { ...contextFor().context.press, toolAtDown: state };
      expect(tagAddController.matches(press)).toBe(false);
      expect(tagAddController.wantsEvents(state)).toBe(false);
    }
  });
});

describe("tagAddController exact terminal claim", () => {
  it("fails before event effects when deferredDrawing is missing", () => {
    const { context } = contextFor();
    const event = eventWith();

    expect(() => tagAddController.onMouseDown(
      event,
      { ...context, deferredDrawing: undefined },
    )).toThrow("tagAdd controller requires the deferredDrawing capability");
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it.each([
    { startResult: true, button: 0 },
    { startResult: true, button: 2 },
    { startResult: false, button: 0 },
    { startResult: false, button: 2 },
  ])(
    "stops then makes the same one-argument start and claims for start=$startResult/button=$button",
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
        expect(tagAddController.onMouseDown(event, context)).toBe(true);
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

  it("contains no rectangle settlement, data mutation, store, button, or authority ownership", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/viewer/tools/tagAdd.ts"),
      "utf8",
    );
    for (const forbidden of [
      "invalidateToolTailAuthority",
      "claimToolTailAuthority",
      "consumeToolTailAuthority",
      "ownsToolTailAuthority",
      "readYoloTags",
      "updateYoloTag",
      "setTagAddingMode",
      "useToolStore",
      "stores.",
      "getState(",
      "tagId",
      "instances",
      "annotationId",
      "confidence",
      "bbox",
      "onMouseUp",
      "cssScale",
      "useRef",
      "journal",
      "let ",
      "var ",
      "preventDefault",
      "event.button",
      "context.press.position, false",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});

describe("tagAdd real registry integration", () => {
  it("lazily claims between symbolSearch and parseRect even when the starter rejects", () => {
    const index = TOOLS.indexOf(tagAddController);
    expect(index).toBeGreaterThan(0);
    expect(TOOLS.slice(index - 2, index + 2).map((tool) => tool.kind)).toEqual([
      "tagPick",
      "symbolSearch",
      "tagAdd",
      "parseRect",
    ]);

    const { context, deferredDrawing, position } = contextFor({ startResult: false });
    const createContext = vi.fn(() => context);
    const event = eventWith({ button: 2 });

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
