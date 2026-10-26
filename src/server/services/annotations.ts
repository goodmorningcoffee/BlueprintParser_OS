// [refactor jun17 P1.3] Annotations service — first P1.3 core family.
//
// The three annotation route files (annotations[/route], annotations/[id], annotations/
// batch-delete) are now thin `defineRoute` shells; ALL behavior lives here. Behavior is
// preserved EXACTLY against the P0.3 characterization tests (annotations.route.test.ts) +
// the two [id]/batch-delete char files added with this migration. The ONE sanctioned diff
// is the error envelope ({error:string} → {error:{code,message}}, handled by the shell).
//
// Recipe applied (S008 §B): every annotation route is auth:"none" + service-resolved access,
// because all three shapes conflict with the shell's declarative auth-before-validate phase:
//   • POST (single + batch): validate-before-auth — fields/bbox 400 before the 401. So auth
//     stays INSIDE the service, AFTER field validation (resolveByPublicId).
//   • [id] PUT/DELETE: indirect lookup — the annotation is fetched by URL id, then access is
//     checked on its PARENT project (missing entity 404s BEFORE auth).
//   • batch-delete POST: validate-before-auth — projectId/annotationIds 400 before the 401.
//
// Frozen quirks deliberately kept (do NOT "fix" them here):
//   • POST single: falsy pageNumber (0) is treated as MISSING → 400 (the `!pageNumber` guard).
//   • POST single omits `threshold` on insert; POST batch sets `threshold: ann.threshold ?? null`.
//   • bbox validation uses the LEGACY validateBbox messages ("bbox values must be 0-1" etc.),
//     NOT zBboxMinMax — single returns the bare message, batch wraps it "Invalid annotation: …".
//   • PUT [id] does NOT validate bbox (assigns the four corners blindly) and returns
//     {success, autoCsiCodes}; DELETE [id] returns {success} and does NOT touch markers.
//   • [id] uses parseInt(id) with NO radix → a non-numeric id → NaN → pg int-cast THROWS →
//     generic 500 (NOT 404). Same quirk as takeoff-items/[id]; verified empirically.
//   • annotation writes resolve the canonical project, acquire a ProjectWriteCapability, and
//     revalidate it under the parent-row lock at the sink. `project.isDemo` is rejected for every
//     role; allowDemo on public-id resolution identifies the protected project but grants no write.
//
// Two leak/robustness changes from the legacy bare routes (sanctioned, logged in CHANGELOG):
//   • batch POST wraps delete-before-insert + insert in ONE db.transaction so a failed insert
//     can't leave a source's annotations deleted-but-not-replaced (partial-delete data loss).
//     Happy-path behavior is identical; this mirrors the takeoff create-path tx decision (P1.2).
//   • batch-delete's catch used to LEAK raw pg err.message into the 500 body; it now logs the
//     cause server-side and throws a generic ApiError (the envelope's leak-free 500).

import { db } from "@/lib/db";
import { annotations, takeoffItems } from "@/lib/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { detectCsiCodes } from "@/lib/csi-detect";
// [refactor jul9 P2-A C1] company CSI context resolver (config + custom DB). Resolved once
// per request (before any tx, I-1) and threaded through mergeAutoCsi into detect (D-1/D-2).
import {
  getCompanyCsiContext,
  type CompanyCsiContext,
} from "@/lib/csi-company-db";
import { logger } from "@/lib/logger";
import {
  parseSplittableAreaData,
  SPLIT_ANNOTATION_MAX_SOURCE_VERTICES,
  SPLIT_HOLED_TARGET_MESSAGE,
  SPLIT_UNSUPPORTED_AREA_DATA_MESSAGE,
  type SplitAnnotationRequest,
  type SplitAnnotationResponse,
} from "@/lib/annotation-split-contract";
import { splitPolygonByLine, type Pt } from "@/lib/polygon-split";
// [refactor jul23 P4.1 U1] log-mode shape observation + v-gate at the create sink.
import {
  observeAnnotationData,
  observeAnnotationDataBatch,
} from "./annotation-data-observe";
import { ApiError } from "@/server/api/envelope";
import {
  resolveByPublicId,
  resolveWritableProjectOrThrow,
} from "@/server/api/access";
import {
  assertProjectWritable,
  withProjectWrite,
} from "@/server/api/project-write-capability";
import {
  inspectSimpleSplitPolygon,
  splitAreasConserve,
  splitMeasurementsMatchGeometry,
  storedSplitBboxMatches,
} from "@/server/services/annotation-split-geometry";
import type { AnnotationData, ClientAnnotation } from "@/types";

