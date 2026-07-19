import type { ClientAnnotation, ClientTakeoffItem, CountMarkerData } from "@/types";

type ExistingAnnotationRenderData = Pick<
  ClientAnnotation,
  "id" | "name" | "bbox" | "source" | "data"
>;

type TakeoffItemRenderData = Pick<ClientTakeoffItem, "id" | "size">;

export interface ExistingAnnotationSelection {
  isSelected(id: number): boolean;
}

export interface ExistingAnnotationActiveTag {
  readonly color?: string;
  readonly name: string;
  readonly tagText: string;
}

export interface DrawExistingAnnotationsProps {
  readonly annotations: readonly ExistingAnnotationRenderData[];
  readonly width: number;
  readonly height: number;
  readonly selectedId: number | null;
  readonly hiddenTakeoffItemIds: ReadonlySet<number>;
  readonly selection: ExistingAnnotationSelection;
  readonly activeTag: ExistingAnnotationActiveTag | null | undefined;
  readonly activeTagAnnotationIds: ReadonlySet<number>;
  readonly symbolSearchResults: unknown | null;
  readonly cssScale: number;
  readonly getLabelColor: (name: string) => string;
  readonly getTakeoffItems: () => readonly TakeoffItemRenderData[];
}

function drawCountMarker(
  ctx: CanvasRenderingContext2D,
  ann: ExistingAnnotationRenderData,
  width: number,
  height: number,
  isSelected: boolean,
  markerSize?: number,
  cssScale?: number,
): void {
  const data = ann.data as unknown as CountMarkerData;
  if (!data?.color || !data?.shape) return;

  const [minX, minY, maxX, maxY] = ann.bbox;
  const cx = ((minX + maxX) / 2) * width;
  const cy = ((minY + maxY) / 2) * height;
  // Divide by cssScale so markers stay constant screen-size regardless of zoom
  const r = (markerSize || 10) / (cssScale || 1);

  ctx.save();
  ctx.fillStyle = data.color + "cc";
  const rgb = parseInt(data.color.slice(1), 16);
  ctx.strokeStyle = `rgb(${((rgb >> 16) & 0xff) * 0.7 | 0}, ${((rgb >> 8) & 0xff) * 0.7 | 0}, ${(rgb & 0xff) * 0.7 | 0})`;
  ctx.lineWidth = isSelected ? 3 : 1.5;

  ctx.beginPath();
  switch (data.shape) {
    case "circle":
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      break;
    case "square":
      ctx.rect(cx - r, cy - r, r * 2, r * 2);
      break;
    case "diamond":
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r, cy);
      ctx.lineTo(cx, cy + r);
      ctx.lineTo(cx - r, cy);
      ctx.closePath();
      break;
    case "triangle":
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r, cy + r);
      ctx.lineTo(cx - r, cy + r);
      ctx.closePath();
      break;
    case "cross": {
      const a = r * 0.35;
      ctx.moveTo(cx - a, cy - r); ctx.lineTo(cx + a, cy - r);
      ctx.lineTo(cx + a, cy - a); ctx.lineTo(cx + r, cy - a);
      ctx.lineTo(cx + r, cy + a); ctx.lineTo(cx + a, cy + a);
      ctx.lineTo(cx + a, cy + r); ctx.lineTo(cx - a, cy + r);
      ctx.lineTo(cx - a, cy + a); ctx.lineTo(cx - r, cy + a);
      ctx.lineTo(cx - r, cy - a); ctx.lineTo(cx - a, cy - a);
      ctx.closePath();
      break;
    }
  }
  ctx.fill();
  ctx.stroke();

  if (isSelected) {
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 4 / (cssScale || 1), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Draw existing count markers or bbox/label annotations in source-row order.
 * The caller owns stage order and supplies live cache and label-color bridges.
 */
export function drawExistingAnnotations(
  ctx: CanvasRenderingContext2D,
  {
    annotations,
    width,
    height,
    selectedId,
    hiddenTakeoffItemIds,
    selection,
    activeTag,
    activeTagAnnotationIds,
    symbolSearchResults,
    cssScale,
    getLabelColor,
    getTakeoffItems,
  }: DrawExistingAnnotationsProps,
): void {
  for (const ann of annotations) {
    // Count markers: draw shape instead of rectangle
    if (ann.source === "takeoff" && (ann.data as any)?.type === "count-marker") {
      const itemId = (ann.data as any)?.takeoffItemId;
      if (hiddenTakeoffItemIds.has(itemId)) continue;
      // [refactor jul10 P2.2④] bridge read, NOT the hook value: this draw effect's dep array
      // (end of effect) deliberately EXCLUDES takeoffItems — item edits (size/color) do not
      // redraw the canvas today. Using the subscribed hook value here (or adding the dep)
      // would create a brand-new canvas-redraw trigger class on every item mutation on the
      // SACRED path. The injected bridge reads the live cache synchronously, same as the old
      // getState(). (TAKEOFF_IMPL/SPEC.md §3.3 :372 row — do not "clean up".)
      const items = getTakeoffItems();
      const item = items.find((t) => t.id === itemId || String(t.id) === String(itemId));
      drawCountMarker(ctx, ann, width, height, ann.id === selectedId || selection.isSelected(ann.id), item?.size, cssScale);
      continue;
    }

    // Area polygons have their own dedicated render pass below (Loop 2).
    // Skip the bbox-rectangle drawing here — it only adds visual clutter
    // overlapping adjacent rooms since the actual polygon shape is drawn
    // by the polygon loop. The label, delete "x", and click handlers
    // still use `ann.bbox` as an invisible-but-stable anchor.
    const isAreaPolygon = ann.source === "takeoff" && (ann.data as any)?.type === "area-polygon";

    const color = getLabelColor(ann.name);
    const [minX, minY, maxX, maxY] = ann.bbox;
    const x = minX * width;
    const y = minY * height;
    const w = (maxX - minX) * width;
    const h = (maxY - minY) * height;

    // If an active tag is set, hide non-matching YOLO annotations entirely
    // so the selected tag is easy to spot. Non-YOLO annotations just dim.
    const isTagMatch = activeTag && activeTagAnnotationIds.has(ann.id);
    if (activeTag && ann.source === "yolo" && !isTagMatch) continue;
    const dimmed = (activeTag && !isTagMatch) || (symbolSearchResults !== null);

    if (isAreaPolygon) {
      // Bbox fill/stroke skipped — Loop 2 draws the actual polygon below.
      ctx.globalAlpha = dimmed ? 0.25 : 1;
    } else if (isTagMatch) {
      // Bright magenta fill + tag color stroke for active tag instances
      ctx.fillStyle = "#ff00ff40"; // magenta at 25% opacity
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = activeTag.color || "#22d3ee";
      ctx.lineWidth = 3;
      ctx.strokeRect(x, y, w, h);
    } else {
      ctx.globalAlpha = dimmed ? 0.25 : 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = (ann.id === selectedId || selection.isSelected(ann.id)) ? 3 : 2;
      ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = color + "15";
      ctx.fillRect(x, y, w, h);
    }

    // Label
    const fontSize = Math.max(10, Math.min(13, h * 0.3));
    ctx.font = `bold ${fontSize}px sans-serif`;
    const labelText = ann.name;
    const textW = ctx.measureText(labelText).width;
    const isSelected = ann.id === selectedId || selection.isSelected(ann.id);

    // Label background + text
    const isUserSource = ann.source === "user";
    const extraW = isSelected ? (isUserSource ? 36 : 20) : 6;
    ctx.fillStyle = "rgba(0,0,0,0.75)";
    ctx.fillRect(x, y - fontSize - 4, textW + extraW, fontSize + 4);
    ctx.fillStyle = color;
    ctx.fillText(labelText, x + 3, y - 4);

    // Selected: show edit pencil (user markups) + delete "x" + corner resize handles
    if (isSelected) {
      let iconX = x + textW + 8;
      if (isUserSource) {
        ctx.fillStyle = "#60a5fa"; // blue pencil
        ctx.font = `${fontSize}px sans-serif`;
        ctx.fillText("\u270E", iconX, y - 4);
        iconX += 16;
      }
      ctx.fillStyle = "#ff4444";
      ctx.font = `bold ${fontSize}px sans-serif`;
      ctx.fillText("x", iconX, y - 4);

      // Corner handles — skipped for area polygons. The resize handler only
      // updates ann.bbox, not data.vertices, so dragging a corner visually
      // shifts the (now-invisible) bbox without reshaping the polygon. The
      // handles would be dead decorations floating in space.
      if (!isAreaPolygon) {
        const hs = 6;
        ctx.fillStyle = color;
        ctx.fillRect(x - hs / 2, y - hs / 2, hs, hs);
        ctx.fillRect(x + w - hs / 2, y - hs / 2, hs, hs);
        ctx.fillRect(x - hs / 2, y + h - hs / 2, hs, hs);
        ctx.fillRect(x + w - hs / 2, y + h - hs / 2, hs, hs);
      }
    }

    // Tag name label for active tag match
    if (isTagMatch && activeTag) {
      const tagLabel = activeTag.name || activeTag.tagText;
      ctx.globalAlpha = 1;
      ctx.font = "bold 11px sans-serif";
      const tlw = ctx.measureText(tagLabel).width;
      ctx.fillStyle = (activeTag.color || "#22d3ee") + "dd";
      ctx.fillRect(x, y + h + 1, tlw + 6, 14);
      ctx.fillStyle = "#000";
      ctx.fillText(tagLabel, x + 3, y + h + 12);
    }

    ctx.globalAlpha = 1;
  }
}
