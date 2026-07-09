// [refactor jul5 S026] The shared scaffold of the 5 cheap region-parse routes (notes-parse
// ±propose, spec-parse ±propose, table-parse/propose): truthy field-400 → bbox-400 →
// resolveProjectOrThrow({dbId}) → page textractData fetch/404. The five legacy routes carried
// this as ~55 byte-identical copy-paste lines; the ONLY two divergences are parameterized:
//   • bboxMessage — 4 routes use the LONG form, table-parse/propose the SHORT "Invalid
//     regionBbox" (frozen copy-paste drift, char-pinned PQ-2).
//   • allowDemo — true on 4 (demo projects publicly readable), FALSE on table-parse/propose
//     (demo+anon → 401; char-pinned PQ-3; do NOT "fix").
// Field checks are TRUTHY on purpose: projectId:0 / pageNumber:0 trip "Missing…" (falsy-zero
// quirk, PQ-1). Non-castable projectId strings flow into the pg cast and throw → the shell's
// generic INTERNAL 500 (sanctioned diff B); an integer guard is DECLINED (would flip the
// negative-id 404 → 400). Cosmetic deviation sanctioned at fold: the page select is unified
// to {id, textractData} (table-propose's legacy select omitted id — HTTP-invisible).
// The big fat-route catch-alls that LEAKED err.message at 500 are RETIRED (diff B) — services
// throw/propagate; the shell owns the generic 500.

import { db } from "@/lib/db";
import { pages } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import type { TextractPageData } from "@/types";
import { ApiError } from "@/server/api/envelope";
import { resolveProjectOrThrow } from "@/server/api/access";

export interface RegionParseInput {
  textractData: TextractPageData;
  regionBbox: [number, number, number, number];
  pageNumber: number;
  // [refactor jul9 P2-A C1] the owning company id — surfaced here (from the already-
  // resolved project) so notes-parse/spec-parse can resolve their CSI context. Fixes
  // both dependents in one change (the project is fetched here, not in the callers).
  companyId: number;
}

export async function resolveRegionPage(
  rawBody: Record<string, unknown>,
  opts: { bboxMessage: string; allowDemo: boolean },
): Promise<RegionParseInput> {
  const { projectId, pageNumber, regionBbox } = rawBody as {
    projectId?: number;
    pageNumber?: number;
    regionBbox?: [number, number, number, number];
  };

  if (!projectId || !pageNumber || !regionBbox || regionBbox.length !== 4) {
    throw new ApiError("VALIDATION", "Missing projectId, pageNumber, or regionBbox");
  }

  const [x0, y0, x1, y1] = regionBbox;
  if (
    ![x0, y0, x1, y1].every((v) => typeof v === "number" && isFinite(v) && v >= 0 && v <= 1)
    || x0 >= x1 || y0 >= y1
  ) {
    throw new ApiError("VALIDATION", opts.bboxMessage);
  }

  const { project } = await resolveProjectOrThrow(
    { dbId: projectId },
    opts.allowDemo ? { allowDemo: true } : undefined,
  );

  const [pageRow] = await db
    .select({ id: pages.id, textractData: pages.textractData })
    .from(pages)
    .where(and(eq(pages.projectId, project.id), eq(pages.pageNumber, pageNumber)))
    .limit(1);

  if (!pageRow?.textractData) {
    throw new ApiError("NOT_FOUND", "Page has no OCR data");
  }

  return {
    textractData: pageRow.textractData as TextractPageData,
    regionBbox,
    pageNumber,
    companyId: project.companyId, // [refactor jul9 P2-A C1]
  };
}

export const LONG_BBOX_MESSAGE =
  "Invalid regionBbox: values must be finite numbers in [0,1] with min < max";
