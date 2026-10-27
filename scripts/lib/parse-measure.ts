/**
 * parse-measure.ts — the scoring core of scripts/parse-engine-measure.ts (table-pipeline WP-2.G; PLAN §6.2–6.4).
 *
 * Pure: no file IO, no clock, no unseeded randomness. A unit is one gold region (G-TAB table or G-PARA block) with
 * its page slice; a leg turns a unit into a prediction (a grid or an item list); the metrics score a prediction
 * against the unit's truth (every metric is in [0, 1], higher is better); the paired bootstrap gives a 95 % CI of
 * (leg − baseline) per headline, resampling units with a seeded PRNG. TP-2 has only the legacy legs (the 2.0a
 * adapters); TP-3.Q adds an `engine` leg with the same `Leg` shape. Nothing here returns drawing text: reports carry
 * numbers, leg ids, strata and opaque gold ids.
 */
import { LEGACY_PATH_IDS, runLegacyPath, type LegacyPathId, type LegacySlice } from "@/lib/legacy-joins/legacy-paths";
import { mulberry32, normKey, normText, type ParaTruth, type TabTruth } from "../gold/gold-lib";

export interface Item { key: string; text: string }
export interface Prediction { grid?: string[][] | null; items?: Item[] | null }

export type UnitGold = { gold: "G-TAB"; truth: TabTruth } | { gold: "G-PARA"; truth: ParaTruth };
export type Unit = UnitGold & { goldId: string; setId: string; stratum: string; slice: LegacySlice };

export interface Leg { id: string; applies: (u: Unit) => boolean; run: (u: Unit) => Prediction }

// ─── legacy outputs → a grid or an item list ─────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

/** `{headers, rows: Record[] | string[][]}` → rows of cells in header order (duplicate header names collapse once, K06). */
function gridOf(v: unknown): string[][] | null {
  if (!isObj(v) || !Array.isArray(v.rows)) return null;
  const headers = [...new Set(Array.isArray(v.headers) ? v.headers.map(str) : [])];
  return v.rows.map((r) => {
    if (Array.isArray(r)) return r.map(str);
    if (!isObj(r)) return [];
    return headers.length ? headers.map((h) => str(r[h])) : Object.values(r).map(str);
  });
}

/** A grid read as items: the first cell is the key, the rest (non-empty, in order) the text. */
const gridToItems = (g: string[][]): Item[] => g.map((r) => ({ key: r[0] ?? "", text: r.slice(1).filter((c) => c.trim()).join(" ") }));
/** Items read as a two-column grid (key, text). */
const itemsToGrid = (xs: Item[]): string[][] => xs.map((x) => [x.key, x.text]);

/** One legacy path's output as a prediction (null parts when the path produced nothing usable). */
export function legacyPrediction(id: LegacyPathId, out: unknown): Prediction {
  if (out == null) return { grid: null, items: null };
  switch (id) {
    case "guided-extract": {
      const g = isObj(out) ? gridOf(out.onLines) : null;
      return { grid: g, items: g && gridToItems(g) };
    }
    case "notes-guided": {
      const g = isObj(out) ? gridOf(out.grid) : null;
      return { grid: g, items: g && gridToItems(g) };
    }
    case "keynote-manual": {
      const items = Array.isArray(out) ? out.filter(isObj).map((r) => ({ key: str(r.key), text: str(r.description) })) : null;
      return { grid: items && itemsToGrid(items), items };
    }
    case "notes-paragraph":
    case "spec-paragraph": {
      if (!Array.isArray(out)) return { grid: null, items: null };
      const items = out.filter(isObj).map((c) => {
        const rt = isObj(c.rowText) ? c.rowText : {};
        return id === "notes-paragraph" ? { key: str(rt.Key), text: str(rt.Note) } : { key: str(rt.sectionHeader), text: str(rt.body) };
      });
      return { grid: itemsToGrid(items), items };
    }
    case "spec-auto": {
      const o = isObj(out) ? out : {};
      const pick = isObj(o.withSubSections) ? o.withSubSections : isObj(o.plain) ? o.plain : null;
      const sections = pick && Array.isArray(pick.sections) ? pick.sections.filter(isObj) : null;
      const items = sections && sections.map((s) => ({ key: str(s.sectionHeader), text: str(s.body) }));
      return { grid: items && itemsToGrid(items), items };
    }
    default: {
      const g = gridOf(out);
      return { grid: g, items: g && gridToItems(g) };
    }
  }
}