/**
 * Auto-CSI merger for annotation inserts. Runs detectCsiCodes against the note text and merges
 * any detected codes into `data.csiCodes`, preserving manual entries. No-ops on empty/short
 * notes (detectCsiCodes early-returns below 10 chars), so bulk saves with no notes stay cheap.
 * Ported verbatim from the legacy route. */
function mergeAutoCsi(
  noteText: string | undefined,
  existingData: Record<string, unknown> | null | undefined,
  // [refactor jul9 P2-A C1] company CSI context (config + DB), resolved once per request
  // by the caller and threaded in so this per-annotation call adds ZERO extra I/O.
  csiCtx: CompanyCsiContext,
): Record<string, unknown> | null {
  const text = (noteText || "").trim();
  if (!text) return existingData ?? null;
  // [refactor jul9 P2-A C1] 4-arg: text-only detection (no textract words) + company config/DB.
  const auto = detectCsiCodes(text, undefined, csiCtx.config, csiCtx.db).map(
    (c) => c.code,
  );
  if (auto.length === 0) return existingData ?? null;
  const data = { ...(existingData ?? {}) };
  const manual = (data.csiCodes as string[]) || [];
  data.csiCodes = [...new Set([...manual, ...auto])];
  return data;
}

interface AnnotationInput {
  pageNumber: number;
  name: string;
  bbox: [number, number, number, number];
  note?: string;
  source?: string;
  data?: Record<string, unknown>;
  threshold?: number;
}

/** Legacy bbox validator — exact frozen messages (deliberately NOT zBboxMinMax). */
function validateBbox(bbox: number[]): string | null {
  if (!bbox || bbox.length !== 4)
    return "bbox must be [minX, minY, maxX, maxY]";
  const [minX, minY, maxX, maxY] = bbox;
  if (
    [minX, minY, maxX, maxY].some(
      (v) => typeof v !== "number" || v < 0 || v > 1,
    )
  )
    return "bbox values must be 0-1";
  if (minX >= maxX || minY >= maxY) return "bbox min must be less than max";
  return null;
}

function toClientAnnotation(
  a: typeof annotations.$inferSelect,
): ClientAnnotation {
  return {
    id: a.id,
    pageNumber: a.pageNumber,
    name: a.name,
    bbox: [a.minX, a.minY, a.maxX, a.maxY],
    note: a.note,
    source: a.source as ClientAnnotation["source"],
    data: a.data ?? null,
  };
}

const SPLIT_STALE_CONFLICT_MESSAGE =
  "Annotation changed before the split could be saved";
const SPLIT_INVALID_SOURCE_MESSAGE =
  "Annotation cannot be split in its current state";
const SPLIT_INVALID_MEASUREMENTS_MESSAGE =
  "Split measurements do not match the split geometry";
const POSTGRES_INTEGER_MAX = 2_147_483_647;

function splitSourceCasWhere(projectId: number, body: SplitAnnotationRequest) {
  return and(
    eq(annotations.id, body.sourceAnnotationId),
    eq(annotations.projectId, projectId),
    eq(annotations.pageNumber, body.expectedSource.pageNumber),
    eq(annotations.minX, body.expectedSource.bbox[0]),
    eq(annotations.minY, body.expectedSource.bbox[1]),
    eq(annotations.maxX, body.expectedSource.bbox[2]),
    eq(annotations.maxY, body.expectedSource.bbox[3]),
    eq(annotations.data, body.expectedSource.data as AnnotationData),
  );
}

