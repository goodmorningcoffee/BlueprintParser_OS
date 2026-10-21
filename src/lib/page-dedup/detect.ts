// Duplicate-page detector (admin data tools, feature 2). Pure: stored text in, report out.
//
// Owner's method (OWNER_INPUT_2026-10-21): high OCR similarity plus "the sheet numbers repeat
// in the same order". Made revision-safe (PLAN §2.1, critic #1):
//   • two scores per pair — `content` (boilerplate stripped; finds/ranks, the 0.90 line) and
//     `full` (unstripped; every bulk gate), because the strip removes exactly the tokens that
//     separate a permit set from its IFC re-issue;
//   • non-exact block tiers need both drawing numbers non-null and equal; pairs whose numbers
//     differ are never reported (unless the text is identical);
//   • blocks need L ≥ 3 and d ≥ L (runs.ts), so typical floors at offset 1 never chain;
//   • a block holding any pair that fails the run gate (`full` ≥ 0.995 AND ≤ 6 changed
//     shingles, i.e. at most one changed word whatever the sheet size) is "near" / "likely
//     revision set": removable one block at a time only, never in bulk; inside it every pair
//     takes the block's tier;
//   • revision context: a same-offset run of scored pairs (numbers equal, missing or misread,
//     see revisionContext) holding any changed page is a re-issue, so its text-identical pages
//     are near too, even when the changed sheet splits the link run into two blocks or leaves
//     lone identical pairs. Without it one changed sheet in an IFC re-issue let "remove all
//     exact" hide the rest of the IFC set (verify-r1, verify-r2). It sees one offset at a time,
//     so a changed sheet it cannot score (number missing or misread AND text below the 0.70
//     floor, which ≈ 8 % of words changed already reaches) breaks the run there;
//   • bulk hold (holdReason, verify-r3): an inserted, dropped or reordered sheet moves part of a
//     re-issue to another offset, and unscorable changed sheets split a run, so ANY revision
//     evidence in a project turns "remove all" off for the whole project; its blocks, exact
//     ones too, go one at a time. Residual: an unscorable changed FIRST or LAST sheet leaves no
//     evidence, so the rest of that set stays bulk exact. Identical pages with no changed
//     neighbour stay exact (the plan's rule: the stored text is all there is; a graphics-only
//     re-issue is indistinguishable).
//   • default keep: exact → first copy; run / near → latest copy, since their texts differ and
//     the later copy is the likelier re-issue (owner decision 7, extended to run).

import { boilerplateLines, drawingKey, normalizeDrawingNumber, normalizedLines, removePhrase, tokensOf } from "./normalize";
import { blockId, findBlocks, MIN_RUN, resolveBlockCoverage, type RawBlock } from "./runs";
import { changedShingles, jaccard, jaccardUpperBound, shingles } from "./similarity";
import type { DedupPageInput, DuplicateBlock, DuplicateKeep, DuplicatePair, DuplicateReport, DuplicateTier } from "./types";

export const DEDUP_THRESHOLDS = Object.freeze({
  /** Owner's line: ≥ 90 % OCR similarity (content score). */
  near: 0.9,
  /** Every pair of a bulk "repeat set" block (full score). */
  run: 0.995,
  /** …and at most this many changed full-text shingles (one interior word = 6): a ratio alone
   *  lets a one-line revision on a dense notes sheet through (J ≥ 0.995 ⇔ N ≳ 1,200 tokens). */
  runMaxChangedShingles: 6,
  /** Review-only floor. */
  possible: 0.7,
  /** Pages with fewer non-boilerplate tokens are never duplicates (blank sheets hash alike). */
  minContentTokens: 5,
  minRun: MIN_RUN,
});

/**
 * `run` blocks join "remove all" only after the owner reviews prod reports (PLAN §4 Q2): the
 * July corpus has no revision-set upload, so the natural gap above 0.995 is not established.
 * Until then a run block is removable one block at a time, like `near`.
 */
export const RUN_BULK_ENABLED = false;

/** Tiers that "remove all" / tier-bulk apply may take. */
export function bulkTiers(): DuplicateTier[] {
  return RUN_BULK_ENABLED ? ["exact", "run"] : ["exact"];
}

interface Prepared {
  pageNumber: number;
  number: string | null;
  fullText: string;
  full: Uint32Array;
  content: Uint32Array;
  eligible: boolean;
}

