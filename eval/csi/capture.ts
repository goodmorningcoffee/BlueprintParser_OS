/**
 * capture.ts — Stage B of the CSI freeze-first corpus baseline (PLAN P0).
 *
 * Runs the LIVE engine over every page of the extracted corpus and writes a
 * committed baseline artifact. This is the measurement the whole rebuild is
 * scored against: P1 fixes the OLD-engine number, P2 has to beat it, and any
 * unintended drift in between shows up as a changed page hash.
 *
 * WHAT IS HELD FIXED (and why it is recorded in the artifact rather than
 * assumed): the engine is called `detectCsiCodes(rawText, words, undefined,
 * undefined)` — default config, builtin DB. That is the `companyId == null`
 * path in getCompanyCsiContext, which the C1 refactor pinned as byte-identical
 * to the pre-refactor engine (invariant I-6). Baselining through a company
 * config instead would fold per-tenant slider drift into the number and make
 * later comparisons meaningless.
 *
 * WHY FULL CORPUS, NOT A SAMPLE: the 7 bundles hold 471 pages total. Scoring
 * all of them costs ~30 s, so there is no reason to sample — and no sampling
 * rule to argue about later. "The baseline is every page we have" is a claim
 * that cannot rot.
 *
 * Build + run (from blueprintparser_2/):
 *   npx esbuild eval/csi/capture.ts --bundle --platform=node --target=node20 \
 *     --outfile=build/csi-capture.js --alias:@=./src --external:pg-native
 *   node build/csi-capture.js <corpus.ndjson> <out.json>
 */
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { detectCsiCodes } from "@/lib/csi-detect";
import { DEFAULT_CSI_DETECT_CONFIG } from "@/lib/csi-detect-defs";
import type { CsiCode, TextractWord } from "@/types";

/** One page as emitted by extract-corpus.sh. */
interface CorpusPage {
  bundle: string;
  publicId: string;
  pageNumber: number;
  drawingNumber: string | null;
  discipline: string | null;
  rawText: string | null;
  words: { text: string; bbox: [number, number, number, number] }[];
  priorCodes: string[];
}

/** Per-page baseline row. Compact on purpose — this file is committed. */
interface BaselineRow {
  bundle: string;
  page: number;
  /** sha256 of the exact engine inputs — proves a re-run saw identical bytes. */
  inputSha: string;
  /** Emitted codes, sorted. Human-diffable surface. */
  codes: string[];
  /** sha256 of the FULL unsorted result incl. triggers/bboxes — catches drift
   *  that the sorted code list cannot see (trigger tiers, bbox math, order). */
  resultSha: string;
  /** Trigger count by tier, so tier-semantics changes are visible as numbers
   *  and not only as an opaque hash delta. The rebuild flips tier meaning
   *  (PLAN P2), so this column is the before-picture for that flip. */
  triggers: { t1: number; t2: number; t3: number };
  /** What the OLD engine had already persisted for this page, sorted. Not an
   *  input to scoring — recorded so a later run can tell "the engine changed"
   *  apart from "the stored corpus changed". */
  priorCodes: string[];
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function gitSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  const [corpusPath, outPath] = process.argv.slice(2);
  if (!corpusPath || !outPath) {
    console.error("usage: node csi-capture.js <corpus.ndjson> <out.json>");
    process.exit(1);
  }

  const rows: BaselineRow[] = [];
  const divisionHistogram = new Map<string, number>();
  const codeHistogram = new Map<string, number>();
  const perBundle = new Map<string, { pages: number; scored: number; withCodes: number; codes: number }>();

  let pagesTotal = 0;
  let pagesScored = 0; // had usable rawText
  let pagesWithCodes = 0;
  let codesTotal = 0;
  let triggersTotal = 0;

