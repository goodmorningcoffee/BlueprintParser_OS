/**
 * POST /api/table-parse on the parse engine (`tablesRoute = engine`; table pipeline PLAN §3.3 G, §3.4 U01/U02/U09;
 * WP-3.I, K15, K20, K27). Called only by `server/services/table-parse.ts` after its own validation, access, demo
 * gate, company CSI context and "Page has no OCR data" checks; with `tablesRoute = legacy` this module never runs
 * and the classic route is byte-equal to TP-2.
 *
 * The three classic callers (Tables › Auto Parse, the proposal hint path "Parse this table" / "Accept with tags",
 * Specs/Notes › Keynotes › Auto) send the same body as before. Here:
 *   - **the engine is the merge base**: one `runParse` (WP-3.E run service) replaces the five classic methods and
 *     `mergeGrids`. The kind is a TABLE kind, because every classic caller reads a grid: the owning proposal's class
 *     when it names a keynote or legend table, else `schedule` (a box the kind head would read as notes is still
 *     returned as a grid here). Rows come from the engine's fusion, so a keynote or schedule box with a column of
 *     aligned tag shapes is cut at the shape centres (R2, K27) and a hinted proposal's stored anchors are the prior
 *     (R6, `hints.proposalId` from the request body);
 *   - **budget**: `standard` (crop rulings, the engine's replacement for the classic full-page OpenCV lines). When the
 *     page's stored Textract tables do not cover the box (the classic route's ≥ 30 % rule) and the call is not a demo
 *     call, `thorough` with the paid Textract crop: it is read through the S3 crop cache first and charged like the
 *     classic live crop (company cap, root exempt) only on a miss, and the result is cached (K17), so a re-parse of
 *     the same box is free. Demo and signed-out calls stay at `standard`, never pay and never write a cache (C1-M8);
 *   - **response**: the legacy projection of the model (`legacyView`: headers, rows, tagColumn, rowCount,
 *     columnCount, colBoundaries, rowBoundaries, tableName when a title was read) — so the response's grid IS the
 *     projection of `structure` — plus the classic summary fields (`confidence`, `methods`, `disagreements`),
 *     `csiTags` from the region-level detector with the company's CSI context (K15, `regionCsi`, the commit's one
 *     copy), `infraErrors: []`, and the engine's own `structure` and `engine` stamp. Debug adds `alternatives`,
 *     `evidence`, `infraStages: []` and `totalDurationMs`. The classic tuning knobs (`rowTolerance`, `minColGap`, …,
 *     `rowSource`) are not read by the engine;
 *   - **history**: the admin parse history (`op_log`) gets one entry as before (no `methodResults`: the engine's
 *     methods are geometry, not grids); a failed history write is logged, never a 500.
 * No project or page row is written here (the classic client persists through promote as before).
 */

import { randomUUID } from "crypto";
import { addToHistory, type ParseHistoryEntry } from "@/lib/parse-history";
import { logger } from "@/lib/logger";
import type { AuthSession, ProjectAccessScope } from "@/lib/api-utils";
import type { CompanyCsiContext } from "@/lib/csi-company-db";
import { kindFromClassId, owningProposalOf } from "@/lib/parse-engine/engine-kind";
import { legacyView, type LegacyGridView } from "@/lib/parse-engine/legacy-view";
import type { BboxMinMax, EngineProposal, ParseEngineFlags, ParseRequest, ParseResult, StructureKind } from "@/lib/parse-engine/types";
import { regionCsi } from "@/server/services/parse-engine/commit";
import { defaultRunParseDeps, isDemoCall, runParse, type ParseCaller, type ParseProject, type RunParseDeps } from "@/server/services/parse-engine/run";

/** The longest `proposalId` forwarded as a hint (the commit route's id cap). */
const MAX_PROPOSAL_ID = 300;

export interface ClassicEngineInput {
  project: ParseProject;
  session: AuthSession | null;
  scope: ProjectAccessScope | null;
  /** Trusted client address (the concurrency key of a signed-out demo caller). */
  ip: string;
  pageNumber: number;
  regionBbox: BboxMinMax;
  /** The page's stored Textract tables cover the box (the classic ≥ 30 % overlap rule): no paid crop is needed. */
  storedTableCovers: boolean;
  /** The request body's `proposalId` (unvalidated). */
  proposalId: unknown;
  csiCtx: Pick<CompanyCsiContext, "config" | "db"> | null;
  flags: ParseEngineFlags;
  /** The effective debug mode (request flag or the admin's persistent override). */
  debugMode: boolean;
  /** The request's own debug flag, for the history entry. */
  requestDebugMode: boolean;
}

