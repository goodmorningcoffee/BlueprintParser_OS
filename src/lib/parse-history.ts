/**
 * parse-history.ts — In-memory ring buffer for recent table-parse requests.
 *
 * Phase I.1.f: gives the admin debug UI a "Recent Parses" view without
 * requiring a database table. Capped at 50 entries, lost on container restart.
 *
 * Multi-replica ECS gotcha: each task has its own buffer. The admin page may
 * show different "recent parses" depending on which task served the most recent
 * request. Acceptable for MVP — can move to a shared store later if needed.
 */

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

const buffer: ParseHistoryEntry[] = [];

/** Add an entry to the ring buffer. Newest entries first; oldest dropped at cap. */
export function addToHistory(entry: ParseHistoryEntry): void {
  buffer.unshift(entry);
  if (buffer.length > MAX_ENTRIES) {
    buffer.length = MAX_ENTRIES;
  }
}

/** Get a shallow copy of the current history. Callers cannot mutate the buffer. */
export function getHistory(): ParseHistoryEntry[] {
  return [...buffer];
}

/** Clear the history (admin "Clear" button). */
export function clearHistory(): void {
  buffer.length = 0;
}

/** Returns the maximum number of entries the buffer can hold. */
export function getMaxEntries(): number {
  return MAX_ENTRIES;
}
