/**
 * VA SEED PROPOSER — picks candidate seeds by a FIXED, ORACLE-BLIND rule, floods them, and draws
 * the result so a human can confirm or reject three numbers instead of clicking in a PDF viewer.
 *
 * ── ★★ WHY THIS IS NOT CHEATING, AND WHERE THE LINE IS ──────────────────────────────────
 * Phase 1's gate certifies the port's accuracy against a REAL drawing rather than synthetics we
 * generated ourselves. That only means something if the gate can still fail. So the rule below is
 * fixed in advance and **never consults the oracle**:
 *
 *     1. take the label's own anchor point (from the text layer)
 *     2. if it does not flood, spiral outward to the nearest point that does
 *     3. inside that flooded region, take the point FARTHEST FROM ANY WALL
 *        (the pole of inaccessibility — a distance-transform maximum)
 *     4. re-flood from there and keep it only if the area is stable
 *
 * Nothing in that reads 154.6 / 184.6 / 240.7 SF. The areas are printed AFTERWARDS, as a report.
 * If the rule picks a point in the wrong room, or the engine is inaccurate, the numbers come out
 * wrong and the gate fails — which is the whole point of having it.
 *
 * ⛔ WHAT THIS SCRIPT IS NOT: a gate result. It writes a PROPOSAL to a separate file and prints
 * "PROPOSED, NOT ACCEPTED". Only a human moving those coordinates into `test/va-seeds.json` makes
 * them real, because only a human can look at the picture and say "yes, that is room 163".
 *
 * ── WHY IT DRAWS ────────────────────────────────────────────────────────────────────────
 * Three numbers in a terminal cannot be checked by anyone. A picture of the sheet with the seed
 * marked and the traced outline overlaid can be checked in two seconds, which is the entire job
 * this is trying to make possible.
 *
 * Usage:
 *   node scripts/probes/va-seed-propose.mjs            # node >= 22.6
 *   node scripts/probes/va-seed-propose.mjs --out DIR
 */

import "./_ts-resolve.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPdfjs, densityFixture, enginePath } from "./_paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

const engine = await import(enginePath());
const { extractVectorGeometry, buildMask, floodRegion, traceRegion, SENS_BALANCED } = engine;
const pdfjs = await loadPdfjs();

const MASK_DIM = 3000;
/** The three rooms phase 1's gate names. Their AREAS are deliberately not in this file's logic. */
const WANTED = ["163", "162", "161"];

const outDir = (() => {
  const i = process.argv.indexOf("--out");
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : join(REPO, "..", "..", "gitignore", "projects", "bucketfill_rebuild", "notes", "va_seed_proposal");
})();
mkdirSync(outDir, { recursive: true });

const file = densityFixture();
const doc = await pdfjs.getDocument({ url: file, isEvalSupported: false, useSystemFonts: false }).promise;
const page = await doc.getPage(1);
const vp1 = page.getViewport({ scale: 1 });
const scale = MASK_DIM / Math.max(vp1.width, vp1.height);
const vp = page.getViewport({ scale });
const geo = extractVectorGeometry(await page.getOperatorList(), vp.transform, pdfjs.OPS);
const maskObj = buildMask(geo.segs, vp.width, vp.height, MASK_DIM, geo.meta);
const { mask, mw, mh, ws } = maskObj;

console.log(`sheet ${vp1.width.toFixed(0)} x ${vp1.height.toFixed(0)} pt · scale ${scale.toFixed(3)} · mask ${mw} x ${mh} · ${geo.segs.length / 4} segments`);

// ── label anchors, from the text layer ────────────────────────────────────
const tc = await page.getTextContent();
const labels = new Map();
for (const it of tc.items) {
  const s = (it.str ?? "").trim();
  if (!WANTED.includes(s)) continue;
  if (labels.has(s)) continue; // first occurrence wins; deterministic
  labels.set(s, { x: it.transform[4], y: it.transform[5] });
}

const userToImage = (p) => {
  const [x, y] = pdfjs.Util.applyTransform([p.x, p.y], vp.transform);
  return { x, y };
};

/** Flood from an IMAGE-px point; returns the engine's result. */
const floodAt = (img) => floodRegion(maskObj, img.x, img.y, SENS_BALANCED);

/**
 * Step 3: the point in `region` farthest from any wall.
 *
 * A brute-force distance transform over the region's bbox. Slower than a two-pass chamfer and
 * completely adequate here — this runs once, offline, on three rooms.
 */
