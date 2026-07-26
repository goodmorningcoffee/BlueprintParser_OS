// ADOPTED into the repo 2026-07-26 (PLAN §5 phase 0 item 3). Behaviour unchanged; the only
// edit is path resolution — the original hardcoded absolute paths, which is the workspace's
// recurring silent-failure bug class. See ./_paths.mjs.
// R2 PHYSICS PROBE — is the "dedicated offscreen render ~2.2 s, FLAT in mask dim"
// constant (J3 M-6 / C4 / E10, carried into the plan's §7 constants) measuring the
// RENDER, or is it measuring a content-stream parse that BP2's viewer has already
// paid for the display intent?
//
// pdf.js keys intentStates by renderingIntent (+annotationMode), NOT by viewport
// (pdf.mjs getRenderingIntent / cacheKey). So a SECOND page.render() at a different
// scale should reuse the parsed op list. If that is true, the incremental cost of a
// dedicated mask-scale render in the app is PAINT ONLY, and the design's "the render
// is the expensive half" ordering premise is measured against the wrong number.
//
//   node render-warm.mjs <pdf> [page]
import { readFileSync } from "node:fs";
import { loadPdfjs, loadEngine, loadCanvas, enginePath, densityFixture } from "./_paths.mjs";
const pdfjs = await loadPdfjs();
const { createCanvas } = await loadCanvas();
const file = process.argv[2], pageNo = Number(process.argv[3] ?? 1);
const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(file)) }).promise;
const page = await doc.getPage(pageNo);
const vp1 = page.getViewport({ scale: 1 });
console.log(`page ${pageNo}  ${vp1.width.toFixed(0)}x${vp1.height.toFixed(0)}pt`);

const renderAt = async (dim) => {
  const ws = Math.min(1, dim / Math.max(vp1.width, vp1.height));
  const vp = page.getViewport({ scale: ws });
  const mw = Math.ceil(vp.width), mh = Math.ceil(vp.height);
  const cv = createCanvas(mw, mh), ctx = cv.getContext("2d");
  const t = performance.now();
  await page.render({ canvasContext: ctx, viewport: vp, background: "#ffffff" }).promise;
  return { ms: performance.now() - t, mw, mh };
};

// 1. the COLD render — what J3's probe measured (parse + paint, one sample)
const cold = await renderAt(1500);
console.log(`COLD first render @1500 (parse+paint): ${cold.ms.toFixed(0)} ms  ${cold.mw}x${cold.mh}`);

// 2. WARM renders — the display intentState now exists, so this is PAINT ONLY.
//    This is the model that matches the app: the viewer has already display-rendered
//    the page the user is clicking on.
for (const dim of [1000, 1500, 2000, 3000, 4000]) {
  const a = await renderAt(dim), b = await renderAt(dim);
  console.log(`WARM render @${String(dim).padEnd(4)} -> ${String(a.mw + "x" + a.mh).padEnd(10)} ${a.ms.toFixed(0)} / ${b.ms.toFixed(0)} ms   (Mpx=${(a.mw * a.mh / 1e6).toFixed(1)})`);
}

// 3. proof the reuse is the intent cache, not luck: cleanup() drops intentStates,
//    so the next render must pay the parse again.
const dropped = page.cleanup();
const afterClean = await renderAt(1500);
console.log(`page.cleanup()=${dropped}; next render @1500: ${afterClean.ms.toFixed(0)} ms  <- back to COLD if the reuse was the intent cache`);
const again = await renderAt(1500);
console.log(`and the one after that:                 ${again.ms.toFixed(0)} ms`);
await doc.destroy();
