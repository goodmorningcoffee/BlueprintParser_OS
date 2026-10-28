/**
 * parse-engine-leg.ts — the ENGINE leg of scripts/parse-engine-measure.ts and the per-tool promotion table
 * (table-pipeline WP-3.Q; PLAN §5 WP-3.Q, §6.2–§6.4).
 *
 * The engine leg runs `runParseEngine` on the same page slice every legacy leg reads (the gold region as the box, the
 * `instant` budget: stored evidence only, no Python, no paid crop — the same evidence the offline legacy merger sees,
 * which also skips opencv / img2table). Evidence goes through the REAL loader (`buildPageEvidence`), the slice's tag
 * shapes are passed as the fused shape set. The kind is the one the tool under test would request (`ENGINE_KIND`).
 * `runParseEngine` is async, so the leg is PRECOMPUTED (`engineLeg`) and `measure` stays synchronous and pure.
 *
 * The prediction is read from the structure model, not from the legacy projection: a table's body and section rows
 * as cells in column order (header and footer rows dropped, like the legacy grids), a paragraph doc's paragraphs as
 * `{key, text}` items in model order. Nothing here returns or prints drawing text.
 */
import { buildPageEvidence } from "@/server/services/parse-engine/evidence";
import { runParseEngine } from "@/lib/parse-engine/engine";
import type { ParseEngineProfile } from "@/lib/parse-engine/profile";
import type { EnginePageEvidence, ParseEngineToolId, ParseRequest, StructureKind, StructureModel, StructureTableModel } from "@/lib/parse-engine/types";
import { HEADLINE_GAPS, measure, promotionVerdict, type Item, type Leg, type PairedCI, type Prediction, type Unit, type UnitGold } from "./parse-measure";

/** A pinned run time, so two runs of the leg are byte-equal (E-7). */
export const ENGINE_LEG_AT = "2026-10-28T00:00:00.000Z";

/** The kind the tool under test requests for a gold stratum (PLAN §6.1 strata). */
export const ENGINE_KIND: Record<string, StructureKind> = {
  "shape-tag-schedule": "schedule", "ruled-no-shape": "schedule", unruled: "schedule", "two-tier-wrapped": "schedule", "continued-split": "schedule",
  "keynote-legend-shapes": "keynote", "kv-legend": "keynote", "symbol-legend": "legend",
  "spec-hierarchy": "spec", notes: "notes", "multi-column-notes": "notes",
};

export function engineKindOf(u: Pick<Unit, "gold" | "stratum">): StructureKind {
  return ENGINE_KIND[u.stratum] ?? (u.gold === "G-TAB" ? "schedule" : "notes");
}

type SliceShape = { bbox: [number, number, number, number]; label: string; source?: "yolo" | "classical"; text?: string | null };

/** Engine evidence of one page slice through the real loader (words → visual lines, Textract tables), plus its tag shapes. */
export function sliceEvidence(slice: Unit["slice"]): EnginePageEvidence {
  const page = slice.page as { words?: unknown[]; tables?: unknown[] | null };
  const loaded = buildPageEvidence({
    pageNumber: 1, drawingNumber: null, keynotes: null, csiCodes: null,
    words: (page.words ?? []) as never, tables: (page.tables ?? null) as never, layout: null,
    pageZones: null, regionsV2: null, parsedRegions: null, channels: null, classifierProposals: null, yolo: [],
  }, { recompute: true });
  const { sources: _sources, ...ev } = loaded;
  void _sources;
  const shapes = ((slice.shapes ?? []) as unknown as SliceShape[]).filter((s) => Array.isArray(s?.bbox) && s.bbox.length === 4);
  return {
    ...ev,
    shapes: shapes.map((s) => ({ b: s.bbox, cls: s.label, src: s.source === "classical" ? "classical" : "yolo", text: s.text ?? null, textSrc: s.text ? ("crop" as const) : null })),
  };
}

const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, " ").trim();

/** A structure model as a measurable prediction (grid for tables, items for paragraph docs; both for both). */
export function enginePrediction(model: StructureModel): Prediction {
  if ("paragraphs" in model) {
    const items: Item[] = model.paragraphs.map((p) => ({ key: p.key ?? "", text: oneLine(p.text) }));
    return { items, grid: items.map((x) => [x.key, x.text]) };
  }
  return tableGrid(model);
}

