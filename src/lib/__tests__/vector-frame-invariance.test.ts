// @vitest-environment node
/**
 * FRAME INVARIANCE — the same room must measure the same area regardless of how the page frame
 * is described.
 *
 * A PDF can present identical geometry under /Rotate 0/90/180/270, with a CropBox that differs
 * from the MediaBox, or with a UserUnit other than 1. pdf.js folds all of that into
 * `viewport.transform`, and `extractVectorGeometry` consumes that transform — so if the chain is
 * right, the measured square footage does not move. If it is wrong, the number is confidently
 * wrong on a whole class of real drawings, and nothing else in the suite would notice.
 *
 * PDFs are built here with pdf-lib rather than loaded from disk: the generated fixture corpus
 * lives under the gitignored `test/fixtures/`, so a test depending on it would pass locally and
 * fail on a fresh clone.
 *
 * ── ONE THING THIS TEST DELIBERATELY DOES NOT ASSERT ────────────────────────────────────
 * Scale invariance is NOT a property of this engine below mask saturation, and asserting it would
 * be asserting a falsehood. `buildMask` uses `ws = min(1, maskDim / max(imgW, imgH))` — it never
 * upscales — and burns every wall as a ONE-mask-pixel line. So the flood stops one mask px inside
 * the centreline and the inset in points is `2 / (mask px per pt)`. Extract at a low scale and the
 * mask is coarse and the area reads small; extract at a scale that saturates `maskDim` and it
 * converges. Phase 0 measured exactly this: −2.184 / −1.095 / −0.548 / −0.416 % at 0.5 / 1 / 2 /
 * 2.451 mask px per pt, successive ratios ≈ 2.00.
 *
 * Frames are therefore compared at a single canonical scale (the product's own model: extract
 * once, at a scale that saturates the mask), and the scale behaviour is asserted as CONVERGENCE
 * rather than invariance.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { PDFDocument, rgb, degrees } from "pdf-lib";
import { extractVectorGeometry } from "@/lib/oneclick/oneclick";
import { vectorBucketFill } from "@/lib/bucket-fill-vector-adapter";

// Loaded dynamically so the heavyweight legacy build is only pulled in for this suite.
let pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs");
beforeAll(async () => {
  pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
});

const PAGE_W = 600;
const PAGE_H = 400;
const MASK_DIM = 3000;

/** Room in PDF user space: 200 x 150 pt = 12.5% of the sheet, well under LEAK_FRACTION (0.30). */
const R = { x0: 100, y0: 100, x1: 300, y1: 250 };
const ROOM_AREA_PT2 = (R.x1 - R.x0) * (R.y1 - R.y0); // 30,000
/** Room centre, in USER space — frame-independent by construction. */
const SEED_USER = { x: (R.x0 + R.x1) / 2, y: (R.y0 + R.y1) / 2 };

interface Frame {
  name: string;
  rotate?: 0 | 90 | 180 | 270;
  cropBox?: { x: number; y: number; w: number; h: number };
  userUnit?: number;
}

async function makePdf(frame: Frame): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([PAGE_W, PAGE_H]);
  const black = rgb(0, 0, 0);
  const line = (x1: number, y1: number, x2: number, y2: number) =>
    page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 2, color: black });
  line(R.x0, R.y0, R.x1, R.y0);
  line(R.x1, R.y0, R.x1, R.y1);
  line(R.x1, R.y1, R.x0, R.y1);
  line(R.x0, R.y1, R.x0, R.y0);

  if (frame.rotate) page.setRotation(degrees(frame.rotate));
  if (frame.cropBox) page.setCropBox(frame.cropBox.x, frame.cropBox.y, frame.cropBox.w, frame.cropBox.h);
  if (frame.userUnit) {
    // pdf-lib has no UserUnit helper; set it on the page dict directly.
    const { PDFName, PDFNumber } = await import("pdf-lib");
    page.node.set(PDFName.of("UserUnit"), PDFNumber.of(frame.userUnit));
  }
  return doc.save();
}

/** Measure the room, returning absolute pt² — the frame-independent quantity. */
async function measure(bytes: Uint8Array, scale: number): Promise<number | null> {
  // ⚠ COPY. pdf.js takes OWNERSHIP of the `data` buffer and detaches it, so passing the same
  // Uint8Array to a second getDocument fails with "Unable to deserialize cloned data" — which is
  // how the convergence test below first failed. Measured, not guessed.
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
  try {
    const page = await doc.getPage(1);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale });
    const geo = extractVectorGeometry(await page.getOperatorList(), vp.transform, pdfjs.OPS);

    // Seed carried in USER space and mapped through the SAME transform the geometry used. A
    // device-space seed would drift on a rotated page and turn a frame bug into a moved click.
    const [dx, dy] = pdfjs.Util.applyTransform([SEED_USER.x, SEED_USER.y], vp.transform);

    const r = vectorBucketFill({
      geo,
      imgW: vp.width,
      imgH: vp.height,
      seedX: dx / vp.width,
      seedY: dy / vp.height,
      maskDimension: MASK_DIM,
    });
    if (r.type !== "result") return null;
    // areaFraction is a fraction of the page; multiply by the page's own pt² to compare frames
    // whose page dimensions differ (a CropBox variant is a smaller sheet).
    return r.areaFraction! * vp1.width * vp1.height;
  } finally {
    await doc.destroy();
  }
}

