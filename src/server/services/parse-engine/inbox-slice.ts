/**
 * Refresh ONE page's slice of the derived project inbox (table pipeline TP-3 WP-3.F; PLAN §2.2 "project
 * index": "the verdict route refreshes one page's `inbox` slice with `jsonb_set`"; C1-B2, rule 9, rule 11).
 *
 * `PJ.structureIndex` is DERIVED by the summaries pass (WP-3.H) and never hand-written. The one exception
 * is this refresh: after a verdict, the page's slice is recomputed with the same pure `deriveInboxForPage`
 * the summaries pass uses, and written with `jsonb_set` on that one path, so the inbox shows the verdict
 * without a full recompute and every other key of the index (and of `projectIntelligence`) survives.
 *
 *   - Used inside the verdict's `withProjectWrite` (the project row is already locked, rule 11), with the
 *     page intelligence as it is AFTER the verdict write. This module READS and builds the value; the one
 *     `update(projects)` runs in `refreshInboxSlice` (`proposal-verdicts.ts`), which every proposal verdict and
 *     undo (classic verdict bar included, verify MED-1) and the workspace text-region verdicts call, because
 *     the policy checker accepts a tx-taking project writer only inside a file that holds a withProjectWrite.
 *   - No index yet (`structureIndex.inbox` absent): nothing is written. The next summaries pass derives the
 *     whole index; creating a partial one here would be a hand-written index (C1-B2).
 *   - A hidden duplicate page never enters the index: its slice is removed instead.
 *   - The previous slice supplies the boxes recorded for legacy reject ids (`legacyRejectHolds`).
 *
 * Security manifest: no sink of its own (it writes nothing); the write is reached from the verdict routes'
 * MUTATION_SURFACES entries (workspace and classic). (PLAN named a `project-write-transaction-helper` sink here; that checker policy is
 * reserved to the Label Studio grant helpers, MEASURED `check-project-security-policy.mjs:2863-2872`.)
 */

import { eq, sql, type SQL } from "drizzle-orm";
import { projects } from "@/lib/db/schema";
import { deriveInboxForPage, type InboxEntry } from "@/lib/parse-engine/inbox-derive";
import type { InboxSlim } from "@/lib/parse-engine/types";
import type { ProjectWriteTransaction } from "@/server/api/project-write-capability";

function isHidden(pageIntelligence: unknown): boolean {
  const mark = (pageIntelligence as { duplicateOf?: { hiddenAt?: unknown } } | null)?.duplicateOf;
  return !!mark && typeof mark === "object" && mark.hiddenAt !== undefined && mark.hiddenAt !== null;
}

/** The project's current inbox state for one page: whether an index exists, and the page's previous slice. */
export interface InboxSliceState {
  hasInbox: boolean;
  prev: InboxSlim[] | null;
}

/** Read the inbox state under the caller's transaction (the project row is already locked by withProjectWrite). */
export async function readInboxSliceState(
  tx: ProjectWriteTransaction,
  projectId: number,
  pageNumber: number,
): Promise<InboxSliceState> {
  const [row] = await tx
    .select({
      hasInbox: sql<boolean>`jsonb_typeof(${projects.projectIntelligence}->'structureIndex'->'inbox') = 'object'`,
      prev: sql<unknown>`${projects.projectIntelligence}->'structureIndex'->'inbox'->(${String(pageNumber)}::text)`,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return { hasInbox: row?.hasInbox === true, prev: Array.isArray(row?.prev) ? (row!.prev as InboxSlim[]) : null };
}

/**
 * The new `projectIntelligence` value expression for one page's slice (a `jsonb_set` on that one path, or the
 * path removed for a hidden page) and the entries written; null when the project has no index yet. The caller
 * runs the single `update(projects)` inside its own withProjectWrite callback (the verdict service).
 */
export function inboxSliceUpdate(
  state: InboxSliceState,
  pageNumber: number,
  pageIntelligence: unknown,
): { value: SQL; entries: InboxEntry[] } | null {
  if (!state.hasInbox) return null;
  const path = sql`array['structureIndex', 'inbox', ${String(pageNumber)}::text]`;
  if (isHidden(pageIntelligence)) return { value: sql`${projects.projectIntelligence} #- ${path}`, entries: [] };
  const entries = deriveInboxForPage({ page: pageNumber, pageIntelligence, prev: state.prev });
  return { value: sql`jsonb_set(${projects.projectIntelligence}, ${path}, ${JSON.stringify(entries)}::jsonb, true)`, entries };
}
