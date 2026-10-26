// [TP-1 WP-1.B 2026-10-26] Keyed page-intelligence writes for the two long server loops (K02).
//
// YOLO load (services/yolo.ts `yoloLoad`) and the intelligence reprocess (services/reprocess.ts,
// scope=intelligence) read every page of a project at loop start, compute for minutes, then wrote
// each page's WHOLE `pageIntelligence` from that snapshot. A schedule saved, a region rejected or a
// proposal verdict recorded on page 300 while a 500-page run was on page 10 was erased when the
// loop reached page 300. The page-level CSI codes had the same problem in YOLO load (a commit's
// page CSI recomputed mid-run was overwritten from the snapshot).
//
// The fix: write only what the loop computed. `pageIntelligenceDelta` turns (snapshot, next) into
// {set, clear}; `writeComputedPageIntelligence` applies it as ONE SQL statement over the LIVE row,
//     (live - clear) || set
// so a key the loop did not compute keeps whatever a concurrent writer put there. CSI codes, when
// given, are unioned with the live `csi_codes` read under the page row lock in the same transaction.
// Lock order is project row (withProjectWrite) → page row, as everywhere else.

import { and, eq, sql, type SQL } from "drizzle-orm";
import { pages } from "@/lib/db/schema";
import { mergeCsiCodes } from "@/lib/csi-utils";
import { REPROCESS_COMPUTED_KEYS } from "@/lib/intelligence-merge";
import type { CsiCode } from "@/types";
import { type ProjectWriteCapability, withProjectWrite } from "@/server/api/project-write-capability";

// The reprocess imports its merge helpers from here, so its one import line names every helper it uses.
export { carryNonComputedIntelligence, mergeProjectIntelligence } from "@/lib/intelligence-merge";

/** What one loop iteration computed for one page: keys to (re)write and keys to drop. */
export interface PageIntelligenceDelta {
  set: Record<string, unknown>;
  clear: string[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * The keys `next` changed relative to the `snapshot` it was built from.
 * - set: keys whose value is not the snapshot's own value (reference compare: the loops spread or
 *   carry untouched keys, so an unchanged key keeps its identity), plus every `computedKeys` key
 *   present in `next` (always rewritten, even when equal, as the old whole write did).
 * - clear: snapshot keys `next` dropped, `computedKeys` absent from `next`, and keys whose value is
 *   `undefined` (JSON drops them, so the old whole write dropped them too).
 * Keys in neither are left to the live row: that is the whole point.
 */
export function pageIntelligenceDelta(
  snapshot: unknown,
  next: Record<string, unknown>,
  computedKeys: readonly string[] = [],
): PageIntelligenceDelta {
  const before = asRecord(snapshot);
  const computed = new Set(computedKeys);
  const set: Record<string, unknown> = {};
  const clear = new Set<string>();
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) clear.add(key);
    else if (computed.has(key) || value !== before[key]) set[key] = value;
  }
  for (const key of [...Object.keys(before), ...computedKeys]) {
    if (!Object.prototype.hasOwnProperty.call(next, key)) clear.add(key);
  }
  return { set, clear: [...clear].sort() };
}

/** The intelligence reprocess's delta: every REPROCESS_COMPUTED_KEYS key is the loop's to write or clear. */
export function reprocessPageIntelligenceDelta(snapshot: unknown, next: Record<string, unknown>): PageIntelligenceDelta {
  return pageIntelligenceDelta(snapshot, next, REPROCESS_COMPUTED_KEYS);
}

/**
 * The new `page_intelligence` value as SQL over the live column: `(live - clear) || set`.
 * A NULL or non-object live value (legacy rows) starts from `{}`. Exported for the unit test.
 */
export function keyedPageIntelligenceSql(delta: PageIntelligenceDelta): SQL {
  const live = sql`(CASE WHEN jsonb_typeof(${pages.pageIntelligence}) = 'object' THEN ${pages.pageIntelligence} ELSE '{}'::jsonb END)`;
  const kept = delta.clear.length > 0
    ? sql`(${live} - ARRAY[${sql.join(delta.clear.map((key) => sql`${key}::text`), sql`, `)}]::text[])`
    : live;
  return sql`${kept} || ${JSON.stringify(delta.set)}::jsonb`;
}

/** True when the delta changes nothing (no write needed for the intelligence column). */
export function isEmptyDelta(delta: PageIntelligenceDelta): boolean {
  return delta.clear.length === 0 && Object.keys(delta.set).length === 0;
}

/**
 * Apply one page's delta (and, for YOLO load, union `addCsiCodes` into the live page CSI) in one
 * transaction under the caller's write capability. The CSI union keeps the old write guard: the
 * column is written only when the union adds codes the live row lacks.
 * Returns whether each column was written.
 */
export async function writeComputedPageIntelligence(
  writeCapability: ProjectWriteCapability,
  projectId: number,
  pageId: number,
  delta: PageIntelligenceDelta,
  addCsiCodes?: Parameters<typeof mergeCsiCodes>[1],
): Promise<{ intelligence: boolean; csiCodes: boolean }> {
  return withProjectWrite(writeCapability, projectId, async (tx) => {
    const target = and(eq(pages.id, pageId), eq(pages.projectId, projectId));
    let csiCodes: CsiCode[] | undefined;
    if (addCsiCodes && addCsiCodes.length > 0) {
      const [live] = await tx.select({ csiCodes: pages.csiCodes }).from(pages).where(target).for("update").limit(1);
      const liveCsi = (live?.csiCodes ?? []) as CsiCode[];
      const merged = mergeCsiCodes(liveCsi, addCsiCodes);
      if (merged.length > liveCsi.length) csiCodes = merged;
    }
    const intelligence = !isEmptyDelta(delta);
    if (!intelligence && !csiCodes) return { intelligence: false, csiCodes: false };
    await tx
      .update(pages)
      .set({
        ...(intelligence ? { pageIntelligence: keyedPageIntelligenceSql(delta) } : {}),
        ...(csiCodes ? { csiCodes } : {}),
      })
      .where(target);
    return { intelligence, csiCodes: csiCodes !== undefined };
  });
}
