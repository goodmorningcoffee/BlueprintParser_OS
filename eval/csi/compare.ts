/**
 * compare.ts — CSI v2 S5 comparison table (IMPLEMENTATION §II S5, PLAN §8).
 *
 * Scores one or more engine CAPTURES (baseline shape: `{pages:[{bundle, page, codes[]}]}`,
 * optionally `codeDetails` / `spans`) against the gold set and prints OLD-vs-NEW side by side.
 * `score.ts` stays frozen: its exported helpers are reused, and its unexported strict/generous
 * gold construction is re-stated here (`goldFor`) and cross-checked against a score.ts output
 * with `--check-score` — the flat cells must reproduce score.ts to 4 decimals.
 *
 * What it adds over score.ts:
 *  - HIERARCHY-AWARE cells: an emitted code that is not a TP but sits on a gold code's chain is
 *    TP-ancestor (08 11 00 for gold 08 11 13) or TP-descendant (08 11 13 for gold 08 11 00).
 *    Ancestors count only at level ≥ `minLevel` (default 2): a bare division (08 00 00) is a
 *    hint, not a tag, and would otherwise hit every group in its division. Division-level chain
 *    hits are counted separately (`divisionOnChain`) so the choice is visible, not hidden.
 *    A should_not hit stays a hard FP (the labeler said no); only cross/unadjudicated FPs move.
 *  - DISTINCT-PAGE DEDUPE by sha256(rawText) from the corpus (471 rows → 378 distinct), applied
 *    identically to every engine and to the gold pages. Fallbacks (no corpus) are named.
 *  - corpus-level codes/page, integrity counters, and the PLAN §8 per-term table.
 *
 * Output is NUMBERS ONLY (no page text, no KB phrases): safe for eval/csi/results/.
 * Pattern text (top (code, pattern) pairs) goes only to `--private-out`.
 *
 * Build + run (from the repo root):
 *   npx esbuild eval/csi/compare.ts --bundle --platform=node --target=node24 --alias:@=./src \
 *     --external:pg-native --outfile=build/csi-compare.js
 *   node build/csi-compare.js --gold=<gold.json> --frame=eval/csi/gold-frame.json \
 *     --corpus=<corpus.ndjson> --engine=old=eval/csi/baseline-old-engine.json [--engine=v2=…] \
 *     [--out=<numbers.json>] [--check-score=old=<score.json>] [--min-level=2] [--private-out=<f>]
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { basename } from "node:path";
import { digits, section, exact, division, fbeta, isCertifiedPage, type GoldPage } from "./score";

export type Mode = "section" | "exact";
export type Variant = "certified" | "strict" | "generous";
export interface Group { id: string; tier: "primary" | "secondary" | "tertiary"; division: string; codes: string[] }

export interface CodeDetail {
  code: string;
  confidence?: number;
  level?: number;
  triggers?: { emitted?: boolean; pattern?: string; source?: string }[];
}
export interface CapturePage {
  bundle: string;
  page: number;
  codes: string[];
  inputSha?: string;
  rawTextSha?: string;
  codeDetails?: CodeDetail[];
  spans?: { emitted?: boolean }[];
  /** capture-v2.ts per-page checks (PLAN §8 integrity inputs that need the KB). */
  checks?: { emittedCodes: number; emittedSpans: number; childWithoutDiffToken: number; familySpans?: number; hints?: number; parentBesideDescendantSameRange?: number };
}
export interface Capture { pages: CapturePage[]; engineSha?: unknown; kbSha?: unknown }

/** Per-page corpus facts compare.ts needs; never copied into the output. */
export interface PageInfo { textSha: string; text: string | null; discipline: string | null }

const keyFor = (mode: Mode) => (mode === "section" ? section : exact);
export const pageKey = (bundle: string, page: number) => `${bundle}:${page}`;
const r4 = (x: number | null) => (x === null ? null : +x.toFixed(4));
const r1 = (x: number) => +x.toFixed(1);

// ═══════════════════════════════════════════════════════════════
// Hierarchy (PLAN §8: "TP-ancestor / TP-descendant when on the gold code's chain")
// ═══════════════════════════════════════════════════════════════

/**
 * Significant-digit chain key. Prefix order = MasterFormat ancestry, matching `parent()`:
 * 08 00 00 → "08" (L1), 08 10 00 → "081" (L2), 08 11 00 → "0811" (L3), 08 11 13 → "081113" (L4),
 * 08 11 13.13 → "08111313" (L5). Section mode truncates to 4 digits (a section cell cannot see
 * below L3). Accepts any separator style and a flat score key ("0811", "081113").
 */
