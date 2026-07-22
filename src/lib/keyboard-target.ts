/** True when a keyboard event originated from a native or inherited text-editing surface. */
export function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return true;
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;

  // jsdom does not currently compute inherited isContentEditable. This fallback also keeps the
  // predicate explicit for descendants while respecting a nearer contenteditable="false" island.
  for (let element: HTMLElement | null = target; element; element = element.parentElement) {
    const value = element.getAttribute("contenteditable");
    if (value === null) continue;
    const normalized = value.trim().toLowerCase();
    if (normalized === "false") return false;
    if (normalized === "" || normalized === "true" || normalized === "plaintext-only") {
      return true;
    }
  }
  return false;
}
