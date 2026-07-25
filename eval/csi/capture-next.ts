/**
 * capture-next.ts — runs the REBUILT scorer over the corpus and emits the same
 * shape as `baseline-old-engine.json`.
 *
 * Same shape is the point: `score.ts` then consumes either engine's output
 * without modification, so old and new are measured by one instrument with one
 * set of rules. An evaluation where each side is scored by its own harness is
 * not a comparison.
 *
 * Build + run (from blueprintparser_2/):
 *   npx esbuild eval/csi/capture-next.ts --bundle --platform=node --target=node20 \
 *     --outfile=build/csi-capture-next.js --alias:@=./src
 *   node build/csi-capture-next.js <corpus.ndjson> build/csi-kb.json <out.json>
 */
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

import { detectCsiCodesNext, DEFAULT_NEXT_CONFIG, type Kb } from "./csi-detect-next";

interface CorpusPage {
  bundle: string;
  page?: number;
  pageNumber?: number;
  rawText: string | null;
}

async function main(): Promise<void> {
  const [corpusPath, kbPath, outPath] = process.argv.slice(2);
  if (!corpusPath || !kbPath || !outPath) {
    console.error("usage: node csi-capture-next.js <corpus.ndjson> <kb.json> <out.json>");
    process.exit(1);
  }

  const kb = JSON.parse(readFileSync(kbPath, "utf-8")) as Kb;
  const rows: { bundle: string; page: number; codes: string[]; meanConfidence: number }[] = [];
  let pages = 0;
  let totalCodes = 0;
  const started = Date.now();

  const rl = createInterface({ input: createReadStream(corpusPath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const p = JSON.parse(line) as CorpusPage;
    const pageNo = p.pageNumber ?? p.page ?? 0;
    pages++;

    const out = detectCsiCodesNext(p.rawText ?? "", undefined, undefined, kb);
    totalCodes += out.length;
    rows.push({
      bundle: p.bundle,
      page: pageNo,
      codes: out.map(c => c.code).sort(),
      meanConfidence: out.length ? +(out.reduce((n, c) => n + c.confidence, 0) / out.length).toFixed(4) : 0,
    });
  }

  const artifact = {
    schemaVersion: "csi-baseline/1",
    what: "REBUILT engine (csi-detect-next) over the corpus. Same shape as the old-engine baseline so score.ts can compare them.",
    engine: "csi-detect-next",
    unwired: true,
    config: DEFAULT_NEXT_CONFIG,
    kbSha: createHash("sha256").update(readFileSync(kbPath)).digest("hex").slice(0, 16),
    capturedAt: new Date().toISOString(),
    summary: {
      pagesTotal: pages,
      codesTotal: totalCodes,
      meanCodesPerPage: pages ? +(totalCodes / pages).toFixed(3) : 0,
      elapsedMs: Date.now() - started,
    },
    pages: rows.sort((a, b) => a.bundle.localeCompare(b.bundle) || a.page - b.page),
  };

  writeFileSync(outPath, JSON.stringify(artifact, null, 2) + "\n");
  console.error(
    `[next] ${pages} pages · ${totalCodes} codes · mean ${artifact.summary.meanCodesPerPage}/page · ` +
      `${artifact.summary.elapsedMs} ms → ${outPath}`,
  );
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
