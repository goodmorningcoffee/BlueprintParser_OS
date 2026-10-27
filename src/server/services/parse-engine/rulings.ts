/**
 * Crop rulings + the img2table rotation guard (table pipeline WP-3.B; PLAN §1.3 E-3 `standard` budget,
 * §1.4; K16, K70). Server-only (runs Python).
 *
 * K16: the classic opencv-lines method rasterises the WHOLE page and runs `detect_table_lines.py` on it, so
 * its length thresholds are page-relative and it keeps the first 20 columns / 50 rows of the SHEET. Here
 * the caller passes the page image it already has (the run service, WP-3.E, owns where it comes from and
 * the crop cache) and the parse box; the script cuts the box out itself (`--crop x0,y0,x1,y1`, normalised
 * page coordinates) and uses crop-relative thresholds. Positions come back normalised to the crop;
 * `cols/rulings.ts` `rulingsHypothesis` maps them onto the page. Nothing here re-rasterises.
 *
 * Heavy work: callers run this BEFORE any project write (PLAN §1.6 rule 11), never inside `withProjectWrite`.
 *
 * K70: img2table's PDF mode scales the crop by the unrotated MediaBox but clips in rotated CropBox space, so
 * on a rotated page it reads the wrong area. `img2tableSkipReason` is the guard the run service checks
 * before calling img2table: a page whose census rotation (`pageIntelligence.channels.rotation`) is not a
 * multiple of 360 is skipped. CropBox ≠ MediaBox is NOT stored anywhere (MEASURED: `PageChannelsRecord`
 * holds `widthPt`/`heightPt`/`rotation` only), so that half of K70 stays open; a page without a census
 * record runs as today.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BboxMinMax } from "@/lib/parse-engine/types";
import type { CropRulings } from "@/lib/parse-engine/types-cols";

export const CROP_RULINGS_TIMEOUT_MS = 60_000;
const STDOUT_CAP = 10 * 1024 * 1024;

export interface CropRulingsOptions {
  minHLength?: number;
  minVLength?: number;
  tolerance?: number;
  timeoutMs?: number;
}

/** The subprocess runner (injectable for tests). Resolves with stdout; rejects on a non-zero exit or timeout. */
export type RunPython = (args: readonly string[], timeoutMs: number) => Promise<string>;

const defaultRun: RunPython = (args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile("python3", [...args], { timeout: timeoutMs, maxBuffer: STDOUT_CAP }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });

/** `detect_table_lines.py` arguments for a crop (exported for tests). */
export function cropRulingsArgs(scriptPath: string, imagePath: string, crop: BboxMinMax, opts: CropRulingsOptions = {}): string[] {
  const args = [scriptPath, imagePath, "--crop", crop.map((v) => String(v)).join(",")];
  if (opts.minHLength != null) args.push("--min-h-length", String(opts.minHLength));
  if (opts.minVLength != null) args.push("--min-v-length", String(opts.minVLength));
  if (opts.tolerance != null) args.push("--tolerance", String(opts.tolerance));
  return args;
}

const validCrop = (b: BboxMinMax): boolean =>
  b.every((v) => Number.isFinite(v) && v >= 0 && v <= 1) && b[2] > b[0] && b[3] > b[1];

const nums = (xs: unknown, key: "x" | "y"): number[] =>
  Array.isArray(xs) ? xs.flatMap((e) => (e && typeof e === "object" && Number.isFinite((e as Record<string, unknown>)[key]) ? [(e as Record<string, number>)[key]] : [])) : [];

/** Ruled lines inside `crop` of a page image (PNG bytes). Never throws: a failure comes back as `error`. */
export async function detectCropRulings(
  pagePng: Buffer,
  crop: BboxMinMax,
  opts: CropRulingsOptions = {},
  deps: { run?: RunPython; scriptPath?: string } = {},
): Promise<CropRulings> {
  if (!validCrop(crop)) return { rows: [], cols: [], confidence: 0, error: "invalid crop" };
  const dir = await mkdtemp(join(tmpdir(), "bp2-rulings-"));
  try {
    const img = join(dir, "page.png");
    await writeFile(img, pagePng);
    const script = deps.scriptPath ?? join(process.cwd(), "scripts/detect_table_lines.py");
    const stdout = await (deps.run ?? defaultRun)(cropRulingsArgs(script, img, crop, opts), opts.timeoutMs ?? CROP_RULINGS_TIMEOUT_MS);
    const parsed = JSON.parse(stdout.trim() || "{}") as Record<string, unknown>;
    if (typeof parsed.error === "string") return { rows: [], cols: [], confidence: 0, error: parsed.error };
    const cut = parsed.crop;
    return {
      rows: nums(parsed.rows, "y"),
      cols: nums(parsed.cols, "x"),
      confidence: Number.isFinite(parsed.confidence) ? (parsed.confidence as number) : 0,
      ...(Array.isArray(cut) && cut.length === 4 && cut.every((v) => Number.isFinite(v)) ? { crop: cut.map(Number) as BboxMinMax } : {}),
    };
  } catch (err) {
    return { rows: [], cols: [], confidence: 0, error: err instanceof Error ? err.message.slice(0, 500) : "rulings failed" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** K70 guard: why img2table must not run on this page, or null when it may. */
export function img2tableSkipReason(channels: { rotation?: unknown } | null | undefined): string | null {
  const rot = channels?.rotation;
  if (typeof rot !== "number" || !Number.isFinite(rot)) return null;
  return ((rot % 360) + 360) % 360 === 0 ? null : `page rotated ${rot}° (K70: img2table clips in rotated CropBox space)`;
}
