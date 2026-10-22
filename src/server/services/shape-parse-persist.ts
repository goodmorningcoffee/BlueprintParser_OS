// [fix 2026-10-21 reprocess-persistence] The ONE writer for a page's shape-parse results.
//
// Two stores hold them and must agree: `pages.keynotes` (the detector output the viewer's
// page window re-reads on load) and `annotations` rows with source='shape-parse'. Upload
// (lib/processing.ts) writes both; before this module the admin reprocess wrote both but
// DELETED every shape-parse annotation of the project before computing anything, and the
// viewer wrote neither. Owner 2026-10-21: "all the 'reprocess' tools in the admin need to be
// double checked that they write to the data base".
//
// Contract — compute-then-swap:
//   • Call this only AFTER the replacement for the page exists. A page whose scan FAILED is
//     never passed here, so its previous rows survive untouched.
//   • One transaction per page: delete the old rows of the swapped scope, write
//     pages.keynotes, insert the new rows. A failed insert rolls the delete back.
//   • scope "page": the whole page is replaced. An empty `keynotes` (a CONFIRMED scan that
//     found nothing) clears the page — keynotes=NULL, no rows.
//   • scope "region": only shapes whose bbox centre lies inside the region are replaced; the
//     rest of the page (keynotes and annotations) is kept.
import { pages, annotations } from "@/lib/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import type { ClientAnnotation, KeynoteShapeData } from "@/types";
import { observeAnnotationDataBatch } from "./annotation-data-observe";
import {
  type ProjectWriteCapability,
  withProjectWrite,
} from "@/server/api/project-write-capability";

export type ShapeParseRegion = [number, number, number, number];

export interface ShapeParsePageSwap {
  pageNumber: number;
  /** The replacement for the swapped scope (already remapped to full-page coordinates). */
  keynotes: readonly KeynoteShapeData[];
  /** Absent → replace the whole page. */
  region?: ShapeParseRegion;
  /** Creator for viewer-initiated runs; pipeline runs leave it null (as upload does). */
  creatorId?: number | null;
}

export interface ShapeParsePageSwapResult {
  pageNumber: number;
  /** No pages row for this page number: nothing was written (rows would be orphans). */
  pageMissing?: true;
  /** pages.keynotes after the swap (null = cleared). */
  keynotes: KeynoteShapeData[] | null;
  /** Annotation rows inserted by this swap. */
  annotations: ClientAnnotation[];
  /** Annotation rows removed by this swap. */
  removedAnnotationIds: number[];
}

/** Strip transport fields (the fan-out adds pageS3Key) so only the keynote shape is stored. */
export function toStoredKeynote(k: KeynoteShapeData): KeynoteShapeData {
  return {
    shape: k.shape,
    text: k.text,
    bbox: k.bbox,
    ...(k.contour !== undefined ? { contour: k.contour } : {}),
  };
}

function centreInside(
  bbox: readonly number[],
  region: ShapeParseRegion,
): boolean {
  const cx = (bbox[0] + bbox[2]) / 2;
  const cy = (bbox[1] + bbox[3]) / 2;
  return cx >= region[0] && cx <= region[2] && cy >= region[1] && cy <= region[3];
}

export function shapeParseAnnotationRow(
  projectId: number,
  pageNumber: number,
  k: KeynoteShapeData,
  creatorId: number | null = null,
) {
  return {
    name: k.shape,
    minX: k.bbox[0], minY: k.bbox[1], maxX: k.bbox[2], maxY: k.bbox[3],
    pageNumber,
    threshold: 0.9,
    source: "shape-parse" as const,
    data: { modelName: "shape-parse", shapeType: k.shape, text: k.text, contour: k.contour, confidence: 0.9 },
    creatorId,
    projectId,
  };
}

/**
 * Swap one page's shape-parse results in a single transaction (see the file contract).
 * `sink` names the caller for the log-mode shape observation (gate:false permanently —
 * these fixed-key blobs never stamp `v`, so a throw would only poison the caller's loop).
 */