export function chainKey(code: string, mode: Mode): string {
  const d = digits(code);
  const d6 = d.slice(0, 6).padEnd(6, "0");
  const tail = d.slice(6, 8);
  let k: string;
  if (tail && /[1-9]/.test(tail)) k = d6 + tail.padEnd(2, "0");
  else if (d6.slice(2) === "0000") k = d6.slice(0, 2);
  else if (d6.slice(3) === "000") k = d6.slice(0, 3);
  else if (d6.slice(4) === "00") k = d6.slice(0, 4);
  else k = d6;
  return mode === "section" ? k.slice(0, 4) : k;
}

/** MasterFormat level of a chain key. */
export const chainLevel = (k: string) => ({ 2: 1, 3: 2, 4: 3, 6: 4, 8: 5 } as Record<number, number>)[k.length] ?? 0;

/** Where `emit` sits relative to `gold` on the chain (both chain keys). */
export function relation(emit: string, gold: string): "equal" | "ancestor" | "descendant" | null {
  if (emit === gold) return "equal";
  if (gold.startsWith(emit)) return "ancestor";
  if (emit.startsWith(gold)) return "descendant";
  return null;
}

// ═══════════════════════════════════════════════════════════════
// Gold construction (re-states score.ts main()'s goldFor; cross-checked by --check-score)
// ═══════════════════════════════════════════════════════════════

export function goldFor(p: GoldPage, variant: Variant): Group[] | null {
  if (p.expected_groups) return p.expected_groups as Group[];
  const a = (p.passA?.groups ?? null) as Group[] | null;
  const b = (p.passB?.groups ?? null) as Group[] | null;
  if (!a || !b) return null;
  if (variant === "generous") {
    const seen = new Set<string>();
    const out: Group[] = [];
    for (const g of [...a, ...b]) {
      const sig = g.codes.map(section).sort().join("|");
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push(g);
    }
    return out;
  }
  const bSecs = b.map(g => new Set(g.codes.map(section)));
  return a.filter(g => {
    const s = new Set(g.codes.map(section));
    return bSecs.some(t => [...s].some(x => t.has(x)));
  });
}

// ═══════════════════════════════════════════════════════════════
// Page scoring — flat (== score.ts) and hierarchy-aware in one pass
// ═══════════════════════════════════════════════════════════════

export interface PageScoreH {
  weight: number;
  emitted: number;
  tp: number; fpHard: number; fpCross: number; fpUnadj: number;
  tpAncestor: number; tpDescendant: number; tpChainEqual: number; divisionOnChain: number; onChainRedundant: number;
  groupsTotal: number; groupsHit: number; primaryTotal: number; primaryHit: number;
  hierGroupsHit: number; hierPrimaryHit: number;
}

