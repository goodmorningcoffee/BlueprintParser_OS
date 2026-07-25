/**
 * csi-detect-next.ts — the rebuilt CSI scorer. **UNWIRED, ON PURPOSE.**
 *
 * ⚠ DO NOT IMPORT THIS FROM ANY OF THE 13 PRODUCTION CALL SITES. It exposes a
 * signature compatible with `detectCsiCodes`, so wiring it will typecheck
 * cleanly and pass the build. That is exactly the trap. It may not be wired
 * until: the gold set is human-certified (§9), pooled adjudication has run
 * (§5.0.1), and owner question Q4 (code format) is answered. It lives in
 * `eval/csi/` rather than `src/lib/` so that reaching for it is a deliberate act.
 *
 * ── WHY THE OLD SCORING RULE IS REPLACED, NOT TUNED ──
 *
 * The old engine gates on the WORD COUNT of a code's title: Tier 2 needs ≥3
 * significant words, Tier 3 needs ≥5, and Tier 1 down-weights short titles into
 * oblivion. Measured consequence (S5): 2,362 of 8,951 codes — 26.4% — cannot be
 * emitted for ANY input. `painting`, `tiling`, `millwork`, `countertops`,
 * `mirrors`, `firestopping` are all structurally invisible. S4 proved this is not
 * fixable with vocabulary: richer titles rescue only 6.2%.
 *
 * Title length is a proxy for specificity, and a bad one. What the gates were
 * reaching for is: *is this token discriminative?* The KB answers that directly
 * — `equipment` names 998 codes and is nearly worthless; 1,707 tokens name
 * exactly one code and are decisive. So this scorer weights by IDF and drops the
 * word-count gates entirely.
 *
 * ── THE MODEL ──
 *
 *     score = coverage × saturate(evidence mass)
 *
 *       coverage      = Σ idf(t) matched / Σ idf(t) over the code's tokens
 *       evidence mass = Σ idf(t) · (1 + ln tf(t))  over matched tokens
 *
 * COVERAGE ALONE WAS THE FIRST DESIGN AND IT WAS WRONG. Dividing by the code's
 * own IDF total makes a short title trivially fully covered, so `art`, `seating`,
 * `fees` and `structural panels` all scored 1.0 on a single weak word. That is
 * the old engine's short-title failure inverted — it buried short codes, this
 * promoted them to certainty. Probing three gold-labelled pages caught it.
 *
 * The absolute EVIDENCE MASS term is what fixes it, and TERM FREQUENCY is what
 * makes the mass meaningful. The old engine ignored TF entirely — it matched on
 * set membership, so one stray word counted the same as a word repeated across a
 * sheet. That is precisely the discrimination needed here:
 *
 *   - `art` (idf 7.15) appearing ONCE on a restaurant elevation → mass 7.2 → 0.42
 *   - `painting` appearing eight times on a finish schedule → mass ~17.6 → 1.0
 *
 * Title length cannot separate those. Repetition can, and it is what a human
 * reads as "this sheet is about painting".
 *
 * Two further adjustments, both precision-first (plan 2 §0):
 *   - **Phrase bonus.** A consecutive span of the code's title on the page is
 *     stronger evidence than the same words scattered. Additive, capped.
 *   - **Singleton floor.** A token naming ≤N codes is near-proof of that code.
 *     Applied only when the token also clears a TF floor, or `fees` sneaks back in.
 *
 * Candidate generation is via the KB's inverted index, so only codes sharing at
 * least one token with the page are scored — not all 8,951.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ──
 *
 * It does not normalize code format. It emits whatever the KB holds (nospace),
 * exactly as the current engine does. Changing that is owner Q4 and rewrites
 * stored data.
 */
import type { CsiCode, TextractWord } from "@/types";

export interface KbEntry {
  code: string;
  description: string;
  trade: string;
  division: string;
  phraseWords: string[];
  allWords: string[];
  tokens: string[];
}

export interface Kb {
  codes: KbEntry[];
  tokenIndex: Record<string, string[]>;
  df: Record<string, number>;
}