interface Score {
  content: number;
  full: number;
  /** |A △ B| over the full-text shingles. */
  fullChanged: number;
  identical: boolean;
  sameNumber: boolean;
}

const round = (x: number) => Math.round(x * 10000) / 10000;

function prepare(input: readonly DedupPageInput[]): Prepared[] {
  const byPage = new Map<number, DedupPageInput>();
  for (const p of input) if (!byPage.has(p.pageNumber)) byPage.set(p.pageNumber, p);
  const pages = [...byPage.values()].sort((a, b) => a.pageNumber - b.pageNumber);
  const lines = pages.map((p) => normalizedLines(p.rawText));
  const boiler = boilerplateLines(lines);
  return pages.map((p, i) => {
    const dn = normalizeDrawingNumber(p.drawingNumber);
    const contentLines: string[] = [];
    for (const line of lines[i]) {
      if (boiler.has(line)) continue;
      const stripped = removePhrase(line, dn);
      if (stripped) contentLines.push(stripped);
    }
    const contentTokens = tokensOf(contentLines);
    return {
      pageNumber: p.pageNumber,
      number: drawingKey(p.drawingNumber),
      fullText: lines[i].join(" "),
      full: shingles(tokensOf(lines[i])),
      content: shingles(contentTokens),
      eligible: contentTokens.length >= DEDUP_THRESHOLDS.minContentTokens,
    };
  });
}