export async function swapShapeParsePage(
  writeCapability: ProjectWriteCapability,
  projectId: number,
  swap: ShapeParsePageSwap,
  sink: string,
): Promise<ShapeParsePageSwapResult> {
  const incoming = swap.keynotes.map(toStoredKeynote);
  const rows = incoming.map((k) =>
    shapeParseAnnotationRow(projectId, swap.pageNumber, k, swap.creatorId ?? null),
  );
  observeAnnotationDataBatch(rows.map((r) => r.data), sink, { gate: false });

  return withProjectWrite(writeCapability, projectId, async (tx) => {
    const pageWhere = and(eq(pages.projectId, projectId), eq(pages.pageNumber, swap.pageNumber));
    const [current] = await tx.select({ keynotes: pages.keynotes }).from(pages).where(pageWhere).limit(1);
    if (!current) {
      return { pageNumber: swap.pageNumber, pageMissing: true as const, keynotes: null, annotations: [], removedAnnotationIds: [] };
    }
    const existing = await tx
      .select({
        id: annotations.id,
        minX: annotations.minX, minY: annotations.minY,
        maxX: annotations.maxX, maxY: annotations.maxY,
      })
      .from(annotations)
      .where(
        and(
          eq(annotations.projectId, projectId),
          eq(annotations.pageNumber, swap.pageNumber),
          eq(annotations.source, "shape-parse"),
        ),
      );
    const region = swap.region;
    const removedAnnotationIds = existing
      .filter((a) => !region || centreInside([a.minX, a.minY, a.maxX, a.maxY], region))
      .map((a) => a.id);

    let kept: KeynoteShapeData[] = [];
    if (region) {
      const stored = Array.isArray(current.keynotes) ? (current.keynotes as KeynoteShapeData[]) : [];
      kept = stored.filter((k) => !centreInside(k.bbox, region));
    }
    const merged = [...kept, ...incoming];
    const nextKeynotes = merged.length > 0 ? merged : null;

    if (removedAnnotationIds.length > 0) {
      await tx.delete(annotations).where(
        and(eq(annotations.projectId, projectId), inArray(annotations.id, removedAnnotationIds)),
      );
    }
    await tx.update(pages).set({ keynotes: nextKeynotes }).where(pageWhere);
    const inserted = rows.length > 0 ? await tx.insert(annotations).values(rows).returning() : [];

    return {
      pageNumber: swap.pageNumber,
      keynotes: nextKeynotes,
      removedAnnotationIds,
      annotations: inserted.map((a) => ({
        id: a.id,
        pageNumber: a.pageNumber,
        name: a.name,
        bbox: [a.minX, a.minY, a.maxX, a.maxY] as [number, number, number, number],
        note: a.note,
        source: "shape-parse" as const,
        data: a.data ?? null,
      })),
    };
  });
}

/**
 * [fix 2026-10-22] Upload pipeline (lib/processing.ts): replace one page's shape-parse
 * ANNOTATION rows in one transaction — delete the page's source='shape-parse' rows, insert
 * the new ones. A retry/rerun of the page used to append a second copy. pages.keynotes is
 * NOT touched here: upload writes it in its own page upsert, and the pages row may not exist
 * yet on the first run (which is why swapShapeParsePage, which needs the row, is not used).
 * Call only for a scan that did not fail; an empty `keynotes` clears the page's rows.
 */
export async function replaceShapeParseAnnotations(
  writeCapability: ProjectWriteCapability,
  projectId: number,
  pageNumber: number,
  keynotes: readonly KeynoteShapeData[],
  sink: string,
): Promise<number> {
  const rows = keynotes.map((k) => shapeParseAnnotationRow(projectId, pageNumber, k));
  observeAnnotationDataBatch(rows.map((r) => r.data), sink, { gate: false });
  return withProjectWrite(writeCapability, projectId, async (tx) => {
    await tx.delete(annotations).where(
      and(
        eq(annotations.projectId, projectId),
        eq(annotations.pageNumber, pageNumber),
        eq(annotations.source, "shape-parse"),
      ),
    );
    if (rows.length > 0) await tx.insert(annotations).values(rows);
    return rows.length;
  });
}
