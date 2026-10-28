// @vitest-environment node
// [table pipeline WP-3.B] Server half of the column work: the printed-title band (deriveName, server-only by
// E-8), the crop-rulings runner (`detect_table_lines.py --crop`, K16; subprocess injected) and the K70
// img2table rotation guard. Synthetic words only.
import { describe, expect, it } from "vitest";
import { deriveTitle } from "@/server/services/parse-engine/title";
import { cropRulingsArgs, detectCropRulings, img2tableSkipReason, type RunPython } from "@/server/services/parse-engine/rulings";
import type { ColWord } from "@/lib/parse-engine/cells";
import type { BboxMinMax } from "@/lib/parse-engine/types";

const w = (t: string, x0: number, y0: number, h = 0.008): ColWord => ({ t, b: [x0, y0, x0 + 0.006 * t.length, y0 + h] as BboxMinMax });
const BOX: BboxMinMax = [0.1, 0.1, 0.5, 0.3];
const header = [w("MARK", 0.11, 0.13), w("WIDTH", 0.2, 0.13), w("HEIGHT", 0.3, 0.13), w("REMARKS", 0.4, 0.13)];
const body = [0, 1, 2].flatMap((i) => [w(`D${i + 1}`, 0.11, 0.15 + i * 0.02), w("3", 0.2, 0.15 + i * 0.02), w("7", 0.3, 0.15 + i * 0.02)]);

describe("deriveTitle", () => {
  it("a title line in the box's header band (tall, keyword) → header-band, with its bottom for the header skip", () => {
    const words = [w("DOOR", 0.2, 0.102, 0.012), w("SCHEDULE", 0.25, 0.102, 0.012), ...header, ...body];
    const pick = deriveTitle(words, BOX);
    expect(pick.title).toMatchObject({ text: "DOOR SCHEDULE", src: "header-band" });
    expect(pick.title!.conf).toBeGreaterThanOrEqual(0.7);
    expect(pick.titleBottom).toBeCloseTo(0.114, 9);
  });

  it("a title just above the box → above, no skip", () => {
    const words = [w("FINISH", 0.2, 0.087), w("LEGEND", 0.26, 0.087), ...header, ...body];
    const pick = deriveTitle(words, BOX);
    expect(pick.title).toMatchObject({ text: "FINISH LEGEND", src: "above" });
    expect(pick.titleBottom).toBeNull();
  });

  it("falls back to the proposal's name, else no title", () => {
    const words = [...body];
    expect(deriveTitle(words, BOX, { proposal: { title: "Schedule", p: 0.62 } })).toEqual({ title: { text: "Schedule", src: "proposal", conf: 0.62 }, titleBottom: null });
    expect(deriveTitle([], BOX)).toEqual({ titleBottom: null });
  });

  it("a column-header row named as the title is never skipped (many segments)", () => {
    const words = [w("KEY", 0.11, 0.13), w("NOTES", 0.3, 0.13), w("LIST", 0.42, 0.13), ...body];
    const pick = deriveTitle(words, BOX);
    expect(pick.title).toMatchObject({ text: "KEY NOTES LIST", src: "header-band" });
    expect(pick.titleBottom).toBeNull();
  });
});

describe("crop rulings", () => {
  it("passes the crop and only the overrides given", () => {
    expect(cropRulingsArgs("s.py", "i.png", [0.1, 0.2, 0.3, 0.4])).toEqual(["s.py", "i.png", "--crop", "0.1,0.2,0.3,0.4"]);
    expect(cropRulingsArgs("s.py", "i.png", [0.1, 0.2, 0.3, 0.4], { minVLength: 0.5, tolerance: 4 }))
      .toEqual(["s.py", "i.png", "--crop", "0.1,0.2,0.3,0.4", "--min-v-length", "0.5", "--tolerance", "4"]);
  });

  it("parses the script's output (crop-normalised positions + the whole-pixel crop)", async () => {
    let seen: readonly string[] = [];
    const run: RunPython = async (args) => {
      seen = args;
      return JSON.stringify({ rows: [{ y: 0, height: 0.5 }, { y: 0.5, height: 0.5 }], cols: [{ x: 0.25, width: 0.75 }], confidence: 0.42, crop: [0.1, 0.2, 0.3, 0.4] });
    };
    const r = await detectCropRulings(Buffer.from("png"), [0.1, 0.2, 0.3, 0.4], {}, { run, scriptPath: "s.py" });
    expect(r).toEqual({ rows: [0, 0.5], cols: [0.25], confidence: 0.42, crop: [0.1, 0.2, 0.3, 0.4] });
    expect(seen[0]).toBe("s.py");
    expect(seen.slice(2)).toEqual(["--crop", "0.1,0.2,0.3,0.4"]);
  });

  it("never throws: script errors, a failed run and an invalid crop come back as `error`", async () => {
    const bad: RunPython = async () => JSON.stringify({ error: "Failed to load image", rows: [], cols: [] });
    expect((await detectCropRulings(Buffer.from(""), [0, 0, 1, 1], {}, { run: bad })).error).toBe("Failed to load image");
    const boom: RunPython = async () => { throw new Error("timeout"); };
    expect((await detectCropRulings(Buffer.from(""), [0, 0, 1, 1], {}, { run: boom })).error).toBe("timeout");
    expect((await detectCropRulings(Buffer.from(""), [0.5, 0, 0.4, 1])).error).toBe("invalid crop");
  });
});

describe("img2tableSkipReason (K70)", () => {
  it("skips a rotated page, runs an unrotated or un-censused one", () => {
    expect(img2tableSkipReason({ rotation: 90 })).toMatch(/rotated 90/);
    expect(img2tableSkipReason({ rotation: -90 })).toMatch(/rotated -90/);
    expect(img2tableSkipReason({ rotation: 270 })).toMatch(/K70/);
    expect(img2tableSkipReason({ rotation: 0 })).toBeNull();
    expect(img2tableSkipReason({ rotation: 360 })).toBeNull();
    expect(img2tableSkipReason(null)).toBeNull();
    expect(img2tableSkipReason({})).toBeNull();
    expect(img2tableSkipReason({ rotation: "90" })).toBeNull();
  });
});
