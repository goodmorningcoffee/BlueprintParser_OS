/**
 * parse-history.ts — Recent table-parse requests, durable in Postgres `op_log`.
 *
 * Phase I.1.f originally gave the admin debug UI a "Recent Parses" view via an
 * in-memory ring buffer (capped 50, lost on restart, per-ECS-task).
 *
 * [refactor jul23 P5.4-C] The ring buffer is replaced by the shared `op_log`
 * table (migration 0039). This fixes the multi-replica gotcha — the admin page
 * now shows the SAME recent parses regardless of which task served the request.
 * The public signatures are preserved (behind unchanged names) except the three
 * mutating/reading helpers are now `async`; callers (table-parse.ts writer,
 * recent-parses.ts reader/clearer) await them (RD-P5e).
 *
 * The 50-entry ring semantics are reproduced by the READ contract, not by
 * eviction on write: getHistory() returns `ORDER BY created_at DESC, id DESC
 * LIMIT 50` (newest-first, exactly the unshift/drop-oldest behavior the freeze
 * pins). op_log keeps more rows than 50; the advisory-locked janitor (P5.4-E)
 * trims to OP_LOG_RETENTION. The full entry (id/timestamp/request/response) is
 * stored losslessly in the `request` jsonb so getHistory round-trips it verbatim
 * — including the caller-supplied `id`, which the admin UI keys on.
 */

import { db } from "@/lib/db";
import { opLog } from "@/lib/db/schema";
import { sql } from "drizzle-orm";
import type { MethodResult, MergerNotes } from "@/lib/grid-merger";

const MAX_ENTRIES = 50;

export interface InfraStage {
  stage: "pdf-download" | "rasterize" | "csi-detect" | "merge";
  durationMs: number;
  /** size of the produced asset (PDF bytes, PNG bytes, etc.) when applicable */
  sizeBytes?: number;
  /** dimensions for rasterize stage */
  dimensions?: { width: number; height: number };
  /** error message if the stage failed */
  error?: string;
}

export interface ParseHistoryEntry {
  /** unique id for the entry */
  id: string;
  /** ISO8601 timestamp of when the parse started */
  timestamp: string;
  request: {
    projectId: number;
    pageNumber: number;
    regionBbox: [number, number, number, number];
    debugMode: boolean;
    /** all the tuning knobs from the request body, minus projectId/pageNumber/regionBbox/debugMode */
    options: Record<string, unknown>;
  };
  response: {
    /** HTTP status code */
    status: number;
    /** total wall-clock duration of the parse, ms */
    durationMs: number;
    /** merged grid headers */
    headers: string[];
    /** merged grid row count (full rows would be too large for the buffer) */
    rowCount: number;
    /** merged grid confidence */
    confidence: number;
    /** merged grid tag column (if detected) */
    tagColumn?: string;
    /** per-method shape summary, same as merged.methods in the API response */
    methods: Array<{
      name: string;
      confidence: number;
      gridShape: [number, number];
      error?: string;
    }>;
    /** FULL per-method results with debug fields. Always captured in history,
     *  regardless of the request's debugMode flag. */
    methodResults: MethodResult[];
    /** infrastructure stage timings/sizes/errors (pdf-download, rasterize) */
    infraStages: InfraStage[];
    /** infrastructure errors that prevented methods from running */
    infraErrors: Array<{ stage: string; error: string }>;
    /** merger filtering decisions */
    mergerNotes?: MergerNotes;
  };
}

/**
 * Append an entry to op_log. `created_at` defaults to now() and the serial `id`
 * gives a strict insertion tiebreak, so getHistory's ORDER BY reproduces the
 * ring's newest-first order even for same-millisecond writes. The whole entry is
 * stored in the `request` jsonb (lossless round-trip); `response` is left null.
 */
export async function addToHistory(entry: ParseHistoryEntry): Promise<void> {
  await db
    .insert(opLog)
    .values({ kind: "table-parse", request: entry as unknown });
}

/**
 * Newest-first, capped at MAX_ENTRIES — the ring's read contract as SQL. Returns
 * a fresh array each call (inherently defensive: mutating it never touches the
 * store).
 */
export async function getHistory(): Promise<ParseHistoryEntry[]> {
  const res = await db.execute(
    sql`SELECT request FROM op_log ORDER BY created_at DESC, id DESC LIMIT ${MAX_ENTRIES}`,
  );
  return res.rows.map(
    (r) => (r as { request: ParseHistoryEntry }).request,
  );
}

/** Clear the history (admin "Clear" button). */
export async function clearHistory(): Promise<void> {
  await db.delete(opLog);
}

/** Returns the maximum number of entries getHistory returns (the ring cap). */
export function getMaxEntries(): number {
  return MAX_ENTRIES;
}
