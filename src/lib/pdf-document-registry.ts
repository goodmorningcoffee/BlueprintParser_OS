"use client";

/**
 * pdf-document-registry.ts — the out-of-band handle on the live pdf.js document.
 *
 * ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────────────────
 * The vector bucket-fill path needs the `PDFDocumentProxy` at mousedown, inside a tool
 * controller. The controller receives a `ToolContext`, and **`ToolContext` has no `pdfDoc` by
 * design and must not gain one** (`tools/types.ts`): it is kept dependency-neutral against a
 * frozen 37-entry dependency block, and widening it would retarget those freeze tests for a
 * reason that has nothing to do with tool dispatch.
 *
 * The precedent for reaching around it already exists in the very same controller —
 * `readTextractForPage(qc, publicId, pageNumber)` at `tools/bucketFill.ts`'s import list is an
 * out-of-band, page-keyed, imperative read whose "silent miss returns undefined" convention the
 * caller routes on. This registry is the same shape for a thing that cannot live in a query at
 * all.
 *
 * ── WHY A MODULE-LEVEL MAP AND NOT A QUERY ──────────────────────────────────────────────
 * A `PDFDocumentProxy` is a **live handle with a `destroy()`**, not serializable data. Putting it
 * in the react-query cache would invite structural sharing to walk it, gc timers to drop a handle
 * someone still holds, and devtools to try to render it. Geometry — which *is* plain data — goes
 * in react-query (`queries/pageGeometryCache.ts`); the handle it is derived from lives here.
 *
 * ── ⚠ THIS REGISTRY DOES NOT OWN THE DOCUMENT'S LIFETIME ────────────────────────────────
 * `PDFViewer` creates the document and destroys it. `unregisterPdfDocument` **forgets, it does
 * not destroy** — calling `destroy()` here would tear a document out from under the component
 * still rendering it. The registry is a lookup table, and every consumer must treat a miss as
 * normal rather than exceptional: a miss is precisely the auto-fallback trigger (PLAN §4.3 — "the
 * mechanism falls out of the cache design rather than being invented").
 */

import type { PDFDocumentProxy } from "pdfjs-dist";

/**
 * publicId → the live document currently open for it.
 *
 * Module-level rather than per-QueryClient: there is exactly one pdf.js document open per viewer,
 * and the registry's whole purpose is to be reachable from a synchronous call site that has no
 * React context. A `Map` (not `WeakMap`) because `publicId` is a string key, and entries are
 * removed explicitly by the same component that added them.
 */
const documents = new Map<string, PDFDocumentProxy>();

/**
 * Publish the open document for a project.
 *
 * Replacing an existing entry is legitimate and silent — re-opening the same project produces a
 * new proxy, and the newest one is authoritative. The old handle is NOT destroyed here for the
 * reason in the header: whoever created it owns it.
 */
export function registerPdfDocument(publicId: string, doc: PDFDocumentProxy): void {
  if (!publicId) return;
  documents.set(publicId, doc);
}

/**
 * Read the open document, or `undefined`.
 *
 * ⚠ **`undefined` is an ordinary outcome, not an error.** It means the viewer has not finished
 * loading, the project was torn down, or this is a context (tests, SSR, a background job) with no
 * viewer at all. Callers route to the raster path on it.
 */
export function getPdfDocument(publicId: string): PDFDocumentProxy | undefined {
  if (!publicId) return undefined;
  return documents.get(publicId);
}

/**
 * Forget the document for a project. Does **not** destroy it.
 *
 * `expected` guards the teardown race that this workspace keeps rediscovering: project A's
 * unmount can run *after* a same-id reopen has already registered project A's new document, and
 * an unguarded `delete` would then unregister the live one and silently route every subsequent
 * click to raster. Pass the handle you registered and a stale teardown becomes a no-op.
 */
export function unregisterPdfDocument(publicId: string, expected?: PDFDocumentProxy): void {
  if (!publicId) return;
  if (expected !== undefined && documents.get(publicId) !== expected) return;
  documents.delete(publicId);
}

/** Test-only: how many documents are registered. Never used by product code. */
export function registeredPdfDocumentCount(): number {
  return documents.size;
}

/** Test-only reset, so one suite's registration cannot leak into the next. */
export function __resetPdfDocumentRegistry(): void {
  documents.clear();
}
