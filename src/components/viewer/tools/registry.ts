import type { MouseEvent as ReactMouseEvent } from "react";

import { calibrationController } from "./calibration";
import { keynotePickController } from "./keynotePick";
import { markupController } from "./markup";
import { parseRectController } from "./parseRect";
import { symbolSearchController } from "./symbolSearch";
import { tagAddController } from "./tagAdd";
import { tagPickController } from "./tagPick";
import { takeoffCountController } from "./takeoffCount";
import { takeoffLinearController } from "./takeoffLinear";
import { takeoffPolygonController } from "./takeoffPolygon";
import type { ToolContext, ToolController, ToolPressSnapshot } from "./types";

// [refactor jul16 P3.2] Array order is RUNTIME PRIORITY (board §5: calibration FIRST, markup
// LAST), which is NOT the extraction chronology (markup was extracted second). Every future
// controller inserts BETWEEN calibration and markup — the tuple's tail slot belongs to markup.
// [refactor jul17 P3.2] takeoffCount was the first interior insert (board §5 priority #6);
// takeoffLinear slots in AHEAD of it (§5 priority #5) — a linear press claims here and never
// reaches takeoffCount's linear-decline, which stays anyway (honest partition, ordering-robust).
// takeoffPolygon slots in AHEAD of takeoffLinear (§5 priority #4) — the same argument makes the
// linear/count polygon-declines dead-but-honest; the five-way claim set is pairwise disjoint,
// so registry order stays unobservable.
// The interior stays §5-ordered as later controllers land: split/bucketFill slot in BEFORE
// takeoffPolygon. keynotePick precedes parseRect so an active YOLO miss can eligible-decline into
// the generic rectangle starter in the SAME dispatch. tagPick and symbolSearch now occupy their
// exact middle slots; tagAdd now occupies its slot after symbolSearch. pointerGroup remains between
// parseRect and markup.
export const TOOLS = Object.freeze(
  [
    calibrationController,
    takeoffPolygonController,
    takeoffLinearController,
    takeoffCountController,
    keynotePickController,
    tagPickController,
    symbolSearchController,
    tagAddController,
    parseRectController,
    markupController,
  ] as const,
) satisfies readonly ToolController[];

/**
 * Ordered strangler dispatch. Matching is eligibility; only a true handler result consumes.
 * Context stays lazy so the P3.1 empty registry adds no store reads or callback dependencies.
 */
export function dispatchToolMouseDown(
  controllers: readonly [],
  event: ReactMouseEvent,
): false;
export function dispatchToolMouseDown(
  controllers: readonly ToolController[],
  event: ReactMouseEvent,
  press: ToolPressSnapshot,
  createContext: () => ToolContext,
): boolean;
export function dispatchToolMouseDown(
  controllers: readonly ToolController[],
  event: ReactMouseEvent,
  press?: ToolPressSnapshot,
  createContext?: () => ToolContext,
): boolean {
  if (controllers.length === 0) return false;
  if (!press || !createContext) {
    throw new Error(
      "A non-empty tool registry requires a press and context factory",
    );
  }
  let context: ToolContext | undefined;

  for (const controller of controllers) {
    if (!controller.matches(press)) continue;
    context ??= createContext();
    if (controller.onMouseDown(event, context)) return true;
  }

  return false;
}
