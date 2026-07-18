// @vitest-environment node
//
// [refactor jul18 P3.2] Direct contract for parseRectController, landed with registration. The
// boolean returned by deferredDrawing.start is deliberately ignored: the legacy branch returned
// terminally after every attempt, so both accepted and rejected leases are true registry claims.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MouseEvent as ReactMouseEvent } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ToolStoreState } from "@/stores/toolStore";
import { TOOL_STORE_CAPABILITIES } from "../tools/capabilities";
import { parseRectController } from "../tools/parseRect";
import type { ToolContext, ToolPressSnapshot } from "../tools/types";

function toolState(activeTool: unknown): Readonly<ToolStoreState> {
  return { activeTool, mode: "move" } as unknown as Readonly<ToolStoreState>;
}

function contextFor(
  flow: "table" | "keynote" | "notes" | "spec" = "keynote",
  startResult = true,
) {
  const position = { x: 73, y: 41 };
  const press: ToolPressSnapshot = {
    toolAtDown: toolState({ kind: "parseRect", flow }),
    position,
    publicId: "parse-rect-controller",
    pageNumber: 2,
  };
  const deferredDrawing = {
    start: vi.fn((_position: { x: number; y: number }) => startResult),
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

function eventWith(stopPropagation = vi.fn()) {
  return { stopPropagation } as unknown as ReactMouseEvent & {
    stopPropagation: ReturnType<typeof vi.fn>;
  };
}

describe("parseRectController exact terminal claim", () => {
  it("matches and wants events for every parseRect flow, and no other activation", () => {
    for (const flow of ["table", "keynote", "notes", "spec"] as const) {
      const { context } = contextFor(flow);
      expect(parseRectController.matches(context.press)).toBe(true);
      expect(parseRectController.wantsEvents(context.press.toolAtDown)).toBe(true);
    }
    for (const activeTool of [{ kind: "calibration" }, { kind: "tagPick" }, null]) {
      const press = { ...contextFor().context.press, toolAtDown: toolState(activeTool) };
      expect(parseRectController.matches(press)).toBe(false);
      expect(parseRectController.wantsEvents(press.toolAtDown)).toBe(false);
    }
  });

  it("fails loudly when the deferredDrawing capability is missing", () => {
    const { context } = contextFor();
    expect(() => parseRectController.onMouseDown(
      eventWith(),
      { ...context, deferredDrawing: undefined },
    )).toThrow("parseRect controller requires the deferredDrawing capability");
  });

  it.each([true, false])("stops, starts with the same position, and returns true when start returns %s", (startResult) => {
    const journal: string[] = [];
    const { context, deferredDrawing, position } = contextFor("keynote", startResult);
    deferredDrawing.start.mockImplementation((received) => {
      journal.push(`start:${received === position}`);
      return startResult;
    });
    const event = eventWith(vi.fn(() => journal.push("stop")));

    expect(parseRectController.onMouseDown(event, context)).toBe(true);

    expect(journal).toEqual(["stop", "start:true"]);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(deferredDrawing.start).toHaveBeenCalledExactlyOnceWith(position);
  });

  it("has no explicit tail-authority invalidator or store reader", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/viewer/tools/parseRect.ts"),
      "utf8",
    );
    expect(source).not.toContain("invalidateToolTailAuthority");
    expect(source).not.toContain("stores.");
    expect(source).not.toContain("getState(");
  });
});
