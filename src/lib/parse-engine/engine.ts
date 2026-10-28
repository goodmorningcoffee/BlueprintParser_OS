/**
 * The parse engine entry point (table pipeline PLAN §1.2–§1.5, §2.1; WP-3.D fills the WP-2.E stub, rule 13).
 * Server-side (it reads the printed title through `server/services/parse-engine/title.ts` and the R8 profile from
 * disk); never imported by the client, which previews corrections with the pure `ops.ts` instead (§1.1 row 12).
 *
 * `runParseEngine(evidence, request)` parses ONE box (plus continuation `parts`) of ONE page from the page's stored
 * evidence, plus the crop evidence the run service gathered BEFORE the call (`EnginePageEvidenceWithCrops.crops`:
 * rulings at `standard`, the paid Textract crop / TATR at `thorough`; rule 11 — no heavy work happens here):
 *
 * 1. **title** — `deriveTitle` over the page words (printed header band / above-the-box line, `CONFIDENT_NAME` bar);
 * 2. **kind** — `engine-kind.ts`: the request's kind ≻ the owning proposal's class ≻ the box's own reading (both
 *    families probed); `kindSuggestion` is returned whenever the request did not name the kind;
 * 3. **model** — tables (schedule / keynote / legend) through `engine-table.ts` (rows R1–R12, columns R7, cells E-1,
 *    headers, tag column R9), paragraphs (notes / spec) through `engine-paragraphs.ts` (`paragraphs/segment.ts`);
 *    ids re-matched to `request.prior` (band IoU ≥ .5);
 * 4. **result** — `alternatives[]` with each method's geometry (the client's `pin-source` preview), the region words
 *    (the client's `applyOps` preview), `EvidenceAvailability`, and the `EngineStamp`: engine version, the
 *    capability versions used, one line per method (`used`, `error`, `cached` from the crop cache), budget,
 *    evidence hash, `paramsHash` (request without `prior` + the R8 profile) and `at`.
 *
 * Determinism (E-7): the same evidence and request give a byte-equal result except `stamp.at`, which is the run time
 * unless `options.at` pins it (the goldens and tests pin it). A paid method that was asked for and has no value
 * (cap reached, failed, no runner) raises the quality flag `paid-evidence-skipped`.
 */

import { deriveTitle } from "@/server/services/parse-engine/title";
import { kindFromBox, kindFromRequest, owningProposalOf, type KindDecision } from "./engine-kind";
import { parseParagraphs } from "./engine-paragraphs";
import { parseTable, type MethodRun, type TableParseOutput } from "./engine-table";
import { centreIn } from "./geometry";
import { parseEngineProfile, type ParseEngineProfile } from "./profile";
import { stableHash } from "./snapshot";
import {
  PARSE_ENGINE_VERSION,
  type BboxMinMax,
  type Capability,
  type EnginePageEvidence,
  type EngineStamp,
  type EvidenceAvailability,
  type ParseRequest,
  type ParseResult,
  type StructureKind,
  type StructureModel,
  type StructureTitle,
} from "./types";
import type { CropMethodId, CropMethodOutcome, CropTextractEvidence, EnginePageEvidenceWithCrops } from "./types-crop";
import type { CropRulings } from "./types-cols";
import { CAPABILITY_VERSIONS } from "./version";

export interface RunParseEngineOptions {
  /** `stamp.at` (ISO time). Default: now. Pin it for byte-equal results. */
  at?: string;
  /** R8 weights. Default: the shipped `src/data/parse-engine/profile.json` (`profile.ts`; `{v:1,id:"default"}` = R8). */
  profile?: ParseEngineProfile;
}

const TABLE_CAPS: readonly Capability[] = ["evidence", "rows", "cols", "cells", "headers", "tagColumn", "title", "kind"];
const PARAGRAPH_CAPS: readonly Capability[] = ["evidence", "paragraphs", "title", "kind"];

const isTableKind = (k: StructureKind): k is "schedule" | "keynote" | "legend" => k === "schedule" || k === "keynote" || k === "legend";

function validBox(b: unknown): b is BboxMinMax {
  return Array.isArray(b) && b.length === 4 && b.every((v) => typeof v === "number" && Number.isFinite(v)) && b[2] > b[0] && b[3] > b[1];
}