// [refactor jul8 P1-review PR-C1] the local resolveByPublicId (validate-before-auth recipe) was
// hoisted byte-identical to server/api/access.ts. Call sites here pass NO opts on purpose —
// undefined ≡ allowDemo:false (api-utils gates on `options?.allowDemo`), preserving the old
// no-opts body exactly: annotation writes never allow demo. The zPublicId guard (non-uuid id →
// clean 400, not the legacy pg-uuid-cast 500) still sits AFTER field validation, so the error
// precedence the characterization tests freeze is unchanged.

/** Indirect lookup: fetch the annotation by id (404 if missing), then resolve access on its
 *  parent project (no allowDemo). parseInt has NO radix → non-numeric id → NaN → pg cast 500. */
async function verifyAnnotationAccess(annotationId: number) {
  const [annotation] = await db
    .select()
    .from(annotations)
    .where(eq(annotations.id, annotationId))
    .limit(1);
  if (!annotation) throw new ApiError("NOT_FOUND", "Not found");
  // [refactor jul9 P2-A C1] keep the resolved project (was discarded) so updateAnnotation
  // can derive companyId for the CSI resolver. Access check is byte-identical.
  const { project, writeCapability } = await resolveWritableProjectOrThrow({
    dbId: annotation.projectId,
  });
  return { annotation, project, writeCapability };
}

// ── POST /api/annotations (single + batch) ───────────────────────────────────────

/** POST /api/annotations — polymorphic: batch mode when `annotations` is an array, else single. */
export async function createAnnotation(body: Record<string, unknown>) {
  if (body.annotations && Array.isArray(body.annotations)) {
    return createAnnotationBatch(body);
  }
  return createAnnotationSingle(body);
}

/** Batch mode: { projectId, annotations: [...], deleteSource?, deletePageNumbers?, deleteIds? }.
 *  Order (frozen): projectId-required → AUTH → per-annotation bbox → delete-before-insert+insert.
 *  [TP-1 WP-1.C, K12] `deleteIds` (with `deleteSource`) replaces exactly the named rows, and only
 *  those of this project, that source AND the caller's own creatorId; the response then carries
 *  `deletedIds`. The page-wide `deletePageNumbers` path erased every template's and every user's
 *  rows on the saved pages, so it is REFUSED for `symbol-search` (a tab from an older bundle gets a
 *  400 that says to reload); other sources keep it. */