function poleOfInaccessibility(flood) {
  const { region, minX, minY, maxX, maxY } = flood;
  const at = (x, y) => region[y * mw + x] === 1;
  let best = null;
  let bestD = -1;
  // Coarse then fine: a 4-px stride finds the neighbourhood, then a full scan refines it.
  for (const stride of [4, 1]) {
    const x0 = best ? Math.max(minX, best.x - 8) : minX;
    const x1 = best ? Math.min(maxX, best.x + 8) : maxX;
    const y0 = best ? Math.max(minY, best.y - 8) : minY;
    const y1 = best ? Math.min(maxY, best.y + 8) : maxY;
    for (let y = y0; y <= y1; y += stride) {
      for (let x = x0; x <= x1; x += stride) {
        if (!at(x, y)) continue;
        // Chebyshev-ish radius: grow a square until it touches a non-region cell.
        let r = 0;
        for (;;) {
          const nr = r + 1;
          if (x - nr < minX || x + nr > maxX || y - nr < minY || y + nr > maxY) break;
          let clear = true;
          for (let k = -nr; k <= nr && clear; k++) {
            if (!at(x + k, y - nr) || !at(x + k, y + nr) || !at(x - nr, y + k) || !at(x + nr, y + k)) clear = false;
          }
          if (!clear) break;
          r = nr;
          if (r > 400) break;
        }
        if (r > bestD) { bestD = r; best = { x, y }; }
      }
    }
  }
  return best ? { mask: best, radiusMaskPx: bestD } : null;
}

/** Step 2: spiral outward from a point until something floods. */
function nearestFloodable(img) {
  const first = floodAt(img);
  if (first.status === "ok") return { img, flood: first, offsetPx: 0 };
  const stepPx = Math.max(2, vp.width / 600);
  for (let ring = 1; ring <= 40; ring++) {
    for (let a = 0; a < 16; a++) {
      const th = (a / 16) * Math.PI * 2;
      const p = { x: img.x + Math.cos(th) * ring * stepPx, y: img.y + Math.sin(th) * ring * stepPx };
      const f = floodAt(p);
      if (f.status === "ok") return { img: p, flood: f, offsetPx: ring * stepPx };
    }
  }
  return null;
}

const sheetAreaPt2 = vp1.width * vp1.height;
const results = [];

for (const id of WANTED) {
  const label = labels.get(id);
  if (!label) { console.log(`\n${id}: NO LABEL FOUND`); continue; }

  const anchorImg = userToImage(label);
  const found = nearestFloodable(anchorImg);
  if (!found) { console.log(`\n${id}: no floodable point near the label`); continue; }

  const pole = poleOfInaccessibility(found.flood);
  let finalImg = found.img;
  let finalFlood = found.flood;
  let usedPole = false;
  if (pole) {
    const poleImg = { x: pole.mask.x / ws, y: pole.mask.y / ws };
    const reflood = floodAt(poleImg);
    // Step 4: keep the pole only if it is STABLE — same room, area within 2% of the anchor flood.
    if (reflood.status === "ok") {
      const drift = Math.abs(reflood.count - found.flood.count) / found.flood.count;
      if (drift < 0.02) { finalImg = poleImg; finalFlood = reflood; usedPole = true; }
    }
  }

  const areaPt2 = (finalFlood.count / (mw * mh)) * sheetAreaPt2;
  const userX = (finalImg.x / vp.width) * vp1.width;
  const userY = vp1.height - (finalImg.y / vp.height) * vp1.height;
  const ring = traceRegion(finalFlood).map(([x, y]) => [x, y]);

  results.push({ id, userX, userY, imgX: finalImg.x, imgY: finalImg.y, areaPt2, ring,
    offsetPx: found.offsetPx, usedPole, radiusMaskPx: pole?.radiusMaskPx ?? 0 });

  console.log(`\n${id}: seed user (${userX.toFixed(1)}, ${userY.toFixed(1)})`);
  console.log(`     label offset ${found.offsetPx.toFixed(1)} img px · pole ${usedPole ? `used, clearance ${pole.radiusMaskPx} mask px` : "rejected (unstable)"}`);
  console.log(`     flooded ${areaPt2.toFixed(0)} pt²  (${ring.length} vertices)`);
}

// ── the report. Ratios are computed HERE, after the rule has already chosen. ──
console.log("\n" + "─".repeat(78));
if (results.length === 3) {
  const total = results.reduce((s, r) => s + r.areaPt2, 0);
  console.log("RATIOS (scale-free — this is what the gate's assertion 1 checks):");
  for (const r of results) {
    console.log(`  ${r.id}:  ${(r.areaPt2 / total * 100).toFixed(2)}% of the three-room total`);
  }
  console.log("\n  Oracle ratios, for comparison only — the rule above never saw these:");
  const ORACLE = { 163: 154.6, 162: 184.6, 161: 240.7 };
  const oTotal = Object.values(ORACLE).reduce((a, b) => a + b, 0);
  let worst = 0;
  for (const r of results) {
    const got = r.areaPt2 / total, want = ORACLE[r.id] / oTotal;
    const dev = (got - want) / want * 100;
    worst = Math.max(worst, Math.abs(dev));
    console.log(`  ${r.id}:  proposed ${(got * 100).toFixed(2)}%  vs oracle ${(want * 100).toFixed(2)}%   deviation ${dev >= 0 ? "+" : ""}${dev.toFixed(2)}%`);
  }
  console.log(`\n  worst ratio deviation: ${worst.toFixed(2)}%   (gate needs < 1.00%)`);
  console.log(worst < 1 ? "  → the ratio assertion WOULD PASS with these seeds" : "  → the ratio assertion WOULD FAIL with these seeds");
}
console.log("─".repeat(78));

