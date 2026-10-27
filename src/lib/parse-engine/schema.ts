/**
 * Runtime validation of the parse-engine contract (PLAN §2.1 caps; WP-2.E).
 *
 * zod schemas for everything a client sends or the engine stores: the parse request (with continuation
 * `parts`), the correction ops (incl. `set-lines` and `set-col-role`), both structure models (incl. a
 * schedule's own `notes` block), region links (incl. `continues`) and the `data.*` extension a commit
 * writes. Every object is STRICT: an unknown key is refused rather than silently stored. The caps come
 * from `PARSE_ENGINE_CAPS` in `./types`; a payload over a cap fails validation (the engine itself
 * stores an over-cap model truncated, with the flag `truncated`, so a valid engine result always
 * passes).
 *
 * Not in the client-safe subset (E-8): it imports zod. Server routes (TP-3 parse / commit) and tests
 * import it by path.
 */

import { z } from "zod";
import {
  COL_ROLES,
  METHOD_IDS,
  PARSE_ENGINE_CAPS as CAPS,
  STRUCTURE_KINDS,
  type BboxMinMax,
  type Capability,
  type ColRole,
  type MethodId,
  type StructureKind,
} from "./types";

const SHORT = 128;
const LABEL = CAPS.cellText;

const zUnit = z.number().finite().min(0).max(1);
export const zBboxMinMax = z
  .tuple([zUnit, zUnit, zUnit, zUnit])
  .refine((b) => b[0] <= b[2] && b[1] <= b[3], { message: "bbox must be MinMax [x0,y0,x1,y1] with x0<=x1, y0<=y1" }) as unknown as z.ZodType<BboxMinMax>;
const zId = z.string().min(1).max(SHORT);
const zKind = z.enum(STRUCTURE_KINDS as [StructureKind, ...StructureKind[]]);
const zMethod = z.enum(METHOD_IDS as [MethodId, ...MethodId[]]);
const zColRole = z.enum(COL_ROLES as [ColRole, ...ColRole[]]);
const zAxis = z.enum(["rows", "cols"]);
const zCount = z.number().int().min(0);
const zProb = z.number().finite().min(0).max(1);
const zLines = z.array(zUnit).max(CAPS.rows + 1); // the cols axis is capped tighter in `set-lines` (VERIFY LOW-3)
const zIso = z.string().min(1).max(64);
/** Runtime capability ids; the contract test ties this list to `CAPABILITIES` (version.ts). */
export const CAPABILITY_IDS = [
  "evidence", "rows", "cols", "cells", "headers", "tagColumn", "title", "kind", "csi", "paragraphs", "refs", "tagMap",
] as const satisfies readonly Capability[];

export const zCsiRef = z.strictObject({
  code: z.string().min(1).max(32),
  description: z.string().max(LABEL),
  conf: zProb.optional(),
  src: z.enum(["engine", "company", "user"]),
});

export const zRowKey = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("text"), text: z.string().max(LABEL) }),
  z.strictObject({
    kind: z.literal("shape-text"), text: z.string().max(LABEL).nullable(), shapeClass: z.string().max(SHORT),
    shapeBbox: zBboxMinMax, textSource: z.enum(["inside", "crop", "user"]),
  }),
  z.strictObject({ kind: z.literal("symbol"), shapeBbox: zBboxMinMax, yoloClass: z.string().max(SHORT).optional() }),
]);

const zTitle = z.strictObject({
  text: z.string().max(LABEL),
  src: z.enum(["header-band", "above", "proposal", "user"]),
  conf: zProb,
});
const zQuality = z.strictObject({ conf: zProb, agreement: zProb, flags: z.array(z.string().max(SHORT)).max(64) });