function tableGrid(model: StructureTableModel): Prediction {
  const cols = model.cols.slice().sort((a, b) => a.x0 - b.x0);
  const colIndex = new Map(cols.map((c, i) => [c.id, i]));
  const byRow = new Map<string, string[]>();
  for (const c of model.cells) {
    const ci = colIndex.get(c.col);
    if (ci === undefined) continue;
    const row = byRow.get(c.row) ?? byRow.set(c.row, new Array<string>(cols.length).fill("")).get(c.row)!;
    row[ci] = row[ci] ? `${row[ci]} ${oneLine(c.text)}` : oneLine(c.text);
  }
  const grid = model.rows
    .filter((r) => r.role === "body" || r.role === "section")
    .map((r) => {
      const cells = byRow.get(r.id) ?? new Array<string>(cols.length).fill("");
      // a section row is one merged cell in the gold; give it as one cell when the model put its text in one column
      if (r.role === "section") { const filled = cells.filter((c) => c.trim()); return filled.length <= 1 ? [filled[0] ?? ""] : cells; }
      return cells;
    });
  return { grid, items: grid.map((r) => ({ key: r[0] ?? "", text: r.slice(1).filter((c) => c.trim()).join(" ") })) };
}

export interface EngineLegOptions {
  /** Leg id (default "engine"). Two legs with different profiles need different ids. */
  id?: string;
  /** R8 weights (default: the shipped profile, `src/data/parse-engine/profile.json`). */
  profile?: ParseEngineProfile;
  /** Test seam: the engine call (default `runParseEngine` with the pinned `at`). */
  runner?: (evidence: EnginePageEvidence, request: ParseRequest, profile?: ParseEngineProfile) => Promise<{ model: StructureModel }>;
}

export interface PrecomputedLeg extends Leg { errors: number; ran: string[] }

const defaultRunner: NonNullable<EngineLegOptions["runner"]> = (ev, req, profile) => runParseEngine(ev, req, { at: ENGINE_LEG_AT, ...(profile ? { profile } : {}) });

/** One engine prediction per unit, computed now; the returned leg reads them back synchronously. A unit the engine
 *  throws on scores as an empty prediction (counted in `errors`, like a legacy leg that throws). */
export async function engineLeg(units: readonly Unit[], o: EngineLegOptions = {}): Promise<PrecomputedLeg> {
  const runner = o.runner ?? defaultRunner;
  const preds = new Map<string, Prediction>();
  const ran: string[] = [];
  let errors = 0;
  for (const u of units) {
    ran.push(u.goldId);
    try {
      const res = await runner(sliceEvidence(u.slice), { page: 1, bbox: u.slice.region, budget: "instant", kind: engineKindOf(u) }, o.profile);
      preds.set(u.goldId, enginePrediction(res.model));
    } catch {
      errors++;
      preds.set(u.goldId, { grid: null, items: null });
    }
  }
  return {
    id: o.id ?? "engine",
    applies: (u: Unit) => preds.has(u.goldId),
    run: (u: Unit) => preds.get(u.goldId) ?? { grid: null, items: null },
    errors,
    ran,
  };
}

// ─── the per-tool promotion table (§6.4) ─────────────────────────────────────

export interface PromotionTool {
  tool: Exclude<ParseEngineToolId, "workspace">;
  gold: UnitGold["gold"];
  strata: readonly string[];
  /** The legacy leg the tool runs today (its §6.4 baseline). */
  baseline: string;
  /** Where the flag is read (MEASURED by grep at the TP-3 g3 head 8e30e81), or null when nothing reads it. */
  readBy: string | null;
}

const SCHEDULE_STRATA = ["shape-tag-schedule", "ruled-no-shape", "unruled", "two-tier-wrapped", "continued-split"] as const;
const KEYNOTE_STRATA = ["keynote-legend-shapes", "kv-legend", "symbol-legend"] as const;
const NOTES_STRATA = ["notes", "multi-column-notes"] as const;

