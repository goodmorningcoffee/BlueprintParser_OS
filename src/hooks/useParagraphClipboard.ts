import { useEffect, useRef } from "react";

/**
 * Global keyboard listener for Cmd+C / Cmd+V while ParagraphOverlay is active.
 * Extracted from the overlay body so the component stays focused on rendering,
 * and the keyboard logic can be tested / reused in isolation.
 *
 * Focus-gate: events are ignored when the active element is a text input,
 * textarea, contenteditable region, or inside a `[data-focus-ignore]`
 * wrapper. This keeps chat inputs / note-edit forms from stealing copy.
 */
export interface UseParagraphClipboardArgs {
  enabled: boolean;
  onCopy: () => void;
  onPaste: () => void;
}

function shouldIgnoreKeyEvent(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target.isContentEditable || target.contentEditable === "true") return true;
  if (target.closest("[data-focus-ignore]")) return true;
  return false;
}

export function useParagraphClipboard({ enabled, onCopy, onPaste }: UseParagraphClipboardArgs): void {
  const onCopyRef = useRef(onCopy);
  const onPasteRef = useRef(onPaste);
  useEffect(() => {
    onCopyRef.current = onCopy;
    onPasteRef.current = onPaste;
  }, [onCopy, onPaste]);

  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      const metaOrCtrl = e.metaKey || e.ctrlKey;
      if (!metaOrCtrl) return;
      const key = e.key.toLowerCase();
      if (key !== "c" && key !== "v") return;
      if (shouldIgnoreKeyEvent(e.target) || shouldIgnoreKeyEvent(document.activeElement)) return;
      e.preventDefault();
      if (key === "c") onCopyRef.current();
      else onPasteRef.current();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enabled]);
}

/** Exported for unit tests — the focus-gate predicate is the interesting part. */
export const _testOnly_shouldIgnoreKeyEvent = shouldIgnoreKeyEvent;