/** Detect in-project duplicates. Page numbers are taken as-is; nothing is renumbered. */
export function detectDuplicates(input: readonly DedupPageInput[]): DuplicateReport {
  const pages = prepare(input);
  const scores = new Map<string, Score>();
  const key = (a: number, b: number) => `${a}:${b}`;

  // 1. Score candidate pairs (a < b). Size-ratio prefilter skips pairs that cannot reach the
  //    review floor, except same-number pairs (a lone repeated sheet is always reported).
  const eligible = pages.filter((p) => p.eligible);
  for (let i = 0; i < eligible.length; i++) {
    const a = eligible[i];
    for (let j = i + 1; j < eligible.length; j++) {
      const b = eligible[j];
      const identical = a.fullText === b.fullText;
      const sameNumber = a.number !== null && a.number === b.number;
      const bothNumbered = a.number !== null && b.number !== null;
      if (!identical && bothNumbered && !sameNumber) continue; // differing numbers: never paired
      if (!identical && !sameNumber && jaccardUpperBound(a.content.length, b.content.length) < DEDUP_THRESHOLDS.possible) continue;
      const content = identical ? 1 : jaccard(a.content, b.content);
      if (!identical && !sameNumber && content < DEDUP_THRESHOLDS.possible) continue;
      const full = identical ? 1 : jaccard(a.full, b.full);
      const fullChanged = identical ? 0 : changedShingles(a.full.length, b.full.length, full);
      scores.set(key(a.pageNumber, b.pageNumber), { content, full, fullChanged, identical, sameNumber });
    }
  }

  // 2. Blocks: links are identical pairs or same-number pairs at the owner's 0.90 line.
  const links: [number, number][] = [];
  for (const [k, s] of scores) {
    if (s.identical || (s.sameNumber && s.content >= DEDUP_THRESHOLDS.near)) {
      const [a, b] = k.split(":").map(Number);
      links.push([a, b]);
    }
  }
  const rawBlocks = resolveBlockCoverage(findBlocks(links, DEDUP_THRESHOLDS.minRun));
  const revision = revisionContext(scores, pages);

  const pairs = new Map<number, DuplicatePair>();
  const blocks: DuplicateBlock[] = [];
  for (const rb of rawBlocks) {
    const members: { a: number; b: number; s: Score }[] = [];
    for (let i = 0; i < rb.length; i++) {
      const a = rb.start + i;
      const s = scores.get(key(a, a + rb.offset));
      if (s) members.push({ a, b: a + rb.offset, s });
    }
    if (members.length !== rb.length) continue; // defensive: findBlocks only emits linked pages
    const tier = members.some((m) => revision.has(key(m.a, m.b))) ? "near" : blockTier(members.map((m) => m.s));
    const id = blockId(rb);
    blocks.push({
      id,
      start: rb.start,
      offset: rb.offset,
      length: rb.length,
      tier,
      label: tier === "near" ? "likely revision set" : "repeat set",
      minContent: round(Math.min(...members.map((m) => m.s.content))),
      minFull: round(Math.min(...members.map((m) => m.s.full))),
    });
    for (const m of members) {
      if (pairs.has(m.b)) continue; // first (nearest-root) block wins
      pairs.set(m.b, toPair(m.b, m.a, tier, m.s, id));
    }
  }

  // 3. Lone pairs for pages not already in a block: identical text first (lowest copy is
  //    canonical), else the best-scoring earlier partner.
  const groups = new Map<string, number[]>();
  for (const p of eligible) {
    const list = groups.get(p.fullText);
    if (list) list.push(p.pageNumber);
    else groups.set(p.fullText, [p.pageNumber]);
  }
  for (const list of groups.values()) {
    for (const page of list.slice(1)) {
      if (pairs.has(page)) continue;
      const s = scores.get(key(list[0], page));
      if (s) pairs.set(page, toPair(page, list[0], revision.has(key(list[0], page)) ? "near" : "exact", s, null));
    }
  }
  const best = new Map<number, { a: number; s: Score }>();
  for (const [k, s] of scores) {
    if (s.identical) continue;
    const [a, b] = k.split(":").map(Number);
    if (pairs.has(b)) continue;
    const prior = best.get(b);
    if (!prior || s.content > prior.s.content || (s.content === prior.s.content && a < prior.a)) best.set(b, { a, s });
  }
  for (const [b, { a, s }] of best) {
    const tier: DuplicateTier = s.content >= DEDUP_THRESHOLDS.near ? "near" : "possible";
    pairs.set(b, toPair(b, a, tier, s, null));
  }

  // 4. Chains resolve to the root (a set repeated 3× points every copy at the first). Only
  //    through exact/run links: a revision is not a copy of what it revised.
  const confirmed = (t: DuplicateTier) => t === "exact" || t === "run";
  for (const pair of pairs.values()) {
    if (!confirmed(pair.tier)) continue;
    const seen = new Set<number>([pair.page]);
    let target = pair.canonical;
    for (;;) {
      const next = pairs.get(target);
      if (!next || !confirmed(next.tier) || seen.has(next.canonical)) break;
      seen.add(target);
      target = next.canonical;
    }
    pair.canonical = target;
  }

  const bulkHold = holdReason(scores, revision, blocks, pages);
  const sorted = [...pairs.values()].sort((x, y) => x.page - y.page);
  const count = (t: DuplicateTier) => sorted.filter((p) => p.tier === t).length;
  return {
    counts: {
      pages: pages.length,
      blank: pages.length - eligible.length,
      exact: count("exact"),
      run: count("run"),
      near: count("near"),
      possible: count("possible"),
      blocks: blocks.length,
    },
    blocks: blocks.sort((x, y) => x.start + x.offset - (y.start + y.offset)),
    pairs: sorted,
    bulkHold,
  };
}

/**
 * The pairs "remove all" may hide: none while the project is on hold (`bulkHold`), else every
 * pair of a bulk tier. planHides reads this, so the hold is one rule for every bulk path.
 */
export function bulkPairs(report: DuplicateReport, tiers: readonly DuplicateTier[] = bulkTiers()): DuplicatePair[] {
  if (report.bulkHold) return [];
  return report.pairs.filter((p) => tiers.includes(p.tier));
}

/** A re-issue that inserts or drops up to this many sheets still counts as beside its copy. */
const REISSUE_SHIFT = 3;

/**
 * Why "remove all" must skip this project, or null. Conservative project-level rule
 * (verify-r3): a re-issue that inserts, drops or reorders a sheet moves part of the set to
 * another offset, where the per-offset revision context cannot see the changed sheet, so ANY
 * revision evidence turns bulk off for the whole project; its blocks stay removable one at a
 * time. Evidence, over the scored pairs:
 *   1. a likely-revision-set block, or an identical pair inside a revision context;
 *   2. a repeated drawing number whose text is ≥ 90 % alike but fails the run gate;
 *   3. a changed pair ≥ 90 % alike (a number missing) within REISSUE_SHIFT pages and offset
 *      of a run of copies (identical or run-gate pairs at one offset) — a revised first/last
 *      sheet next to an inserted or dropped one;
 *   4. two runs of copies at one offset d split by < d slots that are not blank in both
 *      copies — changed sheets whose numbers are missing or misread and whose
 *      text fell below the review floor (≈ 8 % of words changed already does).
 * Not seen: a changed first or last sheet that is unscored (number missing or misread AND
 * text below the 0.70 floor) — nothing ties it to the set, so the rest stays bulk exact.
 */