async function createAnnotationBatch(body: Record<string, unknown>) {
  const {
    projectId,
    annotations: anns,
    deleteSource,
    deletePageNumbers,
  } = body as {
    projectId?: string;
    annotations: AnnotationInput[];
    deleteSource?: string;
    deletePageNumbers?: number[];
  };

  if (!projectId) throw new ApiError("VALIDATION", "projectId required");

  const { project, session } = await resolveByPublicId(projectId, {
    allowDemo: true,
  });
  const writeCapability = assertProjectWritable(project);
  if (!session) throw new ApiError("UNAUTHORIZED", "Unauthorized");

  // [refactor jul9 P2-A C1] Resolve company CSI context ONCE, BEFORE the tx below
  // (I-1) — not per annotation. Threaded into every mergeAutoCsi call in the .map().
  const csiCtx = await getCompanyCsiContext(project.companyId);

  for (const ann of anns) {
    const err = validateBbox(ann.bbox);
    if (err) throw new ApiError("VALIDATION", `Invalid annotation: ${err}`);
  }
  const deleteIds = parseDeleteIds(body.deleteIds, deleteSource);
  if (deleteSource === "symbol-search" && deletePageNumbers !== undefined) {
    throw new ApiError("VALIDATION", "Symbol matches now save by id. Reload the page and save again.");
  }

  // [refactor jul23 P4.1 U5] Rows are built + merged BEFORE the tx (mergeAutoCsi is pure;
  // every field is tx-independent — the d120d42 batch freeze pins byte-identical behavior)
  // so each blob can be observed on the value actually persisted. Ordering is load-bearing:
  // a v-carrying INVALID item throws here and 400s the WHOLE batch BEFORE the
  // delete-before-insert runs, so a rejected batch can never leave a source's annotations
  // deleted-but-not-replaced.
  const rows = anns.map((ann) => ({
    name: ann.name,
    minX: ann.bbox[0],
    minY: ann.bbox[1],
    maxX: ann.bbox[2],
    maxY: ann.bbox[3],
    pageNumber: ann.pageNumber,
    threshold: ann.threshold ?? null,
    note: ann.note || null,
    source: ann.source || "user",
    data: mergeAutoCsi(ann.note, ann.data, csiCtx), // [refactor jul9 P2-A C1] merged above [P4.1 U5]
    creatorId: session.user.dbId,
    projectId: project.id,
  }));
  // [refactor jul23 P4.1 U5-review] batch variant: v-gate still per-row (throws pre-tx),
  // but log-mode warns aggregate to ONE per (sink, kind) per request — a drifted
  // symbol-search save must not emit hundreds of identical canary warns.
  observeAnnotationDataBatch(
    rows.map((r) => r.data),
    "annotations.createBatch",
  );

  // delete-before-insert + insert wrapped in ONE tx so a failed insert can't leave a source's
  // annotations deleted-but-not-replaced (sanctioned scope-add; happy path identical — P1.2 precedent).
  const deletedIds: number[] = [];
  const inserted = await withProjectWrite(
    writeCapability,
    project.id,
    async (tx) => {
      if (deleteIds) {
        const gone = deleteIds.length === 0 ? [] : await tx
          .delete(annotations)
          .where(
            and(
              eq(annotations.projectId, project.id),
              eq(annotations.source, deleteSource as string),
              eq(annotations.creatorId, session.user.dbId),
              inArray(annotations.id, deleteIds),
            ),
          )
          .returning({ id: annotations.id });
        deletedIds.push(...gone.map((r) => r.id).sort((a, b) => a - b));
      } else if (deleteSource && deletePageNumbers?.length) {
        for (const pn of deletePageNumbers) {
          await tx
            .delete(annotations)
            .where(
              and(
                eq(annotations.projectId, project.id),
                eq(annotations.source, deleteSource),
                eq(annotations.pageNumber, pn),
              ),
            );
        }
      }
      return tx.insert(annotations).values(rows).returning();
    },
  );

  return {
    count: inserted.length,
    annotations: inserted.map(toClientAnnotation),
    ...(deleteIds ? { deletedIds } : {}),
  };
}

const MAX_DELETE_IDS = 10_000;

/** [TP-1 WP-1.C, K12] undefined = no id-scoped replace; otherwise positive int ids + a source. */
function parseDeleteIds(raw: unknown, deleteSource: string | undefined): number[] | undefined {
  if (raw === undefined) return undefined;
  if (
    !Array.isArray(raw) ||
    raw.length > MAX_DELETE_IDS ||
    !raw.every((id) => Number.isInteger(id) && id > 0 && id <= POSTGRES_INTEGER_MAX)
  ) {
    throw new ApiError("VALIDATION", "deleteIds must be an array of annotation ids");
  }
  if (typeof deleteSource !== "string" || !deleteSource) {
    throw new ApiError("VALIDATION", "deleteIds requires deleteSource");
  }
  return [...new Set(raw as number[])];
}

/** Single-record mode (backward compatible): { projectId, pageNumber, name, bbox, note?, source?, data? }.
 *  Order (frozen): required fields → bbox geometry → AUTH → insert (no threshold field). */