/** Scale at which the mask saturates for this page — the product's canonical extraction scale. */
const CANONICAL = MASK_DIM / Math.max(PAGE_W, PAGE_H); // 5

describe("frame invariance — /Rotate", () => {
  it.each([0, 90, 180, 270] as const)("measures the same room under /Rotate %i", async (rotate) => {
    const base = await measure(await makePdf({ name: "base" }), CANONICAL);
    const rot = await measure(await makePdf({ name: `rot${rotate}`, rotate }), CANONICAL);
    expect(base).not.toBeNull();
    expect(rot).not.toBeNull();
    // Within 0.5%: rotation re-quantises the mask grid relative to the room, so a fraction of a
    // mask pixel of difference is expected and physical. A frame BUG is orders of magnitude
    // larger — a swapped axis reads as a different room entirely.
    expect(rot!).toBeGreaterThan(base! * 0.995);
    expect(rot!).toBeLessThan(base! * 1.005);
  });

  it("lands on the true centreline area, not merely self-consistently", async () => {
    // Self-consistency across frames would also hold if every frame were wrong the same way.
    const a = await measure(await makePdf({ name: "base" }), CANONICAL);
    expect(a).not.toBeNull();
    expect(a!).toBeGreaterThan(ROOM_AREA_PT2 * 0.99);
    expect(a!).toBeLessThanOrEqual(ROOM_AREA_PT2);
  });
});

describe("frame invariance — CropBox != MediaBox", () => {
  it("measures the same room when the CropBox is offset and smaller", async () => {
    const base = await measure(await makePdf({ name: "base" }), CANONICAL);
    // Crop tightly around the room but not through it.
    const cropped = await makePdf({
      name: "crop",
      cropBox: { x: 50, y: 50, w: 500, h: 320 },
    });
    // The crop changes the page size, so the canonical scale changes with it.
    const got = await measure(cropped, MASK_DIM / 500);
    expect(base).not.toBeNull();
    expect(got).not.toBeNull();
    expect(got!).toBeGreaterThan(base! * 0.99);
    expect(got!).toBeLessThan(base! * 1.01);
  });
});

describe("scale behaviour — convergence, NOT invariance", () => {
  it("converges upward toward the centreline area as the mask resolves finer", async () => {
    // Asserting invariance here would assert a falsehood: the inset is a fixed 1 mask px per
    // side, so a coarser mask reads systematically SMALL. What must hold is monotone convergence.
    const bytes = await makePdf({ name: "base" });
    const areas: number[] = [];
    for (const s of [0.5, 1, 2.37, CANONICAL]) {
      const a = await measure(bytes, s);
      expect(a).not.toBeNull();
      areas.push(a!);
    }
    for (let i = 1; i < areas.length; i++) {
      expect(areas[i]).toBeGreaterThanOrEqual(areas[i - 1] * 0.999);
    }
    // And every one of them undershoots the centreline truth — never overshoots.
    for (const a of areas) expect(a).toBeLessThanOrEqual(ROOM_AREA_PT2 * 1.001);
    // The coarsest is meaningfully worse than the finest; if it were not, this test would be
    // measuring nothing.
    expect(areas[areas.length - 1] - areas[0]).toBeGreaterThan(0);
  });
});

describe("UserUnit — honoured, and therefore NOT invariant", () => {
  /**
   * ⚠ THIS TEST WAS WRITTEN ASSERTING THE OPPOSITE AND FAILED. The first version claimed pdf.js
   * ignores UserUnit — it does not. MEASURED: a 600x400 MediaBox with UserUnit 2 reports a
   * 1200x800 viewport at scale 1, so the same linework measures UserUnit² = 4x the area.
   *
   * That is CORRECT, not a bug: UserUnit declares how many default user-space units one PDF unit
   * represents, so such a sheet genuinely is physically larger. It is recorded here because
   * "frame invariance" is the wrong expectation for this one field — the area SHOULD move — and
   * because anything downstream that assumes viewport dimensions equal MediaBox points would be
   * wrong by a factor of UserUnit² on these sheets.
   */
  it("scales measured area by UserUnit², because pdf.js applies it to the viewport", async () => {
    const base = await measure(await makePdf({ name: "base" }), CANONICAL);
    // The page is 2x larger in each dimension, so its canonical scale halves.
    const uu = await measure(await makePdf({ name: "uu", userUnit: 2 }), CANONICAL / 2);
    expect(base).not.toBeNull();
    expect(uu).not.toBeNull();
    expect(uu! / base!).toBeGreaterThan(3.9);
    expect(uu! / base!).toBeLessThan(4.1);
  });

  it("reports the viewport pdf.js actually builds, so the factor is traceable", async () => {
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(await makePdf({ name: "uu", userUnit: 2 })),
      isEvalSupported: false,
    }).promise;
    try {
      const vp = (await doc.getPage(1)).getViewport({ scale: 1 });
      expect(vp.width).toBeCloseTo(PAGE_W * 2, 3);
      expect(vp.height).toBeCloseTo(PAGE_H * 2, 3);
    } finally {
      await doc.destroy();
    }
  });
});
