import type { ClientAnnotation, LinearPolylineData } from "@/types";

type LinearPolylineAnnotation = Pick<ClientAnnotation, "id" | "source" | "data">;

export interface LinearPolylineSelection {
  readonly isSelected: (annotationId: number) => boolean;
}

export interface DrawLinearPolylinesProps {
  readonly annotations: readonly LinearPolylineAnnotation[];
  readonly width: number;
  readonly height: number;
  readonly selectedId: number | null;
  readonly hiddenTakeoffItemIds: ReadonlySet<number>;
  readonly selection: LinearPolylineSelection;
}

/**
 * Draw the completed linear-polyline stage. The caller owns canvas setup and stage order.
 */
export function drawLinearPolylines(
  ctx: CanvasRenderingContext2D,
  {
    annotations,
    width,
    height,
    selectedId,
    hiddenTakeoffItemIds,
    selection,
  }: DrawLinearPolylinesProps,
): void {
  for (const ann of annotations) {
    if (ann.source !== "takeoff" || ann.data?.type !== "linear-polyline") continue;
    const data = ann.data as unknown as LinearPolylineData;
    if (hiddenTakeoffItemIds.has(data.takeoffItemId)) continue;
    if (!data.vertices || data.vertices.length < 2) continue;

    ctx.save();
    // Stroke connected line segments (no fill, no closePath)
    ctx.strokeStyle = data.color;
    ctx.lineWidth = ann.id === selectedId ? 3 : 2;
    ctx.beginPath();
    ctx.moveTo(data.vertices[0].x * width, data.vertices[0].y * height);
    for (let i = 1; i < data.vertices.length; i++) {
      ctx.lineTo(data.vertices[i].x * width, data.vertices[i].y * height);
    }
    ctx.stroke();

    // Vertices when selected
    if (ann.id === selectedId || selection.isSelected(ann.id)) {
      for (const v of data.vertices) {
        ctx.fillStyle = data.color;
        ctx.beginPath();
        ctx.arc(v.x * width, v.y * height, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // Total length label at last vertex
    const lastV = data.vertices[data.vertices.length - 1];
    const lx = lastV.x * width;
    const ly = lastV.y * height;
    const labelText = data.totalLength > 0
      ? `${data.totalLength.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${data.unit}`
      : `-- ${data.unit}`;
    ctx.font = "bold 11px sans-serif";
    const tw = ctx.measureText(labelText).width;
    ctx.fillStyle = "rgba(0,0,0,0.75)";
    ctx.fillRect(lx + 6, ly - 7, tw + 8, 16);
    ctx.fillStyle = data.color;
    ctx.fillText(labelText, lx + 10, ly + 5);
    ctx.restore();
  }
}
