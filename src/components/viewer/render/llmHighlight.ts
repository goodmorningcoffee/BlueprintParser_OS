type NormalizedBoundingBox = readonly [number, number, number, number];

export interface LlmHighlightRenderData {
  readonly pageNumber: number;
  readonly bbox: NormalizedBoundingBox;
  readonly label?: string;
}

export interface DrawLlmHighlightProps {
  readonly llmHighlight: LlmHighlightRenderData | null;
  readonly pageNumber: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Draw the current LLM tool-use highlight. The caller owns canvas setup and stage order.
 */
export function drawLlmHighlight(
  ctx: CanvasRenderingContext2D,
  {
    llmHighlight,
    pageNumber,
    width,
    height,
  }: DrawLlmHighlightProps,
): void {
  if (llmHighlight && llmHighlight.pageNumber === pageNumber) {
    const [hMinX, hMinY, hMaxX, hMaxY] = llmHighlight.bbox;
    const hx = hMinX * width, hy = hMinY * height;
    const hw = (hMaxX - hMinX) * width, hh = (hMaxY - hMinY) * height;
    ctx.strokeStyle = "#22d3ee";
    ctx.lineWidth = 3;
    ctx.setLineDash([8, 4]);
    ctx.strokeRect(hx, hy, hw, hh);
    ctx.setLineDash([]);
    ctx.fillStyle = "#22d3ee20";
    ctx.fillRect(hx, hy, hw, hh);
    if (llmHighlight.label) {
      ctx.font = "bold 12px sans-serif";
      const tw = ctx.measureText(llmHighlight.label).width;
      ctx.fillStyle = "#22d3eedd";
      ctx.fillRect(hx, hy - 18, tw + 8, 16);
      ctx.fillStyle = "#000";
      ctx.fillText(llmHighlight.label, hx + 4, hy - 5);
    }
  }
}
