#!/usr/bin/env node
/**
 * bp-dataset-split — convert an admin data export (bp-dataset/1, .ndjson or .ndjson.gz) into one
 * bp-export/1 JSON file per project, the shape GET /api/projects/[id]/export returns
 * (src/server/services/export.ts), so tooling that reads bp-export/1 keeps working.
 *
 *   node scripts/bp-dataset-split.mjs <dataset.ndjson.gz | dataset.ndjson | -> [options]
 *     --out <dir>          output directory (default: gitignore/bp-dataset-split, gitignored)
 *     --keep-duplicates    keep pages marked as hidden duplicates (default: drop them and the
 *                          annotations on them — the frozen bp-export/1 download never drops them)
 *     --keep-incomplete    also write projects the export flagged as failed part-way
 *     --base-url <url>     prefix for gateway asset paths (e.g. https://app.example.com)
 *
 * Differences from the live bp-export/1, all deliberate:
 *   • S3 keys are never exported by the admin dataset, so project.dataUrl, assets.pdfKey and
 *     page.image.pngKey / thumbKey are null. The *Url fields carry the presigned URL when the
 *     dataset was exported with presign=1 (null if signing failed, like the live export), else
 *     the application gateway URL (which needs a signed-in session).
 *   • pages are sorted by pageNumber and annotations by id (the live export's order).
 *   • hidden duplicate pages are dropped unless --keep-duplicates.
 *   • omit=intelligence: the dataset leaves projectIntelligence out of its project lines (plan
 *     §3.3), so project.projectIntelligence here is null — the live bp-export/1 with the same
 *     omit still returns it (it only drops page.pageIntelligence). The value is not in the file
 *     and cannot be rebuilt; the summary's `projectIntelligenceOmitted` counts such projects.
 *     Re-export without omit=intelligence when it is needed.
 * Everything else is copied value-for-value, with the live export's key order, so a bundle
 * from this converter and one from the live endpoint are byte-identical once the fields above
 * are aligned (pinned by src/app/api/__tests__/admin-data-export-converter.route.test.ts for the
 * default options and for omit=textract).
 *
 * Prints one JSON summary line on stdout. Exit 0 = every project written; 2 = some projects
 * skipped as incomplete or the file has no footer (truncated); 1 = usage or input error.
 */

import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createGunzip } from "node:zlib";
import { Readable, pipeline } from "node:stream";
import { fileURLToPath } from "node:url";

export const DATASET_SCHEMA = "bp-dataset/1";

/** Mirrors isHiddenDuplicate in src/server/services/admin-data-export-stream.ts. */
export function isHiddenDuplicate(duplicateOf) {
  if (!duplicateOf || typeof duplicateOf !== "object" || Array.isArray(duplicateOf)) return false;
  const h = duplicateOf.hiddenAt;
  return h !== undefined && h !== null && h !== "" && h !== false;
}

function absolute(baseUrl, gatewayPath) {
  if (gatewayPath == null) return null;
  if (!baseUrl) return gatewayPath;
  return `${baseUrl.replace(/\/+$/, "")}${gatewayPath}`;
}

function pickUrl(assets, presignedKey, gatewayKey, baseUrl) {
  if (!assets) return null;
  if (Object.prototype.hasOwnProperty.call(assets, presignedKey)) return assets[presignedKey] ?? null;
  return absolute(baseUrl, assets[gatewayKey]);
}