export interface ClassicEngineDeps {
  run: RunParseDeps;
  addToHistory(entry: ParseHistoryEntry): Promise<void>;
  now(): number;
}

export const defaultClassicEngineDeps: ClassicEngineDeps = {
  run: defaultRunParseDeps,
  addToHistory,
  now: () => Date.now(),
};

/** The table kind a classic grid caller gets: the owning proposal's keynote / legend class, else `schedule`. */
export function classicTableKind(proposals: readonly EngineProposal[], bbox: BboxMinMax, proposalId?: string): Exclude<StructureKind, "notes" | "spec"> {
  const k = kindFromClassId(owningProposalOf(proposals, bbox, proposalId)?.classId);
  return k === "keynote" || k === "legend" ? k : "schedule";
}

/** The classic `methods` summary rows: the fused result first, then one row per engine method in stamp order. */
function methodSummary(result: ParseResult, view: LegacyGridView): ParseHistoryEntry["response"]["methods"] {
  const fused = { name: "engine", confidence: result.model.quality.conf, gridShape: [view.rowCount, view.columnCount] as [number, number] };
  return [fused, ...result.stamp.methods.map((m) => {
    const alt = result.alternatives.find((a) => a.method === m.id);
    return {
      name: m.id,
      confidence: m.used ? m.conf : 0,
      gridShape: (alt ? [alt.rows, alt.cols] : [0, 0]) as [number, number],
      ...(m.error ? { error: m.error } : {}),
    };
  })];
}

/** One classic `/api/table-parse` request on the engine. Returns the response body (the shell wraps it). */
export async function tableParseOnEngine(input: ClassicEngineInput, deps: ClassicEngineDeps = defaultClassicEngineDeps): Promise<Record<string, unknown>> {
  const startedAt = deps.now();
  const caller: ParseCaller = {
    userId: typeof input.session?.user?.dbId === "number" ? input.session.user.dbId : null,
    isRoot: input.session?.user?.isRootAdmin === true,
    ip: input.ip,
  };
  const proposalId = typeof input.proposalId === "string" && input.proposalId && input.proposalId.length <= MAX_PROPOSAL_ID ? input.proposalId : undefined;
  const paid = !input.storedTableCovers && !isDemoCall(input.project, caller, input.scope);
  const request: ParseRequest = {
    page: input.pageNumber,
    bbox: input.regionBbox,
    budget: paid ? "thorough" : "standard",
    ...(proposalId || paid ? { hints: { ...(proposalId ? { proposalId } : {}), ...(paid ? { allowPaidTextract: true } : {}) } } : {}),
  };
  // The kind is decided on the loaded evidence (its stored proposals), inside the run, before the engine call.
  const run: RunParseDeps = {
    ...deps.run,
    runEngine: (evidence, req) => deps.run.runEngine(evidence, { ...req, kind: classicTableKind(evidence.proposals, req.bbox, req.hints?.proposalId) }),
  };
  const result = await runParse({ project: input.project, caller, scope: input.scope, request, flags: input.flags }, run);
  const view = legacyView(result.model) as LegacyGridView;
  const csiTags = regionCsi(result.model, view, input.csiCtx).map((c) => ({ code: c.code, description: c.description }));
  const methods = methodSummary(result, view);
  const totalDurationMs = deps.now() - startedAt;

  const history: ParseHistoryEntry = {
    id: randomUUID(),
    timestamp: new Date(startedAt).toISOString(),
    request: {
      projectId: input.project.id,
      pageNumber: input.pageNumber,
      regionBbox: input.regionBbox,
      debugMode: input.requestDebugMode,
      options: { route: "engine", budget: request.budget, kind: result.model.kind, ...(proposalId ? { proposalId } : {}) },
    },
    response: {
      status: 200,
      durationMs: totalDurationMs,
      headers: view.headers,
      rowCount: view.rowCount,
      confidence: result.model.quality.conf,
      tagColumn: view.tagColumn,
      methods,
      methodResults: [],
      infraStages: [],
      infraErrors: [],
    },
  };
  try {
    await deps.addToHistory(history);
  } catch (err) {
    logger.warn(`[table-parse] op_log history write failed for page ${input.pageNumber} (engine):`, err);
  }

  const body: Record<string, unknown> = {
    ...view,
    confidence: result.model.quality.conf,
    methods,
    disagreements: [],
    csiTags,
    infraErrors: [],
    structure: result.model,
    engine: result.stamp,
  };
  if (input.debugMode) {
    body.alternatives = result.alternatives;
    body.evidence = result.evidence;
    body.infraStages = [];
    body.totalDurationMs = totalDurationMs;
  }
  return body;
}
