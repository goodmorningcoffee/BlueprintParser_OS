/**
 * csi-database.ts — CSI MasterFormat database types, TSV parser, builtin loader.
 *
 * [refactor jul9 P2-A C1] NEW module, extracted from csi-detect.ts (SPEC_FINAL
 * §1.0). Why its own module and NOT extra exports on csi-detect.ts: several
 * route test suites (parse-region.route.test.ts:62-65, table-parse.route.test.ts:70)
 * mock `@/lib/csi-detect` with FULL factories (no importOriginal). If the
 * upcoming company-DB resolver (C3) imported the loader/parser via csi-detect,
 * those mocks would turn them into `undefined` at runtime and 500 every
 * notes/spec/table-parse request in those suites (the C3-F-1 blocker). Keeping
 * the DB surface here leaves those mock factories byte-untouched. Do NOT
 * re-export these functions from csi-detect.ts — that would reintroduce the
 * hazard for any consumer importing via csi-detect.
 *
 * SERVER-ONLY (uses `readFileSync`) — keep out of client bundles.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { logger } from "@/lib/logger";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

// [refactor jul9 P2-A C1] moved verbatim from csi-detect.ts (was module-private).
export interface CsiEntry {
  code: string;
  phraseWords: string[];       // significant words from description
  allWords: string[];          // all words including stop words
  description: string;
  trade: string;
  division: string;
  wordCount: number;           // count of significant words
}

/**
 * [refactor jul9 P2-A C1] Bundles the two coupled singletons (invariant I-2):
 * Tier-3 anchor scoring reads `wordFrequency` built from the SAME entry set —
 * a per-company entries array paired with the global word-frequency map would
 * silently corrupt anchor scoring. They travel together, always.
 */
export interface CsiDatabase {
  entries: CsiEntry[];
  wordFrequency: Map<string, number>;
}

// ═══════════════════════════════════════════════════════════════
// Bounds + S3 key namespace (consumed by upload writer + resolver guard in C3/C4)
// ═══════════════════════════════════════════════════════════════

// [refactor jul9 P2-A C1] I-9 caps — single source for the upload gate (C4) +
// resolver guard (C3). Builtin is 935 KB / 8,951 rows; these are >5x headroom.
// Owner-tunable (SPEC_FINAL NEEDS-OWNER N-6).
export const CSI_DB_MAX_BYTES = 10 * 1024 * 1024;
export const CSI_DB_MAX_ENTRIES = 50_000;

// [refactor jul9 P2-A C1] I-7 — sole definition of the custom-DB S3 key
// namespace; the upload writer (csi-upload.ts) and the tenant guard
// (csi-company-db.ts) both consume THIS helper (a literal-string duplicate
// could silently drift and force all custom DBs onto builtin, masked by the
// warn-only fallback). Trailing "/" is load-bearing: without it,
// company-1's prefix would match company-1x's keys.
export function csiDbKeyPrefix(companyId: number): string {
  return `csi-databases/company-${companyId}/`;
}

// ═══════════════════════════════════════════════════════════════
// Stop words (filtered from bag-of-words matching)
// [refactor jul9 P2-A C1] moved verbatim from csi-detect.ts — only the parser
// consumes these (phraseWords construction); the engine matches on the
// already-filtered word lists.
// ═══════════════════════════════════════════════════════════════

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "of", "for", "in", "on", "at", "to",
  "by", "with", "from", "as", "is", "are", "was", "were", "be", "been",
  "not", "no", "all", "any", "each", "other", "such", "than", "that",
  "this", "its", "per", "new",
]);

function getSignificantWords(words: string[]): string[] {
  return words.filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

// ═══════════════════════════════════════════════════════════════
// TSV parser
// ═══════════════════════════════════════════════════════════════

/**
 * Parse CSI database TSV content into a CsiDatabase bundle.
 *
 * [refactor jul9 P2-A C1] Verbatim lift of the parse loop from
 * csi-detect.ts:95-122 — split "\n", `.slice(1)` header skip, tab-split,
 * `cols.length < 6` row drop, cols[2]=code / [3]=description / [4]=trade /
 * [5]=division, wordFrequency built from each row's phraseWords. The
 * custom-upload TSV (csi-upload.ts) is byte-compatible with this layout —
 * this is the ONE parser for builtin and custom DBs alike.
 *
 * Known characterized quirks (pinned in tests, deliberately NOT fixed):
 * tab-embedded descriptions shift columns (mis-parse, no crash); CRLF files
 * leave a trailing "\r" on the division field.
 */
export function parseCsiTsv(content: string): CsiDatabase {
  const lines = content.split("\n").slice(1); // skip header
  const entries: CsiEntry[] = [];
  const wordFrequency = new Map<string, number>();

  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = line.split("\t");
    if (cols.length < 6) continue;

    const description = cols[3].trim();
    const allWords = description.toLowerCase().replace(/-/g, " ").split(/\s+/).filter(Boolean);
    const phraseWords = getSignificantWords(allWords);

    // Track word frequency across all descriptions (for anchor scoring)
    for (const w of phraseWords) {
      wordFrequency.set(w, (wordFrequency.get(w) || 0) + 1);
    }

    entries.push({
      code: cols[2].trim(),
      phraseWords,
      allWords,
      description,
      trade: cols[4].trim(),
      division: cols[5].trim(),
      wordCount: phraseWords.length,
    });
  }

  return { entries, wordFrequency };
}

// ═══════════════════════════════════════════════════════════════
// Builtin database loading
// ═══════════════════════════════════════════════════════════════

// [refactor jul9 P2-A C1] module-local memo — replaces csi-detect.ts's paired
// `csiDatabase` / `wordFrequency` module lets (the bundle memoizes both as one).
let builtinDb: CsiDatabase | null = null;

/**
 * Load the built-in MasterFormat database (memoized for the process lifetime).
 *
 * [refactor jul9 P2-A C1] was the private `loadCsiDatabase()` in csi-detect.ts.
 * Same 3-path readFileSync probe; same not-found behavior (log error, memoize
 * an EMPTY bundle so detection degrades to zero results instead of throwing).
 */
export function loadBuiltinCsiDatabase(): CsiDatabase {
  if (builtinDb) return builtinDb;

  const paths = [
    join(process.cwd(), "src/data/csi-masterformat.tsv"),
    join(process.cwd(), "csi-masterformat.tsv"),
    join(__dirname, "../../data/csi-masterformat.tsv"),
  ];

  let content = "";
  for (const p of paths) {
    try {
      content = readFileSync(p, "utf-8");
      break;
    } catch { continue; }
  }

  if (!content) {
    logger.error("CSI database not found");
    builtinDb = { entries: [], wordFrequency: new Map() };
    return builtinDb;
  }

  builtinDb = parseCsiTsv(content);
  return builtinDb;
}
