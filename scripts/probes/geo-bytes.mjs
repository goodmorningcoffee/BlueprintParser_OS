// ADOPTED into the repo 2026-07-26 (PLAN §5 phase 0 item 3). Behaviour unchanged; the only
// edit is path resolution — the original hardcoded absolute paths, which is the workspace's
// recurring silent-failure bug class. See ./_paths.mjs.
// R2 probe: what does the CACHED VectorGeometry actually weigh, term by term?
import { readFileSync } from "node:fs";
import { loadPdfjs, loadEngine, loadCanvas, enginePath, densityFixture } from "./_paths.mjs";
const oc = await loadEngine();
const pdfjs = await loadPdfjs();
const settle = async () => { for (let i=0;i<4;i++){ global.gc(); await new Promise(r=>setTimeout(r,30)); } };
const H = () => process.memoryUsage().heapUsed/1048576;
const doc = await pdfjs.getDocument({data:new Uint8Array(readFileSync(process.argv[2])), isEvalSupported:false}).promise;
const page = await doc.getPage(1); const vp = page.getViewport({scale:2});
let ol = await page.getOperatorList();
let geo = oc.extractVectorGeometry(ol, vp.transform, pdfjs.OPS);
ol = null; page.cleanup();
await settle(); const all = H();
let keepSegs = geo.segs, keepMeta = geo.meta, keepPts = geo.points;
geo = null; await settle(); const afterGeoObj = H();
keepPts = null; await settle(); const noPoints = H();
keepSegs = null; await settle(); const noSegs = H();
keepMeta = null; await settle(); const nothing = H();
console.log(`held: segs+points+meta = ${(all-nothing).toFixed(1)} MB`);
console.log(`  points[] (${104218} Point tuples) costs ${(afterGeoObj-noPoints).toFixed(1)} MB`);
console.log(`  segs[]   (JS number[])          costs ${(noPoints-noSegs).toFixed(1)} MB`);
console.log(`  meta     (Uint8Array)           costs ${(noSegs-nothing).toFixed(1)} MB`);
await doc.destroy();