export function scorePageH(gold: Group[], g: GoldPage, emittedCodes: string[], mode: Mode, weight: number, minLevel = 2): PageScoreH {
  const key = keyFor(mode);
  const emitted = [...new Set(emittedCodes.map(key))];
  const goldKeys = new Set(gold.flatMap(x => x.codes.map(key)));
  const goldChains = [...new Set(gold.flatMap(x => x.codes.map(c => chainKey(c, mode))))];
  const shouldNot = new Set((g.should_not_codes ?? []).map(key));
  const shouldNotDiv = new Set((g.should_not_divisions ?? []).map(division));
  const acceptable = g.acceptable_divisions?.length ? new Set(g.acceptable_divisions.map(division)) : null;

  const s: PageScoreH = {
    weight, emitted: emitted.length, tp: 0, fpHard: 0, fpCross: 0, fpUnadj: 0,
    tpAncestor: 0, tpDescendant: 0, tpChainEqual: 0, divisionOnChain: 0, onChainRedundant: 0,
    groupsTotal: gold.length, groupsHit: 0, primaryTotal: 0, primaryHit: 0, hierGroupsHit: 0, hierPrimaryHit: 0,
  };
  /** A chain hit on `gk` that hierarchy-aware scoring credits. */
  const credited = (ek: string, gk: string) => {
    const rel = relation(ek, gk);
    if (rel === "equal" || rel === "descendant") return rel;
    if (rel === "ancestor") return chainLevel(ek) >= minLevel ? rel : "division";
    return null;
  };
  // Precision credit is ONE per gold chain key per page (score.ts §5.1.1's "one fact → one TP"):
  // a flat TP consumes its chain, and the remaining on-chain emits are matched greedily, equal
  // before descendant before ancestor, in sorted order. Siblings sprayed under one gold code
  // (08 11 13 + 08 11 16 + 08 11 19 under gold 08 11 00) earn one credit; the rest are
  // `onChainRedundant` — still FPs, still on the chain. Recall (per group, below) is unaffected.
  const consumed = new Set<string>();
  const onChain: { ek: string; rels: (string | null)[] }[] = [];
  for (const k of emitted) {
    const d = k.slice(0, 2);
    if (goldKeys.has(k)) { s.tp++; consumed.add(chainKey(k, mode)); continue; }
    if (shouldNot.has(k) || shouldNotDiv.has(d)) { s.fpHard++; continue; }
    if (acceptable && !acceptable.has(d)) s.fpCross++;
    else s.fpUnadj++;
    const ek = chainKey(k, mode);
    const rels = goldChains.map(gk => credited(ek, gk));
    if (rels.some(r => r === "equal" || r === "descendant" || r === "ancestor")) onChain.push({ ek, rels });
    else if (rels.includes("division")) s.divisionOnChain++;
  }
  onChain.sort((a, b) => (a.ek < b.ek ? -1 : a.ek > b.ek ? 1 : 0));
  const done = new Set<number>();
  // "equal" here = same chain key under a different flat key (e.g. 08 11 13.00 vs 08 11 13).
  for (const rel of ["equal", "descendant", "ancestor"] as const) {
    onChain.forEach((e, i) => {
      if (done.has(i)) return;
      const j = e.rels.findIndex((r, gi) => r === rel && !consumed.has(goldChains[gi]));
      if (j < 0) return;
      consumed.add(goldChains[j]); done.add(i);
      if (rel === "equal") s.tpChainEqual++; else if (rel === "descendant") s.tpDescendant++; else s.tpAncestor++;
    });
  }
  s.onChainRedundant = onChain.length - done.size;
  const emittedSet = new Set(emitted);
  const emittedChains = emitted.map(k => chainKey(k, mode));
  for (const grp of gold) {
    const hit = grp.codes.some(c => emittedSet.has(key(c)));
    const gcs = grp.codes.map(c => chainKey(c, mode));
    const hierHit = hit || emittedChains.some(ek => gcs.some(gk => {
      const r = credited(ek, gk);
      return r !== null && r !== "division";
    }));
    if (hit) s.groupsHit++;
    if (hierHit) s.hierGroupsHit++;
    if (grp.tier === "primary") {
      s.primaryTotal++;
      if (hit) s.primaryHit++;
      if (hierHit) s.hierPrimaryHit++;
    }
  }
  return s;
}

export interface Cell {
  pagesScored: number;
  precision: number | null; recall: number | null; primaryRecall: number | null; f05: number | null;
  precisionBracket: { floor: number; ceiling: number; unadjudicatedShare: number } | null;
  truePositives: number; falsePositives: { hard: number; crossDivision: number; unadjudicated: number };
  groupsTotal: number; groupsHit: number;
  hier: {
    precision: number | null; recall: number | null; primaryRecall: number | null; f05: number | null;
    tpAncestor: number; tpDescendant: number; tpChainEqual: number; divisionOnChain: number; onChainRedundant: number; groupsHit: number;
  };
}

