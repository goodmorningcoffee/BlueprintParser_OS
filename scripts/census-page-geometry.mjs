#!/usr/bin/env node

/**
 * Corpus census: what kind of drawings are actually in the corpus?
 *
 * This is the artifact behind owner decision 1 in the BucketFill rebuild plan, and no other
 * phase produces it. It walks a directory (or a manifest) of `original.pdf`s, runs the
 * One-Click vector extractor over EVERY page, and emits one CSV row per page:
 *
 *     project, page, segCount, imageFrac, rasterEligible, hasHiddenOCG
 *
 * Zero judgment required to run it. It answers three questions that are currently guesses:
 *
 *   1. Is the corpus vector-dominant or scan-dominant?  (`rasterEligible` rate)
 *      -> decision 7, and the phase-5 inversion trigger: >=40% scans promotes raster
 *         convergence ahead of the public vector flip.
 *   2. How common are hidden CAD layers, really?        (`hasHiddenOCG` rate)
 *      -> risk #2 / U5. Hidden layers are the one known case where the vector path is
 *         strictly WORSE than the raster path it replaces: pdf.js resolves optional content
 *         at PAINT time, so the operator list contains linework the user cannot see, and a
 *         hidden layer bisecting a room yields a confidently wrong half-room polygon with no
 *         status fired. The mechanism is confirmed; only the PREVALENCE is unmeasured.
 *         This column is that measurement.
 *   3. How dense do real sheets get?                    (`segCount` distribution)
 *      -> U4. The VA plan (~72k segments) is our densest known sheet; a customer E-size
 *         sheet could exceed it and blow the one-time per-page extraction budget.
 *
 * ---------------------------------------------------------------------------------------
 * NODE VERSION -- READ THIS FIRST. This script needs **node >= 22.6**, which is the OPPOSITE
 * of the constraint on this repo's test suite (which is pinned to node 20 by `.nvmrc`,
 * because node 24 breaks vitest). The reason is that the engine is a TypeScript module
 * loaded directly via type-stripping, with no build step. MEASURED 2026-07-26:
 *     node 20.20.2 -> ERR_UNKNOWN_FILE_EXTENSION
 *     node 24.18.0 -> loads fine
 * So: run the TESTS on node 20, run THIS on node 22.6+. The check below fails loud and
 * names the remedy rather than dying on a cryptic loader error.
 * ---------------------------------------------------------------------------------------
 *
 * USAGE
 *   node scripts/census-page-geometry.mjs --dir <root> [--out census.csv]
 *   node scripts/census-page-geometry.mjs --manifest paths.txt [--out census.csv]
 *
 *   --dir <root>        Walk <root> recursively for `original.pdf` (override with --name).
 *   --manifest <file>   Newline-delimited list of paths instead of a walk. Lines may be
 *                       local paths or `s3://` URIs; blank lines and `#` comments ignored.
 *   --out <file>        CSV destination (default: stdout). Written incrementally.
 *   --resume            Skip (project,page) pairs already present in --out. Safe to re-run
 *                       after an interruption; a corpus run is long and WILL be interrupted.
 *   --engine <path>     Override the extractor module (see resolution order below).
 *   --scale <n>         Viewport scale for extraction (default 1). segCount and imageFrac
 *                       are scale-invariant -- verified, not assumed -- so leave this alone
 *                       unless you are investigating something specific.
 *   --raster-threshold  imageFrac at/above which a page counts as rasterEligible (default
 *                       0.10, matching the pass-3 probes).
 *   --max-pages <n>     Cap pages per document (default 0 = all).
 *   --limit <n>         Cap documents processed (default 0 = all). Useful for a smoke run.
 *   --name <basename>   Filename to look for under --dir (default `original.pdf`).
 *   --quiet             Suppress the per-file progress line on stderr.
 *
 * ENGINE RESOLUTION, first hit wins:
 *   1. --engine <path>
 *   2. $BP_ONECLICK_ENGINE
 *   3. <repo>/src/lib/oneclick/oneclick.ts        <- the vendored copy, once phase 1 lands
 *   4. $BP_OT_CLONE/web/src/lib/oneclick.ts       <- the OpenTakeoff clone (phase-0 reality)
 * In phase 0 the vendored copy does not exist yet, so 4 is the live path. After phase 1
 * vendors the engine, 3 takes over automatically and this script needs no edit.
 *
 * S3: the `s3://` branch shells out to `aws s3 cp`. There is NO aws CLI in the dev container,
 * so that branch is UNTESTED HERE -- it is written to fail loud rather than silently skip.
 * The tested, recommended path is: `aws s3 sync s3://<bucket>/<prefix> ./corpus` on a machine
 * that has the CLI, then point --dir at ./corpus.
 *
 * OUTPUT NOTES
 * - One row per page, ALWAYS. A page that fails to parse emits a row with status=ERROR and
 *   the message, because a corpus run that silently drops its failures reports a cleaner
 *   corpus than it measured. (This repo has already been bitten by exactly that: see the
 *   `fix(reprocess): one bad project no longer truncates the NDJSON stream` commit.)
 * - `hasHiddenOCG` is a genuine PER-PAGE measure, not a document-level one: it scans the
 *   page's own operator list for `beginMarkedContentProps` with an "OC" tag and asks the
 *   default optional-content config whether that group is visible. Verified against a
 *   known-answer fixture (`_wf/pass3/probe6/ocg.pdf`, one hidden group named HiddenLayer).
 * - A summary is printed to stderr at the end -- that is the part that answers decision 1.
 *
 * ── A CAVEAT ON `rasterEligible` THAT YOU MUST READ BEFORE ACTING ON IT ──────────────────
 * `imageFrac` is a SUM of placed image area over the page, so it is not by itself a scan
 * detector. MEASURED on the VA finish plan: that sheet contains **12,433 image ops** which
 * are decorative one-pixel-tall gradient strips (72x1, 10x1, 18x1) in the title block and
 * border -- not a scan underlay at all. It lands at imageFrac 0.0144, comfortably below the
 * threshold, so the verdict is right here. But a sheet with heavy gradient artwork could in
 * principle accumulate toward 0.10 without containing a single scanned pixel.
 *
 * That is why the `imageOps` column exists. Use the two together:
 *     high imageFrac + LOW  imageOps  ->  a genuine scan/photo underlay (one big image)
 *     high imageFrac + HIGH imageOps  ->  decorative gradient artwork; a FALSE positive
 * If the census returns a scan-dominant verdict, check `imageOps` on those rows before
 * letting it fire the phase-5 inversion trigger.
 */