export const zStructureParagraphDoc = z.strictObject({
  v: z.literal(1),
  kind: z.enum(["notes", "spec"]),
  bbox: zBboxMinMax,
  title: zTitle.optional(),
  spec: z.strictObject({ section: z.string().max(SHORT).optional() }).optional(),
  blocks: z.array(z.strictObject({
    id: zId, header: z.string().max(LABEL).nullable(), headerNorm: z.string().max(LABEL).nullable(),
    b: zBboxMinMax, continued: z.literal(true).optional(),
  })).max(CAPS.paragraphs),
  paragraphs: z.array(z.strictObject({
    id: zId, blockId: zId,
    key: z.string().max(SHORT).nullable(),
    keyPath: z.array(z.string().max(SHORT)).max(16),
    keyNorm: z.string().max(SHORT),
    depth: z.number().int().min(0).max(16),
    text: z.string().max(CAPS.paragraphText),
    b: zBboxMinMax,
    lineCount: zCount,
    csi: z.array(zCsiRef).max(32).optional(),
  })).max(CAPS.paragraphs),
  sources: z.strictObject({ segment: z.array(zMethod).max(METHOD_IDS.length) }),
  quality: zQuality,
});

export const zStructureTableModel = z.strictObject({
  v: z.literal(1),
  kind: z.enum(["schedule", "keynote", "legend"]),
  bbox: zBboxMinMax,
  parts: z.array(zBboxMinMax).max(CAPS.parts).optional(),
  title: zTitle.optional(),
  classId: z.string().max(SHORT).optional(),
  rows: z.array(z.strictObject({
    id: zId, y0: zUnit, y1: zUnit, part: z.number().int().min(0).max(CAPS.parts).optional(),
    role: z.enum(["header", "body", "section", "footer"]), key: zRowKey.optional(), csi: z.array(zCsiRef).max(32).optional(),
  })).max(CAPS.rows),
  cols: z.array(z.strictObject({
    id: zId, x0: zUnit, x1: zUnit, label: z.string().max(LABEL), labelRaw: z.string().max(LABEL),
    group: z.string().max(LABEL).optional(), role: zColRole.optional(),
  })).max(CAPS.cols),
  cells: z.array(z.strictObject({
    row: zId, col: zId, rs: z.number().int().min(1).optional(), cs: z.number().int().min(1).optional(),
    text: z.string().max(CAPS.cellText), b: zBboxMinMax.optional(),
    src: z.union([zMethod, z.literal("edit")]), conf: zProb.optional(), csi: z.array(zCsiRef).max(32).optional(),
  })).max(CAPS.cells),
  headerRows: z.number().int().min(0).max(CAPS.rows),
  tag: z.strictObject({
    col: zId, src: z.enum(["shape", "header", "body", "user"]), shapeClass: z.string().max(SHORT).optional(),
    pattern: z.string().max(SHORT).optional(), scope: z.enum(["sheet", "project"]),
  }).optional(),
  notes: zStructureParagraphDoc.optional(),
  sources: z.strictObject({ rows: z.array(zMethod).max(METHOD_IDS.length), cols: z.array(zMethod).max(METHOD_IDS.length) }),
  quality: zQuality,
});

export const zStructureModel = z.union([zStructureTableModel, zStructureParagraphDoc]);

export const zParseRequest = z.strictObject({
  page: z.number().int().min(1),
  bbox: zBboxMinMax,
  kind: zKind.optional(),
  parts: z.array(zBboxMinMax).max(CAPS.parts).optional(),
  budget: z.enum(["instant", "standard", "thorough"]),
  hints: z.strictObject({
    proposalId: z.string().min(1).max(256).optional(),
    headerRows: z.number().int().min(0).max(CAPS.rows).optional(),
    tagCol: z.number().int().min(0).max(CAPS.cols).optional(),
    expectedCols: z.number().int().min(1).max(CAPS.cols).optional(),
    tatr: z.boolean().optional(),
    allowPaidTextract: z.boolean().optional(),
  }).optional(),
  prior: zStructureModel.optional(),
});