  const started = Date.now();
  const rl = createInterface({ input: createReadStream(corpusPath), crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    const p = JSON.parse(line) as CorpusPage;
    pagesTotal++;

    const bundleStats = perBundle.get(p.bundle) ?? { pages: 0, scored: 0, withCodes: 0, codes: 0 };
    bundleStats.pages++;

    const rawText = p.rawText ?? "";
    const words = p.words as TextractWord[];

    // Hash the exact inputs the engine is about to see.
    const inputSha = sha256(JSON.stringify([rawText, words]));

    // ── the measurement ──
    // 4-arg call with config=undefined, db=undefined (see file docstring).
    const result: CsiCode[] = detectCsiCodes(rawText, words, undefined, undefined);

    if (rawText.length >= 10) {
      pagesScored++;
      bundleStats.scored++;
    }

    const codes = result.map(r => r.code).sort();
    if (codes.length > 0) {
      pagesWithCodes++;
      bundleStats.withCodes++;
    }
    codesTotal += codes.length;
    bundleStats.codes += codes.length;

    const triggers = { t1: 0, t2: 0, t3: 0 };
    for (const r of result) {
      for (const t of r.triggers ?? []) {
        if (t.tier === 1) triggers.t1++;
        else if (t.tier === 2) triggers.t2++;
        else triggers.t3++;
      }
    }
    triggersTotal += triggers.t1 + triggers.t2 + triggers.t3;

    for (const c of codes) {
      const div = c.slice(0, 2);
      divisionHistogram.set(div, (divisionHistogram.get(div) ?? 0) + 1);
      codeHistogram.set(c, (codeHistogram.get(c) ?? 0) + 1);
    }

    rows.push({
      bundle: p.bundle,
      page: p.pageNumber,
      inputSha,
      codes,
      resultSha: sha256(JSON.stringify(result)),
      triggers,
      priorCodes: [...p.priorCodes].sort(),
      });

    perBundle.set(p.bundle, bundleStats);

    if (pagesTotal % 50 === 0) {
      console.error(`[capture] ${pagesTotal} pages … ${codesTotal} codes`);
    }
  }

  const elapsedMs = Date.now() - started;

  // Engine provenance: if any of these hashes move, the baseline is stale by
  // construction and must be recaptured before it is compared against.
  const engineFiles = [
    "src/lib/csi-detect.ts",
    "src/lib/csi-detect-defs.ts",
    "src/lib/csi-database.ts",
    "src/data/csi-masterformat.tsv",
  ];
  const engineSha: Record<string, string> = {};
  for (const f of engineFiles) engineSha[f] = sha256File(join(process.cwd(), f));

  const sortedDivisions = [...divisionHistogram.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const topCodes = [...codeHistogram.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 50);

  const artifact = {
    schemaVersion: "csi-baseline/1",
    what: "Live-engine output over the full bp-export/1 corpus, default config + builtin DB.",
    capturedAt: new Date().toISOString(),
    capturedAtGitSha: gitSha(),
    call: "detectCsiCodes(rawText, textractData.words, undefined, undefined)",
    config: DEFAULT_CSI_DETECT_CONFIG,
    database: "builtin src/data/csi-masterformat.tsv",
    engineSha,
    corpusSha: sha256File(corpusPath),
    summary: {
      pagesTotal,
      pagesScored,
      pagesSkippedShortText: pagesTotal - pagesScored,
      pagesWithCodes,
      codesTotal,
      triggersTotal,
      distinctCodes: codeHistogram.size,
      distinctDivisions: divisionHistogram.size,
      meanCodesPerScoredPage: pagesScored ? +(codesTotal / pagesScored).toFixed(3) : 0,
      elapsedMs,
    },
    perBundle: [...perBundle.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([bundle, s]) => ({ bundle, ...s })),
    // An ARRAY, not an object: division keys are digit strings ("10", "23"),
    // and JS objects reorder integer-like keys into ascending numeric order,
    // which would silently discard this count-descending sort and put "00".."09"
    // (non-canonical, so treated as string keys) after "48". An array preserves
    // the sort the reader is told they are getting.
    divisionHistogram: sortedDivisions.map(([division, n]) => ({ division, n })),
    topCodes: topCodes.map(([code, n]) => ({ code, n })),
    pages: rows,
  };

  writeFileSync(outPath, JSON.stringify(artifact, null, 2) + "\n");
  console.error(
    `[capture] ${pagesTotal} pages · ${pagesScored} scored · ${codesTotal} codes · ` +
      `${codeHistogram.size} distinct · ${elapsedMs} ms → ${outPath}`,
  );
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
