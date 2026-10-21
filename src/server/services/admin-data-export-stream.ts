// Admin data export (bp-dataset/1) — the pure half: line vocabulary, labels, and the streaming
// machinery. No database access lives here; admin-data-export.ts owns every query.
//
// Streaming contract (plan §3.4):
//   • the producer is an async generator; ReadableStream.pull() asks it for the next ~64 KiB of
//     lines only when the consumer has room, gzips them and enqueues the output, so a slow
//     download slows the database reads instead of buffering the file in memory;
//   • one export per caller class (root / company) per process; the slot is released idempotently on normal
//     end, on cancel(), on the request's abort signal, on the idle cap and on any producer throw;
//   • idle cap: no pull() for idleMs while the stream is open → abort and free the slot;
//   • overall deadline: a final `error` line, then close.

import { createGzip } from "node:zlib";

export const DATASET_SCHEMA_VERSION = "bp-dataset/1";

export interface ExportStreamLimits {
  /** No pull() for this long → the export is aborted and the slot freed. */
  idleMs: number;
  /** Wall-clock ceiling for one export. A final `error` line is written, then the file ends. */
  deadlineMs: number;
  /** Lines are batched into chunks of about this many characters before gzip. */
  chunkChars: number;
}

export const DEFAULT_EXPORT_LIMITS: ExportStreamLimits = {
  idleMs: 120_000,
  deadlineMs: 60 * 60_000,
  chunkChars: 64 * 1024,
};

let limits: ExportStreamLimits = { ...DEFAULT_EXPORT_LIMITS };

export function exportLimits(): ExportStreamLimits {
  return limits;
}

/** Test seam: shorten the caps so a stalled-reader test does not wait two minutes. */
export function setExportLimitsForTest(next: Partial<ExportStreamLimits> | null): void {
  limits = next ? { ...DEFAULT_EXPORT_LIMITS, ...next } : { ...DEFAULT_EXPORT_LIMITS };
}

// ── single-flight, one slot per caller class ───────────────────────────────────────────────────
//
// A single slot shared by every caller lets the cheapest caller deny the owner: a company admin
// who reads one chunk just inside the idle cap holds it until the deadline. So root has its own
// slot and a company admin can never block it; at most one root and one company-admin export run
// at once. Company admins still share theirs (cross-company starvation is bounded by the caps).

export type ExportCallerClass = "root" | "company";

const activeSlots = new Map<ExportCallerClass, symbol>();

/** Take the export slot for this caller class. Returns an idempotent release, or null when busy. */
export function tryAcquireExportSlot(callerClass: ExportCallerClass): (() => void) | null {
  if (activeSlots.has(callerClass)) return null;
  const token = Symbol("admin-data-export");
  activeSlots.set(callerClass, token);
  return () => {
    if (activeSlots.get(callerClass) === token) activeSlots.delete(callerClass);
  };
}

/** Any export running (no argument), or one for the given caller class. */
export function isExportRunning(callerClass?: ExportCallerClass): boolean {
  return callerClass ? activeSlots.has(callerClass) : activeSlots.size > 0;
}

// ── labels ─────────────────────────────────────────────────────────────────────────────────────

export type AnnotationOrigin = "machine" | "human" | "assisted" | "unknown";

const ORIGIN_BY_SOURCE: Record<string, AnnotationOrigin> = {
  yolo: "machine",
  "shape-parse": "machine",
  user: "human",
  takeoff: "human",
  "takeoff-scale": "human",
  "symbol-search": "assisted",
};

/**
 * A label, not proof: `source` is client-writable and YOLO loads set a creator. The mapping is
 * the plan's (§3.3); anything not listed is "unknown".
 */
export function annotationOrigin(source: string | null | undefined): AnnotationOrigin {
  return (source && ORIGIN_BY_SOURCE[source]) || "unknown";
}

/**
 * The duplicate mark written by the duplicate-pages tool lives at
 * pages.page_intelligence.duplicateOf = {pageNumber, tier, score, scannedAt, hiddenAt?}.
 * A page is HIDDEN only when the mark carries a non-empty hiddenAt; a scanned-but-kept mark is
 * exported as a normal page.
 */
export function isHiddenDuplicate(duplicateOf: unknown): boolean {
  if (!duplicateOf || typeof duplicateOf !== "object" || Array.isArray(duplicateOf)) return false;
  const hiddenAt = (duplicateOf as Record<string, unknown>).hiddenAt;
  return hiddenAt !== undefined && hiddenAt !== null && hiddenAt !== "" && hiddenAt !== false;
}

// ── option parsing helpers ─────────────────────────────────────────────────────────────────────

export function parseFlag(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return fallback;
}