export const PROMOTION_TOOLS: readonly PromotionTool[] = [
  { tool: "tablesRoute", gold: "G-TAB", strata: SCHEDULE_STRATA, baseline: "legacy:merger", readBy: "server/services/table-parse.ts" },
  { tool: "keynoteRoute", gold: "G-TAB", strata: KEYNOTE_STRATA, baseline: "legacy:merger", readBy: null },
  { tool: "notesClassifier", gold: "G-PARA", strata: NOTES_STRATA, baseline: "legacy:notes-auto", readBy: "server/services/regions.ts" },
  { tool: "notesAuto", gold: "G-PARA", strata: NOTES_STRATA, baseline: "legacy:notes-auto", readBy: "server/services/notes-parse.ts, reprocess.ts" },
  { tool: "specClassifier", gold: "G-PARA", strata: ["spec-hierarchy"], baseline: "legacy:spec-auto", readBy: "server/services/regions.ts" },
  { tool: "specAuto", gold: "G-PARA", strata: ["spec-hierarchy"], baseline: "legacy:spec-auto", readBy: "server/services/spec-parse.ts" },
];

/** The units a tool is scored on. */
export const toolUnits = (t: PromotionTool, units: readonly Unit[]): Unit[] => units.filter((u) => u.gold === t.gold && t.strata.includes(u.stratum));

export interface ToolVerdict {
  tool: PromotionTool["tool"]; readBy: string | null; gold: UnitGold["gold"]; baseline: string;
  units: number; byStratum: Record<string, number>;
  metrics: Record<string, PairedCI>;
  /** §6.4 over every §6.3 headline (the unmeasured ones withhold promote). */
  strict: ReturnType<typeof promotionVerdict>;
  /** §6.4 over the MEASURED headlines only (what the narrowed set would say if the owner accepts it). */
  measured: ReturnType<typeof promotionVerdict>;
}

/** The §6.4 table per tool on the given (held-out) units: the tool's legacy baseline vs `engineLegId`. */
export function promotionTable(units: readonly Unit[], legs: readonly Leg[], engineLegId: string, o: { seed?: number; resamples?: number } = {}): ToolVerdict[] {
  return PROMOTION_TOOLS.map((t) => {
    const tu = toolUnits(t, units);
    const byStratum: Record<string, number> = {};
    for (const u of tu) byStratum[u.stratum] = (byStratum[u.stratum] ?? 0) + 1;
    const pick = legs.filter((l) => l.id === t.baseline || l.id === engineLegId);
    const none = { verdict: "undecided" as const, reason: "no units" };
    if (!tu.length || pick.length < 2) return { tool: t.tool, readBy: t.readBy, gold: t.gold, baseline: t.baseline, units: tu.length, byStratum, metrics: {}, strict: none, measured: none };
    const r = measure(tu, pick, { sets: "held-out", seed: o.seed, resamples: o.resamples, baseline: { [t.gold]: t.baseline } });
    const metrics = r.paired[t.gold]?.legs[engineLegId]?.metrics ?? {};
    return {
      tool: t.tool, readBy: t.readBy, gold: t.gold, baseline: t.baseline, units: tu.length, byStratum, metrics,
      strict: promotionVerdict(metrics, { gaps: HEADLINE_GAPS[t.gold] }),
      measured: promotionVerdict(metrics, { gaps: HEADLINE_GAPS[t.gold], acceptGaps: true }),
    };
  });
}

const f3 = (v: number): string => (Number.isFinite(v) ? v.toFixed(3) : "n/a");

/** The §6.4 table as markdown (numbers, tool ids, strata counts only). */
export function promotionMarkdown(rows: readonly ToolVerdict[]): string {
  const out = ["## §6.4 promotion table (held-out units; engine − the tool's legacy baseline, paired 95 % CI)", "",
    "| tool | read by | units | baseline | headline diffs | §6.4 (every headline) | §6.4 (measured headlines only) |", "|---|---|---|---|---|---|---|"];
  for (const r of rows) {
    const diffs = Object.entries(r.metrics).map(([k, c]) => `${k} ${f3(c.diff)} [${f3(c.lo)}, ${f3(c.hi)}] n=${c.n}`).join("; ") || "—";
    const v = (x: ToolVerdict["strict"]) => `${x.verdict}${x.needUnits ? ` (need ~${x.needUnits} units)` : ""}`;
    out.push(`| ${r.tool} | ${r.readBy ?? "**nothing reads it**"} | ${r.units} | ${r.baseline} | ${diffs} | ${v(r.strict)} | ${v(r.measured)} |`);
  }
  out.push("");
  return out.join("\n");
}
