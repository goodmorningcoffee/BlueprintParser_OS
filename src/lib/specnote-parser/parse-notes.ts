import type { TextractPageData, BboxLTWH, TextractLine } from "@/types";
import { NOTES_KEY_COLUMN_GAP } from "@/lib/spatial-constants";
import { buildLineFeatures, median, RE_NUMBERED_ITEM, RE_LETTERED_ITEM, RE_TAG_PREFIX } from "./shared";
import { bindNumberedGrid } from "./bind-numbered";
import { bindLetteredGrid } from "./bind-lettered";
import { bindTaggedKeynoteGrid } from "./bind-tagged-keynote";
import { bindKeyValueGrid } from "./bind-key-value";
import { bindSpecSections } from "./bind-sections";
import { detectColumnsInRegion, type MultiColumnSplitOptions } from "./multi-column-split";

export interface ParsedNotesGrid {
  headers: string[];
  rows: Record<string, string>[];
  rowBoundaries?: number[];
  colBoundaries?: number[];
}

export interface ParseNotesOptions {
  /** When true (default), pre-detect multi-column layout and parse each
   *  column independently, concatenating rows in left-to-right order.
   *  Set false to force single-column treatment of wide regions. */
  autoSplitColumns?: boolean;
  /** Tuning knobs for the column-split heuristic. */
  columnSplitOptions?: MultiColumnSplitOptions;
}

/**
 * Parse a user-drawn bbox region into a notes grid.
 *
 * Pipeline:
 *   0. Optional multi-column split preprocess. When a region spans ≥2
 *      columns with clear gutters, each column is parsed independently
 *      and the rows are concatenated L→R. This preserves per-column
 *      numbering and avoids Y-cluster interleaving across columns.
 *   1. Serial fallback binders: numbered → tagged-keynote → lettered →
 *      section-headered → key-value. First match wins. Step 5 will make
 *      this parallel + confidence-scored.
 */
export function parseNotesFromRegion(
  textractData: TextractPageData,
  regionBbox: BboxLTWH,
  options?: ParseNotesOptions,
): ParsedNotesGrid | undefined {
  if (!textractData?.lines || textractData.lines.length === 0) return undefined;

  const autoSplit = options?.autoSplitColumns ?? true;

  // Step 4: attempt multi-column split first. If the region partitions
  // cleanly into N columns, parse each independently and merge.
  if (autoSplit) {
    const split = detectColumnsInRegion(textractData.lines, regionBbox, options?.columnSplitOptions);
    if (split && split.columns.length >= 2) {
      const merged = parseColumnsMerged(textractData.lines, split.columns, regionBbox);
      if (merged) return merged;
      // Fall through to single-column parse if per-column binding failed.
    }
  }

  return parseSingleRegion(textractData.lines, regionBbox);
}

function parseSingleRegion(
  lines: readonly TextractLine[],
  regionBbox: BboxLTWH,
): ParsedNotesGrid | undefined {
  const [rx, ry, rw, rh] = regionBbox;
  const rRight = rx + rw;
  const rBottom = ry + rh;

  const linesInRegion = lines.filter((line) => {
    if (!line.bbox || line.bbox.length < 4) return false;
    const cx = line.bbox[0] + line.bbox[2] / 2;
    const cy = line.bbox[1] + line.bbox[3] / 2;
    return cx >= rx && cx <= rRight && cy >= ry && cy <= rBottom;
  });

  if (linesInRegion.length === 0) return undefined;

  const features = buildLineFeatures(linesInRegion);
  if (features.length === 0) return undefined;

  // Serial fallback order (priority: most-specific → most-permissive).
  // Step 5 will refactor to run all methods in parallel + score by confidence;
  // this intermediate form keeps each new binder independently useful until
  // then.
  //   1. Numbered         (1. 2) (3))            — tight digit prefix
  //   2. Tagged-keynote   (K-01, AD.1)           — alpha-prefixed, X-uniform
  //   3. Lettered         (A. B. a))             — single-letter + sequence guard
  //   4. Section-headered (PART 1 / RCP NOTES)   — shared with spec parse
  //   5. Key-value        (largest-gap)          — catch-all split

  const numbered = bindNumberedGrid(features);
  if (numbered) {
    return withKeyColBoundaries(numbered, features, RE_NUMBERED_ITEM, rx, rRight);
  }

  const tagged = bindTaggedKeynoteGrid(features);
  if (tagged) {
    return withKeyColBoundaries(tagged, features, RE_TAG_PREFIX, rx, rRight, /* matchAgainstFullText */ true);
  }

  const lettered = bindLetteredGrid(features);
  if (lettered) {
    return withKeyColBoundaries(lettered, features, RE_LETTERED_ITEM, rx, rRight);
  }

  // Section-headered — reuses the spec-parse binder to catch drawing-notes
  // category headers (BUILDING DEPARTMENT NOTES / RENOVATION NOTES / etc.)
  // and ABBREVIATIONS / LEGEND blocks. Maps sections → {Key: header, Note: body}
  // to keep the same ParsedNotesGrid shape as other binders.
  const sections = bindSpecSections(linesInRegion);
  if (sections && sections.sections.length >= 1) {
    const rows = sections.sections
      .filter((s) => s.sectionHeader || s.body)
      .map((s) => ({ Key: s.sectionHeader || "(preamble)", Note: s.body }));
    if (rows.length >= 1) {
      return {
        headers: ["Key", "Note"],
        rows,
        rowBoundaries: sections.rowBoundaries,
      };
    }
  }

  const kv = bindKeyValueGrid(features);
  if (kv) return kv;
  return undefined;
}

