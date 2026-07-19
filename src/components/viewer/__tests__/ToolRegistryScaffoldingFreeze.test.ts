// @vitest-environment node
// [refactor jul15 P3.1] Pure contract for the empty strangler registry.

import type { MouseEvent as ReactMouseEvent } from "react";
import { describe, expect, it, vi } from "vitest";

import { dispatchToolMouseDown, TOOLS } from "../tools/registry";
import type {
  ToolContext,
  ToolController,
  ToolControllerKind,
  ToolPressSnapshot,
} from "../tools/types";

const event = {} as ReactMouseEvent;
const press = Object.freeze({
  marker: "press",
}) as unknown as ToolPressSnapshot;
const context = Object.freeze({ marker: "context" }) as unknown as ToolContext;

function controller(
  kind: ToolControllerKind,
  matches: ToolController["matches"],
  onMouseDown: ToolController["onMouseDown"],
): ToolController {
  return Object.freeze({ kind, matches, onMouseDown, wantsEvents: () => true });
}

describe("P3.1 tool registry scaffolding", () => {
  it("keeps registry order while an eligible decline continues to the first consumer", () => {
    const trace: string[] = [];
    const miss = controller(
      "calibration",
      (candidate) => {
        expect(candidate).toBe(press);
        trace.push("calibration.matches");
        return false;
      },
      () => {
        throw new Error("ineligible handler must not run");
      },
    );
    const decline = controller(
      "keynotePick",
      () => {
        trace.push("keynotePick.matches");
        return true;
      },
      (candidateEvent, candidateContext) => {
        expect(candidateEvent).toBe(event);
        expect(candidateContext).toBe(context);
        trace.push("keynotePick.onMouseDown:false");
        return false;
      },
    );
    const consume = controller(
      "parseRect",
      () => {
        trace.push("parseRect.matches");
        return true;
      },
      (candidateEvent, candidateContext) => {
        expect(candidateEvent).toBe(event);
        expect(candidateContext).toBe(context);
        trace.push("parseRect.onMouseDown:true");
        return true;
      },
    );
    const later = controller(
      "pointerGroup",
      () => {
        trace.push("pointerGroup.matches");
        return true;
      },
      () => {
        trace.push("pointerGroup.onMouseDown");
        return true;
      },
    );
    const registry = Object.freeze([miss, decline, consume, later]);
    const identitiesBefore = [...registry];
    const createContext = vi.fn(() => context);

    expect(dispatchToolMouseDown(registry, event, press, createContext)).toBe(
      true,
    );

    expect(trace).toEqual([
      "calibration.matches",
      "keynotePick.matches",
      "keynotePick.onMouseDown:false",
      "parseRect.matches",
      "parseRect.onMouseDown:true",
    ]);
    expect(createContext).toHaveBeenCalledTimes(1);
    expect(registry).toEqual(identitiesBefore);
    registry.forEach((entry, index) =>
      expect(entry).toBe(identitiesBefore[index]),
    );
  });

  it("returns false without constructing context when no controller is eligible", () => {
    const trace: string[] = [];
    const registry = [
      controller(
        "split",
        () => {
          trace.push("split");
          return false;
        },
        vi.fn(),
      ),
      controller(
        "bucketFill",
        () => {
          trace.push("bucketFill");
          return false;
        },
        vi.fn(),
      ),
    ];
    const createContext = vi.fn(() => context);

    expect(dispatchToolMouseDown(registry, event, press, createContext)).toBe(
      false,
    );
    expect(trace).toEqual(["split", "bucketFill"]);
    expect(registry[0].onMouseDown).not.toHaveBeenCalled();
    expect(registry[1].onMouseDown).not.toHaveBeenCalled();
    expect(createContext).not.toHaveBeenCalled();
  });

  it("falls through after every eligible controller deliberately declines", () => {
    const trace: string[] = [];
    const registry = [
      controller(
        "keynotePick",
        () => true,
        () => {
          trace.push("keynotePick:false");
          return false;
        },
      ),
      controller(
        "parseRect",
        () => true,
        () => {
          trace.push("parseRect:false");
          return false;
        },
      ),
    ];
    const createContext = vi.fn(() => context);

    expect(dispatchToolMouseDown(registry, event, press, createContext)).toBe(
      false,
    );
    expect(trace).toEqual(["keynotePick:false", "parseRect:false"]);
    expect(createContext).toHaveBeenCalledTimes(1);
  });

  // [refactor jul16 P3.2] Rewritten non-vacuously at first registration (was the frozen-empty
  // pin). The length-0 short-circuit keeps executable coverage via a synthetic empty registry.
  // Second registration: markup owns the LAST runtime slot (board §5 priority — NOT extraction
  // chronology); future controllers insert BETWEEN calibration and markup.
  // [refactor jul17 P3.2] Third registration: takeoffCount takes the first INTERIOR slot (board
  // §5 priority #6); the interior stays §5-ordered as later controllers land around it.
  // [refactor jul17 P3.2] Fourth registration: takeoffLinear slots in AHEAD of takeoffCount
  // (board §5 priority #5) — a linear press claims before takeoffCount's linear-decline is ever
  // consulted; the decline stays anyway (honest partition, ordering-robust).
  // [refactor jul17 P3.2] Fifth registration: takeoffPolygon slots in AHEAD of takeoffLinear
  // (board §5 priority #4) — the same argument makes the linear/count polygon-declines
  // dead-but-honest; the five-way claim set is pairwise disjoint, so order stays unobservable.
  // [refactor jul18 P3.2] Sixth/seventh registrations land atomically: keynotePick MUST precede
  // parseRect so an eligible pick miss delegates within the same lazy context; a hit consumes.
  // Eighth registration: symbolSearch took its locked slot between them. Its symbolTemplate
  // eligibility is disjoint, so keynote miss delegation still reaches parseRect unchanged.
  // Ninth registration: tagPick inserts immediately after keynotePick and before symbolSearch;
  // all tagPick presses claim, while keynotePick's eligible miss still reaches parseRect.
  // Tenth registration: tagAdd inserts after symbolSearch and before parseRect. Its eligibility is
  // disjoint and every eligible press claims, including when deferred admission rejects.
  it("exports one exact frozen registry with tagPick, symbolSearch, tagAdd, then parseRect", () => {
    expect(TOOLS).toHaveLength(10);
    expect(Object.isFrozen(TOOLS)).toBe(true);
    expect(TOOLS.map((tool) => tool.kind)).toEqual([
      "calibration",
      "takeoffPolygon",
      "takeoffLinear",
      "takeoffCount",
      "keynotePick",
      "tagPick",
      "symbolSearch",
      "tagAdd",
      "parseRect",
      "markup",
    ]);
    expect(TOOLS[TOOLS.length - 1].kind).toBe("markup");
    for (const tool of TOOLS) {
      expect(Object.isFrozen(tool)).toBe(true);
    }
  });

  it("keeps the allocation-free length-0 short-circuit via a synthetic empty registry", () => {
    expect(dispatchToolMouseDown(Object.freeze([] as const), event)).toBe(false);
  });

  it("real-registry dispatch with a non-eligible press falls through without building context", () => {
    // [refactor jul16 P3.2] mode "move" + activeTool null keeps this press non-eligible for all
    // TEN registered controllers (calibration, the three takeoffPlacement controllers, and the
    // five parse/pick/deferred units need their activations; markup needs mode "markup").
    const nullPress = Object.freeze({
      toolAtDown: { activeTool: null, mode: "move" },
    }) as unknown as ToolPressSnapshot;
    const createContext = vi.fn(() => context);
    expect(dispatchToolMouseDown(TOOLS, event, nullPress, createContext)).toBe(
      false,
    );
    expect(createContext).not.toHaveBeenCalled();
  });

  it("fails loudly if untyped JavaScript registers a tool without wiring context", () => {
    const registered = [
      controller(
        "markup",
        () => true,
        () => true,
      ),
    ];
    const unsafeDispatch = dispatchToolMouseDown as unknown as (
      controllers: readonly ToolController[],
      candidateEvent: ReactMouseEvent,
    ) => boolean;
    expect(() => unsafeDispatch(registered, event)).toThrow(
      "A non-empty tool registry requires a press and context factory",
    );
  });
});
