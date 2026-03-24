import { readFileSync } from "fs";
import { join } from "path";
import type { CsiCode } from "@/types";

interface CsiEntry {
  csi95: string;
  phrase95Words: string[];
  csi04: string;
  phrase04Words: string[];
  trade: string;
  division: string;
  description04: string;
}

let csiDatabase: CsiEntry[] | null = null;

/**
 * Load and parse the CSI code database (lazy, cached).
 * File is ~2800 rows, loads once per process lifetime.
 */
function loadCsiDatabase(): CsiEntry[] {
  if (csiDatabase) return csiDatabase;

  // Try multiple paths for dev vs production
  const paths = [
    join(process.cwd(), "src/data/csi.tsv"),
    join(process.cwd(), "csi.tsv"),
    join(__dirname, "../../data/csi.tsv"),
  ];

  let content = "";
  for (const p of paths) {
    try {
      content = readFileSync(p, "utf-8");
      break;
    } catch {
      continue;
    }
  }

  if (!content) {
    console.error("CSI database not found");
    csiDatabase = [];
    return csiDatabase;
  }

  const lines = content.split("\n").slice(1); // skip header
  csiDatabase = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = line.split("\t");
    if (cols.length < 6) continue;

    csiDatabase.push({
      csi95: cols[0].trim(),
      phrase95Words: cols[1].toLowerCase().replace(/-/g, " ").split(/\s+/).filter(Boolean),
      csi04: cols[2].trim(),
      phrase04Words: cols[3].toLowerCase().replace(/-/g, " ").split(/\s+/).filter(Boolean),
      trade: cols[4].trim(),
      division: cols[5].trim(),
      description04: cols[3].trim(),
    });
  }

  return csiDatabase;
}

/**
 * Check if phraseWords appears as a consecutive subsequence in textWords.
 * Port of theta_old's is_subphrase().
 */
function isSubphrase(phraseWords: string[], textWords: string[]): boolean {
  if (phraseWords.length === 0) return false;
  const limit = textWords.length - phraseWords.length;
  for (let i = 0; i <= limit; i++) {
    let match = true;
    for (let j = 0; j < phraseWords.length; j++) {
      if (phraseWords[j] !== textWords[i + j]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

/**
 * Detect CSI codes in page text.
 * Returns unique CSI codes found, with description, trade, and division.
 *
 * Port of theta_old's detect_csi.py main().
 */
export function detectCsiCodes(rawText: string): CsiCode[] {
  if (!rawText || rawText.length < 10) return [];

  const db = loadCsiDatabase();
  const text = rawText.replace(/\n/g, " ").toLowerCase();
  const textWords = text.split(/\s+/).filter(Boolean);

  // Track unique codes (by csi04 code)
  const seen = new Set<string>();
  const results: CsiCode[] = [];

  for (const entry of db) {
    // Check 1995 standard
    if (
      entry.phrase95Words.length > 0 &&
      text.includes(entry.phrase95Words.join(" ")) &&
      isSubphrase(entry.phrase95Words, textWords)
    ) {
      if (entry.csi04 && !seen.has(entry.csi04)) {
        seen.add(entry.csi04);
        results.push({
          code: entry.csi04,
          description: entry.description04,
          trade: entry.trade,
          division: entry.division,
        });
      }
    }

    // Check 2004 standard
    if (
      entry.phrase04Words.length > 0 &&
      text.includes(entry.phrase04Words.join(" ")) &&
      isSubphrase(entry.phrase04Words, textWords)
    ) {
      if (entry.csi04 && !seen.has(entry.csi04)) {
        seen.add(entry.csi04);
        results.push({
          code: entry.csi04,
          description: entry.description04,
          trade: entry.trade,
          division: entry.division,
        });
      }
    }
  }

  return results;
}