// ── the proposal file. Deliberately NOT test/va-seeds.json. ──
const proposal = {
  pdf: "",
  page: 1,
  note: `PROPOSED by scripts/probes/va-seed-propose.mjs on ${new Date().toISOString().slice(0, 10)} using a fixed, oracle-blind rule. NOT ACCEPTED until a human confirms against the rendered images and copies this into test/va-seeds.json.`,
  rooms: results.map((r) => ({
    id: r.id,
    expectedSF: { 163: 154.6, 162: 184.6, 161: 240.7 }[r.id],
    seedUser: { x: Number(r.userX.toFixed(1)), y: Number(r.userY.toFixed(1)) },
  })),
};
const proposalPath = join(outDir, "va-seeds.PROPOSED.json");
writeFileSync(proposalPath, JSON.stringify(proposal, null, 2) + "\n");

// ── the pictures ──
await renderImages(results);

console.log(`\n⛔ PROPOSED, NOT ACCEPTED.`);
console.log(`   proposal : ${proposalPath}`);
console.log(`   images   : ${outDir}`);
console.log(`   To accept: look at the images, then copy the three seedUser pairs into`);
console.log(`   blueprintparser_2/test/va-seeds.json and run:`);
console.log(`     node scripts/oneclick-accuracy.mjs --va-seeds test/va-seeds.json`);

await doc.destroy();

async function renderImages(rows) {
  const { createCanvas } = await import("@napi-rs/canvas");
  const RENDER_SCALE = 1600 / Math.max(vp1.width, vp1.height);
  const rvp = page.getViewport({ scale: RENDER_SCALE });
  const canvas = createCanvas(Math.ceil(rvp.width), Math.ceil(rvp.height));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: rvp }).promise;

  const k = RENDER_SCALE / scale; // extraction px -> render px
  const COLORS = { 163: "#e11d48", 162: "#0ea5e9", 161: "#16a34a" };

  // full sheet, all three
  for (const r of rows) {
    ctx.beginPath();
    r.ring.forEach(([x, y], i) => (i ? ctx.lineTo(x * k, y * k) : ctx.moveTo(x * k, y * k)));
    ctx.closePath();
    ctx.fillStyle = COLORS[r.id] + "33";
    ctx.fill();
    ctx.strokeStyle = COLORS[r.id];
    ctx.lineWidth = 3;
    ctx.stroke();
    marker(ctx, r.imgX * k, r.imgY * k, COLORS[r.id], r.id);
  }
  writeFileSync(join(outDir, "va-seeds-overview.png"), canvas.toBuffer("image/png"));

  // one close-up per room
  for (const r of rows) {
    const xs = r.ring.map(([x]) => x * k), ys = r.ring.map(([, y]) => y * k);
    const pad = 90;
    const x0 = Math.max(0, Math.min(...xs) - pad), y0 = Math.max(0, Math.min(...ys) - pad);
    const w = Math.min(canvas.width - x0, Math.max(...xs) - Math.min(...xs) + pad * 2);
    const h = Math.min(canvas.height - y0, Math.max(...ys) - Math.min(...ys) + pad * 2);
    const c2 = createCanvas(Math.ceil(w), Math.ceil(h));
    const g = c2.getContext("2d");
    g.drawImage(canvas, x0, y0, w, h, 0, 0, w, h);
    g.fillStyle = "rgba(0,0,0,0.78)";
    g.fillRect(0, 0, Math.ceil(w), 34);
    g.fillStyle = "#fff";
    g.font = "bold 17px sans-serif";
    g.fillText(`ROOM ${r.id} — proposed seed (${r.userX.toFixed(1)}, ${r.userY.toFixed(1)}) · flooded ${r.areaPt2.toFixed(0)} pt²`, 10, 23);
    writeFileSync(join(outDir, `va-seed-${r.id}.png`), c2.toBuffer("image/png"));
  }
}

function marker(ctx, x, y, color, label) {
  ctx.beginPath(); ctx.arc(x, y, 13, 0, Math.PI * 2);
  ctx.fillStyle = "#fff"; ctx.fill();
  ctx.lineWidth = 4; ctx.strokeStyle = color; ctx.stroke();
  ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
  ctx.font = "bold 20px sans-serif";
  ctx.lineWidth = 4; ctx.strokeStyle = "#fff";
  ctx.strokeText(label, x + 18, y + 7);
  ctx.fillStyle = color; ctx.fillText(label, x + 18, y + 7);
}
