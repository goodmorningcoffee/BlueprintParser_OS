import { polygonCentroid } from "@/lib/areaCalc";
import type { AreaPolygonData, ClientAnnotation } from "@/types";

type AreaPolygonAnnotation = Pick<ClientAnnotation, "id" | "source" | "data">;

export interface AreaPolygonSelection {
  readonly isSelected: (annotationId: number) => boolean;
}

export interface DrawAreaPolygonsProps {
  readonly annotations: readonly AreaPolygonAnnotation[];
  readonly width: number;
  readonly height: number;
  readonly selectedId: number | null;
  readonly hiddenTakeoffItemIds: ReadonlySet<number>;
  readonly selection: AreaPolygonSelection;
}

/**
 * Draw the completed area-polygon stage. The caller owns canvas setup and stage order.
 */
export function drawAreaPolygons(
  ctx: CanvasRenderingContext2D,
  {
    annotations,
    width,
    height,
    selectedId,
    hiddenTakeoffItemIds,
    selection,
  }: DrawAreaPolygonsProps,
): void {
  for (const ann of annotations) {
    if (ann.source !== "takeoff" || ann.data?.type !== "area-polygon") continue;
    const data = ann.data as unknown as AreaPolygonData;
    if (hiddenTakeoffItemIds.has(data.takeoffItemId)) continue;
    if (!data.vertices || data.vertices.length < 3) continue;

    // Holes (e.g., courtyards inside a U-shaped hallway). Rendered via
    // fill-rule="evenodd" as cutouts. Same pattern as DrawingPreviewLayer
    // so committed annotations match their pre-commit preview exactly.
    const holes = data.holes ?? [];

    ctx.save();
    // Fill — outer polygon + hole subpaths, evenodd rule for cutouts.
    // With no holes this is identical to the previous `fill()` behavior.
    ctx.fillStyle = data.color + "40";
    ctx.beginPath();
    ctx.moveTo(data.vertices[0].x * width, data.vertices[0].y * height);
    for (let i = 1; i < data.vertices.length; i++) {
      ctx.lineTo(data.vertices[i].x * width, data.vertices[i].y * height);
    }
    ctx.closePath();
    for (const hole of holes) {
      if (hole.vertices.length < 3) continue;
      ctx.moveTo(hole.vertices[0].x * width, hole.vertices[0].y * height);
      for (let i = 1; i < hole.vertices.length; i++) {
        ctx.lineTo(hole.vertices[i].x * width, hole.vertices[i].y * height);
      }
      ctx.closePath();
    }
    ctx.fill("evenodd");

    // Stroke outer polygon
    ctx.strokeStyle = data.color;
    ctx.lineWidth = ann.id === selectedId ? 3 : 2;
    ctx.beginPath();
    ctx.moveTo(data.vertices[0].x * width, data.vertices[0].y * height);
    for (let i = 1; i < data.vertices.length; i++) {
      ctx.lineTo(data.vertices[i].x * width, data.vertices[i].y * height);
    }
    ctx.closePath();
    ctx.stroke();
    // Stroke each hole so the user can see which regions are cutouts
    for (const hole of holes) {
      if (hole.vertices.length < 3) continue;
      ctx.beginPath();
      ctx.moveTo(hole.vertices[0].x * width, hole.vertices[0].y * height);
      for (let i = 1; i < hole.vertices.length; i++) {
        ctx.lineTo(hole.vertices[i].x * width, hole.vertices[i].y * height);
      }
      ctx.closePath();
      ctx.stroke();
    }

    // Vertices when selected (outer only — hole vertices aren't editable)
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

    // Area label at centroid
    const centroid = polygonCentroid(data.vertices);
    const cx = centroid.x * width;
    const cy = centroid.y * height;
    const labelText = data.areaSqUnits > 0
      ? `${data.areaSqUnits.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${data.unit}`
      : `-- ${data.unit}`;
    ctx.font = "bold 11px sans-serif";
    const tw = ctx.measureText(labelText).width;
    ctx.fillStyle = "rgba(0,0,0,0.75)";
    ctx.fillRect(cx - tw / 2 - 4, cy - 7, tw + 8, 16);
    ctx.fillStyle = data.color;
    ctx.fillText(labelText, cx - tw / 2, cy + 5);
    ctx.restore();
  }
}