import { readFileSync, existsSync, statSync, readdirSync, appendFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

// ── node version gate ────────────────────────────────────────────────────────
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 6)) {
  console.error(
    `\nFATAL: this script needs node >= 22.6 for TypeScript type-stripping; you are on ` +
      `${process.versions.node}.\n\n` +
      `  This repo pins node 20 in .nvmrc for the TEST SUITE (node 24 breaks vitest).\n` +
      `  That pin does not apply here. Run this script with a newer node:\n\n` +
      `      . /usr/local/share/nvm/nvm.sh && nvm use default   # node 24 in this container\n\n` +
      `  Alternatively pass --engine <path> pointing at a compiled .js build of the engine.\n`,
  );
  process.exit(2);
}

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : argv[i + 1];
};
const bool = (name) => argv.includes(`--${name}`);

const dirArg = flag("dir");
const manifestArg = flag("manifest");
const outArg = flag("out");
const engineArg = flag("engine");
const scale = Number(flag("scale", "1"));
const rasterThreshold = Number(flag("raster-threshold", "0.10"));
const maxPages = Number(flag("max-pages", "0"));
const limit = Number(flag("limit", "0"));
const nameArg = flag("name", "original.pdf");
const quiet = bool("quiet");
const resume = bool("resume");

if (!dirArg && !manifestArg) {
  console.error("usage: node scripts/census-page-geometry.mjs --dir <root> | --manifest <file> [--out census.csv]");
  console.error("       (run with no corpus to see this; --help is not a thing here on purpose)");
  process.exit(2);
}
if (resume && !outArg) {
  console.error("FATAL: --resume needs --out (there is nothing to resume from on stdout).");
  process.exit(2);
}

