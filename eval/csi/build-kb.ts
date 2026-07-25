/**
 * build-kb.ts — builds the CSI knowledge base P2's engine will score against,
 * and measures what it changes about reachability (PLAN §3 P2, S4 audit).
 *
 * SOURCES, both already in the repo — nothing is fetched, and owner question Q8
 * is deliberately not touched:
 *   - `src/data/csi-masterformat.tsv` — 8,951 canonical entries. THE code list.
 *   - `src/data/csi.tsv` — the 1995↔2004 crosswalk. Its **1995 titles** are
 *     alternate names for modern codes: `08 71 00 door hardware` also answers to
 *     "door trim" and "weatherstripping and seals". 1,163 codes gain at least one
 *     differing title, worth 1,907 new significant words. Free, no licensing question.
 *     (S4 first reported 212 / 785 — it counted only codes with TWO OR MORE
 *     alternates, and used inconsistent code keys. See canonCode below.)
 *
 * WHAT THIS DOES NOT DO, on purpose:
 *   - It does not merge the 181 codes that exist only in the crosswalk, and it
 *     does not invent `26 53 00`. Both are owner Q8 (§S4_TSV_AUDIT).
 *   - It does not change the engine. The KB is data; the scorer is S7.
 *
 * THE THING TO UNDERSTAND BEFORE READING THE NUMBERS: S4 established that
 * unreachability is a SCORING property, not a vocabulary one. A code whose title
 * has two significant words cannot clear the current tier gates no matter how
 * many synonyms it gains, unless one synonym happens to be longer. So the
 * alternate titles here buy RECALL BREADTH — more ways to match a code that was
 * already matchable — and only incidentally buy reachability. The measurement
 * below reports both separately so they are never conflated.
 *
 * Build + run (from blueprintparser_2/):
 *   npx esbuild eval/csi/build-kb.ts --bundle --platform=node --target=node20 \
 *     --outfile=build/csi-kb-build.js
 *   node build/csi-kb-build.js build/csi-kb.json eval/csi/kb-stats.json
 *
 * The KB itself lands in build/ (gitignored) because it is DERIVED — regenerable
 * byte-identically from two committed inputs. Only the stats are committed; a
 * 3 MB artifact that can be rebuilt in a second is not worth versioning.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Mirrors csi-database.ts exactly — the KB must tokenize the way the engine
// does, or every measurement made against it is about a different vocabulary.
const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "of", "for", "in", "on", "at", "to",
  "by", "with", "from", "as", "is", "are", "was", "were", "be", "been",
  "not", "no", "all", "any", "each", "other", "such", "than", "that",
  "this", "its", "per", "new",
]);

const allWords = (s: string) => s.toLowerCase().replace(/-/g, " ").split(/\s+/).filter(Boolean);
const significant = (words: string[]) => words.filter(w => w.length > 2 && !STOP_WORDS.has(w));
/**
 * THE canonical code key. Use this and nothing else.
 *
 * Three separate wrong numbers were published during the S4 audit because key
 * normalization was re-improvised at each call site:
 *   - masterformat keys had dots stripped while crosswalk keys kept them, so
 *     every level-4 code failed to match (inflated "missing codes" 181 → 507);
 *   - `csi.tsv` carries 29 rows with an UNPADDED division (`7 16 13`, not
 *     `07 16 13`), which naive space-stripping turns into phantom divisions
 *     71/72/81/83/85 and hides real matches.
 * Both classes of bug are invisible in the output — they just make counts wrong.
 */
export function canonCode(code: string): string {
  const parts = code.trim().split(/[\s.]+/);
  // '7 16 13' → '07 16 13'. A single leading digit is an unpadded division.
  if (parts.length > 1 && /^\d$/.test(parts[0])) parts[0] = "0" + parts[0];
  return parts.join("").replace(/\D/g, "");
}

