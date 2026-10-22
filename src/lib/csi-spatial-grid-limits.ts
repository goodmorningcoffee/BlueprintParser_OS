// CSI spatial heatmap grid bounds — shared by the admin picker and the pipeline-config PUT.
// csi-spatial.ts labels zones generically ("row R, col C") past 3x3, so any size in range works.

export const CSI_GRID_MIN = 1;
export const CSI_GRID_MAX = 27;
export const CSI_GRID_PRESETS = [3, 6, 9, 12, 15, 18, 21, 24, 27] as const;

export function isValidCsiGridDim(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= CSI_GRID_MIN && n <= CSI_GRID_MAX;
}

/** null when absent or valid; otherwise the validation message. */
export function csiGridError(grid: unknown): string | null {
  if (grid === undefined || grid === null) return null;
  const g = grid as { rows?: unknown; cols?: unknown };
  if (typeof grid !== "object" || !isValidCsiGridDim(g.rows) || !isValidCsiGridDim(g.cols)) {
    return `csiSpatialGrid rows and cols must be whole numbers from ${CSI_GRID_MIN} to ${CSI_GRID_MAX}`;
  }
  return null;
}
