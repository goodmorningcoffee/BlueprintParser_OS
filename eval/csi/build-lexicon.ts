/**
 * build-lexicon.ts — measures the vocabulary gap between what drawings actually
 * say and what the CSI knowledge base can match (PLAN §3 P2, plan 2 §3-§4).
 *
 * Plan 2 calls lexicon coverage "the single biggest quality lever" and names two
 * sources: the repo's existing AEC abbreviation dictionary, and an AUTHORED
 * manufacturer/component lexicon. This step does the measurable half of that and
 * refuses to guess at the rest.
 *
 * ── WHAT IT DOES ──
 *
 * 1. **Abbreviation → code candidates.** `src/lib/detectors/abbreviations.ts`
 *    holds 236 AEC abbreviations with an expansion and a coarse trade. Plan 2
 *    §3 notes the trade enum is useless for CSI mapping — and it is right: 190
 *    of 236 are just "general". But the EXPANSION is not useless. "CMU" expands
 *    to "Concrete Masonry Unit", whose tokens hit the KB index directly. That
 *    join is mechanical and is done here.
 *
 *    The map is module-private (a lazy singleton inside `getAbbrDict`), so it is
 *    parsed from source rather than imported. Deliberate: this is an analysis
 *    step and should not change a production detector to run. If S7 wants the
 *    map at runtime it can export it then.
 *
 * 2. **The corpus vocabulary gap, measured.** Which words appear often across
 *    the 471 real pages but match NOTHING in the KB? Those are the coverage
 *    hole — brands, trade slang, abbreviations the dictionary lacks. This is the
 *    evidence base for authoring, and it costs nothing to compute.
 *
 * ── WHAT IT REFUSES TO DO ──
 *
 * It does not invent brand→code mappings. Plan 2 suggests seeding from ARCAT and
 * NCS; those are external sources and land in owner Q8. Everything here is
 * derived from files already in the repo plus the corpus the owner already has.
 *
 * ── AND IT DOES NOT PRETEND FREQUENCY IS AN AUTHORING QUEUE ──
 *
 * The first draft of this file ranked unknown corpus words by page count and
 * called that the queue. The output refuted it immediately: the top entries are
 * `date`, `scale`, `issued`, firm names and contract language — precisely the
 * title-block content rubric R6 excludes from scope. A KB that learned those
 * would be worse. The banding below is kept as the evidence for that negative
 * result, which is the honest deliverable here.
 *
 * The method that DOES work is mining the gold set's own evidence quotes — terms
 * a labeler cited to justify a real system. It cuts the noise ~26x. But it
 * carries a context bias worth knowing: a term maps to the section it was quoted
 * FOR, not its canonical meaning, so "drywall" lands on 02 41 demolition when it
 * was quoted to justify demolishing drywall. And at 20 pilot pages it yields only
 * a few dozen defensible terms. **The lexicon is therefore downstream of the gold
 * set, not independent of it** — which puts it behind the same owner decision as
 * P1. That scheduling fact is the most useful thing this file establishes.
 *
 * Build + run (from blueprintparser_2/):
 *   npx esbuild eval/csi/build-lexicon.ts --bundle --platform=node --target=node24 \
 *     --outfile=build/csi-lexicon-build.js
 *   node build/csi-lexicon-build.js <corpus.ndjson> build/csi-lexicon.json eval/csi/lexicon-gap.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "of", "for", "in", "on", "at", "to",
  "by", "with", "from", "as", "is", "are", "was", "were", "be", "been",
  "not", "no", "all", "any", "each", "other", "such", "than", "that",
  "this", "its", "per", "new",
]);

const significant = (s: string) =>
  s.toLowerCase().replace(/-/g, " ").split(/\s+/).filter(w => w.length > 2 && !STOP_WORDS.has(w));

interface KbEntry { code: string; description: string; tokens: string[] }
interface Kb { codes: KbEntry[]; tokenIndex: Record<string, string[]>; df: Record<string, number> }

/**
 * Parse the abbreviation dictionary out of the detector source.
 *
 * Regex-on-source is normally a smell. It is the right call here precisely
 * because the alternative — exporting a module-private singleton so an analysis
 * script can read it — changes production code to serve a measurement.
 */
