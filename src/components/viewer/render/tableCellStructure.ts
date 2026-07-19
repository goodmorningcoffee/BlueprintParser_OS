type NormalizedBoundingBox = readonly [number, number, number, number];

export interface TableCellRenderData {
  readonly bbox: NormalizedBoundingBox;
  readonly highlighted: boolean;
  readonly type: string;
}

export interface TableCellStructureRenderData {
  readonly pageNumber: number;
  readonly cells: readonly TableCellRenderData[];
}

export interface DrawTableCellStructureProps {
  readonly tableCellStructure: TableCellStructureRenderData | null;
  readonly pageNumber: number;
  readonly showTableCellStructure: boolean;
  readonly width: number;
  readonly height: number;
}

/**
 * Draw the TATR table-cell structure overlay. The caller owns canvas setup and stage order.
 */
export function drawTableCellStructure(
  ctx: CanvasRenderingContext2D,
  {
    tableCellStructure,
    pageNumber,
    showTableCellStructure,
    width,
    height,
  }: DrawTableCellStructureProps,
): void {
  // TATR-OVERLAY: gated on showTableCellStructure (toggle in AutoParseTab),
  // bumped visual style — solid 1px borders + 5% cyan tint on every cell so
  // they're actually visible against a busy architectural drawing background.
  // Previous styling (dashed 0.3-opacity cyan) was effectively invisible.
  if (tableCellStructure && tableCellStructure.pageNumber === pageNumber && showTableCellStructure) {
    for (const cell of tableCellStructure.cells) {
      const [cx0, cy0, cx1, cy1] = cell.bbox;
      const cellX = cx0 * width;
      const cellY = cy0 * height;
      const cellW = (cx1 - cx0) * width;
      const cellH = (cy1 - cy0) * height;

      if (cell.highlighted) {
        // Highlighted: thick cyan with bright fill (user clicked)
        ctx.fillStyle = "rgba(34,211,238,0.25)";
        ctx.fillRect(cellX, cellY, cellW, cellH);
        ctx.strokeStyle = "#22d3ee";
        ctx.lineWidth = 2.5;
      } else if (cell.type === "column-header" || cell.type === "row-header") {
        // Header cells: violet tint
        ctx.fillStyle = "rgba(168,85,247,0.15)";
        ctx.fillRect(cellX, cellY, cellW, cellH);
        ctx.strokeStyle = "rgba(168,85,247,0.7)";
        ctx.lineWidth = 1.25;
      } else {
        // Data cells: subtle cyan tint + visible solid border
        ctx.fillStyle = "rgba(34,211,238,0.05)";
        ctx.fillRect(cellX, cellY, cellW, cellH);
        ctx.strokeStyle = "rgba(34,211,238,0.7)";
        ctx.lineWidth = 1;
      }
      ctx.strokeRect(cellX, cellY, cellW, cellH);
    }
  }
}