function textractCropOf(crops: EnginePageEvidenceWithCrops["crops"]): CropTextractEvidence | undefined {
  const v = crops?.textract?.value as CropTextractEvidence | undefined;
  return v && Array.isArray(v.words) && Array.isArray(v.tables) ? v : undefined;
}

function rulingsOf(crops: EnginePageEvidenceWithCrops["crops"]): { value: CropRulings; box: BboxMinMax } | undefined {
  const o = crops?.rulings;
  const v = o?.value as CropRulings | undefined;
  return o && v && Array.isArray(v.rows) && Array.isArray(v.cols) ? { value: v, box: o.box } : undefined;
}

/** Which evidence exists for the box (`ParseResult.evidence`). */
function availability(ev: EnginePageEvidence, boxes: readonly BboxMinMax[], table: TableParseOutput | null, crop: CropTextractEvidence | undefined, rulings: ReturnType<typeof rulingsOf>): EvidenceAvailability {
  const inAny = (b: BboxMinMax): boolean => boxes.some((x) => centreIn(b, x));
  const out: EvidenceAvailability = {
    words: ev.words.filter((w) => inAny(w.b)).length,
    lines: ev.lines.filter((l) => inAny(l.b)).length,
    paidCropAvailable: !crop,
  };
  const tables = crop?.tables.length ? crop.tables : ev.textractTables;
  if (table && table.textractCover !== null) {
    const cells = tables.flatMap((t) => t.cells).filter((c) => centreIn(c.b, boxes[0]));
    out.textractTable = { containment: Math.round(table.textractCover * 1000) / 1000, cells: cells.length, spans: cells.some((c) => c.rs > 1 || c.cs > 1), cached: crop?.tables.length ? "crop" : "page" };
  }
  const col = table?.fused.shapeColumn;
  if (col) {
    const yolo = col.shapes.filter((s) => s.src === "yolo").length;
    out.shapeColumn = { source: yolo * 2 >= col.shapes.length ? "yolo" : "classical", shapeClass: col.shapeClass, n: col.shapes.length, gapCv: col.gapCv === null ? null : Math.round(col.gapCv * 1000) / 1000 };
  }
  const prims = ev.primitives.filter((p) => inAny(p.b));
  if (prims.length) out.primitiveCover = { grid: prims.filter((p) => p.cls === "grid").length, vArea: prims.filter((p) => p.cls === "vertical_area").length, hArea: prims.filter((p) => p.cls === "horizontal_area").length };
  if (rulings) out.rulings = { h: rulings.value.rows.length, v: rulings.value.cols.length };
  const layout = (ev.layout ?? []).filter((b) => inAny(b.b));
  if (layout.length) out.layout = { list: layout.filter((b) => b.k === "list").length, text: layout.filter((b) => b.k === "text").length, header: layout.filter((b) => b.k === "section-header" || b.k === "title").length };
  return out;
}

/** Stamp lines for the crop methods (their `cached` flag and errors), merged into the geometry methods' lines. */
function withCropMethods(methods: MethodRun[], crops: EnginePageEvidenceWithCrops["crops"]): EngineStamp["methods"] {
  const out: EngineStamp["methods"] = methods.map((m) => ({ ...m }));
  const idOf: Record<CropMethodId, EngineStamp["methods"][number]["id"]> = { textract: "textract-cells", rulings: "rulings", img2table: "img2table", tatr: "tatr" };
  for (const [method, o] of Object.entries(crops ?? {}) as [CropMethodId, CropMethodOutcome][]) {
    if (!o) continue;
    const id = idOf[method];
    const line = out.find((m) => m.id === id);
    if (line) {
      if (o.cached) line.cached = true;
      if (o.error && !line.used) line.error = o.error;
    } else {
      out.push({ id, v: 0, conf: 0, used: false, ...(o.error ? { error: o.error } : { error: "unsupported" }), ...(o.cached ? { cached: true as const } : {}) });
    }
  }
  return out;
}

function paidSkipped(request: ParseRequest, crops: EnginePageEvidenceWithCrops["crops"]): boolean {
  if (request.budget !== "thorough") return false;
  if (request.hints?.allowPaidTextract && !textractCropOf(crops)) return true;
  if (request.hints?.tatr && crops?.tatr?.value === undefined) return true;
  return false;
}