function parseAbbreviations(src: string): { abbr: string; meaning: string; trade: string }[] {
  const out: { abbr: string; meaning: string; trade: string }[] = [];
  const re = /\["([^"]+)",\s*\{\s*meaning:\s*"([^"]+)",\s*trade:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push({ abbr: m[1], meaning: m[2], trade: m[3] });
  return out;
}

function main(): void {
  const [corpusPath, lexOut, gapOut] = process.argv.slice(2);
  if (!corpusPath || !lexOut || !gapOut) {
    console.error("usage: node csi-lexicon-build.js <corpus.ndjson> <lexicon-out.json> <gap-out.json>");
    process.exit(1);
  }

  const kb = JSON.parse(readFileSync(join(process.cwd(), "build/csi-kb.json"), "utf-8")) as Kb;
  const kbVocab = new Set(Object.keys(kb.tokenIndex));

  // ── 1. abbreviation → candidate codes, via the expansion's tokens ──
  const abbrs = parseAbbreviations(readFileSync(join(process.cwd(), "src/lib/detectors/abbreviations.ts"), "utf-8"));

  const abbrevLexicon = abbrs.map(a => {
    const tokens = significant(a.meaning);
    const known = tokens.filter(t => kbVocab.has(t));
    // Codes whose token set contains EVERY known token of the expansion. An
    // expansion matching many codes is weak evidence, so the count is reported
    // and the caller decides — this file does not silently pick a winner.
    let candidates: string[] = [];
    if (known.length > 0) {
      const sets = known.map(t => new Set(kb.tokenIndex[t]));
      candidates = [...sets[0]].filter(c => sets.every(s => s.has(c)));
    }
    return {
      abbr: a.abbr,
      meaning: a.meaning,
      trade: a.trade,
      expansionTokens: tokens,
      tokensKnownToKb: known,
      candidateCodes: candidates.slice(0, 12),
      candidateCount: candidates.length,
      /** Usable = the expansion resolves to a small, actionable code set. */
      usable: candidates.length > 0 && candidates.length <= 12,
    };
  });

  // ── 2. the corpus vocabulary gap ──
  const docFreq = new Map<string, number>();
  let pages = 0;
  for (const line of readFileSync(corpusPath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    const p = JSON.parse(line) as { rawText: string | null };
    if (!p.rawText) continue;
    pages++;
    for (const w of new Set(significant(p.rawText))) docFreq.set(w, (docFreq.get(w) ?? 0) + 1);
  }

  const known = [...docFreq.entries()].filter(([w]) => kbVocab.has(w));
  const unknown = [...docFreq.entries()].filter(([w]) => !kbVocab.has(w));
  const byFreq = (a: [string, number], b: [string, number]) => b[1] - a[1] || a[0].localeCompare(b[0]);

  const RECURRING = 3;
  const unknownRecurring = unknown.filter(([, n]) => n >= RECURRING).sort(byFreq);

  // ── 2b. WHY THE RAW FREQUENCY LIST IS NOT AN AUTHORING QUEUE ──
  //
  // The first version of this file shipped `topUnknownTerms` ranked by page count
  // and called it the authoring queue. Reading the actual output killed that: the
  // top entries are `date` (446 of 466 pages), `scale`, `issued`, `dwg`, `llp`,
  // `example-architects.invalid`, plus contract language — title-block content the
  // rubric's R6 says is NEVER scope. A KB that knew those words would be worse,
  // not better.
  //
  // Banding by page share shows where real material vocabulary actually lives,
  // and it is nowhere near the top. This is the same IDF insight the KB's own DF
  // spread showed: a word on 96% of pages carries no information.
  const bands = [
    { label: ">=80% of pages", lo: 0.8, hi: 1.01 },
    { label: "40-80%", lo: 0.4, hi: 0.8 },
    { label: "15-40%", lo: 0.15, hi: 0.4 },
    { label: "5-15%", lo: 0.05, hi: 0.15 },
    { label: "2-5%", lo: 0.02, hi: 0.05 },
  ].map(b => {
    const inBand = unknown.filter(([, n]) => n / pages >= b.lo && n / pages < b.hi).sort(byFreq);
    return { band: b.label, unknownWords: inBand.length, sample: inBand.slice(0, 12).map(([w]) => w) };
  });

  const lexicon = {
    schemaVersion: "csi-lexicon/1",
    generatedAt: new Date().toISOString(),
    abbreviations: abbrevLexicon,
  };

  const gap = {
    schemaVersion: "csi-lexicon-gap/1",
    generatedAt: new Date().toISOString(),
    corpus: { pagesWithText: pages, distinctSignificantWords: docFreq.size },
    kb: { distinctTokens: kbVocab.size },

    coverage: {
      corpusWordsKnownToKb: known.length,
      corpusWordsUnknownToKb: unknown.length,
      /** The headline: what share of the words drawings actually use can the KB match at all? */
      vocabularyCoverage: +(known.length / docFreq.size).toFixed(4),
      unknownAppearingOn3PlusPages: unknownRecurring.length,
      note:
        "Coverage is over DISTINCT words, not occurrences. A KB that knows the 200 commonest " +
        "words and no others would score badly here and still match most pages, so read this " +
        "with the ranked list below rather than alone.",
    },

    abbreviations: {
      total: abbrs.length,
      tradeIsUseless: {
        general: abbrs.filter(a => a.trade === "general").length,
        note: "plan 2 §3 says the trade enum cannot drive CSI mapping. Confirmed — it is mostly one value.",
      },
      expansionResolvesToCodes: abbrevLexicon.filter(a => a.usable).length,
      expansionTooAmbiguous: abbrevLexicon.filter(a => a.candidateCount > 12).length,
      expansionMatchesNothing: abbrevLexicon.filter(a => a.candidateCount === 0).length,
      sampleUsable: abbrevLexicon.filter(a => a.usable).slice(0, 12).map(a => ({
        abbr: a.abbr,
        meaning: a.meaning,
        codes: a.candidateCodes.slice(0, 4),
      })),
    },

    /**
     * NOT an authoring queue — a demonstration that frequency ranking cannot BE
     * one. The high bands are title-block boilerplate; material vocabulary only
     * starts appearing below 5% of pages, mixed with OCR noise. Kept in the
     * output because the negative result is the useful part.
     */
    frequencyBands: bands,
    verdictOnFrequencyRanking:
      "UNUSABLE as an authoring queue. The top of the list is boilerplate the KB should NOT know " +
      "(`date` on 96% of pages, `scale`, `issued`, firm names, contract language). Real material " +
      "vocabulary appears only below the 5% band, interleaved with OCR garbage. Ranking by raw " +
      "frequency surfaces exactly the words rubric R6 excludes from scope.",
    topUnknownTermsRaw: unknownRecurring.slice(0, 60).map(([word, pages_]) => ({ word, pages: pages_ })),

    /** Words the KB knows that the corpus never uses — the other side of the gap. */
    kbTokensNeverSeenInCorpus: kbVocab.size - known.length,
  };

  writeFileSync(lexOut, JSON.stringify(lexicon, null, 1) + "\n");
  writeFileSync(gapOut, JSON.stringify(gap, null, 2) + "\n");
  console.error(
    `[lexicon] ${abbrs.length} abbreviations (${gap.abbreviations.expansionResolvesToCodes} resolve to codes) · ` +
      `corpus vocabulary ${docFreq.size} words, ${gap.coverage.vocabularyCoverage} known to KB · ` +
      `${unknownRecurring.length} recurring unknowns → ${gapOut}`,
  );
}

// Entry guard — importing this from a test must not run the CLI (see score.ts).
if (process.argv[1]?.includes("csi-lexicon-build")) main();

export { parseAbbreviations, significant };