/**
 * Parse each column independently and concatenate rows in left-to-right
 * order. Column boundaries (vertical gutters) become the outer colBoundaries
 * of the merged grid so the preview renders each column as its own band.
 *
 * Concatenation strategy: rows from column 0 first, then column 1, etc. If
 * columns use incompatible header schemas (e.g. col 0 numbered → [Key,Note],
 * col 1 KV → [Key,Value]), we standardize to [Key, Note] by aliasing Value →
 * Note. This is a deliberate simplification — Step 5's parallel+scored
 * refactor will surface this as a per-column method label in debug output.
 *
 * Returns undefined when every column's single-region parse returns undefined
 * (caller then falls back to treating the original region as one column).
 */
function parseColumnsMerged(
  lines: readonly TextractLine[],
  columns: readonly BboxLTWH[],
  outerRegion: BboxLTWH,
): ParsedNotesGrid | undefined {
  const [rx, , rw] = outerRegion;
  const allRows: Record<string, string>[] = [];
  const allRowBoundaries: number[] = [];
  let anySucceeded = false;

  for (const colBbox of columns) {
    const result = parseSingleRegion(lines, colBbox);
    if (!result) continue;
    anySucceeded = true;
    for (const row of result.rows) {
      allRows.push({
        Key: (row.Key ?? "") as string,
        Note: (row.Note ?? row.Value ?? "") as string,
      });
    }
    if (result.rowBoundaries) allRowBoundaries.push(...result.rowBoundaries);
  }

  if (!anySucceeded || allRows.length === 0) return undefined;

  // Outer colBoundaries trace the column gutters so the preview renders a
  // visible column structure matching what the user drew.
  const colBoundaries: number[] = [rx];
  for (let i = 0; i < columns.length - 1; i++) {
    colBoundaries.push(columns[i][0] + columns[i][2]);
  }
  colBoundaries.push(rx + rw);

  return {
    headers: ["Key", "Note"],
    rows: allRows,
    rowBoundaries: allRowBoundaries.length > 0 ? allRowBoundaries : undefined,
    colBoundaries,
  };
}

/**
 * Shared post-processor that adds a colBoundaries split for key-first grids.
 * Extracted from the original numbered-only implementation so tagged and
 * lettered binders get the same column rendering for free.
 */
function withKeyColBoundaries(
  grid: { headers: string[]; rows: Record<string, string>[]; rowBoundaries?: number[] },
  features: readonly { firstWord: string; line: { words?: { bbox: number[]; text: string }[]; text: string } }[],
  keyRegex: RegExp,
  rx: number,
  rRight: number,
  matchAgainstFullText = false,
): ParsedNotesGrid {
  const firstWordRights: number[] = [];
  for (const f of features) {
    const probe = matchAgainstFullText ? f.line.text : f.firstWord;
    if (!keyRegex.test(probe)) continue;
    const firstWord = f.line.words?.[0];
    if (!firstWord?.bbox || firstWord.bbox.length < 4) continue;
    firstWordRights.push(firstWord.bbox[0] + firstWord.bbox[2]);
  }
  let colBoundaries: number[] | undefined;
  if (firstWordRights.length > 0) {
    const keyColRight = median(firstWordRights);
    colBoundaries = [rx, Math.min(keyColRight + NOTES_KEY_COLUMN_GAP, rRight - 0.001), rRight];
  }
  return {
    headers: grid.headers,
    rows: grid.rows,
    rowBoundaries: grid.rowBoundaries,
    colBoundaries,
  };
}
