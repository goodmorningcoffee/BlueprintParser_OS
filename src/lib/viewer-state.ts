export interface ViewerViewport {
  scale: number;
  pageNumber: number;
  scrollLeft: number;
  scrollTop: number;
  savedAt: number;
}

const KEY_PREFIX = "bp:project:";
const KEY_SUFFIX = ":viewport";

function key(publicId: string) {
  return `${KEY_PREFIX}${publicId}${KEY_SUFFIX}`;
}

function isValid(v: unknown): v is ViewerViewport {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.scale === "number" &&
    Number.isFinite(o.scale) &&
    o.scale >= 0.2 &&
    o.scale <= 10 &&
    typeof o.pageNumber === "number" &&
    Number.isFinite(o.pageNumber) &&
    o.pageNumber >= 1 &&
    typeof o.scrollLeft === "number" &&
    Number.isFinite(o.scrollLeft) &&
    typeof o.scrollTop === "number" &&
    Number.isFinite(o.scrollTop) &&
    typeof o.savedAt === "number"
  );
}

export function loadViewport(publicId: string): ViewerViewport | null {
  if (!publicId || typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key(publicId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isValid(parsed) ? parsed : null;
  } catch (e) {
    console.warn("[viewer-state] loadViewport failed", e);
    return null;
  }
}

export function saveViewport(publicId: string, v: ViewerViewport): void {
  if (!publicId || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key(publicId), JSON.stringify(v));
  } catch (e) {
    console.warn("[viewer-state] saveViewport failed", e);
  }
}

export function clearViewport(publicId: string): void {
  if (!publicId || typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key(publicId));
  } catch (e) {
    console.warn("[viewer-state] clearViewport failed", e);
  }
}