/** One project's lines → a bp-export/1 bundle, key order identical to services/export.ts. */
export function toBpExport(block, header, modelsByCompany, opts = {}) {
  const { project: p } = block;
  const baseUrl = opts.baseUrl ?? null;
  const keepDuplicates = opts.keepDuplicates === true;

  const hidden = new Set();
  const pages = [];
  for (const pg of block.pages) {
    if (!keepDuplicates && isHiddenDuplicate(pg.duplicateOf)) {
      hidden.add(pg.pageNumber);
      continue;
    }
    const out = {
      pageNumber: pg.pageNumber,
      name: pg.name,
      drawingNumber: pg.drawingNumber,
      rawText: pg.rawText,
      csiCodes: pg.csiCodes,
      keynotes: pg.keynotes,
      textAnnotations: pg.textAnnotations,
    };
    // An omitted field stays ABSENT (the live export's FQ-2: undefined-dropped, not null).
    if ("textractData" in pg) out.textractData = pg.textractData;
    if ("pageIntelligence" in pg) out.pageIntelligence = pg.pageIntelligence;
    out.error = pg.error ?? null;
    out.image = {
      pngKey: null,
      pngUrl: pickUrl(pg.assets, "pngPresigned", "png", baseUrl),
      thumbKey: null,
      thumbUrl: pickUrl(pg.assets, "thumbPresigned", "thumb", baseUrl),
    };
    pages.push(out);
  }
  pages.sort((a, b) => a.pageNumber - b.pageNumber);

  const annotations = block.annotations
    .filter((a) => !hidden.has(a.pageNumber))
    .sort((a, b) => a.id - b.id)
    .map((a) => ({
      id: a.id,
      name: a.name,
      bbox: a.bbox,
      pageNumber: a.pageNumber,
      threshold: a.threshold,
      source: a.source,
      data: a.data,
      note: a.note,
    }));

  return {
    bundle: {
      schemaVersion: "bp-export/1",
      exportedAt: header?.exportedAt ?? new Date().toISOString(),
      project: {
        publicId: p.publicId,
        name: p.name,
        dataUrl: null,
        numPages: p.numPages,
        status: p.status,
        projectIntelligence: p.projectIntelligence ?? null,
        projectSummary: p.projectSummary ?? null,
      },
      models: (modelsByCompany.get(p.companyPublicId) ?? []).map((m) => ({
        name: m.name,
        type: m.type,
        config: m.config,
      })),
      assets: { pdfKey: null, pdfUrl: pickUrl(p.assets, "pdfPresigned", "pdf", baseUrl) },
      pages,
      annotations,
    },
    droppedPages: hidden.size,
    droppedAnnotations: block.annotations.length - annotations.length,
    projectIntelligenceOmitted: !("projectIntelligence" in p),
  };
}

/**
 * Consume dataset lines (an async iterable of strings) and call onBundle(publicId, bundle) per
 * complete project. Returns the summary.
 */
export async function splitDataset(lines, opts = {}, onBundle) {
  const summary = {
    written: 0,
    skippedIncomplete: [],
    droppedPages: 0,
    droppedAnnotations: 0,
    projectIntelligenceOmitted: 0,
    footer: false,
    errors: [],
  };
  const modelsByCompany = new Map();
  let header = null;
  let block = null;

  const flush = async (truncated) => {
    if (!block) return;
    const current = block;
    block = null;
    if ((current.failed || truncated) && !opts.keepIncomplete) {
      summary.skippedIncomplete.push(current.project.publicId);
      return;
    }
    const { bundle, droppedPages, droppedAnnotations, projectIntelligenceOmitted } = toBpExport(
      current,
      header,
      modelsByCompany,
      opts,
    );
    if (projectIntelligenceOmitted) summary.projectIntelligenceOmitted++;
    summary.droppedPages += droppedPages;
    summary.droppedAnnotations += droppedAnnotations;
    summary.written++;
    await onBundle(current.project.publicId, bundle);
  };

  let lineNo = 0;
  for await (const raw of lines) {
    lineNo++;
    if (!raw.trim()) continue;
    let line;
    try {
      line = JSON.parse(raw);
    } catch {
      throw new Error(`line ${lineNo}: not JSON`);
    }
    switch (line.t) {
      case "header":
        if (line.schemaVersion !== DATASET_SCHEMA) {
          throw new Error(`unsupported schemaVersion ${JSON.stringify(line.schemaVersion)}`);
        }
        header = line;
        break;
      case "model": {
        const list = modelsByCompany.get(line.companyPublicId) ?? [];
        list.push(line);
        modelsByCompany.set(line.companyPublicId, list);
        break;
      }
      case "project":
        await flush(false);
        block = { project: line, pages: [], annotations: [], failed: false };
        break;
      case "page":
        if (block && line.projectPublicId === block.project.publicId) block.pages.push(line);
        break;
      case "annotation":
        if (block && line.projectPublicId === block.project.publicId) block.annotations.push(line);
        break;
      case "error":
        summary.errors.push({ projectPublicId: line.projectPublicId ?? null, code: line.code ?? null });
        if (block && line.projectPublicId === block.project.publicId) block.failed = true;
        break;
      case "footer":
        await flush(false);
        summary.footer = true;
        break;
      default:
        // takeoffGroup / takeoffItem / qtoWorkflow / annotationGroup: not part of bp-export/1.
        break;
    }
  }
  if (!header) throw new Error("no bp-dataset/1 header line");
  // No footer → the export was cut off; the last open project may be partial.
  await flush(!summary.footer);
  return summary;
}

