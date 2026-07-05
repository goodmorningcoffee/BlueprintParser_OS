// [refactor jul4 S024] Template-region crop — extracted VERBATIM from the symbol-search
// route (old route.ts:122-138) so the python3/OpenCV subprocess is its own mockable seam.
// The DYNAMIC `await import("child_process")` is PRESERVED deliberately: vi.mock("child_process")
// intercepts dynamic imports, so the char test's mock block covers this seam identically to the
// legacy inline form. Args-array form (no string interpolation of user input) + the 10s timeout
// are load-bearing — do not "simplify" to exec().

/** Crop a pixel rect out of a source PNG into a destination PNG via python3/OpenCV. */
export async function cropTemplateRegion(args: {
  sourcePagePath: string;
  templatePath: string;
  x: number;
  y: number;
  w: number;
  h: number;
}): Promise<void> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);

  const cropScript = `
import cv2, json, sys
cfg = json.loads(sys.argv[1])
img = cv2.imread(cfg["src"])
crop = img[cfg["y"]:cfg["y"]+cfg["h"], cfg["x"]:cfg["x"]+cfg["w"]]
cv2.imwrite(cfg["dst"], crop)
`.trim();

  await execFileAsync("python3", [
    "-c", cropScript,
    JSON.stringify({
      src: args.sourcePagePath,
      dst: args.templatePath,
      x: args.x,
      y: args.y,
      w: args.w,
      h: args.h,
    }),
  ], { timeout: 10000 });
}
