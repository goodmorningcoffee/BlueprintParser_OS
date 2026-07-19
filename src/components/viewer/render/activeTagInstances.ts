type NormalizedMinMaxBoundingBox = readonly [number, number, number, number];

export interface ActiveTagInstanceRenderData {
  readonly annotationId: number;
  readonly bbox: NormalizedMinMaxBoundingBox;
}

export interface ActiveTagRenderData {
  readonly id: string;
  readonly color?: string;
  readonly name: string;
  readonly tagText: string;
}

export interface ActiveTagInstanceLookup {
  get(id: string): readonly ActiveTagInstanceRenderData[] | undefined;
}

export interface DrawActiveTagInstancesProps {
  readonly activeTag: ActiveTagRenderData | null | undefined;
  readonly pageTagInstances: ActiveTagInstanceLookup;
  readonly width: number;
  readonly height: number;
}

/**
 * Draw free-floating instances for the active tag. The caller owns stage order.
 */
export function drawActiveTagInstances(
  ctx: CanvasRenderingContext2D,
  {
    activeTag,
    pageTagInstances,
    width,
    height,
  }: DrawActiveTagInstancesProps,
): void {
  if (activeTag) {
    const activeTagPageInsts = pageTagInstances.get(activeTag.id) || [];
    for (const inst of activeTagPageInsts) {
      if (inst.annotationId !== -1) continue;
      const [bMinX, bMinY, bMaxX, bMaxY] = inst.bbox;
      const fx = bMinX * width;
      const fy = bMinY * height;
      const fw = (bMaxX - bMinX) * width;
      const fh = (bMaxY - bMinY) * height;
      ctx.fillStyle = "#ff00ff40"; // magenta fill
      ctx.fillRect(fx, fy, fw, fh);
      ctx.strokeStyle = activeTag.color || "#22d3ee";
      ctx.lineWidth = 3;
      ctx.strokeRect(fx, fy, fw, fh);
      // Label
      const tagLabel = activeTag.name || activeTag.tagText;
      ctx.font = "bold 11px sans-serif";
      const tlw = ctx.measureText(tagLabel).width;
      ctx.fillStyle = (activeTag.color || "#22d3ee") + "dd";
      ctx.fillRect(fx, fy + fh + 1, tlw + 6, 14);
      ctx.fillStyle = "#000";
      ctx.fillText(tagLabel, fx + 3, fy + fh + 12);
    }
  }
}
