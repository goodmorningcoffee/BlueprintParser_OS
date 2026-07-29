"use client";

/**
 * useVectorGeometryPrefetch — pays the ~1.2 s operator-list parse BEFORE the user clicks.
 *
 * PLAN §4.1's whole reason for a cache: extraction is the expensive, once-per-page half and
 * `vectorBucketFill` is the ~5 ms warm click. If extraction happens *on* the click, the vector path
 * is slower than the raster one it replaces and the port is pointless. So the moment the bucket
 * tool is armed, this starts the parse in the background and the click lands on a warm cache.
 *
 * ── ⛔ EVERY DEPENDENCY IS AN ARGUMENT. THAT IS DELIBERATE. ──────────────────────────────
 * This hook reads no store and imports no component. It is mounted by `PDFViewer`, which is pinned
 * by SEVEN freeze tests — including an AST-walking rule that every `useToolStore` selector return
 * exactly one primitive and never the whole `activeTool` object. Keeping the subscription at the
 * call site and the *logic* here means this file can be tested exhaustively without retargeting a
 * single pin, and the wiring commit stays a small, reviewable diff against those pins.
 *
 * ── ★ THE SAFETY RULE THIS HOOK OBEYS ───────────────────────────────────────────────────
 * `shouldPrefetchGeometry(mode, toolArmed)` decides whether to extract at all, and it is not a
 * convenience. `e2e/viewer-perf-v2.spec.ts` brackets the bucket worker and asserts an EXACT zero
 * across four PDF-transport counters, while `PDFViewer` loads the document with
 * `disableAutoFetch: true` and 1 MiB ranges — so `getOperatorList()` on a page whose bytes are not
 * resident ISSUES RANGE REQUESTS. A `raster` session (which is what the e2e spec pins) must
 * therefore prefetch nothing at all. See `lib/bucket-fill-mode.ts` for the full reasoning.
 *
 * ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────────────────
 * It does not prefetch neighbours. PLAN's cache holds 4 pages, and N±1 prefetching is a separate
 * decision with its own transport cost; the page in view is the one a click can land on. It also
 * does not retry: a failure is either permanent (the cache holds a sentinel and re-asking is free)
 * or transient (the next arm re-attempts naturally).
 */

import { useEffect, useRef, useState } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  registerPdfDocument,
  unregisterPdfDocument,
} from "@/lib/pdf-document-registry";
import {
  ensurePageGeometry,
  setGeometryProtectedPages,
} from "@/queries/pageGeometryCache";
import {
  resolveBucketFillMode,
  shouldPrefetchGeometry,
  type BucketFillMode,
} from "@/lib/bucket-fill-mode";
import { setBucketFillPerfMode } from "@/lib/bucket-fill-perf";
import type { OpsTable } from "@/lib/oneclick/oneclick";

export interface VectorGeometryPrefetchArgs {
  queryClient: QueryClient;
  /** Project id. Empty/undefined disables everything — the viewer is between projects. */
  publicId: string | null | undefined;
  /** 1-based page currently mounted. */
  pageNumber: number;
  /** The open document, or null while loading. */
  pdfDoc: PDFDocumentProxy | null;
  /** Is the bucket-fill tool armed? Resolved by the caller — see the header. */
  toolArmed: boolean;
  /** pdf.js `OPS`, injected. This module must not import pdfjs-dist. */
  ops: OpsTable | null;
  /**
   * Test seam for the mode. Production resolves it once at mount.
   *
   * ⚠ Resolved ONCE, not per render: `resolveBucketFillMode` reads `localStorage`, and doing that
   * on every render of a viewer is wasteful for a value that only a developer changes by hand.
   * The consequence is stated rather than hidden — **changing the override requires a reload**,
   * which is the normal contract for a dev flag and is what the e2e harness does anyway.
   */
  modeOverride?: BucketFillMode;
}

export interface VectorGeometryPrefetchState {
  /** The mode this hook resolved at mount. Exposed for diagnostics and tests. */
  mode: BucketFillMode;
}

/**
 * ⚠ The attempted-pages ledger is deliberately NOT returned.
 *
 * An earlier version exposed `attempted: attemptedRef.current`, and `react-hooks/refs` was right
 * to reject it: a ref read during render hands the caller a value that mutates *without* a
 * re-render, so anything that displayed it would show a stale set and never update. It is a
 * de-duplication ledger, not UI state — it stays inside.
 */

