/**
 * Wire types of the workspace items and verdict routes (table pipeline TP-3 WP-3.F; sibling type file,
 * PLAN §1.6 rule 13). Types only: safe to import from the viewer (WP-3.L `useWorkspaceItems`).
 *
 *   GET  /api/projects/[id]/parse-engine/items?scope=all            → WorkspaceItemsResponse (PJ only)
 *   GET  /api/projects/[id]/parse-engine/items?scope=sheet&page=N   → one group with the page's detail
 *   GET  /api/projects/[id]/parse-engine/verdicts?page=N            → TextRegionVerdictsResponse
 *   POST/DELETE /api/projects/[id]/parse-engine/verdict             → WorkspaceVerdictResponse
 *
 * ONE wire for the producer (WP-3.F) and the reader (WP-3.L): the viewer imports these types rather than
 * re-declaring them (WP-3.F fix round, verify HIGH-2). scope=all answers per-sheet `groups` (PLAN §3.2); a
 * flat inbox is `groups.flatMap((g) => g.items)` (and the same for `lowConfidence`).
 */

import type { BboxMinMax, StructureKind, TextRegionVerdict } from "./types";

export type WorkspaceItemOrigin = "proposal" | "text-region" | "region" | "classified-table" | "ensemble";
export type WorkspaceItemState = "todo" | "parsed" | "rejected";

export interface WorkspaceItem {
  /** Stable item id (the `InboxSlim.id`): the proposal id, `tr:<type>:<q2 box>` for a text region, the region id, or `ct:`/`ens:` + box. */
  id: string;
  origin: WorkspaceItemOrigin;
  page: number;
  kind: StructureKind;
  classId?: string | null;
  title: string | null;
  b: BboxMinMax;
  /** Detector probability (1 for a saved region). */
  p: number;
  tableP?: number;
  /** Sort key: `tableP × p` (`p` when there is no table head). */
  score: number;
  state: WorkspaceItemState;
  proposalId?: string;
  regionId?: string;
  verdict?: "accept" | "reject" | "rename";
  /** Text regions: the stored type and positional id (the classic cards' key). */
  regionType?: string;
  legacyId?: string;
  /** Proposals: number of tag rows in the stored tag column. */
  tagRows?: number;
  /** Saved regions: "workspace" or "classic" (from the derived index). */
  regionOrigin?: "workspace" | "classic";
}

export interface WorkspaceItemsGroup {
  page: number;
  /** At or above the threshold, sorted by `score` descending (ties by id). */
  items: WorkspaceItem[];
  /** Below the threshold, and every `classifiedTables` / `ensembleRegions` item (C2-m7). */
  lowConfidence: WorkspaceItem[];
}

export interface WorkspaceItemsResponse {
  scope: "all" | "sheet";
  page?: number;
  /** False until the summaries pass has derived `PJ.structureIndex` (scope=all then lists proposals only). */
  indexReady: boolean;
  /** Items below this score are in `lowConfidence`. */
  threshold: number;
  groups: WorkspaceItemsGroup[];
}

/** One text-region verdict as the viewer reads it (no user id). */
export type TextRegionVerdictSlim = Pick<TextRegionVerdict, "verdict" | "type" | "b" | "at">;

export interface TextRegionVerdictsResponse {
  page: number;
  verdicts: Record<string, TextRegionVerdictSlim>;
}

/**
 * POST body. A proposal item: `{ pageNumber, proposalId, verdict, classId?, name? }`. A text region, either named
 * explicitly (`textRegion: { type, bbox }`) or by its item (`itemId: "tr:<type>:<box>"`, `origin: "text-region"`,
 * `bbox`, the shape the inbox sends). The server matches a STORED region either way (IoU ≥ .7) and records its
 * box. A text region takes `reject` only here: it is accepted by committing its parse (verify LOW-1).
 */
export interface WorkspaceVerdictRequest {
  pageNumber: number;
  verdict: "accept" | "reject" | "rename";
  proposalId?: string;
  classId?: string;
  name?: string;
  textRegion?: { type: string; bbox: BboxMinMax };
  itemId?: string;
  origin?: WorkspaceItemOrigin;
  kind?: StructureKind;
  bbox?: BboxMinMax;
}

/** DELETE body (Undo): `{ pageNumber, proposalId }`, or `{ pageNumber, key }` (alias `itemId`) for a text region. */
export interface WorkspaceVerdictUndoRequest {
  pageNumber: number;
  proposalId?: string;
  key?: string;
  itemId?: string;
}

export interface WorkspaceVerdictResponse {
  /** Text regions: the content key written or removed. */
  key?: string;
  /** Text regions folded into the proposal item whose verdict was mirrored onto them (content keys). */
  folded?: string[];
  verdict?: TextRegionVerdictSlim | null;
  /** Proposals: the stored proposal verdict (null when a via-parse accept was ignored). */
  proposalVerdict?: unknown;
  removed?: boolean;
  /** True when `PJ.structureIndex.inbox[page]` was refreshed in the same transaction. */
  inboxRefreshed: boolean;
}
