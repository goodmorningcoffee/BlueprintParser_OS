/**
 * Replay core (table pipeline WP-3.D; PLAN §1.3 E-6, §1.1 row 7; TP-5 replay, WP-3.G rebase). Server-side.
 *
 * A committed region carries its recipe (`data.recipe`: the parse request), its ops (`data.ops`) and the stamp of
 * the engine that produced it (`data.engine`). Replay = re-run the recipe on the page's CURRENT evidence with the
 * stored model as `prior` (so row / column / paragraph ids re-match at band IoU ≥ .5), then re-apply the ops by id.
 * The stored model is the CORRECTED one; when its ops changed a band it carries `opsBase` (the machine band ids the
 * ops were recorded on, set by `applyOps`), and the engine re-matches against that, never against the corrected
 * bands. Otherwise an `add-line` at ≤ 50 % would hand the fresh full row the minted id, and the replayed edit on
 * that id would land on the other half without being reported (WP-3.D verify HIGH-1).
 * The same step is the commit's rebase when the evidence changed under a draft (WP-3.G step 3): every op must land,
 * else the rebase is refused.
 *
 *   replayPlan(data)                 → what a stored region would replay (stale capabilities, recipe, ops), or null
 *   replayRegion(evidence, recipe, ops, prior, run?)  → { result, model, landed, lost, diff }
 *
 * `staleCapabilities` (version.ts) names the capabilities whose stamped version is behind the current one; a region
 * with none is current and needs no replay (TP-5 offers replay per stale capability).
 */

import { runParseEngine, type RunParseEngineOptions } from "./engine";
import { applyOpsDetailed } from "./ops";
import { diffSnapshots, snapshotOf, type SnapshotDiff } from "./snapshot";
import type {
  Capability,
  CorrectionOp,
  EnginePageEvidence,
  EngineStamp,
  ParseRecipe,
  ParseRequest,
  ParseResult,
  StructureModel,
} from "./types";
import { staleCapabilities } from "./version";

export { staleCapabilities };

export interface ReplayPlan {
  stale: Capability[];
  recipe: ParseRecipe;
  ops: CorrectionOp[];
  prior: StructureModel | null;
}

/**
 * What a stored region `data` would replay; null when it carries no recipe (a classic save). `prior` is the stored
 * (corrected) model as is: its `opsBase` is what the re-parse re-matches against.
 */
export function replayPlan(data: { structure?: StructureModel; engine?: EngineStamp; recipe?: ParseRecipe; ops?: CorrectionOp[] } | null | undefined): ReplayPlan | null {
  if (!data?.recipe?.request) return null;
  return {
    stale: staleCapabilities(data.engine?.caps),
    recipe: data.recipe,
    ops: Array.isArray(data.ops) ? data.ops : [],
    prior: data.structure ?? null,
  };
}

export interface ReplayOutcome {
  /** The fresh parse (before ops). */
  result: ParseResult;
  /** The fresh parse with the ops re-applied. */
  model: StructureModel;
  landed: boolean[];
  /** Indices of the ops that no longer land. */
  lost: number[];
  /** Fresh model vs the prior model (rows / cells that changed), when a prior was given. */
  diff: SnapshotDiff | null;
}

export type EngineRunner = (evidence: EnginePageEvidence, request: ParseRequest, options?: RunParseEngineOptions) => Promise<ParseResult>;

/** Replay = recipe + ops on the current evidence (see the file header). */
export async function replayRegion(
  evidence: EnginePageEvidence,
  recipe: ParseRecipe,
  ops: readonly CorrectionOp[],
  prior: StructureModel | null,
  run: EngineRunner = runParseEngine,
  options: RunParseEngineOptions = {},
): Promise<ReplayOutcome> {
  const request: ParseRequest = { ...recipe.request, ...(prior ? { prior } : {}) };
  if (!request.kind && prior) request.kind = prior.kind;
  const result = await run(evidence, request, options);
  const applied = applyOpsDetailed(result, ops);
  const lost = applied.landed.flatMap((ok, i) => (ok ? [] : [i]));
  return {
    result,
    model: applied.model,
    landed: applied.landed,
    lost,
    diff: prior ? diffSnapshots(snapshotOf(prior), snapshotOf(applied.model)) : null,
  };
}
