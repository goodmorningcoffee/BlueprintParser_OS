/**
 * In-memory per-session viewport storage. Keyed by project publicId.
 * Survives dashboard→project→dashboard→project round-trips within a single
 * page lifecycle, but resets on browser refresh or tab close. That matches
 * the user-visible spec: "close or refresh starts fresh; nav preserves state."
 *
 * Previously backed by localStorage, which caused long-lived state poisoning:
 * a single broken scroll position could get persisted across sessions and
 * replay forever until the user manually cleared localStorage.
 */

export interface ViewerViewport {
  scale: number;
  pageNumber: number;
  scrollLeft: number;
  scrollTop: number;
  savedAt: number;
}

const sessionViewports: Record<string, ViewerViewport> = {};

export function loadViewport(publicId: string): ViewerViewport | null {
  if (!publicId) return null;
  return sessionViewports[publicId] ?? null;
}

export function saveViewport(publicId: string, v: ViewerViewport): void {
  if (!publicId) return;
  sessionViewports[publicId] = v;
}

export function clearViewport(publicId: string): void {
  if (!publicId) return;
  delete sessionViewports[publicId];
}
