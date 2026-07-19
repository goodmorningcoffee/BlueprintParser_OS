type NormalizedBoundingBox = readonly [number, number, number, number];

export interface TableTagViewRenderData {
  readonly pageNum: number;
  readonly bbox: NormalizedBoundingBox;
  readonly tagTexts: readonly string[];
  readonly source: "schedule" | "keynote";
}

export interface TableTagMatch {
  readonly id: string;
}

export interface TableTagInstance {
  readonly bbox: NormalizedBoundingBox;
}

export interface DrawTableTagViewsProps {
  readonly activeTableTagViews: Readonly<Record<string, TableTagViewRenderData>>;
  readonly pageNumber: number;
  readonly width: number;
  readonly height: number;
  readonly tagTextIndex: ReadonlyMap<string, TableTagMatch>;
  readonly pageTagInstances: ReadonlyMap<string, readonly TableTagInstance[]>;
}

/**
 * Draw active table/keynote regions and their mapped tag instances.
 * The caller owns canvas setup and stage order.
 */
export function drawTableTagViews(
  ctx: CanvasRenderingContext2D,
  {
    activeTableTagViews,
    pageNumber,
    width,
    height,
    tagTextIndex,
    pageTagInstances,
  }: DrawTableTagViewsProps,
): void {
  if (Object.keys(activeTableTagViews).length > 0) {
    const tableTagViews = activeTableTagViews;
    for (const view of Object.values(tableTagViews)) {
      // 1. Blue translucent highlight over the table/keynote region (on the region's page)
      if (view.pageNum === pageNumber) {
        const [bMinX, bMinY, bMaxX, bMaxY] = view.bbox;
        const bx = bMinX * width, by = bMinY * height;
        const bw = (bMaxX - bMinX) * width, bh = (bMaxY - bMinY) * height;
        ctx.fillStyle = "rgba(59, 130, 246, 0.08)";
        ctx.strokeStyle = "rgba(59, 130, 246, 0.3)";
        ctx.lineWidth = 1.5;
        ctx.fillRect(bx, by, bw, bh);
        ctx.strokeRect(bx, by, bw, bh);
      }
      // 2. Magenta padded highlights for each mapped tag instance on this page
      const pad = 3; // padding in canvas pixels
      for (const tagText of view.tagTexts) {
        const matchingTag = tagTextIndex.get(`${tagText}:${view.source}`);
        if (!matchingTag) continue;
        const tagPageInsts = pageTagInstances.get(matchingTag.id) || [];
        for (const inst of tagPageInsts) {
          const [iMinX, iMinY, iMaxX, iMaxY] = inst.bbox;
          const ix = iMinX * width - pad, iy = iMinY * height - pad;
          const iw = (iMaxX - iMinX) * width + pad * 2, ih = (iMaxY - iMinY) * height + pad * 2;
          ctx.fillStyle = "#ff00ff25";
          ctx.strokeStyle = "#ff00ff";
          ctx.lineWidth = 1.5;
          ctx.fillRect(ix, iy, iw, ih);
          ctx.strokeRect(ix, iy, iw, ih);
          // Tag text label below the instance
          ctx.font = "bold 9px sans-serif";
          const label = tagText;
          const tw = ctx.measureText(label).width;
          ctx.fillStyle = "#ff00ffcc";
          ctx.fillRect(ix, iy + ih + 1, tw + 6, 12);
          ctx.fillStyle = "#fff";
          ctx.fillText(label, ix + 3, iy + ih + 10);
        }
      }
    }
  }
}
