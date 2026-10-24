// [2026-10-24 master Reprocess tab, phase 1] The stage DAG behind Admin › Reprocess, kept free of
// React and fetch so it can be unit-tested. One checklist replaces the ~12 buttons on 7 tabs that
// all reached the five branches of POST /api/admin/reprocess (full | intelligence | page-names |
// thumbnails | shape-parse) plus the root-only annotation cleanup. Nothing here changes what the
// server does: a plan is a SEQUENCE of today's requests, run one after another, projects-inner
// (each request holds its own `admin-reprocess` lease per project, exactly as the old buttons did).
//
// Dependency edges (gitignore/projects/master_plan_2026-10-24/notes/reprocess_master_tab.md §2):
// ticking a stage auto-includes the stages its output invalidates, each with the reason shown in
// the UI. An auto-included stage can be unticked; the plan then carries a "leaves … stale" warning.
// Ordering is fixed by the DAG, never by click order.

export type ReprocessScopeId = "full" | "intelligence" | "page-names" | "thumbnails" | "shape-parse" | "tiles";

export type StageId =
  | "thumbnails"
  | "page-names"
  | "yolo-run"
  | "yolo-load"
  | "yolo-restamp"
  | "purge-yolo"
  | "dedupe"
  | "full"
  | "shape-parse"
  | "intelligence"
  | "evidence"
  | "tiles"
  | "re-ocr";

/**
 * reprocess   — one POST /api/admin/reprocess?scope=… (admin)
 * cleanup     — POST /api/admin/annotation-cleanup (root; dry run + server-checked typed phrase)
 * handoff     — lives on another tab (model-centric UX stays there); the row links to it
 * placeholder — planned stage with no server work yet ("coming soon")
 * unavailable — does not exist as a rerun (Re-OCR) and is shown disabled with the reason
 */
export type StageKind = "reprocess" | "cleanup" | "handoff" | "placeholder" | "unavailable";

export interface StagePull {
  stage: StageId;
  /** Why the stage is pulled in — rendered next to the auto-ticked checkbox. */
  reason: string;
  /** What stays stale if the pulled stage is unticked. */
  stale: string;
}

export interface StageDef {
  id: StageId;
  label: string;
  /** One line: what it rewrites. */
  writes: string;
  /** One line: where the cost lands. */
  cost: string;
  kind: StageKind;
  scope?: ReprocessScopeId;
  cleanup?: { mode: "delete" | "dedupe"; sources: string[] };
  /** For handoffs: the admin tab that owns the control (an AdminTabs id). */
  handoffTab?: "ai-models" | "csi";
  rootOnly?: boolean;
  /** Deletes rows — requires the server's typed phrase. */
  destructive?: boolean;
  /** Where this stage's work overlaps another's, in plain words. */
  overlap?: string;
  pulls: StagePull[];
}

const PULL_FULL_THEN_INTEL = (because: string): StagePull[] => [
  { stage: "full", reason: `CSI + text annotations added because ${because}`, stale: "pages.csi_codes / text_annotations" },
  { stage: "intelligence", reason: `Intelligence added because ${because}`, stale: "pages.page_intelligence, project analysis" },
];

