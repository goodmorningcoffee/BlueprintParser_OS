// bp-dataset-split (Q10 converter): bp-dataset/1 → per-project bp-export/1. Synthetic lines only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import test from "node:test";

import { isHiddenDuplicate, splitDataset } from "../bp-dataset-split.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(REPO_ROOT, "scripts/bp-dataset-split.mjs");

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const CO = "00000000-0000-4000-8000-0000000000c0";

const header = { t: "header", schemaVersion: "bp-dataset/1", exportedAt: "2026-10-21T12:00:00.000Z" };
const project = (publicId) => ({
  t: "project",
  publicId,
  name: `Synthetic ${publicId.slice(-1)}`,
  companyPublicId: CO,
  numPages: 3,
  status: "completed",
  isDemo: false,
  projectIntelligence: { k: 1 },
  projectSummary: null,
  assets: { pdf: `/api/project-assets/${publicId}/original.pdf` },
});
const page = (publicId, n, extra = {}) => ({
  t: "page",
  projectPublicId: publicId,
  pageNumber: n,
  name: `Page ${n}`,
  drawingNumber: null,
  rawText: `synthetic text ${n}`,
  csiCodes: null,
  keynotes: null,
  textAnnotations: null,
  textractData: { words: [] },
  pageIntelligence: {},
  error: null,
  duplicateOf: null,
  assets: {
    png: `/api/project-assets/${publicId}/pages/page_000${n}.png`,
    thumb: `/api/project-assets/${publicId}/thumbnails/page_000${n}.png`,
  },
  ...extra,
});
const ann = (publicId, id, n) => ({
  t: "annotation",
  id,
  projectPublicId: publicId,
  pageNumber: n,
  name: `a${id}`,
  bbox: [0.1, 0.2, 0.3, 0.4],
  threshold: null,
  source: "user",
  origin: "human",
  shapeKind: "empty-markup",
  data: {},
  note: null,
  creatorPublicId: null,
});
const hiddenMark = { pageNumber: 1, tier: "exact", score: 1, scannedAt: "2026-10-21", hiddenAt: "2026-10-21" };

async function* iter(lines) {
  for (const l of lines) yield JSON.stringify(l);
}

async function run(lines, opts = {}) {
  const bundles = new Map();
  const summary = await splitDataset(iter(lines), opts, async (id, b) => bundles.set(id, b));
  return { summary, bundles };
}

test("isHiddenDuplicate: only a mark with hiddenAt hides", () => {
  assert.equal(isHiddenDuplicate(null), false);
  assert.equal(isHiddenDuplicate({ pageNumber: 1, tier: "exact" }), false);
  assert.equal(isHiddenDuplicate({ ...hiddenMark, hiddenAt: null }), false);
  assert.equal(isHiddenDuplicate(hiddenMark), true);
});

test("bp-export/1 shape: exact key order, S3 keys null, pages by number, annotations by id", async () => {
  const { summary, bundles } = await run(
    [
      header,
      { t: "model", companyPublicId: CO, name: "m1", type: "yolo", config: { classes: ["x"] } },
      project(A),
      page(A, 2),
      page(A, 1),
      ann(A, 9, 1),
      ann(A, 3, 2),
      { t: "takeoffGroup", projectPublicId: A, id: 1 },
      { t: "footer", counts: {} },
    ],
    { baseUrl: "https://app.test/" },
  );
  assert.equal(summary.written, 1);
  assert.equal(summary.footer, true);
  const b = bundles.get(A);
  assert.deepEqual(Object.keys(b), ["schemaVersion", "exportedAt", "project", "models", "assets", "pages", "annotations"]);
  assert.equal(b.schemaVersion, "bp-export/1");
  assert.equal(b.exportedAt, header.exportedAt);
  assert.deepEqual(Object.keys(b.project), ["publicId", "name", "dataUrl", "numPages", "status", "projectIntelligence", "projectSummary"]);
  assert.equal(b.project.dataUrl, null);
  assert.deepEqual(b.models, [{ name: "m1", type: "yolo", config: { classes: ["x"] } }]);
  assert.deepEqual(b.assets, { pdfKey: null, pdfUrl: `https://app.test/api/project-assets/${A}/original.pdf` });
  assert.deepEqual(b.pages.map((p) => p.pageNumber), [1, 2]);
  assert.deepEqual(Object.keys(b.pages[0]), [
    "pageNumber", "name", "drawingNumber", "rawText", "csiCodes", "keynotes", "textAnnotations",
    "textractData", "pageIntelligence", "error", "image",
  ]);
  assert.deepEqual(b.pages[0].image, {
    pngKey: null,
    pngUrl: `https://app.test/api/project-assets/${A}/pages/page_0001.png`,
    thumbKey: null,
    thumbUrl: `https://app.test/api/project-assets/${A}/thumbnails/page_0001.png`,
  });
  assert.deepEqual(b.annotations.map((a) => a.id), [3, 9]);
  assert.deepEqual(Object.keys(b.annotations[0]), ["id", "name", "bbox", "pageNumber", "threshold", "source", "data", "note"]);
});