/** The paths that make sense per gold set (a notes binder is not scored on a schedule, and vice versa). */
export const TAB_PATHS: readonly LegacyPathId[] = ["ocr-positions", "textract", "shape-rows", "merger", "guided-extract", "manual", "keynote-manual", "keynote-guided"];
export const PARA_PATHS: readonly LegacyPathId[] = ["notes-auto", "notes-guided", "notes-paragraph", "spec-paragraph", "notes-fast-manual", "notes-manual", "spec-auto"];
export const DEFAULT_BASELINE: Record<UnitGold["gold"], string> = { "G-TAB": "legacy:merger", "G-PARA": "legacy:notes-auto" };

/** One leg per legacy path (`legacy:<path>`), through the 2.0a adapters. */
export function legacyLegs(filter?: (id: LegacyPathId) => boolean): Leg[] {
  return LEGACY_PATH_IDS.filter((id) => !filter || filter(id)).map((id) => ({
    id: `legacy:${id}`,
    applies: (u: Unit) => (u.gold === "G-TAB" ? TAB_PATHS : PARA_PATHS).includes(id),
    run: (u: Unit) => legacyPrediction(id, runLegacyPath(id, u.slice)),
  }));
}

// ─── metrics ─────────────────────────────────────────────────────────────────

const tokens = (s: string): string[] => normText(s).split(" ").filter(Boolean);
const rowText = (cells: readonly string[]): string => normText(cells.filter((c) => c.trim()).join(" "));

/** Multiset overlap of two token lists. */
function overlap(a: readonly string[], b: readonly string[]): number {
  const m = new Map<string, number>();
  for (const t of a) m.set(t, (m.get(t) ?? 0) + 1);
  let n = 0;
  for (const t of b) { const k = m.get(t) ?? 0; if (k > 0) { n++; m.set(t, k - 1); } }
  return n;
}

/** Monotonic alignment (reading order kept) of truth units to predicted units maximising total token overlap. */
export function alignByTokens(truth: readonly string[][], pred: readonly string[][]): Array<number | null> {
  const n = truth.length, m = pred.length;
  const S: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const w = (i: number, j: number) => overlap(truth[i], pred[j]);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const o = w(i, j);
      S[i][j] = Math.max(S[i + 1][j], S[i][j + 1], o > 0 ? o + S[i + 1][j + 1] : 0);
    }
  }
  const out: Array<number | null> = new Array<number | null>(n).fill(null);
  for (let i = 0, j = 0; i < n && j < m;) {
    const o = w(i, j);
    if (o > 0 && S[i][j] === o + S[i + 1][j + 1]) { out[i] = j; i++; j++; } else if (S[i][j] === S[i + 1][j]) i++; else j++;
  }
  return out;
}

/** Multiset exact-match F1 over two lists of signatures. Both empty → 1. */
function exactF1(truth: readonly string[], pred: readonly string[]): number {
  if (truth.length === 0 && pred.length === 0) return 1;
  const tp = overlap(truth, pred);
  return truth.length + pred.length === 0 ? 0 : (2 * tp) / (truth.length + pred.length);
}

/** Levenshtein distance (two-row DP). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

export const TAB_METRICS = ["rowCountExact", "rowTextF1", "wordRowAcc", "cellExact"] as const;
export const PARA_METRICS = ["itemF1", "keyExact", "textSim"] as const;
/** Headline metrics (PLAN §6.3: rows ✓, cols/cells ✓, paragraphs ✓). */
export const HEADLINES: Record<UnitGold["gold"], readonly string[]> = { "G-TAB": TAB_METRICS, "G-PARA": PARA_METRICS };

/**
 * G-TAB (and G-ROW) metrics of a predicted grid against the truth body rows (header rows are not body rows):
 *   rowCountExact  1 when the non-empty predicted rows number exactly the truth rows;
 *   rowTextF1      exact-match F1 of whole-row text (cells joined in order, column-agnostic): row segmentation;
 *   wordRowAcc     share of truth words found in the predicted row aligned to their row (G-ROW, word → row);
 *   cellExact      share of non-empty truth cells matched exactly in the aligned row, under the best one-to-one
 *                  column mapping (cols/cells, normalised text).
 */