/** DAG order. The checklist renders in this order and plans run in this order. */
export const STAGES: readonly StageDef[] = [
  {
    id: "thumbnails",
    label: "Thumbnails + page images",
    writes: "S3 thumbnails/page_NNNN.png (72 DPI) and pages/page_NNNN.png (300 DPI); no DB rows",
    cost: "rasterizes every page in the web container, 2 S3 PUTs per page",
    kind: "reprocess",
    scope: "thumbnails",
    overlap: "Shape parse reads the regenerated page images — re-run it only if the images changed.",
    pulls: [],
  },
  {
    id: "page-names",
    label: "Page names (drawing numbers)",
    writes: "pages.drawing_number, pages.name (hand-typed names kept)",
    cost: "DB + local CPU; uses existing OCR and any YOLO title-block annotations",
    kind: "reprocess",
    scope: "page-names",
    pulls: PULL_FULL_THEN_INTEL("the drawing number feeds CSI discipline context and page classification"),
  },
  {
    id: "yolo-run",
    label: "YOLO run (SageMaker)",
    writes: "processing_jobs rows + S3 yolo-output/{model}/page_*.json",
    cost: "SageMaker Processing jobs — the only paid compute here",
    kind: "handoff",
    handoffTab: "ai-models",
    rootOnly: true,
    overlap: "Results are loaded automatically; then run CSI + text annotations and Intelligence here.",
    pulls: [],
  },
  {
    id: "yolo-load",
    label: "YOLO load (results → annotations)",
    writes: "annotations source=yolo (replace per model), partial page_intelligence keys, pages.csi_codes ∪ class codes",
    cost: "S3 reads + DB",
    kind: "handoff",
    handoffTab: "ai-models",
    rootOnly: true,
    overlap: "Load does a PARTIAL intelligence merge and only ADDS CSI codes — Full + Intelligence rebuild them exactly.",
    pulls: [],
  },
  {
    id: "yolo-restamp",
    label: "Re-stamp YOLO class tags",
    writes: "annotations.data.csiCodes / keywords from the model's current class config",
    cost: "DB only",
    kind: "handoff",
    handoffTab: "csi",
    overlap: "A re-Load of the model achieves the same and also refreshes page keys.",
    pulls: [],
  },
  {
    id: "purge-yolo",
    label: "Delete YOLO annotations",
    writes: "DELETE annotations source=yolo in the scope (optionally pages.csi_codes = NULL)",
    cost: "DB only; cannot be undone",
    kind: "cleanup",
    cleanup: { mode: "delete", sources: ["yolo"] },
    rootOnly: true,
    destructive: true,
    overlap: "Supersedes AI Models › Purge All, which only ever purged your own company.",
    pulls: PULL_FULL_THEN_INTEL("deleted YOLO rows leave YOLO-class CSI codes and YOLO-derived intelligence stale"),
  },
  {
    id: "dedupe",
    label: "Remove exact-duplicate annotations",
    writes: "DELETE surplus rows identical on page, source, name, box and model (keeps the oldest); recomputes project summaries",
    cost: "DB only; cannot be undone",
    kind: "cleanup",
    cleanup: { mode: "dedupe", sources: ["yolo", "shape-parse"] },
    rootOnly: true,
    destructive: true,
    pulls: [
      { stage: "intelligence", reason: "Intelligence added because page intelligence is derived from the annotation rows", stale: "pages.page_intelligence" },
    ],
  },
  {
    id: "full",
    label: "CSI + text annotations",
    writes: "pages.csi_codes (text-detected ∪ current YOLO-class codes, exact replace), pages.text_annotations (user notes kept), project summaries",
    cost: "DB + local CPU; pages without OCR are skipped",
    kind: "reprocess",
    scope: "full",
    overlap: "Recomputes project summaries itself but NOT page intelligence — Intelligence is added for that.",
    pulls: [
      { stage: "intelligence", reason: "Intelligence added because page intelligence derives from the CSI codes this rewrites", stale: "pages.page_intelligence, project analysis" },
    ],
  },
  {
    id: "shape-parse",
    label: "Shape parse (keynotes)",
    writes: "annotations source=shape-parse (compute-then-swap per page), pages.keynotes",
    cost: "Lambda fan-out when enabled, else local python; failed pages keep their old shapes",
    kind: "reprocess",
    scope: "shape-parse",
    pulls: [
      { stage: "intelligence", reason: "Intelligence added because project summaries read keynotes and annotations (inferred, not measured)", stale: "project summaries" },
    ],
  },
  {
    id: "intelligence",
    label: "Intelligence + project analysis",
    writes: "pages.page_intelligence (all computed keys), projects.project_intelligence, project_summary, summaries",
    cost: "DB + local CPU; classifier debug also writes S3 bundles",
    kind: "reprocess",
    scope: "intelligence",
    overlap: "Includes project analysis and summaries — nothing further needs to run after it.",
    pulls: [],
  },
  {
    id: "evidence",
    label: "Evidence",
    writes: "evidence ensembles per page (planned)",
    cost: "—",
    kind: "placeholder",
    pulls: [],
  },
  {
    // [tiles T9 2026-10-24] services/reprocess-tiles.ts — depends only on the page raster.
    id: "tiles",
    label: "Tile images",
    writes: "S3 tiles/L{size}/page_NNNN/r{row}_c{col}.png + pages/page_NNNN/tiles.json; pageIntelligence.tiles (sizes + counts only)",
    cost: "downloads every 300-DPI page PNG, cuts ~90 tiles per 24x36 sheet in python ON THE WEB TASK (minutes of its CPU per large project), ~90 S3 PUTs per page; runs even when upload tiling is switched off",
    kind: "reprocess",
    scope: "tiles",
    rootOnly: true,
    overlap: "Cut from pages/page_NNNN.png — re-run after Thumbnails + page images only if those rasters changed.",
    pulls: [],
  },
  {
    id: "re-ocr",
    label: "Re-OCR (Textract)",
    writes: "pages.textract_data, raw_text",
    cost: "Textract per page + ECS task time",
    kind: "unavailable",
    overlap: "No admin rerun exists: OCR only runs at ingest and skips pages that already have OCR. Needs server work (phase 5).",
    pulls: [],
  },
];

