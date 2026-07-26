#!/usr/bin/env node
/**
 * VA SEED PICKER — lists the room labels on a sheet with their PDF USER-SPACE coordinates, so a
 * human can locate rooms 163 / 162 / 161 and record a seed point inside each.
 *
 * This exists because phase 1's gate needs three seed points on the VA drawing and NO PUBLISHED
 * COORDINATES EXIST. It deliberately does NOT pick the seeds: a label's position is not the same
 * as a point inside the room it names (labels sit near walls, in doorways, or outside small
 * spaces), and a seed one wall off produces a plausible number for the WRONG room — which would
 * make every assertion in that gate pass or fail for reasons unrelated to the engine.
 *
 * So: this prints what is knowable, and a human does the part that needs judgement.
 *
 *   node scripts/probes/va-seed-picker.mjs [pdf] [page=1] [--all]
 */
import "./_ts-resolve.mjs";
import { readFileSync } from "node:fs";
import { loadPdfjs, densityFixture } from "./_paths.mjs";

const pdfjs = await loadPdfjs();
const file = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : densityFixture();
const pageNo = Number(process.argv[3] ?? 1) || 1;
const showAll = process.argv.includes("--all");

const doc = await pdfjs.getDocument({
  data: new Uint8Array(readFileSync(file)),
  isEvalSupported: false,
}).promise;
const page = await doc.getPage(pageNo);
const vp1 = page.getViewport({ scale: 1 });
const tc = await page.getTextContent();

console.log(`## ${file.split("/").pop()}  page ${pageNo}  ${vp1.width.toFixed(0)} x ${vp1.height.toFixed(0)} pt\n`);
console.log(`Coordinates below are PDF USER space (origin BOTTOM-LEFT) — the same space`);
console.log(`va-seeds.json expects. Most viewers report this directly.\n`);

// The three rooms phase 1's oracle names, plus anything that looks like a room number.
const WANTED = new Set(["161", "162", "163"]);
const rows = [];
for (const it of tc.items || []) {
  const s = (it.str || "").trim();
  if (!s) continue;
  const isWanted = [...WANTED].some((w) => s.includes(w));
  const looksLikeRoom = /^\d{2,4}[A-Z]?$/.test(s);
  if (!showAll && !isWanted && !looksLikeRoom) continue;
  // it.transform is text-space -> user-space; e/f are the translation.
  rows.push({ str: s, x: it.transform[4], y: it.transform[5], wanted: isWanted });
}

const wanted = rows.filter((r) => r.wanted);
const others = rows.filter((r) => !r.wanted);

console.log("★ LABELS MATCHING THE ORACLE ROOMS (161 / 162 / 163):");
if (wanted.length === 0) {
  console.log("   none found — try --all, or the rooms may be on another page.");
} else {
  for (const r of wanted) {
    console.log(`   ${JSON.stringify(r.str).padEnd(24)} label at user (${r.x.toFixed(1)}, ${r.y.toFixed(1)})`);
  }
}

console.log(`\n   ⚠ A LABEL POSITION IS NOT A SEED. Labels sit near walls, in doorways, or outside`);
console.log(`     small rooms. Click the middle of the open floor and use THAT point.\n`);

if (others.length) {
  console.log(`other room-number-shaped labels (${others.length}${showAll ? "" : ", pass --all for every text item"}):`);
  for (const r of others.slice(0, 30)) {
    console.log(`   ${JSON.stringify(r.str).padEnd(24)} (${r.x.toFixed(1)}, ${r.y.toFixed(1)})`);
  }
  if (others.length > 30) console.log(`   … and ${others.length - 30} more`);
}

console.log(`\nWrite the three points into test/fixtures/bucketfill/va-seeds.json, then run:`);
console.log(`   node scripts/oneclick-accuracy.mjs --va-seeds test/fixtures/bucketfill/va-seeds.json`);
await doc.destroy();
