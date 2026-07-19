type NormalizedMinMaxBoundingBox = readonly [number, number, number, number];

export interface VisibleTagInstanceRenderData {
  readonly bbox: NormalizedMinMaxBoundingBox;
  readonly color: string;
  readonly tier: "high" | "medium" | "low";
}

export interface DrawVisibleTagInstancesProps {
  readonly visibleTagInstances: readonly VisibleTagInstanceRenderData[];
  readonly width: number;
  readonly height: number;
}

/**
 * Draw visible non-active tag instances. The caller owns collection and stage order.
 */
export function drawVisibleTagInstances(
  ctx: CanvasRenderingContext2D,
  { visibleTagInstances, width, height }: DrawVisibleTagInstancesProps,
): void {
  for (const vi of visibleTagInstances) {
    const [bMinX, bMinY, bMaxX, bMaxY] = vi.bbox;
    const vx = bMinX * width;
    const vy = bMinY * height;
    const vw = (bMaxX - bMinX) * width;
    const vh = (bMaxY - bMinY) * height;
    ctx.strokeStyle = vi.color;
    ctx.lineWidth = vi.tier === "low" ? 1 : 1.5;
    // Low-tier instances get a tighter dash to visually distinguish audit-flagged
    // matches from normal hits. Medium + high share the standard dash.
    ctx.setLineDash(vi.tier === "low" ? [2, 4] : [4, 3]);
    ctx.strokeRect(vx, vy, vw, vh);
    ctx.setLineDash([]);
  }
}