const key = (publicId: string, pageNumber: number) => `${publicId}::${pageNumber}`;

export function useVectorGeometryPrefetch(
  args: VectorGeometryPrefetchArgs,
): VectorGeometryPrefetchState {
  const { queryClient, publicId, pageNumber, pdfDoc, toolArmed, ops } = args;

  // Resolved once — see the note on `modeOverride`.
  const [mode] = useState<BucketFillMode>(
    () => args.modeOverride ?? resolveBucketFillMode(),
  );

  // ★ The phase-2 perf table's mode gate, armed HERE and not only on the click path.
  // Geometry extraction runs from this hook on tool-arm, BEFORE any click — so if the only setter
  // were `clientBucketFill`, `msParse` and `msWalk` would still be unarmed when the page was
  // parsed, and the table would print "—" for exactly the two columns PLAN §5 phase 2's gate
  // names (msParse is the ~1.2 s number the whole seam exists to pay once). Setting it during
  // render is safe: it is an idempotent write of a value this hook already resolved, and
  // `setBucketFillPerfMode` touches nothing but a module-level variable read by dev-only code.
  setBucketFillPerfMode(mode);

  // Attempts are tracked in a ref, not state: recording one must never trigger a render, and this
  // is a de-duplication ledger rather than anything the UI reads.
  const attemptedRef = useRef<Set<string>>(new Set());

  // ── register the open document ────────────────────────────────────────────
  // Unconditional (not gated on mode): a Map.set is free, and the routing layer needs the handle
  // regardless of whether *this* session prefetches. Registration is not extraction.
  useEffect(() => {
    if (!publicId || !pdfDoc) return;
    registerPdfDocument(publicId, pdfDoc);
    return () => {
      // Pass the handle we registered. A late unmount arriving AFTER a same-id reopen would
      // otherwise unregister the live document and silently route every later click to raster.
      unregisterPdfDocument(publicId, pdfDoc);
    };
  }, [publicId, pdfDoc]);

  // ── protect the mounted page ──────────────────────────────────────────────
  // Also unconditional, and for a reason: `page.cleanup()` frees the retained op list but discards
  // the display cache (+1612 ms on that page's next render). Protection is what stops the cache
  // from ever doing that to the sheet the user is looking at — and geometry may be cached from
  // BEFORE the mode changed, so gating this on the mode would leave a real page unprotected.
  // On an empty project this is an O(1) no-op and issues no transport.
  useEffect(() => {
    if (!publicId) return;
    setGeometryProtectedPages(queryClient, publicId, [pageNumber]);
  }, [queryClient, publicId, pageNumber]);

  // ── the prefetch itself ───────────────────────────────────────────────────
  useEffect(() => {
    if (!publicId || !pdfDoc || !ops) return;
    if (!shouldPrefetchGeometry(mode, toolArmed)) return;

    const attemptKey = key(publicId, pageNumber);
    if (attemptedRef.current.has(attemptKey)) return;
    attemptedRef.current.add(attemptKey);

    let cancelled = false;
    void (async () => {
      try {
        await ensurePageGeometry(queryClient, { publicId, pageNumber, ops });
      } catch {
        // `ensurePageGeometry` already converts every failure into a cached sentinel or a silent
        // miss; this catch exists so an unforeseen throw cannot become an unhandled rejection in
        // the viewer. A prefetch is an optimisation — it must never be able to break the page.
        return;
      }
      if (cancelled) return;
      // Re-assert protection AFTER the entry lands. Publishing calls `pruneGeometryCache`, and on
      // a cache already at its rail the page we just extracted could otherwise be the eviction
      // candidate — extracting a page and immediately dropping it is the one outcome worth
      // spending a line to prevent.
      setGeometryProtectedPages(queryClient, publicId, [pageNumber]);
    })();

    return () => {
      // The parse itself is not abortable (pdf.js gives no signal here), so cancellation is scoped
      // to what happens after it: nothing touches the cache once this effect is torn down.
      cancelled = true;
    };
  }, [queryClient, publicId, pageNumber, pdfDoc, toolArmed, ops, mode]);

  return { mode };
}