/** Lines of a .ndjson or .ndjson.gz file (gzip detected by its magic bytes, not the name). */
export async function* readLines(input) {
  const source = input === "-" ? process.stdin : createReadStream(input);
  const it = source[Symbol.asyncIterator]();
  const first = await it.next();
  if (first.done) return;
  const isGzip = first.value.length >= 2 && first.value[0] === 0x1f && first.value[1] === 0x8b;
  async function* bytes() {
    yield first.value;
    for (;;) {
      const next = await it.next();
      if (next.done) return;
      yield next.value;
    }
  }
  let chunks = Readable.from(bytes());
  if (isGzip) {
    const gunzip = createGunzip();
    pipeline(chunks, gunzip, (err) => {
      if (err) gunzip.destroy(err);
    });
    chunks = gunzip;
  }
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of chunks) {
    const from = rest.length;
    rest += decoder.decode(chunk, { stream: true });
    let start = 0;
    for (let i = rest.indexOf("\n", from); i >= 0; i = rest.indexOf("\n", start)) {
      yield rest.slice(start, i);
      start = i + 1;
    }
    rest = rest.slice(start);
  }
  rest += decoder.decode();
  if (rest) yield rest;
}

function parseArgs(argv) {
  const opts = { out: "gitignore/bp-dataset-split", keepDuplicates: false, keepIncomplete: false, baseUrl: null };
  let input = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") opts.out = argv[++i];
    else if (a === "--keep-duplicates") opts.keepDuplicates = true;
    else if (a === "--keep-incomplete") opts.keepIncomplete = true;
    else if (a === "--base-url") opts.baseUrl = argv[++i];
    else if (a === "-h" || a === "--help") return null;
    else if (!input) input = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!input || !opts.out) return null;
  return { input, opts };
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  if (!parsed) {
    console.error(
      "usage: node scripts/bp-dataset-split.mjs <dataset.ndjson.gz|-> [--out dir] [--keep-duplicates] [--keep-incomplete] [--base-url url]",
    );
    process.exit(1);
  }
  const { input, opts } = parsed;
  await mkdir(opts.out, { recursive: true });
  let summary;
  try {
    summary = await splitDataset(readLines(input), opts, async (publicId, bundle) => {
      if (!/^[0-9a-f-]{36}$/i.test(publicId)) throw new Error("project publicId is not a uuid");
      await writeFile(path.join(opts.out, `${publicId}.json`), JSON.stringify(bundle));
    });
  } catch (e) {
    console.error(`bp-dataset-split: ${e.message}`);
    process.exit(1);
  }
  console.log(JSON.stringify({ out: opts.out, ...summary }));
  process.exit(summary.footer && summary.skippedIncomplete.length === 0 ? 0 : 2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