export const zCorrectionOp = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("pin-source"), axis: zAxis, method: zMethod.nullable() }),
  z.strictObject({ op: z.literal("set-lines"), axis: zAxis, at: zLines })
    .refine((o) => o.at.length <= (o.axis === "cols" ? CAPS.cols : CAPS.rows) + 1, { message: "set-lines: at most cap + 1 lines on that axis", path: ["at"] }),
  z.strictObject({ op: z.literal("move-line"), axis: zAxis, after: zId, at: zUnit }),
  z.strictObject({ op: z.literal("add-line"), axis: zAxis, at: zUnit }),
  z.strictObject({ op: z.literal("remove-line"), axis: zAxis, after: zId }),
  z.strictObject({ op: z.literal("user-boxes"), rows: z.array(zBboxMinMax).max(CAPS.rows), cols: z.array(zBboxMinMax).max(CAPS.cols) }),
  z.strictObject({ op: z.literal("set-header-rows"), n: z.number().int().min(0).max(CAPS.rows) }),
  z.strictObject({ op: z.literal("set-tag-col"), col: zId.nullable() }),
  z.strictObject({ op: z.literal("set-tag-scope"), scope: z.enum(["sheet", "project"]) }),
  z.strictObject({ op: z.literal("set-col-role"), col: zId, role: zColRole.nullable() }),
  z.strictObject({ op: z.literal("rename-col"), col: zId, label: z.string().max(LABEL) }),
  z.strictObject({ op: z.literal("edit-cell"), row: zId, col: zId, text: z.string().max(CAPS.cellText) }),
  z.strictObject({ op: z.literal("merge-cells"), row: zId, col: zId, rs: z.number().int().min(1).max(CAPS.rows), cs: z.number().int().min(1).max(CAPS.cols) }),
  z.strictObject({ op: z.literal("set-row-key"), row: zId, text: z.string().max(LABEL) }),
  z.strictObject({ op: z.literal("split-paragraph"), p: zId, atLine: z.number().int().min(1) }),
  z.strictObject({ op: z.literal("merge-paragraph"), p: zId }),
  z.strictObject({ op: z.literal("set-paragraph-key"), p: zId, key: z.string().max(SHORT).nullable() }),
  z.strictObject({ op: z.literal("mark-block-header"), lineIndex: z.number().int().min(0) }),
  z.strictObject({
    op: z.literal("set-csi"),
    target: z.strictObject({ row: zId.optional(), p: zId.optional() }).refine((t) => (t.row === undefined) !== (t.p === undefined), { message: "set-csi targets exactly one of row / p" }),
    codes: z.array(zCsiRef).max(32),
  }),
  z.strictObject({ op: z.literal("set-title"), text: z.string().max(LABEL) }),
  z.strictObject({ op: z.literal("set-kind"), kind: zKind, classId: z.string().max(SHORT).optional() }),
]);
export const zCorrectionOps = z.array(zCorrectionOp).max(CAPS.ops);

export const zEngineStamp = z.strictObject({
  engine: z.string().min(1).max(SHORT),
  caps: z.partialRecord(z.enum(CAPABILITY_IDS), z.number().int().min(0)),
  methods: z.array(z.strictObject({
    id: zMethod, v: z.number().int().min(0), conf: zProb, used: z.boolean(),
    error: z.string().max(LABEL).optional(), cached: z.literal(true).optional(),
  })).max(METHOD_IDS.length * 2),
  budget: z.enum(["instant", "standard", "thorough"]),
  evidenceHash: z.string().max(SHORT),
  paramsHash: z.string().max(SHORT),
  at: zIso,
});

export const zParseRecipe = z.strictObject({
  request: zParseRequest,
  origin: z.enum(["proposal", "draw", "text-region", "saved", "classic"]),
});

export const zRegionLinks = z.strictObject({
  origin: z.enum(["workspace", "classic-engine"]),
  revision: z.number().int().min(0),
  viewHash: z.string().min(1).max(SHORT),
  proposalId: z.string().min(1).max(256).optional(),
  textRegionKey: z.string().min(1).max(256).optional(),
  continues: zId.optional(),
  acceptedAt: zIso,
  acceptedBy: z.number().int().optional(),
});

export const zRegionDataExt = z.strictObject({
  structure: zStructureModel.optional(),
  links: zRegionLinks.optional(),
  engine: zEngineStamp.optional(),
  recipe: zParseRecipe.optional(),
  ops: zCorrectionOps.optional(),
});