const BY_ID = new Map<StageId, StageDef>(STAGES.map((s) => [s.id, s]));
export const stageDef = (id: StageId): StageDef => BY_ID.get(id)!;
const ORDER = new Map<StageId, number>(STAGES.map((s, i) => [s.id, i]));

/** Runnable from this tab (checkbox rows). Handoffs, placeholders and Re-OCR are rendered without one. */
export const isRunnable = (s: StageDef): boolean => s.kind === "reprocess" || s.kind === "cleanup";

export type ReprocessPreset =
  | "full-refresh"
  | "detectors-changed"
  | "rules-changed"
  | "page-names"
  | "after-yolo"
  | "clean-yolo"
  | "thumbnails"
  | "shape-parse"
  | "tiles";

export interface PresetDef {
  id: ReprocessPreset;
  label: string;
  /** Explicit ticks; the DAG adds the rest. */
  stages: StageId[];
  rootOnly?: boolean;
  /** What the old button(s) this replaces were called — shown as a hint on redirected tabs. */
  replaces: string;
}

export const PRESETS: readonly PresetDef[] = [
  { id: "full-refresh", label: "Full refresh", stages: ["page-names", "full", "shape-parse", "intelligence"], replaces: "Overview › Re-run All Processes" },
  { id: "detectors-changed", label: "Detectors changed", stages: ["full", "intelligence"], replaces: "Text Annotations / CSI › Reprocess All Projects, Page Intelligence › Full Reprocess" },
  { id: "rules-changed", label: "Rules changed", stages: ["intelligence"], replaces: "Heuristics › Reprocess All Projects, Page Intelligence › Reprocess Intelligence" },
  { id: "page-names", label: "Page names", stages: ["page-names"], replaces: "Page Intelligence › Reprocess Page Names" },
  { id: "after-yolo", label: "After YOLO load", stages: ["full", "intelligence"], replaces: "the Full + Intelligence runs the AI Models tab told you to do" },
  { id: "clean-yolo", label: "Clean YOLO + rebuild", stages: ["purge-yolo"], rootOnly: true, replaces: "AI Models › Purge All (then Full + Intelligence)" },
  { id: "thumbnails", label: "Thumbnails", stages: ["thumbnails"], replaces: "Pipeline › Regenerate Thumbnails" },
  { id: "shape-parse", label: "Shape parse", stages: ["shape-parse"], replaces: "Pipeline › Shape Parse (Keynotes)" },
  { id: "tiles", label: "Tile images", stages: ["tiles"], rootOnly: true, replaces: "nothing — new 2026-10-24 (backfills the tile pyramid for projects uploaded before it)" },
];