async function createAnnotationSingle(body: Record<string, unknown>) {
  const { projectId, pageNumber, name, note, source, data } = body as {
    projectId?: string;
    pageNumber?: number;
    name?: string;
    note?: string;
    source?: string;
    data?: Record<string, unknown>;
  };
  const bbox = body.bbox as number[];

  // QUIRK: pageNumber 0 is falsy → treated as missing (frozen).
  if (!projectId || !pageNumber || !name || !bbox || bbox.length !== 4) {
    throw new ApiError(
      "VALIDATION",
      "projectId, pageNumber, name, and bbox required",
    );
  }

  const bboxErr = validateBbox(bbox);
  if (bboxErr) throw new ApiError("VALIDATION", bboxErr);

  const { project, session } = await resolveByPublicId(projectId, {
    allowDemo: true,
  });
  const writeCapability = assertProjectWritable(project);
  if (!session) throw new ApiError("UNAUTHORIZED", "Unauthorized");

  // [refactor jul9 P2-A C1] company CSI context (no tx here); threaded into mergeAutoCsi.
  const csiCtx = await getCompanyCsiContext(project.companyId);

  // [refactor jul23 P4.1 U1] mergeAutoCsi hoisted out of the tx callback (pure fn —
  // identical persisted value, shorter row-lock hold; the d120d42 sink freeze pins the
  // v-absent behavior byte-identical) so the shape observation sees the value ACTUALLY
  // persisted. Log-mode observe + v-gate per annotation-data-observe.ts: v-absent data
  // NEVER changes behavior (warn-only); v-carrying data must be shape-valid (400).
  const dataToPersist = mergeAutoCsi(note, data, csiCtx);
  observeAnnotationData(dataToPersist, "annotations.create");

  const annotation = await withProjectWrite(
    writeCapability,
    project.id,
    async (tx) => {
      const [created] = await tx
        .insert(annotations)
        .values({
          name,
          minX: bbox[0],
          minY: bbox[1],
          maxX: bbox[2],
          maxY: bbox[3],
          pageNumber,
          note: note || null,
          source: source || "user",
          data: dataToPersist, // [refactor jul9 P2-A C1] merged above [P4.1 U1]
          creatorId: session.user.dbId,
          projectId: project.id,
        })
        .returning();
      return created;
    },
  );

  return toClientAnnotation(annotation);
}

// ── Atomic annotation split ───────────────────────────────────────────────────

/**
 * Atomically split one persisted takeoff area. The request carries a complete source snapshot for
 * comparison and client-derived measurements, but never authoritative output geometry or metadata.
 * Both halves are recomputed from the transactionally locked source and commit together.
 */