// ── engine resolution ────────────────────────────────────────────────────────
const REPO = resolve(new URL("..", import.meta.url).pathname);
const OT_CLONE =
  process.env.BP_OT_CLONE ||
  "/workspaces/projects/gitignore/projects/bucketfill_rebuild/gitignore/opentakeoff";

const engineCandidates = [
  engineArg,
  process.env.BP_ONECLICK_ENGINE,
  join(REPO, "src/lib/oneclick/oneclick.ts"),
  join(OT_CLONE, "web/src/lib/oneclick.ts"),
].filter(Boolean);

const enginePath = engineCandidates.find((p) => existsSync(p));
if (!enginePath) {
  console.error(
    "FATAL: could not resolve the One-Click extractor. Tried, in order:\n" +
      engineCandidates.map((p) => `  - ${p}`).join("\n") +
      "\n\nPass --engine <path>, or set $BP_ONECLICK_ENGINE / $BP_OT_CLONE.\n",
  );
  process.exit(2);
}

const pdfjs = await import(join(REPO, "node_modules/pdfjs-dist/legacy/build/pdf.mjs"));
const engine = await import(enginePath);
if (typeof engine.extractVectorGeometry !== "function") {
  console.error(`FATAL: ${enginePath} does not export extractVectorGeometry.`);
  process.exit(2);
}
const BEGIN_MC_PROPS = pdfjs.OPS.beginMarkedContentProps;
const IMAGE_OPS = new Set([
  pdfjs.OPS.paintImageXObject,
  pdfjs.OPS.paintInlineImageXObject,
  pdfjs.OPS.paintImageMaskXObject,
]);
// PLAN item 1 requires the harness to wire standardFontDataUrl. VERIFIED 2026-07-26 that it
// changes NO census column on the VA sheet (identical segs/imageArea/op counts with and
// without) -- but it is wired anyway: it is free, it matches the harness contract, and
// without it pdf.js emits a warning per document that would bury a corpus run's real errors.
const STANDARD_FONTS = join(REPO, "node_modules/pdfjs-dist/standard_fonts/");

// ── corpus enumeration ───────────────────────────────────────────────────────
function walk(root, basename, acc = []) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const p = join(root, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      walk(p, basename, acc);
    } else if (e.name === basename || (basename === "*" && e.name.toLowerCase().endsWith(".pdf"))) {
      acc.push(p);
    }
  }
  return acc;
}