function holdReason(scores: ReadonlyMap<string, Score>, revision: ReadonlySet<string>, blocks: readonly DuplicateBlock[], pages: readonly Prepared[]): string | null {
  const REVISION = "holds a likely revision set";
  if (blocks.some((b) => b.tier === "near")) return REVISION;
  const copiesAt = new Map<number, number[]>();
  const changed: [number, number][] = [];
  for (const [k, s] of scores) {
    if (s.identical && revision.has(k)) return REVISION;
    const [a, b] = k.split(":").map(Number);
    if (passesRun(s)) {
      const list = copiesAt.get(b - a);
      if (list) list.push(a);
      else copiesAt.set(b - a, [a]);
    } else if (s.content >= DEDUP_THRESHOLDS.near) {
      if (s.sameNumber) return "repeats a drawing number with changed text";
      changed.push([a, b]);
    }
  }
  const byPage = new Map(pages.map((p) => [p.pageNumber, p]));
  const blankSlot = (a: number, d: number) => byPage.get(a)?.eligible === false && byPage.get(a + d)?.eligible === false;
  const runs: { d: number; first: number; last: number }[] = [];
  for (const [d, starts] of copiesAt) {
    const sorted = [...new Set(starts)].sort((x, y) => x - y);
    let first = sorted[0];
    for (let i = 1; i <= sorted.length; i++) {
      if (i < sorted.length && sorted[i] === sorted[i - 1] + 1) continue;
      runs.push({ d, first, last: sorted[i - 1] });
      if (i < sorted.length) first = sorted[i];
    }
  }
  for (const [a, b] of changed) {
    const near = runs.some((r) => Math.abs(b - a - r.d) <= REISSUE_SHIFT && a >= r.first - REISSUE_SHIFT && a <= r.last + REISSUE_SHIFT);
    if (near) return REVISION;
  }
  runs.sort((x, y) => x.d - y.d || x.first - y.first);
  for (let i = 1; i < runs.length; i++) {
    const [prev, next] = [runs[i - 1], runs[i]];
    if (prev.d !== next.d || next.first - prev.last - 1 >= next.d) continue;
    for (let a = prev.last + 1; a < next.first; a++) if (!blankSlot(a, next.d)) return "has a repeated set split by changed sheets";
  }
  return null;
}

/** Identical, or a same-number pair within the run gate (ratio AND absolute change cap). */
function passesRun(s: Score): boolean {
  return s.identical || (s.sameNumber && s.full >= DEDUP_THRESHOLDS.run && s.fullChanged <= DEDUP_THRESHOLDS.runMaxChangedShingles);
}

function blockTier(scores: readonly Score[]): DuplicateBlock["tier"] {
  if (scores.every((s) => s.identical)) return "exact";
  if (scores.every(passesRun)) return "run";
  return "near";
}

interface Slot {
  a: number;
  ok: boolean;
}

/**
 * Pair keys that sit in a revision set. A drawing number is NOT required: a changed sheet's
 * number can be missing or misread (verify-r2: either broke the run and let "remove all exact"
 * hide the rest of the re-issue). For each offset d:
 *   1. the runs are consecutive positions a whose (a, a+d) pair was scored (identical, equal
 *      numbers, or a number missing and the pages alike), joined across gaps of < d slots by
 *      `slot` (a changed sheet inside the set, e.g. one whose number was misread);
 *   2. a run shorter than a whole number of copies (length % d ≠ 0) grows at its ends by slots
 *      whose pages are still alike — a changed first or last sheet — or blank in both copies,
 *      up to the next multiple of d, so a complete copy never absorbs a neighbour;
 *   3. each run is cut into d-long chunks like findBlocks; a chunk holding any slot that fails
 *      the run gate marks every pair in it.
 */
