// [feat 2026-10-23 page-permanent-delete] Labeling walks 1..numPages (labeling.ts); a permanently
// deleted hidden duplicate leaves a gap there, and its page image is gone from S3, so a task for
// it would fail the whole create (requireVersionedSource → 409). Keep only the numbers that have
// a page row. A project with NO page rows at all (fixtures, pre-page-table uploads) keeps the
// numeric range: nothing is known to be missing. Lives beside labeling.ts (at its line ceiling).

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { pages } from "@/lib/db/schema";
import { ApiError } from "@/server/api/envelope";

export async function keepExistingPages(projectId: number, pageNumbers: number[]): Promise<number[]> {
  const rows = await db.selectDistinct({ pageNumber: pages.pageNumber }).from(pages).where(eq(pages.projectId, projectId));
  if (rows.length === 0) return pageNumbers;
  const existing = new Set(rows.map((r) => r.pageNumber));
  const kept = pageNumbers.filter((n) => existing.has(n));
  if (kept.length === 0) throw new ApiError("VALIDATION", "No pages in that range exist (they were deleted)");
  return kept;
}