/** Weighted micro-average (score.ts §11.1 arithmetic) over flat and hierarchy-aware counts. */
export function aggregateH(scores: PageScoreH[]): Cell {
  const t = { tp: 0, fpHard: 0, fpCross: 0, fpUnadj: 0, anc: 0, desc: 0, eq: 0, div: 0, red: 0, gT: 0, gH: 0, pT: 0, pH: 0, hgH: 0, hpH: 0 };
  for (const s of scores) {
    const w = s.weight;
    t.tp += s.tp * w; t.fpHard += s.fpHard * w; t.fpCross += s.fpCross * w; t.fpUnadj += s.fpUnadj * w;
    t.anc += s.tpAncestor * w; t.desc += s.tpDescendant * w; t.eq += s.tpChainEqual * w; t.div += s.divisionOnChain * w; t.red += s.onChainRedundant * w;
    t.gT += s.groupsTotal * w; t.gH += s.groupsHit * w; t.pT += s.primaryTotal * w; t.pH += s.primaryHit * w;
    t.hgH += s.hierGroupsHit * w; t.hpH += s.hierPrimaryHit * w;
  }
  const emitted = t.tp + t.fpHard + t.fpCross + t.fpUnadj;
  const precision = emitted ? t.tp / emitted : null;
  const recall = t.gT ? t.gH / t.gT : null;
  const primaryRecall = t.pT ? t.pH / t.pT : null;
  const hp = emitted ? (t.tp + t.anc + t.desc + t.eq) / emitted : null;
  const hr = t.gT ? t.hgH / t.gT : null;
  const f = (p: number | null, r: number | null) => (p === null || r === null ? null : fbeta(p, r, 0.5));
  return {
    pagesScored: scores.length,
    precision: r4(precision), recall: r4(recall), primaryRecall: r4(primaryRecall), f05: r4(f(precision, recall)),
    precisionBracket: emitted
      ? { floor: +(t.tp / emitted).toFixed(4), ceiling: +((t.tp + t.fpUnadj) / emitted).toFixed(4), unadjudicatedShare: +(t.fpUnadj / emitted).toFixed(4) }
      : null,
    truePositives: r1(t.tp),
    falsePositives: { hard: r1(t.fpHard), crossDivision: r1(t.fpCross), unadjudicated: r1(t.fpUnadj) },
    groupsTotal: r1(t.gT), groupsHit: r1(t.gH),
    hier: {
      precision: r4(hp), recall: r4(hr), primaryRecall: r4(t.pT ? t.hpH / t.pT : null), f05: r4(f(hp, hr)),
      tpAncestor: r1(t.anc), tpDescendant: r1(t.desc), tpChainEqual: r1(t.eq), divisionOnChain: r1(t.div), onChainRedundant: r1(t.red), groupsHit: r1(t.hgH),
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// Dedupe, frame weights, corpus-level numbers
// ═══════════════════════════════════════════════════════════════

/** Keep the first page per dedupe key, in input order. */
export function dedupe<T>(items: T[], keyOf: (x: T) => string): { kept: T[]; dropped: number } {
  const seen = new Set<string>();
  const kept: T[] = [];
  for (const x of items) {
    const k = keyOf(x);
    if (seen.has(k)) continue;
    seen.add(k);
    kept.push(x);
  }
  return { kept, dropped: items.length - kept.length };
}

/** Stratum → weight. Fails LOUD on a missing/unknown stratum (run-eval's hard-fail contract). */
export function weightFn(frame: { strata: { stratum: string; weight: number }[] }): (st: string | undefined, where: string) => number {
  const m = new Map(frame.strata.map(s => [s.stratum, s.weight]));
  if (m.size === 0) throw new Error("NO stratum weights in frame — refusing to score");
  for (const [k, v] of m) if (!(v > 0)) throw new Error(`stratum ${k} has non-positive weight ${v}`);
  return (st, where) => {
    if (!st) throw new Error(`UNKNOWN STRATA: gold page ${where} has no stratum`);
    const w = m.get(st);
    if (w === undefined) throw new Error(`UNKNOWN STRATA: ${st} (gold page ${where}) is not in the frame`);
    return w;
  };
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Engine rule: pages under 10 chars of text are skipped, not scored (csi-detect contract). */
export const isScoredText = (t: string | null | undefined) => typeof t === "string" && t.trim().length >= 10;

export function codesPerPage(pages: CapturePage[]) {
  const n = pages.map(p => new Set(p.codes).size);
  const total = n.reduce((a, b) => a + b, 0);
  const sorted = [...n].sort((a, b) => a - b);
  return {
    pages: pages.length,
    pagesWithCodes: n.filter(x => x > 0).length,
    mean: pages.length ? +(total / pages.length).toFixed(3) : null,
    median: median(n),
    p90: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(0.9 * sorted.length))] : null,
    distinctCodes: new Set(pages.flatMap(p => p.codes.map(exact))).size,
  };
}

const CIVIL_DIVS = new Set(["33", "34", "35", "40", "41", "42", "43", "44", "45", "46", "47", "48"]);

/**
 * PLAN §8 integrity counters. Counters that need data a capture does not carry are `null`
 * with the reason in `notAvailable` — never 0.
 */
export function integrity(pages: CapturePage[], info: (p: CapturePage) => PageInfo | undefined) {
  let parentBesideDescendant = 0, pagesWithPBD = 0;
  let civilOnNonCivil = 0, civilOnUnknown = 0;
  let detailPages = 0, fanOut = 0, codesWithoutDetail = 0;
  let checkPages = 0, childWithoutDiff = 0, pbdSameRange = 0, pagesCodesGtSpans = 0, familySpans = 0, emittedSpans = 0, hints = 0;
  const pairs = new Map<string, number>();
  for (const p of pages) {
    const ks = [...new Set(p.codes.map(c => chainKey(c, "exact")))];
    let here = 0;
    for (const a of ks) for (const b of ks) if (a !== b && b.startsWith(a)) here++;
    parentBesideDescendant += here;
    if (here) pagesWithPBD++;
    const disc = info(p)?.discipline ?? null;
    for (const c of new Set(p.codes.map(exact))) {
      if (!CIVIL_DIVS.has(c.slice(0, 2))) continue;
      if (disc === null) civilOnUnknown++;
      else if (disc.toUpperCase() !== "C") civilOnNonCivil++;
    }
    if (p.checks) {
      checkPages++;
      childWithoutDiff += p.checks.childWithoutDiffToken;
      if (p.checks.emittedCodes > p.checks.emittedSpans) pagesCodesGtSpans++;
      familySpans += p.checks.familySpans ?? 0;
      emittedSpans += p.checks.emittedSpans;
      hints += p.checks.hints ?? 0;
      pbdSameRange += p.checks.parentBesideDescendantSameRange ?? 0;
    }
    if (p.codeDetails) {
      detailPages++;
      const by = new Map(p.codeDetails.map(d => [exact(d.code), d]));
      for (const c of new Set(p.codes.map(exact))) {
        const d = by.get(c);
        if (!d) { codesWithoutDetail++; continue; }
        // a τ=0 capture's codeDetails include codes not in `codes`; only emitted codes are looked up
        const owned = (d.triggers ?? []).filter(t => t.emitted !== false);
        if (owned.length === 0) fanOut++;
        for (const t of owned) if (t.pattern) {
          const k = `${d.code}\t${t.pattern}`;
          pairs.set(k, (pairs.get(k) ?? 0) + 1);
        }
      }
    }
  }
  const hasDetails = detailPages > 0;
  const hasChecks = checkPages > 0;
  const top = [...pairs.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 40);
  return {
    counters: {
      parentBesideDescendant, pagesWithParentBesideDescendant: pagesWithPBD,
      civilDivOnNonCivilSheet: civilOnNonCivil, civilDivOnUnknownDiscipline: civilOnUnknown,
      emitsWithoutOwnedSpan: hasDetails ? fanOut + codesWithoutDetail : null,
      parentBesideDescendantSameRange: hasChecks ? pbdSameRange : null,
      childWithoutDiffToken: hasChecks ? childWithoutDiff : null,
      pagesEmitsGtOwnedSpans: hasChecks ? pagesCodesGtSpans : null,
      emittedSpans: hasChecks ? emittedSpans : null,
      familyOwnerSpans: hasChecks ? familySpans : null,
      hintsPerPage: hasChecks && pages.length ? +(hints / pages.length).toFixed(3) : null,
      notesOnlySupportShare: null,
      legendPageCodesPerPageVsMedian: null,
      topPairsDistinct: hasDetails ? pairs.size : null,
    },
    notAvailable: [
      hasDetails ? null : "emitsWithoutOwnedSpan/topPairs: capture has no codeDetails (OLD engine shape)",
      hasChecks ? null : "childWithoutDiffToken / pagesEmitsGtOwnedSpans: capture has no per-page checks (capture-v2 only)",
      "notesOnlySupportShare / legendPageCodesPerPageVsMedian: need pageKind per page; the corpus carries none (P1 trigger)",
    ].filter(Boolean) as string[],
    /** PRIVATE: KB pattern text. Only ever written to --private-out. */
    topPairs: top.map(([k, n]) => ({ code: k.split("\t")[0], pattern: k.split("\t")[1], n })),
  };
}

// ═══════════════════════════════════════════════════════════════
// Per-term table (PLAN §8) — generic trade vocabulary, not client text
// ═══════════════════════════════════════════════════════════════

/**
 * Abbreviations match case-SENSITIVELY (ACT, RB are English words in lower case), so each row is a
 * LIST of regexes — one `/i` alternative would make the whole alternation case-insensitive.
 */
export const PER_TERM_ROWS: { term: string; re: RegExp[]; target: string }[] = [
  { term: "GWB/GYP BD", re: [/\bGWB\b/, /\bGYP\.?\s*BD\b/], target: "0929" },
  { term: "PTD/PAINT", re: [/\bPTD\b/, /\bpaint(ed|ing|s)?\b/i], target: "0991" },
  { term: "HM", re: [/\bH\.?M\.?(?=\s|$|[,;:/)])/], target: "081" },
  { term: "ACT/lay-in", re: [/\bACT\b/, /\blay[- ]in\b/i], target: "095113" },
  { term: "CMU", re: [/\bCMU\b/], target: "0422" },
  { term: "VCT", re: [/\bVCT\b/], target: "0965" },
  { term: "CARPET", re: [/\bcarpet(ing|s)?\b/i], target: "0968" },
  { term: "SPRINKLER", re: [/\bsprinklers?\b/i], target: "2113" },
  { term: "INSULATION", re: [/\binsulation\b/i], target: "0721" },
  { term: "VAPOR BARRIER", re: [/\bvapou?r\s+barriers?\b/i], target: "0726" },
  { term: "MTL STUD", re: [/\b(MTL|metal)\.?\s+studs?\b/i], target: "092216" },
  { term: "SEALANT", re: [/\bsealants?\b/i], target: "0792" },
  { term: "FRP", re: [/\bFRP\b/], target: "0664" },
  { term: "RB", re: [/\bRB\b/], target: "096513" },
  { term: "EIFS", re: [/\bEIFS\b/], target: "0724" },
  { term: "STOREFRONT", re: [/\bstore\s?fronts?\b/i], target: "084" },
  { term: "FLASHING", re: [/\bflashings?\b/i], target: "076" },
  { term: "WATERPROOF", re: [/\bwaterproof(ing)?\b/i], target: "071" },
];

/** For each row: distinct scored pages whose text mentions the term, and how many emit a code under the target. */
export function perTermTable(pages: CapturePage[], textOf: (p: CapturePage) => string | null) {
  return PER_TERM_ROWS.map(row => {
    let withTerm = 0, hit = 0;
    for (const p of pages) {
      const t = textOf(p);
      if (!t || !row.re.some(re => re.test(t))) continue;
      withTerm++;
      if (p.codes.some(c => digits(c).startsWith(row.target))) hit++;
    }
    return { term: row.term, target: row.target, pagesWithTerm: withTerm, pagesHit: hit, recall: withTerm ? r4(hit / withTerm) : null };
  });
}

// ═══════════════════════════════════════════════════════════════
// Engine scoring over the gold set
// ═══════════════════════════════════════════════════════════════

export interface GoldSet { pages: GoldPage[] }

export function scoreEngine(
  gold: GoldPage[], emittedBy: Map<string, string[]>, weightOf: (st: string | undefined, where: string) => number,
  variants: Variant[], minLevel: number,
) {
  const out: Record<string, Record<Mode, Cell>> = {};
  const missing = new Set<string>();
  const unusable = new Set<string>();
  for (const v of variants) {
    const cells = {} as Record<Mode, Cell>;
    for (const mode of ["section", "exact"] as Mode[]) {
      const scores: PageScoreH[] = [];
      for (const p of gold) {
        const k = pageKey(p.bundle, p.page);
        const g = goldFor(p, v);
        if (!g) { unusable.add(k); continue; }
        const e = emittedBy.get(k);
        if (e === undefined) missing.add(k);
        scores.push(scorePageH(g, p, e ?? [], mode, weightOf(p.stratum, k), minLevel));
      }
      cells[mode] = aggregateH(scores);
    }
    out[v] = cells;
  }
  return { cells: out, missingFromEngine: [...missing], unusableGold: [...unusable] };
}

/** score.ts `results[v][mode]` vs ours: flat P/R/primaryR/F0.5/pagesScored must agree exactly. */
export function checkAgainstScore(ours: Record<string, Record<Mode, Cell>>, score: { results: Record<string, Record<Mode, Record<string, unknown>>> }): string[] {
  const bad: string[] = [];
  for (const [v, byMode] of Object.entries(score.results)) {
    for (const mode of ["section", "exact"] as Mode[]) {
      const a = ours[v]?.[mode] as unknown as Record<string, unknown> | undefined;
      const b = byMode[mode];
      if (!a || !b) { bad.push(`${v}/${mode}: missing`); continue; }
      for (const f of ["pagesScored", "precision", "recall", "primaryRecall", "f05", "truePositives", "groupsTotal", "groupsHit"]) {
        if (a[f] !== b[f]) bad.push(`${v}/${mode}.${f}: compare=${a[f]} score=${b[f]}`);
      }
      if (JSON.stringify(a.precisionBracket) !== JSON.stringify(b.precisionBracket)) bad.push(`${v}/${mode}.precisionBracket differs`);
    }
  }
  return bad;
}

// ═══════════════════════════════════════════════════════════════
// Driver
// ═══════════════════════════════════════════════════════════════

const sha16 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex").slice(0, 16);

export function readCorpus(path: string): Map<string, PageInfo> {
  const m = new Map<string, PageInfo>();
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line) continue;
    const r = JSON.parse(line) as { bundle: string; pageNumber: number; rawText: string | null; discipline: string | null };
    m.set(pageKey(r.bundle, r.pageNumber), {
      textSha: createHash("sha256").update(r.rawText ?? "").digest("hex"), text: r.rawText, discipline: r.discipline,
    });
  }
  return m;
}