export const presetDef = (id: ReprocessPreset): PresetDef | undefined => PRESETS.find((p) => p.id === id);
export const isPreset = (v: unknown): v is ReprocessPreset => typeof v === "string" && PRESETS.some((p) => p.id === v);

export interface PlanStep {
  id: StageId;
  def: StageDef;
  /** Ticked by the user (false = pulled in by a dependency edge). */
  explicit: boolean;
  /** Why it was pulled in (empty for explicit stages). */
  reasons: string[];
  /** Auto-included but unticked by the user: shown greyed, not run. */
  excluded: boolean;
}

export interface Plan {
  /** Every stage in DAG order that is explicit or pulled in — including excluded ones, for display. */
  steps: PlanStep[];
  /** Steps that will actually run. */
  run: PlanStep[];
  /** "Leaves X stale" lines for excluded auto-includes. */
  warnings: string[];
  /** Server-checked phrase required before the run; null when nothing is deleted. */
  confirmPhrase: "DELETE" | "DEDUPE" | null;
}

/**
 * Resolve ticks into an ordered plan. `excluded` holds auto-included stages the user unticked; an
 * exclusion only applies while the stage is NOT ticked explicitly. Non-root users never get
 * root-only stages pulled in (they could not run them).
 */
export function resolvePlan(selected: ReadonlySet<StageId>, excluded: ReadonlySet<StageId>, isRootAdmin: boolean): Plan {
  const reasons = new Map<StageId, string[]>();
  const stale = new Map<StageId, string[]>();
  const explicit = new Set<StageId>();
  for (const id of selected) {
    const def = BY_ID.get(id);
    if (!def || !isRunnable(def) || (def.rootOnly && !isRootAdmin)) continue;
    explicit.add(id);
  }
  // Transitive closure over pull edges (the graph is tiny and acyclic; a visited set guards anyway).
  const queue = [...explicit];
  const seen = new Set<StageId>(explicit);
  while (queue.length) {
    const from = BY_ID.get(queue.shift()!)!;
    for (const pull of from.pulls) {
      const target = BY_ID.get(pull.stage)!;
      if (!isRunnable(target) || (target.rootOnly && !isRootAdmin)) continue;
      if (!explicit.has(pull.stage)) {
        reasons.set(pull.stage, [...(reasons.get(pull.stage) ?? []), pull.reason]);
        stale.set(pull.stage, [...(stale.get(pull.stage) ?? []), `${from.label} → ${pull.stale}`]);
      }
      if (!seen.has(pull.stage)) {
        seen.add(pull.stage);
        queue.push(pull.stage);
      }
    }
  }
  const steps: PlanStep[] = [...seen]
    .sort((a, b) => ORDER.get(a)! - ORDER.get(b)!)
    .map((id) => ({
      id,
      def: BY_ID.get(id)!,
      explicit: explicit.has(id),
      reasons: reasons.get(id) ?? [],
      excluded: !explicit.has(id) && excluded.has(id),
    }));
  const run = steps.filter((s) => !s.excluded);
  const warnings = steps
    .filter((s) => s.excluded)
    .map((s) => `${s.def.label} unticked — leaves stale: ${(stale.get(s.id) ?? []).join("; ")}`);
  const confirmPhrase = run.some((s) => s.def.cleanup?.mode === "delete")
    ? "DELETE"
    : run.some((s) => s.def.cleanup?.mode === "dedupe")
      ? "DEDUPE"
      : null;
  return { steps, run, warnings, confirmPhrase };
}