function revisionContext(scores: ReadonlyMap<string, Score>, pages: readonly Prepared[]): Set<string> {
  const byPage = new Map(pages.map((p) => [p.pageNumber, p]));
  const byOffset = new Map<number, number[]>();
  for (const k of scores.keys()) {
    const [a, b] = k.split(":").map(Number);
    const list = byOffset.get(b - a);
    if (list) list.push(a);
    else byOffset.set(b - a, [a]);
  }
  const out = new Set<string>();
  for (const [d, starts] of byOffset) {
    const at = (a: number, wide: boolean) => slot(scores, byPage, a, d, wide);
    const sorted = [...new Set(starts)].sort((x, y) => x - y);
    const runs: Slot[][] = [];
    for (const a of sorted) {
      const run = runs[runs.length - 1];
      const gap = run ? bridge(run[run.length - 1].a, a, d, at) : null;
      const self = { a, ok: passesRun(scores.get(`${a}:${a + d}`) as Score) };
      if (run && gap) run.push(...gap, self);
      else runs.push([self]);
    }
    for (const run of runs) {
      for (let grew = true; grew && run.length % d !== 0; ) {
        grew = false;
        for (const end of [0, 1] as const) {
          if (run.length % d === 0) break;
          const a = end ? run[run.length - 1].a + 1 : run[0].a - 1;
          const ok = at(a, true); // ends grow only by alike changed slots (or blank ones)
          if (ok === null) continue;
          if (end) run.push({ a, ok });
          else run.unshift({ a, ok });
          grew = true;
        }
      }
      for (let c = 0; c < run.length; c += d) {
        const chunk = run.slice(c, c + d);
        if (chunk.some((m) => !m.ok)) for (const m of chunk) out.add(`${m.a}:${m.a + d}`);
      }
    }
  }
  return out;
}

/** The slots strictly between two core positions of one offset-d run, or null where it breaks. */
function bridge(prev: number, next: number, d: number, at: (a: number, wide: boolean) => boolean | null): Slot[] | null {
  const missing = next - prev - 1;
  if (missing >= d) return null;
  const out: Slot[] = [];
  for (let a = prev + 1; a < next; a++) {
    const ok = at(a, missing > 1);
    if (ok === null) return null;
    out.push({ a, ok });
  }
  return out;
}

/**
 * Slot a of an offset-d run, i.e. the pair (a, a+d): true = passes (identical or within the run
 * gate, or both pages blank — a blank sheet in both copies), false = a changed sheet, null = the
 * run breaks here (a page is missing, or in a `wide` gap / at a run end the pages are not alike:
 * unscored and content below the review floor). A one-slot interior gap is always a changed
 * sheet: its pages sit positionally as a copy pair, so a rewrite or a misread number.
 */
function slot(scores: ReadonlyMap<string, Score>, byPage: ReadonlyMap<number, Prepared>, a: number, d: number, wide: boolean): boolean | null {
  const x = byPage.get(a);
  const y = byPage.get(a + d);
  if (!x || !y) return null;
  const s = scores.get(`${a}:${a + d}`);
  if (s) return passesRun(s);
  if (!x.eligible && !y.eligible) return true;
  if (!wide) return false;
  return x.eligible && y.eligible && jaccard(x.content, y.content) >= DEDUP_THRESHOLDS.possible ? false : null;
}

function toPair(page: number, canonical: number, tier: DuplicateTier, s: Score, block: string | null): DuplicatePair {
  return {
    page,
    canonical,
    tier,
    content: round(s.content),
    full: round(s.full),
    sameNumber: s.sameNumber,
    identical: s.identical,
    blockId: block,
  };
}

/**
 * Which pages a block's resolution hides, and what each points at. `earliest` keeps the first
 * copy (hides the later one, the default for exact); `latest` keeps the re-issue and hides
 * the earlier copy (the default for run and for a likely revision set, owner decision 7:
 * their texts differ, so the later copy may carry a revision).
 */
export function blockHides(block: Pick<RawBlock, "start" | "offset" | "length">, keep: DuplicateKeep): { page: number; canonical: number }[] {
  const out: { page: number; canonical: number }[] = [];
  for (let i = 0; i < block.length; i++) {
    const early = block.start + i;
    const late = early + block.offset;
    out.push(keep === "latest" ? { page: early, canonical: late } : { page: late, canonical: early });
  }
  return out;
}

export function defaultKeep(tier: DuplicateTier): DuplicateKeep {
  return tier === "exact" ? "earliest" : "latest";
}