export interface NextConfig {
  /** Score a code must reach to be emitted. The precision lever. */
  threshold: number;
  /** Additive bonus when the code's full title appears as a consecutive span. */
  phraseBonus: number;
  /** A token naming ≤ this many codes is treated as near-proof of it. */
  singletonDfMax: number;
  /** Score floor granted by a singleton match — only if it also clears singletonMinTf. */
  singletonFloor: number;
  /** A singleton token must appear at least this often to be trusted as proof. */
  singletonMinTf: number;
  /**
   * Evidence mass at which a code is considered fully evidenced. Set to the
   * median total IDF mass of a 3-token code (17.2 measured over this KB), so
   * "as much evidence as a typical specific code's full title" saturates.
   */
  evidenceSaturation: number;
  /**
   * Token window within which a code's matched tokens must co-occur to count as
   * real evidence. A drawing names a thing in one place; tokens scattered across
   * a 3,000-word sheet are coincidence, not a mention.
   */
  proximityWindow: number;
  /** Multiplier applied when matched tokens do NOT co-occur within the window. */
  scatterPenalty: number;
  /** Hard cap on codes emitted per page. 0 = uncapped. */
  maxCodesPerPage: number;
}

export const DEFAULT_NEXT_CONFIG: NextConfig = {
  // Precision-first, and measured on DEV pages only (protocol §8). Every number
  // here is provisional until the gold set is certified.
  // 0.9 rather than the F0.5-maximising 0.99: scores saturate at 1.0, so 0.99 is
  // a knife-edge where trivial input changes flip codes in and out. 0.9 gives up
  // ~0.01 F0.5 for a stable operating point. The full sweep is in the S7 note.
  threshold: 0.9,
  phraseBonus: 0.25,
  singletonDfMax: 2,
  singletonFloor: 0.6,
  singletonMinTf: 2,
  evidenceSaturation: 17.2,
  proximityWindow: 25,
  scatterPenalty: 0.35,
  maxCodesPerPage: 40,
};

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "of", "for", "in", "on", "at", "to",
  "by", "with", "from", "as", "is", "are", "was", "were", "be", "been",
  "not", "no", "all", "any", "each", "other", "such", "than", "that",
  "this", "its", "per", "new",
]);

/** Matches the engine's tokenization so KB tokens and page tokens are comparable. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/-/g, " ")
    .split(/\s+/)
    .map(w => w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ""))
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

/** Inverse document frequency over the KB's own code population. */
export function idf(df: number, totalCodes: number): number {
  // +1 smoothing so a token naming every code still contributes ~0 rather than
  // a negative weight.
  return Math.log((totalCodes + 1) / (df + 1));
}

/**
 * Smallest span of the page containing at least one occurrence of every given
 * token. Classic k-way merge over position lists.
 *
 * This is the signal the old engine lacked entirely and the reason a threshold
 * sweep could not control its output: raising the bar from 0.55 to 0.99 only
 * moved codes-per-page 233 → 37, because on a dense sheet dozens of codes have
 * all their tokens present SOMEWHERE. Co-occurrence is what separates a mention
 * from a coincidence.
 */
export function minSpan(positions: Map<string, number[]>, tokens: string[]): number {
  const lists = tokens.map(t => positions.get(t)).filter((x): x is number[] => !!x && x.length > 0);
  if (lists.length === 0) return Infinity;
  if (lists.length === 1) return 1;
  const idx = new Array(lists.length).fill(0);
  let best = Infinity;
  for (;;) {
    let lo = Infinity;
    let hi = -Infinity;
    let loList = -1;
    for (let i = 0; i < lists.length; i++) {
      const v = lists[i][idx[i]];
      if (v < lo) { lo = v; loList = i; }
      if (v > hi) hi = v;
    }
    best = Math.min(best, hi - lo + 1);
    idx[loList]++;
    if (idx[loList] >= lists[loList].length) return best;
  }
}