export function parseList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function datasetFilename(scope: string, now: Date): string {
  const safe = scope.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 60) || "export";
  return `bp-dataset-${safe}-${now.toISOString().slice(0, 10)}.ndjson.gz`;
}

// ── the stream ─────────────────────────────────────────────────────────────────────────────────

export interface DatasetStreamOptions {
  /** Called exactly once when the stream ends for any reason. */
  onDone: () => void;
  /** The request's abort signal — a third release hook beside cancel() and the producer's end. */
  signal?: AbortSignal;
  /** The line written when the deadline is hit. */
  deadlineLine: () => unknown;
  limits?: ExportStreamLimits;
}

/**
 * A gzip encoder driven from pull(): input goes in only when the consumer asks for more, and the
 * compressed output of that input is handed back at once. zlib holds at most its window, so
 * memory is bounded by one pull's worth of lines.
 *
 * Why not CompressionStream("gzip"): measured on node 20, its readable side has no back-pressure
 * — with nobody reading, pipeThrough drained the whole producer into memory (400/400 pulls).
 */
function gzipPump() {
  const gz = createGzip();
  const out: Buffer[] = [];
  let failure: Error | null = null;
  gz.on("data", (b: Buffer) => out.push(b));
  gz.on("error", (e: Error) => {
    failure = e;
  });
  const take = (): Uint8Array | null => {
    if (failure) throw failure;
    if (out.length === 0) return null;
    const b = Buffer.concat(out);
    out.length = 0;
    return b;
  };
  return {
    write: (text: string) =>
      new Promise<Uint8Array | null>((resolve, reject) => {
        gz.write(text, "utf8", (err) => (err ? reject(err) : resolve(take())));
      }),
    end: () =>
      new Promise<Uint8Array | null>((resolve, reject) => {
        gz.once("end", () => resolve(take()));
        gz.once("error", reject);
        gz.end();
      }),
    destroy: () => gz.destroy(),
  };
}

/**
 * NDJSON lines from `produce`, gzip-compressed. Nothing is read from the producer until the
 * consumer pulls, and each pull reads at most ~chunkChars of lines.
 */
export function ndjsonGzipStream(
  produce: () => AsyncGenerator<unknown, void, undefined>,
  opts: DatasetStreamOptions,
): ReadableStream<Uint8Array> {
  const lim = opts.limits ?? exportLimits();
  const startedAt = Date.now();
  const gzip = gzipPump();
  let iterator: AsyncGenerator<unknown, void, undefined> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let finished = false;

  const clearIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  };
  const finish = (destroyGzip: boolean) => {
    if (finished) return;
    finished = true;
    clearIdle();
    const it = iterator;
    iterator = null;
    if (it) void it.return(undefined).catch(() => undefined);
    if (destroyGzip) gzip.destroy();
    opts.onDone();
  };
  const fail = (controller: ReadableStreamDefaultController<Uint8Array>, reason: string) => {
    finish(true);
    try {
      controller.error(new Error(reason));
    } catch {
      /* already closed */
    }
  };
  const armIdle = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    clearIdle();
    idleTimer = setTimeout(() => fail(controller, "export idle cap reached"), lim.idleMs);
  };
  const close = async (controller: ReadableStreamDefaultController<Uint8Array>, tail: string) => {
    finish(false);
    if (tail) {
      const head = await gzip.write(tail);
      if (head) controller.enqueue(head);
    }
    const rest = await gzip.end();
    if (rest) controller.enqueue(rest);
    controller.close();
  };

  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        iterator = produce();
        if (opts.signal) {
          if (opts.signal.aborted) return fail(controller, "request aborted");
          opts.signal.addEventListener("abort", () => fail(controller, "request aborted"), {
            once: true,
          });
        }
        armIdle(controller);
      },
      async pull(controller) {
        clearIdle();
        try {
          // A pull must enqueue before it returns, or the stream never pulls again; zlib may
          // swallow a whole batch into its window, so keep feeding it until output appears.
          for (;;) {
            let buf = "";
            while (buf.length < lim.chunkChars) {
              const it = iterator;
              if (finished || !it) return;
              if (Date.now() - startedAt > lim.deadlineMs) {
                return await close(controller, buf + JSON.stringify(opts.deadlineLine()) + "\n");
              }
              const step = await it.next();
              if (finished) return;
              if (step.done) return await close(controller, buf);
              buf += JSON.stringify(step.value) + "\n";
            }
            const bytes = await gzip.write(buf);
            if (finished) return;
            if (bytes) {
              controller.enqueue(bytes);
              break;
            }
          }
          armIdle(controller);
        } catch {
          fail(controller, "export producer failed");
        }
      },
      cancel() {
        finish(true);
      },
    },
    { highWaterMark: 1 },
  );
}
