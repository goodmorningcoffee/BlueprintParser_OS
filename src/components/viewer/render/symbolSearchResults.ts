type NormalizedLtwhBoundingBox = readonly [number, number, number, number];

export interface SymbolSearchMatchRenderData {
  readonly id: string;
  readonly pageNumber: number;
  readonly bbox: NormalizedLtwhBoundingBox;
  readonly confidence: number;
}

export interface SymbolSearchResultsRenderData {
  readonly matches: readonly SymbolSearchMatchRenderData[];
}

export interface DrawSymbolSearchResultsProps {
  readonly symbolSearchResults: SymbolSearchResultsRenderData | null;
  readonly pageNumber: number;
  readonly symbolSearchConfidence: number;
  readonly dismissedSymbolMatches: ReadonlySet<string>;
  readonly width: number;
  readonly height: number;
}

/**
 * Draw accepted symbol-search matches. The caller owns canvas setup and stage order.
 */
export function drawSymbolSearchResults(
  ctx: CanvasRenderingContext2D,
  {
    symbolSearchResults,
    pageNumber,
    symbolSearchConfidence,
    dismissedSymbolMatches,
    width,
    height,
  }: DrawSymbolSearchResultsProps,
): void {
  if (symbolSearchResults) {
    const pageMatches = symbolSearchResults.matches.filter(
      (m) => m.pageNumber === pageNumber
        && m.confidence >= symbolSearchConfidence
        && !dismissedSymbolMatches.has(m.id)
    );
    for (const match of pageMatches) {
      const [mx, my, mw, mh] = match.bbox;
      const px = mx * width;
      const py = my * height;
      const pw = mw * width;
      const ph = mh * height;

      // Bright cyan fill + border
      ctx.fillStyle = "rgba(34,211,238,0.15)";
      ctx.fillRect(px, py, pw, ph);
      ctx.strokeStyle = "#22d3ee";
      ctx.lineWidth = 2.5;
      ctx.setLineDash([]);
      ctx.strokeRect(px, py, pw, ph);

      // Confidence label
      ctx.font = "bold 10px sans-serif";
      ctx.fillStyle = "#22d3ee";
      const confLabel = `${Math.round(match.confidence * 100)}%`;
      ctx.fillText(confLabel, px + 2, py - 3);
    }
  }
}