export function tabMetrics(truth: TabTruth, grid: readonly string[][] | null | undefined): Record<(typeof TAB_METRICS)[number], number> {
  const body = truth.rows.map((r) => r.cells);
  const pred = (grid ?? []).filter((r) => r.some((c) => c.trim()));
  const tTok = body.map((r) => tokens(r.join(" ")));
  const pTok = pred.map((r) => tokens(r.join(" ")));
  const align = alignByTokens(tTok, pTok);
  const words = tTok.reduce((s, t) => s + t.length, 0);
  const found = tTok.reduce((s, t, i) => s + (align[i] == null ? 0 : overlap(t, pTok[align[i]!])), 0);
  // column mapping: votes of exact cell equality over aligned rows, then greedy one-to-one by votes
  const votes = new Map<string, number>();
  body.forEach((r, i) => {
    const j = align[i];
    if (j == null || truth.rows[i].section) return;
    r.forEach((c, ci) => {
      const t = normText(c);
      if (!t) return;
      pred[j].forEach((p, pi) => { if (normText(p) === t) votes.set(`${ci}:${pi}`, (votes.get(`${ci}:${pi}`) ?? 0) + 1); });
    });
  });
  const colMap = new Map<number, number>();
  const usedPred = new Set<number>();
  for (const [k] of [...votes.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) {
    const [ci, pi] = k.split(":").map(Number);
    if (colMap.has(ci) || usedPred.has(pi)) continue;
    colMap.set(ci, pi);
    usedPred.add(pi);
  }
  let cells = 0, cellHits = 0;
  body.forEach((r, i) => {
    if (truth.rows[i].section) return;
    r.forEach((c, ci) => {
      const t = normText(c);
      if (!t) return;
      cells++;
      const j = align[i], pi = colMap.get(ci);
      if (j != null && pi != null && normText(pred[j][pi] ?? "") === t) cellHits++;
    });
  });
  return {
    rowCountExact: pred.length === body.length ? 1 : 0,
    rowTextF1: exactF1(body.map(rowText), pred.map(rowText)),
    wordRowAcc: words ? found / words : 1,
    cellExact: cells ? cellHits / cells : 1,
  };
}

/**
 * G-PARA metrics of predicted items against the truth items (reading order):
 *   itemF1   exact-match F1 of whole items (normalised key + text): block boundaries;
 *   keyExact share of truth items whose aligned predicted item has the same key (`1.` = `1` = `(1)`);
 *   textSim  mean over truth items of 1 − CER of the aligned item's text (0 when unaligned).
 */
export function paraMetrics(truth: ParaTruth, items: readonly Item[] | null | undefined): Record<(typeof PARA_METRICS)[number], number> {
  const t = truth.items;
  const p = (items ?? []).filter((x) => (x.key + x.text).trim());
  const sig = (x: Item) => `${normKey(x.key)}␟${normText(x.text)}`;
  const align = alignByTokens(t.map((x) => tokens(`${x.key} ${x.text}`)), p.map((x) => tokens(`${x.key} ${x.text}`)));
  let keys = 0, sim = 0;
  t.forEach((x, i) => {
    const j = align[i];
    if (j == null) return;
    if (normKey(x.key) === normKey(p[j].key)) keys++;
    const a = normText(x.text), b = normText(p[j].text);
    sim += Math.max(0, 1 - levenshtein(a, b) / Math.max(1, a.length));
  });
  return { itemF1: exactF1(t.map(sig), p.map(sig)), keyExact: t.length ? keys / t.length : 1, textSim: t.length ? sim / t.length : 1 };
}

export function scoreUnit(u: Unit, pred: Prediction): Record<string, number> {
  return u.gold === "G-TAB" ? tabMetrics(u.truth, pred.grid) : paraMetrics(u.truth, pred.items);
}

// ─── bootstrap ───────────────────────────────────────────────────────────────

export interface BootOpts { resamples?: number; seed?: number }
export interface MeanCI { n: number; mean: number; lo: number; hi: number }
export interface PairedCI { n: number; meanBase: number; meanLeg: number; diff: number; lo: number; hi: number }

const mean = (xs: readonly number[]): number => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const r4 = (v: number): number => (Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : v);
/** Percentile of a sorted array (nearest-rank on (R−1)·q, the convention numpy calls "lower"). */
const pct = (sorted: readonly number[], q: number): number => sorted[Math.floor((sorted.length - 1) * q)];

/** Seeded percentile bootstrap of the mean over units (default 2,000 resamples, 95 %). */
export function bootstrapMean(xs: readonly number[], o: BootOpts = {}): MeanCI {
  const n = xs.length;
  if (!n) return { n: 0, mean: NaN, lo: NaN, hi: NaN };
  const rand = mulberry32(o.seed ?? 20261027);
  const stats: number[] = [];
  for (let r = 0; r < (o.resamples ?? 2000); r++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += xs[Math.floor(rand() * n)];
    stats.push(s / n);
  }
  stats.sort((a, b) => a - b);
  return { n, mean: r4(mean(xs)), lo: r4(pct(stats, 0.025)), hi: r4(pct(stats, 0.975)) };
}

/** Seeded PAIRED bootstrap of mean(leg − base): units are resampled together, so the CI is of the paired difference. */
export function pairedBootstrap(base: readonly number[], leg: readonly number[], o: BootOpts = {}): PairedCI {
  if (base.length !== leg.length) throw new Error(`paired bootstrap needs equal lengths (${base.length} vs ${leg.length})`);
  const d = leg.map((v, i) => v - base[i]);
  const b = bootstrapMean(d, o);
  return { n: d.length, meanBase: r4(mean(base)), meanLeg: r4(mean(leg)), diff: b.mean, lo: b.lo, hi: b.hi };
}

/**
 * The §6.4 promotion rule on one leg vs the baseline (held-out half): promote when every headline's CI lower bound
 * is ≥ −0.01 and at least one headline's point estimate is ≥ +0.03; hold when a headline is surely worse (upper bound
 * < −0.01) or no headline can reach +0.03 (every upper bound < +0.03); otherwise undecided, with a rough count of
 * units needed (n·(half-width / needed half-width)², the largest over the headlines that block). Guards are measured
 * elsewhere (classifier-measure) and are not part of this verdict.
 */
export function promotionVerdict(cis: Record<string, PairedCI>): { verdict: "promote" | "hold" | "undecided"; reason: string; needUnits?: number } {
  const xs = Object.entries(cis).filter(([, c]) => c.n > 0);
  if (!xs.length) return { verdict: "undecided", reason: "no units" };
  const worse = xs.filter(([, c]) => c.hi < -0.01);
  if (worse.length) return { verdict: "hold", reason: `worse on ${worse.map(([k]) => k).join(", ")}` };
  const gain = xs.some(([, c]) => c.diff >= 0.03);
  if (gain && xs.every(([, c]) => c.lo >= -0.01)) return { verdict: "promote", reason: "every lower bound ≥ −0.01 and a headline gains ≥ +0.03" };
  if (xs.every(([, c]) => c.hi < 0.03)) return { verdict: "hold", reason: "no headline can gain +0.03" };
  let need = 0;
  for (const [, c] of xs) {
    if (c.lo >= -0.01) continue;
    const half = (c.hi - c.lo) / 2, wanted = c.diff + 0.01;
    need = Math.max(need, wanted > 0 ? Math.ceil(c.n * (half / wanted) ** 2) : Infinity);
  }
  return { verdict: "undecided", reason: gain ? "a lower bound is below −0.01" : "no headline reaches +0.03 yet", needUnits: Number.isFinite(need) && need > 0 ? need : undefined };
}

// ─── the report ──────────────────────────────────────────────────────────────

export interface LegReport { units: number; coverage: number; metrics: Record<string, MeanCI>; byStratum: Record<string, { units: number; metrics: Record<string, MeanCI> }> }
export interface MeasureReport {
  schema: "bp-parse-measure/1";
  sets: string;
  seed: number;
  resamples: number;
  gold: Record<string, { units: number; byStratum: Record<string, number>; adjudicated?: number }>;
  legs: Record<string, Record<string, LegReport>>;
  paired: Record<string, { baseline: string; legs: Record<string, { metrics: Record<string, PairedCI>; byStratum: Record<string, Record<string, PairedCI>>; verdict: ReturnType<typeof promotionVerdict> }> }>;
  skipped: Record<string, number>;
}

/** Score every leg on every unit it applies to and build the report (deterministic for a given seed). */
export function measure(units: readonly Unit[], legs: readonly Leg[], o: BootOpts & { sets?: string; baseline?: Partial<Record<UnitGold["gold"], string>> } = {}): MeasureReport {
  const seed = o.seed ?? 20261027, resamples = o.resamples ?? 2000;
  const report: MeasureReport = { schema: "bp-parse-measure/1", sets: o.sets ?? "all", seed, resamples, gold: {}, legs: {}, paired: {}, skipped: {} };
  for (const gold of ["G-TAB", "G-PARA"] as const) {
    const us = units.filter((u) => u.gold === gold).slice().sort((a, b) => (a.goldId < b.goldId ? -1 : a.goldId > b.goldId ? 1 : 0));
    if (!us.length) continue;
    const byStratum: Record<string, number> = {};
    for (const u of us) byStratum[u.stratum] = (byStratum[u.stratum] ?? 0) + 1;
    report.gold[gold] = { units: us.length, byStratum };
    const metricNames = HEADLINES[gold];
    const scores = new Map<string, Record<string, number>[]>();
    const covered = new Map<string, number>();
    report.legs[gold] = {};
    for (const leg of legs) {
      if (!us.some(leg.applies)) continue;
      const rows: Record<string, number>[] = [];
      let cov = 0;
      for (const u of us) {
        const pred = leg.run(u);
        if ((u.gold === "G-TAB" ? pred.grid : pred.items)?.length) cov++;
        rows.push(scoreUnit(u, pred));
      }
      scores.set(leg.id, rows);
      covered.set(leg.id, cov);
      const metrics = (sel: (i: number) => boolean) => Object.fromEntries(metricNames.map((m) => [m, bootstrapMean(rows.filter((_, i) => sel(i)).map((r) => r[m]), { seed, resamples })]));
      const strata: LegReport["byStratum"] = {};
      for (const s of Object.keys(byStratum).sort()) strata[s] = { units: byStratum[s], metrics: metrics((i) => us[i].stratum === s) };
      report.legs[gold][leg.id] = { units: us.length, coverage: r4(cov / us.length), metrics: metrics(() => true), byStratum: strata };
    }
    const baseline = o.baseline?.[gold] ?? DEFAULT_BASELINE[gold];
    const base = scores.get(baseline);
    if (!base) { report.skipped[`${gold}: baseline ${baseline} not run`] = 1; continue; }
    report.paired[gold] = { baseline, legs: {} };
    for (const [id, rows] of scores) {
      if (id === baseline) continue;
      const paired = (sel: (i: number) => boolean) => Object.fromEntries(metricNames.map((m) => {
        const idx = us.map((_, i) => i).filter(sel);
        return [m, pairedBootstrap(idx.map((i) => base[i][m]), idx.map((i) => rows[i][m]), { seed, resamples })];
      }));
      const all = paired(() => true);
      const strata: Record<string, Record<string, PairedCI>> = {};
      for (const s of Object.keys(byStratum).sort()) strata[s] = paired((i) => us[i].stratum === s);
      report.paired[gold].legs[id] = { metrics: all, byStratum: strata, verdict: promotionVerdict(all) };
    }
  }
  return report;
}

const f3 = (v: number): string => (Number.isFinite(v) ? v.toFixed(3) : "n/a");
const ci = (c: MeanCI | PairedCI): string => `${f3("mean" in c ? c.mean : c.diff)} [${f3(c.lo)}, ${f3(c.hi)}]`;

/** The report as markdown tables (numbers, leg ids, strata only). */
export function reportMarkdown(r: MeasureReport): string {
  const out: string[] = [`# parse-engine-measure — sets ${r.sets}, ${r.resamples} resamples, seed ${r.seed}`, ""];
  for (const [gold, g] of Object.entries(r.gold)) {
    const names = HEADLINES[gold as UnitGold["gold"]];
    out.push(`## ${gold}: ${g.units} units (${Object.entries(g.byStratum).map(([s, n]) => `${s} ${n}`).join(", ")})`, "");
    out.push(`| leg | coverage | ${names.join(" | ")} |`, `|---|---|${names.map(() => "---").join("|")}|`);
    for (const [id, l] of Object.entries(r.legs[gold] ?? {})) out.push(`| ${id} | ${f3(l.coverage)} | ${names.map((m) => ci(l.metrics[m])).join(" | ")} |`);
    const p = r.paired[gold];
    if (p) {
      out.push("", `Paired (leg − ${p.baseline}), 95 % CI:`, "", `| leg | ${names.join(" | ")} | §6.4 |`, `|---|${names.map(() => "---").join("|")}|---|`);
      for (const [id, l] of Object.entries(p.legs)) out.push(`| ${id} | ${names.map((m) => ci(l.metrics[m])).join(" | ")} | ${l.verdict.verdict}${l.verdict.needUnits ? ` (~${l.verdict.needUnits} units)` : ""} |`);
    }
    out.push("");
  }
  for (const [k, n] of Object.entries(r.skipped)) out.push(`- skipped: ${k} (${n})`);
  return out.join("\n") + "\n";
}
