import type { MouseEvent as ReactMouseEvent } from "react";

import type { ToolContext, ToolController, ToolPressSnapshot } from "./types";

// [refactor jul15 P3.1] Empty by design: the registry seam lands before any behavior moves.
export const TOOLS = Object.freeze(
  [] as const,
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