/** The ticks a preset makes (root-only stages dropped for non-root). */
export function presetTicks(id: ReprocessPreset, isRootAdmin: boolean): Set<StageId> {
  const preset = presetDef(id);
  if (!preset) return new Set();
  return new Set(preset.stages.filter((s) => isRootAdmin || !stageDef(s).rootOnly));
}

/** What the scope picker resolved to. `projectIds` undefined = the server's own predicate ("All"). */
export interface ResolvedScope {
  projectIds: string[] | undefined;
  /** Own company id from GET /api/admin/reprocess/scope — pins the cleanup route to the same company. */
  companyId: number | null;
}

export type RunStep =
  | { kind: "reprocess"; id: StageId; label: string; scope: ReprocessScopeId; projectIds: string[] | undefined }
  | {
      kind: "cleanup";
      id: StageId;
      label: string;
      url: string;
      body: { mode: "delete" | "dedupe"; all?: true; projectPublicIds?: string[]; sources: string[]; clearPageCsi: boolean };
    };

export interface CleanupOptions {
  /** Delete stage: also NULL pages.csi_codes. */
  clearPageCsi: boolean;
  /** Source overrides per cleanup stage (defaults from the stage def). */
  sources?: Partial<Record<StageId, string[]>>;
}

/** Turn a plan + scope into the requests to make, in order. Pure; nothing is sent here. */
export function buildRunSteps(plan: Plan, scope: ResolvedScope, cleanup: CleanupOptions): RunStep[] {
  const out: RunStep[] = [];
  for (const step of plan.run) {
    const def = step.def;
    if (def.kind === "reprocess" && def.scope) {
      out.push({ kind: "reprocess", id: def.id, label: def.label, scope: def.scope, projectIds: scope.projectIds });
    } else if (def.kind === "cleanup" && def.cleanup) {
      const query = scope.companyId !== null ? `?companyId=${scope.companyId}` : "";
      out.push({
        kind: "cleanup",
        id: def.id,
        label: def.label,
        url: `/api/admin/annotation-cleanup${query}`,
        body: {
          mode: def.cleanup.mode,
          ...(scope.projectIds ? { projectPublicIds: scope.projectIds } : { all: true as const }),
          sources: cleanup.sources?.[def.id] ?? def.cleanup.sources,
          clearPageCsi: def.cleanup.mode === "delete" && cleanup.clearPageCsi,
        },
      });
    }
  }
  return out;
}

export interface ScopeProject {
  id: string;
  name: string;
  status: string;
  isDemo: boolean;
  companyId?: number;
  companyName?: string;
}

export type ScopeMode = "all" | "status" | "select";

/**
 * Which project ids a run sends. "all" sends none (the server's predicate: own company, non-demo,
 * any status). "status" and "select" send explicit ids from the listed projects, dropping demo
 * projects (the server would too) and, for root, projects of other companies (the server silently
 * drops those — the picker says so instead).
 */
export function resolveProjectIds(
  mode: ScopeMode,
  projects: readonly ScopeProject[],
  statuses: ReadonlySet<string>,
  picked: ReadonlySet<string>,
  ownCompanyId: number | null,
): string[] | undefined {
  if (mode === "all") return undefined;
  const inCompany = (p: ScopeProject) => ownCompanyId === null || p.companyId === undefined || p.companyId === ownCompanyId;
  if (mode === "status") {
    return projects.filter((p) => !p.isDemo && inCompany(p) && statuses.has(p.status)).map((p) => p.id);
  }
  return projects.filter((p) => picked.has(p.id) && !p.isDemo && inCompany(p)).map((p) => p.id);
}

export const PROJECT_STATUSES = ["completed", "processing", "error", "uploading"] as const;

/** Header line for one stage in the console. */
export const stageHeader = (index: number, total: number, label: string): string => `--- Stage ${index + 1}/${total}: ${label} ---`;