function isSubphrase(needle: string[], haystack: string[]): boolean {
  if (needle.length === 0) return false;
  const limit = haystack.length - needle.length;
  for (let i = 0; i <= limit; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

export interface ScoredCode extends CsiCode {
  confidence: number;
  signals: {
    matchedTokens: string[];
    idfCoverage: number;
    evidenceMass: number;
    phrase: boolean;
    singleton: boolean;
    /** Smallest page window containing all matched tokens. -1 = not computable. */
    span: number;
    together: boolean;
  };
}

/**
 * Detect CSI codes in page text.
 *
 * Signature-compatible with the live `detectCsiCodes` on purpose — so that when
 * it IS eventually wired, the change is one import line rather than a rewrite of
 * 13 call sites. `textractWords` is accepted and currently unused for scoring;
 * trigger collection is a separate concern and stays with the old engine until
 * this one is adopted.
 */
export function detectCsiCodesNext(
  rawText: string,
  _textractWords?: TextractWord[],
  config?: Partial<NextConfig>,
  kb?: Kb,
): ScoredCode[] {
  if (!rawText || rawText.length < 10 || !kb) return [];
  const cfg = { ...DEFAULT_NEXT_CONFIG, ...config };

  const pageTokens = tokenize(rawText);
  const pageSet = new Set(pageTokens);
  // TERM FREQUENCY — the signal the old engine discarded by matching on set
  // membership. One stray "art" and a sheet that says "PAINT" eight times are
  // not the same evidence.
  const tf = new Map<string, number>();
  const positions = new Map<string, number[]>();
  for (let i = 0; i < pageTokens.length; i++) {
    const t = pageTokens[i];
    tf.set(t, (tf.get(t) ?? 0) + 1);
    const ps = positions.get(t);
    if (ps) ps.push(i);
    else positions.set(t, [i]);
  }
  const totalCodes = kb.codes.length;

  // Candidate generation: only codes sharing a token with the page. On a typical
  // sheet this is a few hundred of 8,951, which is what makes IDF scoring cheap
  // enough to run per page.
  const candidates = new Set<string>();
  for (const t of pageSet) {
    const codes = kb.tokenIndex[t];
    if (codes) for (const c of codes) candidates.add(c);
  }

  const byCode = new Map(kb.codes.map(e => [e.code, e]));
  const results: ScoredCode[] = [];

  for (const code of candidates) {
    const e = byCode.get(code);
    if (!e || e.tokens.length === 0) continue;

    let matchedIdf = 0;
    let evidenceMass = 0;
    let totalIdf = 0;
    let singleton = false;
    const matched: string[] = [];

    for (const t of e.tokens) {
      const w = idf(kb.df[t] ?? totalCodes, totalCodes);
      totalIdf += w;
      if (pageSet.has(t)) {
        const count = tf.get(t) ?? 1;
        matchedIdf += w;
        // Sub-linear in tf: the 8th mention is worth less than the 2nd, but
        // repetition still separates a subject from a passing reference.
        evidenceMass += w * (1 + Math.log(count));
        matched.push(t);
        if ((kb.df[t] ?? Infinity) <= cfg.singletonDfMax && count >= cfg.singletonMinTf) singleton = true;
      }
    }
    if (totalIdf === 0 || matched.length === 0) continue;

    const coverage = matchedIdf / totalIdf;
    const saturation = Math.min(1, evidenceMass / cfg.evidenceSaturation);
    const phrase = e.allWords.length > 0 && isSubphrase(e.allWords, pageTokens);

    // BOTH conditions must hold: most of what names this code is present, AND
    // enough absolute discriminative evidence to believe it.
    // PROXIMITY: do this code's matched tokens actually appear together?
    const span = matched.length > 1 ? minSpan(positions, matched) : 1;
    const together = span <= cfg.proximityWindow;

    let score = coverage * saturation;
    if (!together) score *= cfg.scatterPenalty;
    // Phrase bonus is SCALED BY EVIDENCE, not flat. A flat bonus let
    // "equipment systems" — two of the weakest tokens in the KB — clear the gate
    // purely by appearing adjacently. An exact phrase is corroboration of
    // evidence already present; it cannot manufacture evidence that is not.
    if (phrase) score += cfg.phraseBonus * saturation;
    if (singleton) score = Math.max(score, cfg.singletonFloor);
    score = Math.min(score, 1);

    if (score < cfg.threshold) continue;

    results.push({
      code: e.code,
      description: e.description,
      trade: e.trade,
      division: e.division,
      confidence: +score.toFixed(4),
      signals: {
        matchedTokens: matched.sort(),
        idfCoverage: +coverage.toFixed(4),
        evidenceMass: +evidenceMass.toFixed(2),
        phrase,
        singleton,
        span: span === Infinity ? -1 : span,
        together,
      },
    });
  }

  // Precision-first: when capping, keep the most confident. Ties break on code so
  // output is deterministic regardless of Set iteration order.
  results.sort((a, b) => b.confidence - a.confidence || a.code.localeCompare(b.code));
  return cfg.maxCodesPerPage > 0 ? results.slice(0, cfg.maxCodesPerPage) : results;
}