function addFlag(model: StructureModel, flag: string): StructureModel {
  if (model.quality.flags.includes(flag)) return model;
  return { ...model, quality: { ...model.quality, flags: [...model.quality.flags, flag].sort() } } as StructureModel;
}

/**
 * Parse one box of one page from the page's stored evidence (+ gathered crops). Deterministic (E-7) up to
 * `stamp.at`. Heavy evidence is gathered by the server run service before this is called (rule 11).
 */
export async function runParseEngine(evidence: EnginePageEvidence, request: ParseRequest, options: RunParseEngineOptions = {}): Promise<ParseResult> {
  if (!validBox(request.bbox) || !(request.parts ?? []).every(validBox)) throw new Error("parse engine: every box must have a positive width and height");
  const crops = (evidence as EnginePageEvidenceWithCrops).crops;
  const { crops: _drop, ...ev } = evidence as EnginePageEvidenceWithCrops;
  void _drop;
  const profile = options.profile ?? parseEngineProfile();
  const textractCrop = textractCropOf(crops);
  const rulings = rulingsOf(crops);
  const boxes = [request.bbox, ...(request.parts ?? [])];

  // 1. printed title (server-side band; E-8)
  const titlePick = deriveTitle(ev.words.map((w) => ({ t: w.t, b: w.b })), request.bbox);
  const title: StructureTitle | undefined = titlePick.title;

  // 2. kind
  const proposal = owningProposalOf(ev.proposals, request.bbox, request.hints?.proposalId);
  let decision: KindDecision | null = kindFromRequest(request.kind, proposal);
  const tableFor = (kind: "schedule" | "keynote" | "legend", classId: string | null): TableParseOutput =>
    parseTable({ ev, request, kind, classId, title, titleBottom: titlePick.titleBottom, profile, textractCrop, rulings });
  let table: TableParseOutput | null = null;
  let paragraphs: ReturnType<typeof parseParagraphs> | null = null;
  if (!decision) {
    table = tableFor("schedule", null);
    paragraphs = parseParagraphs({ ev, request, title, textractCrop });
    const k = kindFromBox(paragraphs.doc, table.model.cols.length);
    decision = { kind: k.kind, classId: null, p: k.p, src: "box" };
  }

  // 3. model
  let model: StructureModel;
  let words: ParseResult["words"];
  let alternatives: ParseResult["alternatives"] = [];
  let methods: MethodRun[];
  let caps: readonly Capability[];
  if (isTableKind(decision.kind)) {
    if (!table || table.model.kind !== decision.kind || decision.classId) table = tableFor(decision.kind, decision.classId);
    model = table.model;
    words = table.words;
    alternatives = table.alternatives;
    methods = table.methods;
    caps = TABLE_CAPS;
  } else {
    const kind = decision.kind;
    if (!paragraphs || paragraphs.doc.kind !== kind) paragraphs = parseParagraphs({ ev, request, kind, title, textractCrop });
    model = paragraphs.doc;
    words = paragraphs.words;
    methods = model.sources.segment.map((id) => ({ id, v: 1, conf: model.quality.conf, used: true }));
    caps = PARAGRAPH_CAPS;
  }
  if (paidSkipped(request, crops)) model = addFlag(model, "paid-evidence-skipped");

  // 4. result
  const { prior: _prior, ...requestNoPrior } = request;
  void _prior;
  const stamp: EngineStamp = {
    engine: PARSE_ENGINE_VERSION,
    caps: Object.fromEntries(caps.map((c) => [c, CAPABILITY_VERSIONS[c]])) as EngineStamp["caps"],
    methods: withCropMethods(methods, crops),
    budget: request.budget,
    evidenceHash: ev.evidenceHash,
    paramsHash: stableHash({ engine: PARSE_ENGINE_VERSION, request: requestNoPrior, profile }),
    at: options.at ?? new Date().toISOString(),
  };
  const result: ParseResult = {
    model,
    alternatives,
    evidence: availability(ev, boxes, isTableKind(decision.kind) ? table : null, textractCrop, rulings),
    words,
    stamp,
  };
  if (decision.src !== "request") {
    result.kindSuggestion = { kind: decision.kind, classId: decision.classId, p: decision.p, ...(model.title?.text ? { title: model.title.text } : {}) };
  }
  return result;
}
