import type { ClientAnnotation } from "@/types";

type GroupRingAnnotation = Pick<ClientAnnotation, "id" | "bbox">;

export interface DrawGroupRingsProps {
  readonly annotations: readonly GroupRingAnnotation[];
  readonly width: number;
  readonly height: number;
  readonly getGroupOutlineColor: (annotationId: number) => string | null;
}

/**
 * Draw the final group-membership ring stage. The caller owns stage order and canvas setup; this
 * helper preserves the existing per-row save/restore boundary and source-array iteration order.
 */
export function drawGroupRings(
  ctx: CanvasRenderingContext2D,
  {
    annotations,
    width,
    height,
    getGroupOutlineColor,
  }: DrawGroupRingsProps,
): void {
  // Uses ann.bbox so every annotation type (bbox / polygon / polyline /
  // count-marker) gets a consistent ring. Inactive groups are filtered
  // upstream in useMultiSelectInteraction (getGroupOutlineColor returns
  // null for them).
  for (const ann of annotations) {
    const groupColor = getGroupOutlineColor(ann.id);
    if (!groupColor) continue;
    const [minX, minY, maxX, maxY] = ann.bbox;
    const x = minX * width;
    const y = minY * height;
    const w = (maxX - minX) * width;
    const h = (maxY - minY) * height;
    ctx.save();
    ctx.strokeStyle = groupColor;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 2]);
    ctx.strokeRect(x - 2, y - 2, w + 4, h + 4);
    ctx.restore();
  }
}