export async function splitAnnotation(
  body: SplitAnnotationRequest,
): Promise<SplitAnnotationResponse> {
  // Indirect-resource ordering: a missing source is 404 before authentication is resolved.
  // The wire contract admits every positive safe integer, while the serial column is int4; avoid
  // turning an out-of-domain-but-valid missing ID into a PostgreSQL cast error.
  if (body.sourceAnnotationId > POSTGRES_INTEGER_MAX) {
    throw new ApiError("NOT_FOUND", "Not found");
  }
  const [sourceLocator] = await db
    .select({ projectId: annotations.projectId })
    .from(annotations)
    .where(eq(annotations.id, body.sourceAnnotationId))
    .limit(1);
  if (!sourceLocator) throw new ApiError("NOT_FOUND", "Not found");

  const { project, session, writeCapability } =
    await resolveWritableProjectOrThrow({ dbId: sourceLocator.projectId });
  if (!session) throw new ApiError("UNAUTHORIZED", "Unauthorized");

  return withProjectWrite(writeCapability, project.id, async (tx) => {
    const [source] = await tx
      .select()
      .from(annotations)
      .where(
        and(
          eq(annotations.id, body.sourceAnnotationId),
          eq(annotations.projectId, project.id),
        ),
      )
      .for("update")
      .limit(1);
    if (!source) {
      throw new ApiError("CONFLICT", SPLIT_STALE_CONFLICT_MESSAGE);
    }

    // page_number is int4 while the wire contract intentionally admits every positive safe
    // integer. A stale out-of-domain snapshot is a conflict, not a PostgreSQL cast failure.
    if (body.expectedSource.pageNumber > POSTGRES_INTEGER_MAX) {
      throw new ApiError("CONFLICT", SPLIT_STALE_CONFLICT_MESSAGE);
    }

    const [exactSource] = await tx
      .select({ id: annotations.id })
      .from(annotations)
      .where(splitSourceCasWhere(project.id, body))
      .limit(1);
    if (!exactSource) {
      throw new ApiError("CONFLICT", SPLIT_STALE_CONFLICT_MESSAGE);
    }

    if (source.source !== "takeoff") {
      throw new ApiError("CONFLICT", SPLIT_INVALID_SOURCE_MESSAGE);
    }
    const parsedArea = parseSplittableAreaData(source.data);
    if (!parsedArea.ok) {
      if (parsedArea.reason === "nonempty-holes") {
        throw new ApiError("CONFLICT", SPLIT_HOLED_TARGET_MESSAGE);
      }
      if (parsedArea.reason === "unsupported-key") {
        throw new ApiError("CONFLICT", SPLIT_UNSUPPORTED_AREA_DATA_MESSAGE);
      }
      throw new ApiError("CONFLICT", SPLIT_INVALID_SOURCE_MESSAGE);
    }

    const sourceVertices: Pt[] = parsedArea.data.vertices.map(({ x, y }) => ({
      x,
      y,
    }));
    const sourceGeometry = inspectSimpleSplitPolygon(sourceVertices);
    if (
      !sourceGeometry ||
      !storedSplitBboxMatches(
        [source.minX, source.minY, source.maxX, source.maxY],
        sourceGeometry.bbox,
      )
    ) {
      throw new ApiError("CONFLICT", SPLIT_INVALID_SOURCE_MESSAGE);
    }

    if (parsedArea.data.takeoffItemId > POSTGRES_INTEGER_MAX) {
      throw new ApiError("CONFLICT", SPLIT_INVALID_SOURCE_MESSAGE);
    }

    const [item] = await tx
      .select()
      .from(takeoffItems)
      .where(
        and(
          eq(takeoffItems.id, parsedArea.data.takeoffItemId),
          eq(takeoffItems.projectId, project.id),
        ),
      )
      .for("update")
      .limit(1);
    if (!item || item.shape !== "polygon") {
      throw new ApiError("CONFLICT", SPLIT_INVALID_SOURCE_MESSAGE);
    }

    const split = splitPolygonByLine(
      sourceVertices,
      { x: body.lineA.x, y: body.lineA.y },
      { x: body.lineB.x, y: body.lineB.y },
    );
    if (!split) throw new ApiError("CONFLICT", SPLIT_INVALID_SOURCE_MESSAGE);

    const outputVertexLimit = SPLIT_ANNOTATION_MAX_SOURCE_VERTICES + 2;
    const leftGeometry =
      split.left.length <= outputVertexLimit
        ? inspectSimpleSplitPolygon(split.left)
        : null;
    const rightGeometry =
      split.right.length <= outputVertexLimit
        ? inspectSimpleSplitPolygon(split.right)
        : null;
    if (
      !leftGeometry ||
      !rightGeometry ||
      !splitAreasConserve(
        sourceGeometry.area,
        leftGeometry.area,
        rightGeometry.area,
      )
    ) {
      throw new ApiError("CONFLICT", SPLIT_INVALID_SOURCE_MESSAGE);
    }

    if (
      !splitMeasurementsMatchGeometry(
        body.measurements.leftAreaSqUnits,
        body.measurements.rightAreaSqUnits,
        leftGeometry.area,
        rightGeometry.area,
      )
    ) {
      throw new ApiError("CONFLICT", SPLIT_INVALID_MEASUREMENTS_MESSAGE);
    }

    const extensions = {
      ...(parsedArea.data.csiCodes === undefined
        ? {}
        : { csiCodes: [...parsedArea.data.csiCodes] }),
      ...(parsedArea.data.keywords === undefined
        ? {}
        : { keywords: [...parsedArea.data.keywords] }),
    };
    const leftData: AnnotationData = {
      type: "area-polygon",
      takeoffItemId: item.id,
      color: item.color,
      vertices: split.left.map(({ x, y }) => ({ x, y })),
      areaSqUnits: body.measurements.leftAreaSqUnits,
      unit: body.measurements.unit,
      ...extensions,
    };
    const rightData: AnnotationData = {
      type: "area-polygon",
      takeoffItemId: item.id,
      color: item.color,
      vertices: split.right.map(({ x, y }) => ({ x, y })),
      areaSqUnits: body.measurements.rightAreaSqUnits,
      unit: body.measurements.unit,
      ...extensions,
    };

    // The project/source locks serialize sanctioned writers. This complete physical CAS remains
    // load-bearing defense against any writer that bypasses that protocol.
    const [left] = await tx
      .update(annotations)
      .set({
        minX: leftGeometry.bbox[0],
        minY: leftGeometry.bbox[1],
        maxX: leftGeometry.bbox[2],
        maxY: leftGeometry.bbox[3],
        data: leftData,
        updatedAt: new Date(),
      })
      .where(splitSourceCasWhere(project.id, body))
      .returning();
    if (!left) throw new ApiError("CONFLICT", SPLIT_STALE_CONFLICT_MESSAGE);

    const [right] = await tx
      .insert(annotations)
      .values({
        projectId: project.id,
        pageNumber: source.pageNumber,
        name: item.name,
        minX: rightGeometry.bbox[0],
        minY: rightGeometry.bbox[1],
        maxX: rightGeometry.bbox[2],
        maxY: rightGeometry.bbox[3],
        note: null,
        source: "takeoff",
        data: rightData,
        threshold: null,
        creatorId: session.user.dbId,
      })
      .returning();

    return {
      left: toClientAnnotation(left),
      right: toClientAnnotation(right),
    };
  });
}