interface KbEntry {
  code: string;
  description: string;
  trade: string;
  division: string;
  /** Significant words of the canonical title — what the current engine matches on. */
  phraseWords: string[];
  /** Every word of the canonical title, stop words included (Tier-1 span matching). */
  allWords: string[];
  /** Alternate titles from the 1995 crosswalk. Empty for most codes. */
  altTitles: string[];
  /** Significant words contributed ONLY by alternates — the new surface. */
  altWords: string[];
  /** Union of phraseWords and altWords: everything this code can be matched by. */
  tokens: string[];
  wordCount: number;
  /** wordCount including alternate vocabulary. */
  tokenCount: number;
}

function main(): void {
  const [kbOut, statsOut] = process.argv.slice(2);
  if (!kbOut || !statsOut) {
    console.error("usage: node csi-kb-build.js <kb-out.json> <stats-out.json>");
    process.exit(1);
  }

  const mfRaw = readFileSync(join(process.cwd(), "src/data/csi-masterformat.tsv"), "utf-8");
  const csRaw = readFileSync(join(process.cwd(), "src/data/csi.tsv"), "utf-8");

  // ── alternate titles: 2004 code → set of distinct 1995 titles ──
  // The synonyms are the 1995 names, NOT the 2004 description column. Reading
  // the wrong column yields 3 codes instead of 252; S4 records that mistake.
  const alts = new Map<string, Set<string>>();
  for (const line of csRaw.split("\n").slice(1)) {
    const c = line.split("\t");
    if (c.length < 4) continue;
    const code = canonCode(c[2]);
    const title1995 = c[1].trim();
    if (!code || !title1995) continue;
    if (!alts.has(code)) alts.set(code, new Set());
    alts.get(code)!.add(title1995.toLowerCase());
  }

  // ── canonical entries ──
  const entries: KbEntry[] = [];
  for (const line of mfRaw.split("\n").slice(1)) {
    const c = line.split("\t");
    if (c.length < 6) continue;
    const code = c[2].trim();
    const description = c[3].trim();
    const aw = allWords(description);
    const pw = significant(aw);

    const altSet = alts.get(canonCode(code)) ?? new Set<string>();
    // Only alternates that actually differ from the canonical title are useful.
    const altTitles = [...altSet].filter(t => t !== description.toLowerCase()).sort();
    const altWordSet = new Set<string>();
    for (const t of altTitles) for (const w of significant(allWords(t))) altWordSet.add(w);
    for (const w of pw) altWordSet.delete(w); // keep only what is genuinely new
    const altW = [...altWordSet].sort();

    entries.push({
      code,
      description,
      trade: c[4].trim(),
      division: c[5].trim(),
      phraseWords: pw,
      allWords: aw,
      altTitles,
      altWords: altW,
      tokens: [...new Set([...pw, ...altW])].sort(),
      wordCount: pw.length,
      tokenCount: new Set([...pw, ...altW]).size,
    });
  }

  // ── inverted index + document frequency ──
  // DF is over the KB's own token vocabulary, which is what an IDF-weighted
  // scorer needs. It intentionally counts alternate-title tokens too: a word
  // that names many codes is weak evidence regardless of which title it came from.
  const tokenIndex = new Map<string, string[]>();
  for (const e of entries) {
    for (const t of e.tokens) {
      const list = tokenIndex.get(t) ?? [];
      list.push(e.code);
      tokenIndex.set(t, list);
    }
  }
  const df = new Map<string, number>();
  for (const [t, codes] of tokenIndex) df.set(t, codes.length);

  // ── reachability under the CURRENT scoring rule ──
  // Deliberately measured two ways so vocabulary and scoring are never conflated.
  const DEFAULT = { threshold: 0.4, tier2Min: 3, tier3Min: 5, tier2W: 0.75, tier3W: 0.5, t1: [0, 0.01, 0.19, 0.8, 0.8, 0.8] };
  const reachable = (n: number) => {
    const t1 = 0.95 * (n < DEFAULT.t1.length ? DEFAULT.t1[n] : DEFAULT.t1[DEFAULT.t1.length - 1]);
    const t2 = n >= DEFAULT.tier2Min ? DEFAULT.tier2W : 0;
    const t3 = n >= DEFAULT.tier3Min ? DEFAULT.tier3W : 0;
    return Math.max(t1, t2, t3) >= DEFAULT.threshold;
  };

  const beforeUnreachable = entries.filter(e => !reachable(e.wordCount));
  const afterUnreachable = entries.filter(e => !reachable(e.tokenCount));
  const rescued = beforeUnreachable.filter(e => reachable(e.tokenCount));

  // What a scoring change would unlock, independent of vocabulary. This is NOT a
  // recommendation — S7 designs the rule. It is the shape of the tradeoff.
  const byMinWords = [1, 2, 3].map(min => ({
    ifTierGateWere: min,
    reachableCanonical: entries.filter(e => e.wordCount >= min).length,
    reachableWithAlts: entries.filter(e => e.tokenCount >= min).length,
  }));

  const kb = {
    schemaVersion: "csi-kb/1",
    generatedAt: new Date().toISOString(),
    sources: {
      masterformat: { sha256: createHash("sha256").update(mfRaw).digest("hex").slice(0, 16), entries: entries.length },
      crosswalk: { sha256: createHash("sha256").update(csRaw).digest("hex").slice(0, 16), codesWithAlternates: alts.size },
    },
    stopWords: [...STOP_WORDS].sort(),
    codes: entries,
    tokenIndex: Object.fromEntries([...tokenIndex.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
    df: Object.fromEntries([...df.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
  };

  const withAlts = entries.filter(e => e.altTitles.length > 0);
  const newWords = entries.reduce((n, e) => n + e.altWords.length, 0);

  const stats = {
    schemaVersion: "csi-kb-stats/1",
    generatedAt: new Date().toISOString(),
    sources: kb.sources,
    vocabulary: {
      entries: entries.length,
      distinctTokens: tokenIndex.size,
      tokensFromCanonicalTitlesOnly: new Set(entries.flatMap(e => e.phraseWords)).size,
      codesGainingAlternates: withAlts.length,
      newSignificantWordsFromAlternates: newWords,
      meanTokensPerCode: +(entries.reduce((n, e) => n + e.tokenCount, 0) / entries.length).toFixed(2),
    },
    /** The headline S4 predicted, now built rather than estimated. */
    reachability: {
      note:
        "Unreachable = no tier can clear the 0.4 threshold for ANY input under the CURRENT rule. " +
        "S4 predicted vocabulary would barely move this because unreachability is a scoring property. " +
        "These two numbers are kept separate so breadth and reachability are never conflated.",
      unreachableCanonicalOnly: beforeUnreachable.length,
      unreachableWithAlternates: afterUnreachable.length,
      rescuedByAlternates: rescued.length,
      rescuedShareOfUnreachable: +(rescued.length / beforeUnreachable.length).toFixed(4),
      stillUnreachableShareOfDatabase: +(afterUnreachable.length / entries.length).toFixed(4),
      sampleRescued: rescued.slice(0, 10).map(e => ({
        code: e.code,
        canonical: e.description,
        canonicalWords: e.wordCount,
        viaAlternates: e.tokenCount,
        altTitles: e.altTitles.slice(0, 3),
      })),
    },
    /** What a SCORING change would unlock. S7 decides; this is the tradeoff shape. */
    ifTheWordCountGateChanged: byMinWords,
    /** Most ambiguous tokens — high DF means weak evidence, which is what an IDF scorer needs. */
    weakestTokens: [...df.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 25)
      .map(([token, n]) => ({ token, codes: n })),
    strongestTokenSample: [...df.entries()].filter(([, n]) => n === 1).length,
  };

  writeFileSync(kbOut, JSON.stringify(kb) + "\n");
  writeFileSync(statsOut, JSON.stringify(stats, null, 2) + "\n");
  console.error(
    `[kb] ${entries.length} codes · ${tokenIndex.size} tokens · ` +
      `${withAlts.length} codes gained alternates (+${newWords} words) · ` +
      `unreachable ${beforeUnreachable.length} → ${afterUnreachable.length} → ${kbOut}`,
  );
}

// Only run the CLI when this file IS the entry point — same guard as score.ts.
// Without it, a test importing canonCode executes main(), reads vitest's argv,
// and exits the process.
if (process.argv[1]?.includes("csi-kb-build")) main();