let targets = [];
if (dirArg) {
  const root = resolve(dirArg);
  if (!existsSync(root)) {
    console.error(`FATAL: --dir does not exist: ${root}`);
    process.exit(2);
  }
  targets = walk(root, nameArg);
  if (targets.length === 0) {
    // A corpus root with zero matches is far more likely to be a wrong --name than an
    // empty corpus. Say so instead of reporting a clean run over nothing.
    console.error(
      `FATAL: no files named "${nameArg}" under ${root}.\n` +
        `  Use --name to change the filename, or --name '*' to take every .pdf.\n`,
    );
    process.exit(2);
  }
} else {
  const lines = readFileSync(manifestArg, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  targets = lines;
}
if (limit > 0) targets = targets.slice(0, limit);

// ── s3 support (UNTESTED in the dev container -- no aws CLI here) ────────────
let s3Warned = false;
function materialize(target) {
  if (!target.startsWith("s3://")) return { path: target, cleanup: null };
  if (!s3Warned) {
    console.error("[census] NOTE: s3:// inputs shell out to `aws s3 cp`; this path is untested in the dev container.");
    s3Warned = true;
  }
  const local = join(tmpdir(), `census-${process.pid}-${Math.abs(hash(target))}.pdf`);
  try {
    execFileSync("aws", ["s3", "cp", target, local, "--only-show-errors"], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    throw new Error(`aws s3 cp failed for ${target}: ${(e.stderr || e.message).toString().trim()}`);
  }
  return { path: local, cleanup: local };
}
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

// ── project label ────────────────────────────────────────────────────────────
// Prefer the parent directory name, which is how the production layout stores
// `<project>/original.pdf`. Fall back to the filename for flat corpora.
function projectLabel(p) {
  const parts = p.split(/[/\\]/).filter(Boolean);
  const file = parts[parts.length - 1];
  const parent = parts[parts.length - 2];
  if (parent && file.toLowerCase() === nameArg.toLowerCase()) return parent;
  return file.replace(/\.pdf$/i, "");
}

// ── CSV ──────────────────────────────────────────────────────────────────────
const COLUMNS = [
  "project",
  "page",
  "segCount",
  "imageFrac",
  "rasterEligible",
  "hasHiddenOCG",
  "imageOps",
  "ocgTotalDoc",
  "ocgHiddenOnPage",
  "pages",
  "widthPt",
  "heightPt",
  "ms",
  "status",
  "note",
];

const csvCell = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvRow = (obj) => COLUMNS.map((c) => csvCell(obj[c])).join(",");

// Plain-ASCII, collision-safe composite key. (An earlier revision of this file used a raw
// separator byte here, which made the whole script classify as BINARY -- `grep` then matched
// nothing in it and reported success. Keep this printable.)
const key = (proj, page) => `${encodeURIComponent(proj)}::${page}`;

const done = new Set();
// project -> { seen, total }: lets --resume skip a fully-recorded document WITHOUT opening
// it. Re-parsing an already-censused corpus just to skip it page-by-page costs ~1.4 s per
// dense sheet, which on a real corpus is the difference between a resume and a re-run.
const docProgress = new Map();
let resumedFailures = 0;
let resumeSkippedDocs = 0;
const iPages = COLUMNS.indexOf("pages");
const iStatus = COLUMNS.indexOf("status");
let header = COLUMNS.join(",");
if (outArg && resume && existsSync(outArg)) {
  const prior = readFileSync(outArg, "utf8").split("\n").filter(Boolean);
  for (const line of prior.slice(1)) {
    const cells = line.split(",");
    const proj = (cells[0] || "").replace(/^"|"$/g, "");
    const page = cells[1];
    if (!proj) continue;
    // Includes page 0 -- the row a DOC_ERROR writes. Deliberate: without it a document that
    // failed outright is re-processed and its error row APPENDED AGAIN on every resume.
    // MEASURED: a 5-row census became 6 rows after one --resume.
    done.add(key(proj, page));
    if ((cells[iStatus] || "") !== "ok") resumedFailures++;
    if (!docProgress.has(proj)) docProgress.set(proj, { seen: new Set(), total: 0 });
    const rec = docProgress.get(proj);
    rec.seen.add(Number(page));
    const total = Number(cells[iPages]);
    if (Number.isFinite(total) && total > rec.total) rec.total = total;
  }
  if (!quiet) console.error(`[census] --resume: ${done.size} page rows already present, will skip them`);
} else if (outArg) {
  writeFileSync(outArg, header + "\n");
} else {
  process.stdout.write(header + "\n");
}

const emit = (obj) => {
  const line = csvRow(obj) + "\n";
  if (outArg) appendFileSync(outArg, line);
  else process.stdout.write(line);
};

// ── the measurement ──────────────────────────────────────────────────────────
const stats = {
  docs: 0,
  docErrors: 0,
  pages: 0,
  pageErrors: 0,
  rasterEligible: 0,
  hiddenOCG: 0,
  segCounts: [],
  imageFracs: [],
};

for (const target of targets) {
  let mat = null;
  let doc = null;
  const project = projectLabel(target);
  if (resume) {
    const rec = docProgress.get(project);
    // total > 0 means we recorded a real page count for it last time; seen.size >= total
    // means every page is already in the CSV. A DOC_ERROR row (page 0, total 0) does NOT
    // satisfy this, so it is skipped by the `done` check below instead of being retried.
    if (rec && rec.total > 0 && rec.seen.size >= rec.total) {
      resumeSkippedDocs++;
      continue;
    }
    if (rec && rec.total === 0 && done.has(key(project, 0))) {
      resumeSkippedDocs++;
      continue;
    }
  }
  try {
    mat = materialize(target);
    const data = new Uint8Array(readFileSync(mat.path));
    doc = await pdfjs.getDocument({
      data,
      isEvalSupported: false,
      standardFontDataUrl: STANDARD_FONTS,
    }).promise;

    // Optional-content config is document-level; visibility is resolved per page below.
    let occ = null;
    let ocgTotalDoc = 0;
    try {
      occ = await doc.getOptionalContentConfig();
      ocgTotalDoc = Object.keys(occ?.getGroups() || {}).length;
    } catch {
      occ = null;
    }

    const nPages = maxPages > 0 ? Math.min(doc.numPages, maxPages) : doc.numPages;
    stats.docs++;
    if (!quiet) {
      process.stderr.write(`[census] ${stats.docs}/${targets.length} ${project} (${doc.numPages}p)\n`);
    }

    for (let pageNo = 1; pageNo <= nPages; pageNo++) {
      if (done.has(key(project, pageNo))) continue;
      const t0 = performance.now();
      try {
        const page = await doc.getPage(pageNo);
        const vp = page.getViewport({ scale });
        const vp1 = page.getViewport({ scale: 1 });
        const opList = await page.getOperatorList();
        const geo = engine.extractVectorGeometry(opList, vp.transform, pdfjs.OPS);

        const segCount = geo.segs.length >> 2;
        const imageFrac = Math.min(1, geo.imageArea / (vp.width * vp.height));
        const rasterEligible = imageFrac >= rasterThreshold;

        // Per-page hidden-layer detection: walk this page's own operator list for
        // `beginMarkedContentProps` with an "OC" tag, and ask the default config whether
        // that group paints. Representation measured, not assumed:
        //     argsArray[i] === ["OC", { type: "OCG", id: "5R" }]
        let ocgHiddenOnPage = 0;
        let imageOps = 0;
        for (let i = 0; i < opList.fnArray.length; i++) {
          if (IMAGE_OPS.has(opList.fnArray[i])) imageOps++;
        }
        if (occ && ocgTotalDoc > 0) {
          const seen = new Set();
          for (let i = 0; i < opList.fnArray.length; i++) {
            if (opList.fnArray[i] !== BEGIN_MC_PROPS) continue;
            const args = opList.argsArray[i];
            if (!args || args[0] !== "OC" || !args[1]) continue;
            const ref = args[1];
            const key = typeof ref === "object" ? `${ref.type}:${ref.id ?? JSON.stringify(ref)}` : String(ref);
            if (seen.has(key)) continue;
            seen.add(key);
            try {
              if (occ.isVisible(ref) === false) ocgHiddenOnPage++;
            } catch {
              /* an unresolvable OC ref is not a hidden layer; ignore */
            }
          }
        }
        const hasHiddenOCG = ocgHiddenOnPage > 0;

        stats.pages++;
        if (rasterEligible) stats.rasterEligible++;
        if (hasHiddenOCG) stats.hiddenOCG++;
        stats.segCounts.push(segCount);
        stats.imageFracs.push(imageFrac);

        emit({
          project,
          page: pageNo,
          segCount,
          imageFrac: imageFrac.toFixed(6),
          rasterEligible,
          hasHiddenOCG,
          imageOps,
          ocgTotalDoc,
          ocgHiddenOnPage,
          pages: doc.numPages,
          widthPt: vp1.width.toFixed(1),
          heightPt: vp1.height.toFixed(1),
          ms: (performance.now() - t0).toFixed(1),
          status: "ok",
          note: "",
        });
        page.cleanup();
      } catch (e) {
        stats.pages++;
        stats.pageErrors++;
        emit({
          project,
          page: pageNo,
          segCount: "",
          imageFrac: "",
          rasterEligible: "",
          hasHiddenOCG: "",
          imageOps: "",
          ocgTotalDoc,
          ocgHiddenOnPage: "",
          pages: doc.numPages,
          widthPt: "",
          heightPt: "",
          ms: (performance.now() - t0).toFixed(1),
          status: "ERROR",
          note: (e && e.message) || String(e),
        });
      }
    }
  } catch (e) {
    // Whole-document failure: still emit a row, or this document vanishes from the census.
    stats.docErrors++;
    emit({
      project,
      page: 0,
      segCount: "",
      imageFrac: "",
      rasterEligible: "",
      hasHiddenOCG: "",
      imageOps: "",
      ocgTotalDoc: "",
      ocgHiddenOnPage: "",
      pages: "",
      widthPt: "",
      heightPt: "",
      ms: "",
      status: "DOC_ERROR",
      note: (e && e.message) || String(e),
    });
    if (!quiet) process.stderr.write(`[census] DOC_ERROR ${project}: ${(e && e.message) || e}\n`);
  } finally {
    if (doc) {
      try {
        await doc.destroy();
      } catch {
        /* nothing useful to do */
      }
    }
    if (mat?.cleanup) {
      try {
        (await import("node:fs")).unlinkSync(mat.cleanup);
      } catch {
        /* temp file */
      }
    }
  }
}

// ── summary: this is the part that answers decision 1 ────────────────────────
const pct = (n, d) => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`);
const median = (a) => {
  if (a.length === 0) return "n/a";
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const okPages = stats.pages - stats.pageErrors;

const mixVerdict =
  okPages === 0
    ? "unknown (no pages measured)"
    : stats.rasterEligible / okPages >= 0.4
      ? "SCAN-DOMINANT (>=40%) -- fires the phase-5 inversion trigger: raster convergence " +
        "should be promoted AHEAD of the public vector flip"
      : stats.rasterEligible / okPages <= 0.1
        ? "VECTOR-DOMINANT (<=10% raster-eligible) -- phase 5 stays in its planned slot"
        : "MIXED -- neither trigger fires cleanly; owner judgment needed";

const lines = [
  "",
  "──────────────────────────────────────────────────────────────────────────",
  " CORPUS CENSUS SUMMARY",
  "──────────────────────────────────────────────────────────────────────────",
  ` documents           ${stats.docs}   (doc-level failures: ${stats.docErrors})`,
  ` pages measured      ${okPages}   (page-level failures: ${stats.pageErrors})`,
  "",
  ` rasterEligible      ${stats.rasterEligible} / ${okPages}  = ${pct(stats.rasterEligible, okPages)}   (imageFrac >= ${rasterThreshold})`,
  ` hidden OCG layers   ${stats.hiddenOCG} / ${okPages}  = ${pct(stats.hiddenOCG, okPages)}`,
  "",
  ` segCount   median ${median(stats.segCounts)}   max ${stats.segCounts.length ? Math.max(...stats.segCounts) : "n/a"}`,
  ` imageFrac  median ${typeof median(stats.imageFracs) === "number" ? median(stats.imageFracs).toFixed(4) : "n/a"}`,
  "",
  ` INPUT-MIX VERDICT:  ${mixVerdict}`,
  "",
  ` HIDDEN-LAYER RISK:  ${
    stats.hiddenOCG === 0
      ? "no hidden layers found -- risk #2 is real in mechanism but rare here; the phase-2 routing guard still ships"
      : `${pct(stats.hiddenOCG, okPages)} of pages carry a hidden layer. Every one of those is a page where the ` +
        "vector path can commit a confidently wrong number. The phase-2 routing guard is REQUIRED, not optional."
  }`,
  "──────────────────────────────────────────────────────────────────────────",
  "",
];
process.stderr.write(lines.join("\n"));

if (resume && (resumeSkippedDocs > 0 || resumedFailures > 0)) {
  process.stderr.write(
    `NOTE: --resume skipped ${resumeSkippedDocs} already-recorded document(s). ` +
      `${resumedFailures} previously-recorded row(s) had status != ok and were NOT retried -- ` +
      `--resume never retries failures, by design, because retrying them would append duplicate ` +
      `rows. To retry: delete those rows from the CSV, or re-run without --resume.\n\n`,
  );
}

if (stats.docErrors > 0 || stats.pageErrors > 0) {
  process.stderr.write(
    `NOTE: ${stats.docErrors} document(s) and ${stats.pageErrors} page(s) failed and are in the CSV with ` +
      `status=DOC_ERROR/ERROR. They are NOT counted in the rates above. Grep them before trusting the verdict.\n\n`,
  );
}
