/**
 * region-classifier-v2/l2-score.ts — L2 "what kind": OCR words + CSI codes inside a box scored
 * against the class rows (port of regions_rc.py `toks` / `l2` and regions_rc2.py `fallback`,
 * same arithmetic: weight × sqrt(min(3, n)) per keyword, CSI division share, title-block prior,
 * sheet-level detections, tag prior, schedule-word prior; best row wins at ≥ min_score with
 * ≥ min_keywords distinct hits). Pure.
 */

import type { ClassFamily, FallbackTable, PreparedRow } from "./classes";

/** regions_rc.py TOK = `[A-Z0-9][A-Z0-9/&.\-]*` over the upper-cased word. */
const TOKEN = /[A-Z0-9][A-Z0-9/&.\-]*/g;

export type TokenCounts = Map<string, number>;

export function tokenize(words: readonly string[]): TokenCounts {
  const counts: TokenCounts = new Map();
  for (const w of words) {
    for (const t of w.toUpperCase().match(TOKEN) ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return counts;
}

/** Python `text.count(phrase)` — non-overlapping occurrences. */
function countPhrase(text: string, phrase: string): number {
  if (!phrase) return 0;
  let n = 0;
  let i = text.indexOf(phrase);
  while (i !== -1) { n++; i = text.indexOf(phrase, i + phrase.length); }
  return n;
}

export interface L2Context {
  tokens: TokenCounts;
  /** `" " + words joined by " " + " "`, upper-cased — phrases match inside it. */
  text: string;
  /** 2-digit CSI divisions of the codes inside the box (one entry per code). */
  csiDivisions: readonly string[];
  /** Upper-cased OCR text inside the sheet's title block. */
  titleBlockText: string;
  /** YOLO labels on the whole sheet → count (max over models). */
  sheetCounts?: ReadonlyMap<string, number>;
  /** Tag shapes inside the box (tables only). */
  tagShapes?: number;
}

export interface RowScore {
  cls: string;
  kw: number;
  nkw: number;
  csi: number;
  prior: number;
  score: number;
  hits: string[];
  priors: string[];
}

export interface L2Result {
  /** Winning class name, or null when no row clears the bar. */
  cls: string | null;
  best: RowScore;
  second: number;
  /** 1 − exp(−max(0, best.score) / min_score): .63 at the bar. */
  m: number;
  scheduleWord: boolean;
}

const EMPTY: RowScore = { cls: "", kw: 0, nkw: 0, csi: 0, prior: 0, score: 0, hits: [], priors: [] };

export function scoreRows(ctx: L2Context, family: ClassFamily, rows: readonly PreparedRow[]): L2Result {
  const th = family.rules;
  const scheduleWord = ctx.tokens.has("SCHEDULE") || ctx.tokens.has("SCHED");
  const res: RowScore[] = rows.map((r) => {
    const hit = new Map<string, number>();
    for (const [k, v] of Object.entries(r.kw1)) {
      const n = ctx.tokens.get(k);
      if (n) hit.set(k, v * Math.sqrt(Math.min(3, n)));
    }
    for (const [k, v] of Object.entries(r.kwp)) {
      const n = countPhrase(ctx.text, k);
      if (n) hit.set(k, v * Math.sqrt(Math.min(3, n)));
    }
    const divs = new Set(r.csi_divisions ?? []);
    const nc = ctx.csiDivisions.filter((d) => divs.has(d)).length;
    const cs = ctx.csiDivisions.length >= th.csi_min_codes && nc ? (th.csi_weight * nc) / ctx.csiDivisions.length : 0;
    const tb = r.tbp.filter((k) => ctx.titleBlockText.includes(k));
    const tbm = r.tbm.filter((k) => ctx.titleBlockText.includes(k));
    let prior = th.titleblock_weight * (Math.min(1, tb.length) - Math.min(1, tbm.length));
    const priors = tb.map((k) => `title block says ${k}`).concat(tbm.map((k) => `title block says ${k} (against)`));
    const sy = (r.sheet_yolo_plus ?? []).filter((k) => (ctx.sheetCounts?.get(k) ?? 0) > 0);
    if (sy.length) {
      prior += th.sheet_yolo_weight ?? 1.0;
      for (const k of sy) priors.push(`sheet has ${k} ×${ctx.sheetCounts!.get(k)}`);
    }
    const ntag = ctx.tagShapes ?? 0;
    if (r.tags_expected && ntag >= (th.tag_min ?? 3)) { prior += th.tag_weight ?? 1.0; priors.push(`${ntag} shape tags in table`); }
    if (hit.size && scheduleWord && r.is_schedule !== false) prior += th.schedule_word_weight ?? 0;
    const kw = [...hit.values()].reduce((a, b) => a + b, 0);
    return {
      cls: r.name,
      kw: Math.round(kw * 100) / 100,
      nkw: hit.size,
      csi: Math.round(cs * 100) / 100,
      prior,
      score: Math.round((kw + cs + prior) * 100) / 100,
      hits: [...hit.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 8).map(([k]) => k),
      priors,
    };
  });
  res.sort((a, b) => b.score - a.score || (a.cls < b.cls ? -1 : a.cls > b.cls ? 1 : 0));
  const best = res[0] ?? EMPTY;
  const second = res.length > 1 ? res[1].score : 0;
  const ok = best.score >= th.min_score && best.nkw >= th.min_keywords;
  const m = Math.round((1 - Math.exp(-Math.max(0, best.score) / th.min_score)) * 1000) / 1000;
  return { cls: ok ? best.cls : null, best, second, m, scheduleWord };
}

export interface FallbackInput {
  tokens: TokenCounts;
  wordCount: number;
  csiCount: number;
  /** The box overlaps a kept table region (overlap / smaller ≥ .5). */
  overlapsTable: boolean;
}

/** regions_rc2.py `fallback`: first rule that fits wins → { name, evidence }, or null. */
export function fallbackClass(F: FallbackTable | undefined, input: FallbackInput): { name: string; evidence: string } | null {
  if (!F) return null;
  const { tokens, wordCount: nw, csiCount } = input;
  let tot = 0;
  let digits = 0;
  for (const [w, n] of tokens) { tot += n; if (/\d/.test(w)) digits += n; }
  const dig = digits / (tot || 1);
  for (const r of F.rules) {
    if (r.if_rebuilt_table) { if (input.overlapsTable) return { name: r.name, evidence: "overlaps a rebuilt table" }; continue; }
    if (r.max_words !== undefined && nw > r.max_words) continue;
    if (r.min_words !== undefined && nw < r.min_words) continue;
    if (r.digits_share !== undefined) {
      if (dig >= r.digits_share) return { name: r.name, evidence: `${Math.round(dig * 100)}% of tokens have digits` };
      continue;
    }
    const ws = new Set((r.words ?? []).map((w) => w.toUpperCase()));
    const matched = [...tokens.entries()].filter(([w]) => ws.has(w));
    const h = matched.reduce((a, [, n]) => a + n, 0);
    const okw = h >= (r.min_hits ?? 0);
    const okc = csiCount >= (r.csi_min ?? 0);
    if (r.csi_or_words ? okw || okc : okw && okc) {
      const top = matched.sort((a, b) => b[1] - a[1]).slice(0, 4).map(([w]) => w).join(", ");
      return { name: r.name, evidence: `checklist: ${h} hits (${top})${csiCount ? `, ${csiCount} CSI codes` : ""}` };
    }
  }
  return null;
}
