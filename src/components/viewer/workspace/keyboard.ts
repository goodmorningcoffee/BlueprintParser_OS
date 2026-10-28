// [TP-3 WP-3.O] Focus-scoped keyboard handling for the Tables & Notes workspace (PLAN §1.6 rule 14, C2-M11).
//
// The viewer's overlay dispatcher (`useOverlayKeyboardDispatcher`, frozen; never edited) listens on `window`:
//   • Enter finishes an annotation vertex/bbox drag,
//   • Delete / Backspace delete the SELECTED annotation (and send its DELETE request).
// The workspace therefore never adds a `window` listener. Its keys are handled where focus is — on the panel and
// on focusable canvas handles — with React `onKeyDown`, and the three dispatcher keys never bubble out of a
// workspace surface: React's `stopPropagation` stops the native event at the React root, before `window`.
// Typing in a field is never hijacked (`isEditableKeyboardTarget`), and Esc ALWAYS propagates, because
// ProposalFocusLayer owns it (Esc clears the green focus box).

import { createElement, type KeyboardEvent, type ReactNode } from "react";
import { isEditableKeyboardTarget } from "@/lib/keyboard-target";

export { isEditableKeyboardTarget };

/** Keys the window-level overlay dispatcher acts on, which must never leak out of a workspace surface. */
export const DISPATCHER_KEYS: ReadonlySet<string> = new Set(["Enter", "Delete", "Backspace"]);

/** Stop a dispatcher key at this surface (its native default, e.g. a button's Enter click, still happens). */
export function isolateDispatcherKeys(e: KeyboardEvent<Element>): void {
  if (DISPATCHER_KEYS.has(e.key)) e.stopPropagation();
}

export type KeyHandlers = Partial<Record<string, (e: KeyboardEvent<Element>) => void>>;

/**
 * A focus-scoped `onKeyDown`: `handlers[e.key]` runs unless the target is a text field or a modifier is held.
 * A handled key is `preventDefault` + `stopPropagation`. An unhandled dispatcher key still stops propagating.
 * Esc is never handled here, and never stopped.
 */
export function focusScopedKeys(handlers: KeyHandlers): (e: KeyboardEvent<Element>) => void {
  return (e) => {
    if (e.key === "Escape") return;
    const handler = handlers[e.key];
    if (handler && !e.altKey && !e.ctrlKey && !e.metaKey && !isEditableKeyboardTarget(e.target)) {
      e.preventDefault();
      e.stopPropagation();
      handler(e);
      return;
    }
    isolateDispatcherKeys(e);
  };
}

/**
 * A layout-neutral wrapper (`display: contents`) that keeps the dispatcher keys of everything inside it from
 * reaching `window`: a button's Enter inside the workspace panel clicks the button and nothing else.
 */
export function WorkspaceKeyScope({ children }: { children: ReactNode }) {
  return createElement(
    "div",
    { "data-workspace-key-scope": "", style: { display: "contents" }, onKeyDown: isolateDispatcherKeys },
    children,
  );
}
