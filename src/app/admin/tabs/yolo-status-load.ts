// [2026-10-23] GET /api/admin/yolo-status for the admin page (root only). The page used to start
// yoloStatus as {} and swallow every error, so until (or unless) the fetch landed the bulk bar's
// "only projects without results" counted EVERY project as missing results. The page now keeps a
// load state beside the map: not loaded → the bar shows "loading results…" and offers no
// result-filtered Run/Load all; failed → it shows the error.

export type YoloStatusMap = Record<string, Record<string, number>>;

export interface YoloStatusLoad {
  loaded: boolean;
  error: string | null;
}

export async function fetchYoloStatus(): Promise<{ status: YoloStatusMap | null; error: string | null }> {
  try {
    const res = await fetch("/api/admin/yolo-status");
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || typeof body !== "object") {
      const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
      return { status: null, error: typeof message === "string" && message ? message : `HTTP ${res.status}` };
    }
    return { status: body as YoloStatusMap, error: null };
  } catch (err) {
    return { status: null, error: err instanceof Error ? err.message : "network error" };
  }
}
