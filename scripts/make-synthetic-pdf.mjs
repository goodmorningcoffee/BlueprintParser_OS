// [refactor jun12 P0.4] Synthetic blueprint-PDF generator for viewer-perf testing.
//
// The owner's perf mandate: the PDF viewer is sacred; every refactor phase that
// goes near it must benchmark against a realistic heavy plan set. Real customer
// sets are ~100 pages / tens of MB because each sheet carries an embedded scan
// raster. This script fabricates that shape deterministically:
//   - N pages of arch-D size (36"x24")
//   - per page: a UNIQUE incompressible noise PNG (file-size driver, mimicking
//     scan rasters; built by hand with stored-deflate so it cannot compress)
//   - per page: a dense vector layer (~340 text runs + ~140 grid lines + rects)
//     so pdf.js does real text-layer + render work, not just byte shuffling
//
// Output is GENERATED, not committed (test/fixtures/ is gitignored) — CI and
// fresh clones run this script on demand. Deterministic via a seeded PRNG so
// "the fixture" is the same bytes everywhere (modulo pdf-lib version).
//
// usage: node scripts/make-synthetic-pdf.mjs [--pages 100] [--target-mb 60] [--out path]
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const PAGES = parseInt(arg("pages", "100"), 10);
const TARGET_MB = parseFloat(arg("target-mb", "60"));
const OUT = arg("out", "test/fixtures/synthetic-100pg.pdf");

// mulberry32 — tiny seeded PRNG; same seed ⇒ same fixture bytes
function prng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Hand-rolled PNG: signature + IHDR + IDAT(stored-deflate RGB noise) + IEND.
// Stored deflate (level 0) keeps the random payload incompressible — this is
// what makes the output file honestly reach target size like real scans do.
function noisePng(width, height, rand) {
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  // raw scanlines: filter byte 0 + RGB noise
  const raw = Buffer.alloc(height * (1 + width * 3));
  let off = 0;
  for (let y = 0; y < height; y++) {
    raw[off++] = 0;
    for (let x = 0; x < width * 3; x++) raw[off++] = (rand() * 256) | 0;
  }
  const idat = deflateSync(raw, { level: 0 }); // stored blocks ⇒ ~size-preserving
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const W = 2592, H = 1728; // 36x24in @ 72dpi
const SHEET_PREFIXES = ["A", "S", "M", "E", "P"];
const LABELS = ["OFFICE", "CORRIDOR", "STAIR", "MECH", "ELEC", "STORAGE", "LOBBY", "RESTROOM", "JANITOR", "CONF"];

async function main() {
  const rand = prng(0xb1ce);
  // size the per-page raster so PAGES × png ≈ target (vector layer adds ~2-4%)
  const perPageBytes = (TARGET_MB * 1024 * 1024) / PAGES;
  const pixels = perPageBytes / 3; // RGB
  const w = Math.round(Math.sqrt(pixels * (4 / 3)));
  const h = Math.round(pixels / w);

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  for (let p = 1; p <= PAGES; p++) {
    const page = doc.addPage([W, H]);
    // title block
    page.drawRectangle({ x: W - 420, y: 24, width: 396, height: 180, borderWidth: 2, borderColor: rgb(0, 0, 0) });
    const sheetNo = `${SHEET_PREFIXES[p % SHEET_PREFIXES.length]}-${String(100 + p)}`;
    page.drawText(sheetNo, { x: W - 400, y: 150, size: 36, font });
    page.drawText(`SYNTHETIC PLAN SET — SHEET ${p}/${PAGES}`, { x: W - 400, y: 110, size: 14, font });

    // the scan-like raster (unique per page = honest file size)
    const png = await doc.embedPng(noisePng(w, h, rand));
    page.drawImage(png, { x: 60, y: H - 760, width: 1000, height: 700, opacity: 0.35 });

    // grid lines (vector work)
    for (let i = 0; i < 80; i++) {
      const x = 60 + i * ((W - 120) / 79);
      page.drawLine({ start: { x, y: 60 }, end: { x, y: H - 60 }, thickness: 0.4, color: rgb(0.65, 0.65, 0.65) });
    }
    for (let i = 0; i < 60; i++) {
      const y = 60 + i * ((H - 120) / 59);
      page.drawLine({ start: { x: 60, y }, end: { x: W - 60, y }, thickness: 0.4, color: rgb(0.65, 0.65, 0.65) });
    }
    // dense text runs (text-layer work: room labels, dims, keynote bubbles)
    for (let i = 0; i < 340; i++) {
      const x = 70 + rand() * (W - 300);
      const y = 70 + rand() * (H - 160);
      const kind = i % 3;
      const txt = kind === 0
        ? `${LABELS[(rand() * LABELS.length) | 0]} ${100 + ((rand() * 400) | 0)}`
        : kind === 1
          ? `${(rand() * 60 + 2).toFixed(1)}'-${((rand() * 11) | 0)}"`
          : `K${(rand() * 30 + 1) | 0}`;
      page.drawText(txt, { x, y, size: kind === 2 ? 9 : 12, font });
      if (kind === 2) page.drawCircle({ x: x + 9, y: y + 4, size: 11, borderWidth: 0.8, borderColor: rgb(0, 0, 0) });
    }
    if (p % 10 === 0) console.log(`  page ${p}/${PAGES}`);
  }

  const bytes = await doc.save();
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, bytes);
  const mb = (bytes.length / 1024 / 1024).toFixed(1);
  console.log(`wrote ${OUT}: ${PAGES} pages, ${mb} MB (target ${TARGET_MB})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