// ── PUT/DELETE /api/annotations/[id] ──────────────────────────────────────────────

/** PUT /api/annotations/[id] — partial update + auto-CSI merge from the note. NO bbox validation
 *  (frozen). Returns {success, autoCsiCodes}. */
export async function updateAnnotation(
  idParam: string,
  body: Record<string, unknown>,
) {
  // [refactor jul9 P2-A C1] verifyAnnotationAccess now returns { annotation, project };
  // project.companyId feeds the CSI resolver for the auto-CSI detect below.
  const { annotation, project, writeCapability } = await verifyAnnotationAccess(
    parseInt(idParam),
  );

  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.note !== undefined) updates.note = body.note;
  if (body.data !== undefined) updates.data = body.data;
  if (body.bbox) {
    const bbox = body.bbox as number[];
    updates.minX = bbox[0];
    updates.minY = bbox[1];
    updates.maxX = bbox[2];
    updates.maxY = bbox[3];
  }

  // Auto-CSI-tag: detect CSI codes from note text and merge with manual codes.
  let autoCsiCodes: string[] = [];
  const noteText = (body.note as string) || "";
  if (noteText.trim()) {
    // [refactor jul9 P2-A C1] 4-arg: thread company config + DB (D-1/D-2).
    const csiCtx = await getCompanyCsiContext(project.companyId);
    autoCsiCodes = detectCsiCodes(
      noteText,
      undefined,
      csiCtx.config,
      csiCtx.db,
    ).map((c) => c.code);
  }

  if (autoCsiCodes.length > 0) {
    // When the PUT is note-only (no `data` in request), seed from the existing row so detected
    // codes merge in instead of being silently dropped. Manual codes always win (Set dedupe).
    const data =
      (updates.data as Record<string, unknown> | undefined) ??
      (annotation.data as Record<string, unknown> | null) ??
      {};
    const manualCodes = (data.csiCodes as string[]) || [];
    data.csiCodes = [...new Set([...manualCodes, ...autoCsiCodes])];
    updates.data = data;
  }

  // [refactor jul23 P4.1 U6] Observe the data column's final value whenever this PUT will
  // write it (body.data replace AND/OR the auto-csi seed above) — post-seed, post-auth,
  // pre-tx, same contract as the create sinks: v-absent logs only, v-carrying must be valid.
  // [U6-hazard] The v-gate arms ONLY when the client supplied fresh data (body.data). A
  // note-only PUT re-persists the EXISTING row's blob (seeded above) — the historic corpus
  // may carry a coincidental `v` key, and an existing wire must never 400 (Verdict 2).
  if (updates.data !== undefined) {
    observeAnnotationData(updates.data, "annotations.update", {
      gate: body.data !== undefined,
    });
  }

  updates.updatedAt = new Date();

  await withProjectWrite(writeCapability, project.id, async (tx) => {
    await tx
      .update(annotations)
      .set(updates)
      .where(
        and(
          eq(annotations.id, annotation.id),
          eq(annotations.projectId, project.id),
        ),
      );
  });

  return { success: true, autoCsiCodes };
}