test("hidden duplicates and their annotations are dropped by default, kept on request", async () => {
  const lines = [
    header,
    project(A),
    page(A, 1),
    page(A, 2),
    page(A, 3, { duplicateOf: hiddenMark }),
    page(A, 4, { duplicateOf: { ...hiddenMark, hiddenAt: undefined } }), // scanned, not hidden
    ann(A, 1, 1),
    ann(A, 2, 3),
    { t: "footer" },
  ];
  const dropped = await run(lines);
  assert.deepEqual(dropped.bundles.get(A).pages.map((p) => p.pageNumber), [1, 2, 4]);
  assert.deepEqual(dropped.bundles.get(A).annotations.map((a) => a.id), [1]);
  assert.equal(dropped.summary.droppedPages, 1);
  assert.equal(dropped.summary.droppedAnnotations, 1);

  const kept = await run(lines, { keepDuplicates: true });
  assert.deepEqual(kept.bundles.get(A).pages.map((p) => p.pageNumber), [1, 2, 3, 4]);
  assert.deepEqual(kept.bundles.get(A).annotations.map((a) => a.id), [1, 2]);
});

test("omitted fields stay absent; presigned URLs win over gateway paths (null when signing failed)", async () => {
  const p = { ...project(A), assets: { pdf: "/x.pdf", pdfPresigned: null } };
  const pg = page(A, 1, { assets: { png: "/p", thumb: "/t", pngPresigned: "https://signed/p", thumbPresigned: "https://signed/t" } });
  delete pg.textractData;
  delete pg.pageIntelligence;
  delete p.projectIntelligence;
  const { bundles, summary } = await run([header, p, pg, project(B), { t: "footer" }]);
  const b = bundles.get(A);
  assert.equal(b.assets.pdfUrl, null);
  // omit=intelligence: not in the dataset, so null here (documented difference from the live export)
  assert.equal(b.project.projectIntelligence, null);
  assert.equal(summary.projectIntelligenceOmitted, 1);
  assert.deepEqual(bundles.get(B).project.projectIntelligence, { k: 1 });
  assert.ok(!("textractData" in b.pages[0]));
  assert.ok(!("pageIntelligence" in b.pages[0]));
  assert.equal(b.pages[0].image.pngUrl, "https://signed/p");
});

test("a project with an error line, or cut off by a missing footer, is not written", async () => {
  const failed = await run([header, project(A), page(A, 1), { t: "error", projectPublicId: A, code: "PROJECT_FAILED" }, project(B), page(B, 1), { t: "footer" }]);
  assert.deepEqual([...failed.bundles.keys()], [B]);
  assert.deepEqual(failed.summary.skippedIncomplete, [A]);

  const truncated = await run([header, project(A), page(A, 1), project(B), page(B, 1)]);
  assert.deepEqual([...truncated.bundles.keys()], [A]);
  assert.deepEqual(truncated.summary.skippedIncomplete, [B]);
  assert.equal(truncated.summary.footer, false);

  const forced = await run([header, project(A), { t: "error", projectPublicId: A }], { keepIncomplete: true });
  assert.deepEqual([...forced.bundles.keys()], [A]);
});

test("rejects a file that is not bp-dataset/1", async () => {
  await assert.rejects(run([{ t: "header", schemaVersion: "bp-export/1" }]), /unsupported schemaVersion/);
  await assert.rejects(run([project(A)]), /no bp-dataset\/1 header/);
});

test("CLI: gzip input → one <publicId>.json per project, exit 0 with a footer", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "bp-dataset-split-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, "in.ndjson.gz");
  const out = path.join(dir, "out");
  const lines = [header, project(A), page(A, 1), project(B), page(B, 2), { t: "footer" }];
  await writeFile(input, gzipSync(lines.map((l) => JSON.stringify(l)).join("\n") + "\n"));
  const res = spawnSync(process.execPath, [SCRIPT, input, "--out", out], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  const summary = JSON.parse(res.stdout.trim());
  assert.equal(summary.written, 2);
  assert.deepEqual((await readdir(out)).sort(), [`${A}.json`, `${B}.json`]);
  const b = JSON.parse(await readFile(path.join(out, `${B}.json`), "utf8"));
  assert.deepEqual(b.pages.map((p) => p.pageNumber), [2]);

  // plain (uncompressed) input works too; a missing footer exits 2
  const plain = path.join(dir, "cut.ndjson");
  await writeFile(plain, [header, project(A), page(A, 1)].map((l) => JSON.stringify(l)).join("\n"));
  const cut = spawnSync(process.execPath, [SCRIPT, plain, "--out", path.join(dir, "out2")], { encoding: "utf8" });
  assert.equal(cut.status, 2, cut.stderr);

  const usage = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.equal(usage.status, 1);
});
