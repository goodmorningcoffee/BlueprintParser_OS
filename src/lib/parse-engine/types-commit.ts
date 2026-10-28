/**
 * The commit and region-delete wire contract (table pipeline PLAN §3.2 "New routes", §3.3 A/B/C; WP-3.G).
 * A sibling type file (PLAN §1.6 rule 13): client-safe, imports only `./types` (E-8). The workspace's
 * `useCommitStructure` (WP-3.M) sends `CommitRequest` and reads `CommitResponse` / `CommitRefusal`.
 *
 *   POST   /api/projects/[id]/parse-engine/commit  CommitRequest      → 200 CommitResponse | 409 CommitRefusal
 *   DELETE /api/projects/[id]/parse-engine/region  RegionDeleteRequest → 200 RegionDeleteResponse
 *
 * The server never trusts a client model: it re-runs `recipe` (paid methods from the crop cache only),
 * applies `ops` on top, and stores that. Any other field a client sends (a `machine` snapshot, a label,
 * a model) is ignored; `base` is used only to re-match row/column/paragraph ids.
 */

import type { BboxMinMax, CorrectionOp, ParseRecipe, StructureKind, StructureModel } from "./types";

export interface CommitRequest {
  /** What was parsed (page, box, kind, parts, budget, hints) and where the item came from. */
  recipe: ParseRecipe;
  /** The user's corrections, id-keyed, in order (E-2). */
  ops: CorrectionOp[];
  /**
   * The model the ops were authored on (`ParseResult.model` of the draft). Sent as `prior` so a re-parse
   * re-matches ids (band IoU ≥ .5) and the server can count the rows a rebase changed. Optional; without it a
   * re-parse whose ids moved refuses the ops instead of guessing.
   */
  base?: StructureModel;
  /** `ParseResult.stamp.evidenceHash` the draft was parsed on. A different hash at commit → rebase (409). */
  evidenceHash?: string;
  /** Re-saving an existing region: its id and the `links.revision` the draft was loaded at (stale → 409). */
  regionId?: string;
  revision?: number;
  /**
   * Re-saving: `viewHash(region.data)` (`legacy-view.ts`) of the region the draft was loaded on. Any later change
   * to its legacy view → 409 `stale`. Required to re-save a region edited in a classic panel since its last
   * workspace save (PLAN §1.1 row 7); the `stale` and `conflict` refusals carry the current one.
   */
  viewHash?: string;
  /** A same-family region already covers the box (409 `conflict`): "keep-both" saves a second region. */
  onConflict?: "keep-both";
  /** The region's display name (`tableName`); defaults to the model's title. */
  tableName?: string;
  /** Item links the server records in `data.links` (a `proposalId` may also come from `recipe.request.hints`). */
  links?: { proposalId?: string; textRegionKey?: string; continues?: string };
  /** Seconds from open to accept (label telemetry; optional). */
  secondsToAccept?: number;
}

/** "Mapped 14 tags · 212 hits · 3 with none" (C3-M2). Absent when the model has no tag keys. */
export interface TagSummary {
  /** Distinct keys sent to the tag mapper. */
  keys: number;
  /** Keys with at least one hit (the tags written). */
  tags: number;
  /** Hits over all written tags. */
  hits: number;
  /** Keys with no hit (not written; listed for "Review ▸"). */
  none: number;
  noneKeys: string[];
  scope: "sheet" | "project";
}

/** The tag projection rows this call changed, for `adoptServerYoloTags(qc, publicId, rows, replacedRegionIds, removed)`. */
export interface CommitTagsDelta {
  rows: unknown[];
  removed: string[];
  replacedRegionIds: string[];
}

export interface CommitResponse {
  ok: true;
  regionId: string;
  revision: number;
  kind: StructureKind;
  /** The stored `ParsedRegion` (projection + `data.structure/links/engine/recipe/ops`). */
  parsedRegion: unknown;
  /** The page window projection of the written page intelligence (denylisted keys out). */
  updatedIntelligence: unknown;
  /** The page's CSI codes after the commit (they also shrink when a replaced region loses a code, K50). */
  csiCodeCount: number;
  tagSummary?: TagSummary;
  tags: CommitTagsDelta;
  summaries: unknown;
}

/** Every 409 carries the standard error envelope plus one of these bodies. */
export type CommitRefusal =
  | { reason: "stale"; regionId: string; revision: number | null; viewHash?: string }
  | { reason: "conflict"; conflict: { regionId: string; kind: StructureKind; title: string; revision: number; viewHash: string; bbox: BboxMinMax } }
  | { reason: "rebased"; rebased: StructureModel; changedRows: number | null; evidenceHash: string }
  | { reason: "ops-lost"; lost: { index: number; op: CorrectionOp["op"] }[] }
  | { reason: "paid-expired"; paidExpired: true; methods: string[] };

export interface RegionDeleteRequest {
  pageNumber: number;
  regionId: string;
}

export interface RegionDeleteResponse {
  ok: true;
  deleted: boolean;
  updatedIntelligence: unknown;
  csiCodeCount: number;
  tags: CommitTagsDelta;
  summaries: unknown;
}