/** DELETE /api/annotations/[id] — removes the annotation row (annotation_group_members cascade). */
export async function deleteAnnotation(idParam: string) {
  // [refactor jul9 P2-A C1] verifyAnnotationAccess now returns { annotation, project }.
  const { annotation, project, writeCapability } = await verifyAnnotationAccess(
    parseInt(idParam),
  );
  await withProjectWrite(writeCapability, project.id, async (tx) => {
    await tx
      .delete(annotations)
      .where(
        and(
          eq(annotations.id, annotation.id),
          eq(annotations.projectId, project.id),
        ),
      );
  });
  return { success: true as const };
}

// ── POST /api/annotations/batch-delete ───────────────────────────────────────────

/** POST /api/annotations/batch-delete — { projectId, annotationIds: number[] }. Single
 *  project-scoped DELETE (tenancy). Order (frozen): field validation → AUTH → delete. */
export async function batchDeleteAnnotations(body: Record<string, unknown>) {
  const { projectId, annotationIds } = body as {
    projectId?: unknown;
    annotationIds?: unknown;
  };

  if (!projectId || typeof projectId !== "string")
    throw new ApiError("VALIDATION", "projectId required");
  if (!Array.isArray(annotationIds) || annotationIds.length === 0) {
    throw new ApiError(
      "VALIDATION",
      "annotationIds required (non-empty array)",
    );
  }
  if (annotationIds.some((id) => !Number.isInteger(id))) {
    throw new ApiError("VALIDATION", "annotationIds must be integers");
  }

  const { project } = await resolveByPublicId(projectId, { allowDemo: true });
  const writeCapability = assertProjectWritable(project);

  try {
    const deleted = await withProjectWrite(writeCapability, project.id, (tx) =>
      tx
        .delete(annotations)
        .where(
          and(
            eq(annotations.projectId, project.id),
            inArray(annotations.id, annotationIds as number[]),
          ),
        )
        .returning({ id: annotations.id }),
    );

    return {
      success: true,
      deletedCount: deleted.length,
      deletedIds: deleted.map((r) => r.id),
    };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    // Was a raw-pg-leak 500 (err.message); now: server log + generic envelope (no leak).
    logger.error("[annotations/batch-delete] Failed:", err);
    throw new ApiError("INTERNAL", "Internal server error");
  }
}