export function parseArgs(argv: string[]) {
  const multi = (name: string) => argv.filter(a => a.startsWith(`--${name}=`)).map(a => a.slice(name.length + 3));
  const one = (name: string) => multi(name)[0];
  const pair = (s: string) => {
    const i = s.indexOf("=");
    if (i <= 0) throw new Error(`expected label=path, got ${s}`);
    return { label: s.slice(0, i), path: s.slice(i + 1) };
  };
  return {
    gold: one("gold"), frame: one("frame"), corpus: one("corpus"), out: one("out"), privateOut: one("private-out"),
    minLevel: Number(one("min-level") ?? "2"),
    engines: multi("engine").map(pair), checks: multi("check-score").map(pair),
  };
}

function main(): void {
  const a = parseArgs(process.argv.slice(2));
  if (!a.gold || !a.frame || a.engines.length === 0) {
    console.error("usage: node csi-compare.js --gold=<gold.json> --frame=<gold-frame.json> --engine=<label>=<capture.json>… [--corpus=<corpus.ndjson>] [--out=<f>] [--check-score=<label>=<score.json>] [--min-level=2] [--private-out=<f>]");
    process.exit(1);
  }
  if (!existsSync(a.frame)) { console.error(`compare: NO stratum weights — frame not found at ${a.frame}`); process.exit(1); }
  const frameRaw = readFileSync(a.frame, "utf-8");
  const weightOf = weightFn(JSON.parse(frameRaw));
  const goldRaw = readFileSync(a.gold, "utf-8");
  const goldAll = (JSON.parse(goldRaw) as GoldSet).pages;
  const corpus = a.corpus ? readCorpus(a.corpus) : null;
  const engines = a.engines.map(e => {
    const raw = readFileSync(e.path, "utf-8");
    return { ...e, sha: sha16(raw), cap: JSON.parse(raw) as Capture };
  });

  // Dedupe key: corpus rawText sha (spec), else capture-provided, else none — named in the output.
  const dedupeKey = corpus ? "rawTextSha(corpus)" : engines[0].cap.pages.every(p => p.rawTextSha) ? "rawTextSha(capture)"
    : engines[0].cap.pages.every(p => p.inputSha) ? "inputSha(first engine)" : "none";
  const firstBy = new Map(engines[0].cap.pages.map(p => [pageKey(p.bundle, p.page), p]));
  const dk = (bundle: string, page: number) => {
    const k = pageKey(bundle, page);
    if (corpus) return corpus.get(k)?.textSha ?? `missing:${k}`;
    const p = firstBy.get(k);
    return p?.rawTextSha ?? p?.inputSha ?? k;
  };
  const goldD = dedupe(goldAll, p => dk(p.bundle, p.page));
  const certified = goldD.kept.length > 0 && goldD.kept.every(isCertifiedPage);
  const variants: Variant[] = certified ? ["certified"] : ["strict", "generous"];

  const results: Record<string, unknown> = {};
  const corpusStats: Record<string, unknown> = {};
  const integ: Record<string, unknown> = {};
  const perTerm: Record<string, unknown> = {};
  const privateOut: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const e of engines) {
    const emittedBy = new Map(e.cap.pages.map(p => [pageKey(p.bundle, p.page), p.codes]));
    const s = scoreEngine(goldD.kept, emittedBy, weightOf, variants, a.minLevel);
    results[e.label] = { ...s.cells, missingFromEngine: s.missingFromEngine.length, unusableGold: s.unusableGold.length };
    if (s.missingFromEngine.length) problems.push(`${e.label}: ${s.missingFromEngine.length} gold page(s) missing from capture, scored as emitting nothing`);
    const dd = dedupe(e.cap.pages, p => dk(p.bundle, p.page));
    const info = (p: CapturePage) => corpus?.get(pageKey(p.bundle, p.page));
    const scored = corpus ? dd.kept.filter(p => isScoredText(info(p)?.text)) : dd.kept;
    corpusStats[e.label] = { pagesIn: e.cap.pages.length, distinct: dd.kept.length, ...codesPerPage(scored) };
    const ig = integrity(scored, info);
    integ[e.label] = { counters: ig.counters, notAvailable: ig.notAvailable };
    privateOut[e.label] = { topPairs: ig.topPairs };
    perTerm[e.label] = corpus ? perTermTable(scored, p => info(p)?.text ?? null) : null;
  }
  for (const c of a.checks) {
    // score.ts does not dedupe, so the cross-check re-scores over ALL gold pages.
    const e = engines.find(x => x.label === c.label);
    if (!e) { problems.push(`check-score: no engine labelled ${c.label}`); continue; }
    const all = scoreEngine(goldAll, new Map(e.cap.pages.map(p => [pageKey(p.bundle, p.page), p.codes])), weightOf, variants, a.minLevel);
    const bad = checkAgainstScore(all.cells, JSON.parse(readFileSync(c.path, "utf-8")));
    if (bad.length) { console.error(`compare: CHECK FAILED vs ${c.path}:\n  ${bad.join("\n  ")}`); process.exit(2); }
    console.error(`[compare] check-score ${c.label}: flat cells reproduce ${basename(c.path)} exactly`);
  }

  const out = {
    schemaVersion: "csi-compare/1",
    generatedAt: new Date().toISOString(),
    inputs: {
      gold: { file: basename(a.gold), sha16: sha16(goldRaw), pages: goldAll.length, distinct: goldD.kept.length, certified },
      frame: { file: basename(a.frame), sha16: sha16(frameRaw) },
      corpus: a.corpus ? { file: basename(a.corpus), sha16: sha16(readFileSync(a.corpus)), rows: corpus?.size } : null,
      engines: engines.map(e => ({ label: e.label, file: basename(e.path), sha16: e.sha, engineSha: e.cap.engineSha ?? null, kbSha: e.cap.kbSha ?? null })),
    },
    config: { dedupeKey, hierarchyMinAncestorLevel: a.minLevel, fBeta: 0.5, variants },
    caveats: [
      certified ? null : "Gold is UNCERTIFIED: quote strict/generous as a range; precision is a FLOOR (see precisionBracket).",
      dedupeKey === "rawTextSha(corpus)" ? null : `Dedupe key is ${dedupeKey}, not the corpus rawText sha.`,
      goldD.dropped ? `${goldD.dropped} gold page(s) duplicate another gold page's text and are scored once; flat cells therefore differ from score.ts (which scores all ${goldAll.length}).` : null,
      ...problems,
    ].filter(Boolean),
    results, corpus: corpusStats, integrity: integ, perTerm,
  };
  if (a.out) writeFileSync(a.out, JSON.stringify(out, null, 2) + "\n");
  if (a.privateOut) writeFileSync(a.privateOut, JSON.stringify(privateOut, null, 2) + "\n");
  printTable(out.results as Record<string, Record<string, Record<Mode, Cell>>>, corpusStats, variants);
  if (problems.length) console.error(`[compare] ${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
}

function printTable(results: Record<string, Record<string, Record<Mode, Cell>>>, stats: Record<string, unknown>, variants: Variant[]) {
  const f = (x: number | null | undefined) => (x === null || x === undefined ? "  —   " : x.toFixed(4));
  console.error("engine     variant  mode     P      R      primR  F0.5   | hierP  hierR  hierF  | floor..ceil      codes/pg");
  for (const [label, r] of Object.entries(results)) {
    const cpp = (stats[label] as { mean: number | null }).mean;
    for (const v of variants) for (const mode of ["section", "exact"] as Mode[]) {
      const c = r[v][mode];
      const br = c.precisionBracket ? `${f(c.precisionBracket.floor)}..${f(c.precisionBracket.ceiling)}` : "—";
      console.error(`${label.padEnd(10)} ${v.padEnd(8)} ${mode.padEnd(8)} ${f(c.precision)} ${f(c.recall)} ${f(c.primaryRecall)} ${f(c.f05)} | ${f(c.hier.precision)} ${f(c.hier.recall)} ${f(c.hier.f05)} | ${br.padEnd(16)} ${cpp}`);
    }
  }
}

// Only run as the CLI entry point (bundle name contains csi-compare); tests import the pure helpers.
if (process.argv[1]?.includes("csi-compare")) main();
