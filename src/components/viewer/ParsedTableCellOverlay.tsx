"use client";

import { useMemo, memo } from "react";
import { useViewerStore } from "@/stores/viewerStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import { useUiStore } from "@/stores/uiStore";
import { usePageIntelligenceForPage } from "@/queries/usePageWindow";
import { useYoloTagCatalog } from "@/queries/useYoloTags";

interface ParsedTableCellOverlayProps {
  width: number;
  height: number;
  cssScale: number;
}

/**
 * HTML overlay that renders transparent clickable divs over mapped tag cells
 * in parsed table regions. Container has pointerEvents:"none", individual
 * tag cell divs have pointerEvents:"auto" so clicks pass through elsewhere.
 */
export default memo(function ParsedTableCellOverlay({
  width,
  height,
  cssScale,
}: ParsedTableCellOverlayProps) {
  const showParsedRegions = useUiStore((s) => s.showParsedRegions);
  const pageNumber = useViewerCoreStore((s) => s.pageNumber);
  const intel = usePageIntelligenceForPage(pageNumber) as any;
  const hiddenParsedRegionIds = useUiStore((s) => s.hiddenParsedRegionIds);
  // [refactor jul11 P2.2⑨] Hit regions need identity/text and only the presence of instances.
  // Coordinate/count edits therefore no longer repaint this overlay.
  const yoloTagCatalog = useYoloTagCatalog();
  const activeYoloTagId = useUiStore((s) => s.activeYoloTagId);

  const cells = useMemo(() => {
    if (!showParsedRegions || width === 0 || height === 0) return [];

    if (!intel?.parsedRegions) return [];

    const result: {
      key: string;
      left: number;
      top: number;
      width: number;
      height: number;
      tagId: string;
      tagText: string;
    }[] = [];

    for (const region of intel.parsedRegions) {
      if (!region.bbox || !region.data) continue;
      if (region.id && hiddenParsedRegionIds.has(region.id)) continue;

      const headers = region.data.headers as string[] | undefined;
      const rows = region.data.rows as Record<string, string>[] | undefined;
      const tagColumn = region.data.tagColumn as string | undefined;
      if (!headers || !rows || !tagColumn) continue;

      const tagColIdx = headers.indexOf(tagColumn);
      if (tagColIdx < 0) continue;

      const [minX, minY, maxX, maxY] = region.bbox;
      let colB = region.data.colBoundaries as number[] | undefined;
      let rowB = region.data.rowBoundaries as number[] | undefined;

      // Fallback: uniform grid
      if (!colB || colB.length !== headers.length + 1) {
        const step = (maxX - minX) / headers.length;
        colB = Array.from({ length: headers.length + 1 }, (_, i) => minX + step * i);
      }
      const hasHeaderRow = rowB ? rowB.length - 1 > rows.length : true;
      const totalRows = hasHeaderRow ? rows.length + 1 : rows.length;
      if (!rowB || rowB.length !== totalRows + 1) {
        const step = (maxY - minY) / (rows.length + 1);
        rowB = Array.from({ length: rows.length + 2 }, (_, i) => minY + step * i);
      }

      const isKeynote = region.type === "keynote";

      for (let ri = 0; ri < rows.length; ri++) {
        const cellValue = (rows[ri][tagColumn] || "").trim();
        if (!cellValue) continue;

        // Find matching YoloTag
        const yt = isKeynote
          ? yoloTagCatalog.find((t) => t.tagText === cellValue && t.source === "keynote" && t.pageNumber === pageNumber)
          : yoloTagCatalog.find((t) => t.tagText === cellValue && t.source === "schedule");
        if (!yt?.hasInstances) continue;

        // Row index in the boundary array (skip header row if present)
        const rowBIdx = hasHeaderRow ? ri + 1 : ri;
        const cellLeft = colB[tagColIdx] * width;
        const cellTop = rowB[rowBIdx] * height;
        const cellW = (colB[tagColIdx + 1] - colB[tagColIdx]) * width;
        const cellH = (rowB[rowBIdx + 1] - rowB[rowBIdx]) * height;

        result.push({
          key: `${region.id}-${ri}`,
          left: cellLeft,
          top: cellTop,
          width: cellW,
          height: cellH,
          tagId: yt.id,
          tagText: cellValue,
        });
      }
    }

    return result;
  }, [showParsedRegions, width, height, pageNumber, intel, hiddenParsedRegionIds, yoloTagCatalog]);

  if (cells.length === 0) return null;

  const handleClick = (tagId: string) => {
    const store = useUiStore.getState();
    if (store.activeYoloTagId === tagId) {
      store.setActiveYoloTagId(null);
      store.setYoloTagFilter(null);
    } else {
      store.setActiveYoloTagId(tagId);
      store.setYoloTagFilter(tagId);
    }
  };

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: `${width}px`,
        height: `${height}px`,
        pointerEvents: "none",
        transform: cssScale !== 1 ? `scale(${cssScale})` : undefined,
        transformOrigin: "top left",
        willChange: "transform",
        zIndex: 15,
      }}
    >
      {cells.map((cell) => (
        <div
          key={cell.key}
          onClick={() => handleClick(cell.tagId)}
          title={`${cell.tagText} — click to highlight instances`}
          style={{
            position: "absolute",
            left: cell.left,
            top: cell.top,
            width: cell.width,
            height: cell.height,
            pointerEvents: "auto",
            cursor: "pointer",
            borderRadius: 1,
            transition: "background-color 150ms",
            backgroundColor:
              activeYoloTagId === cell.tagId
                ? "rgba(236,72,153,0.25)"
                : undefined,
            boxShadow:
              activeYoloTagId === cell.tagId
                ? "inset 0 0 0 1px rgba(236,72,153,0.5)"
                : undefined,
          }}
          onMouseEnter={(e) => {
            if (activeYoloTagId !== cell.tagId) {
              (e.currentTarget as HTMLDivElement).style.backgroundColor = "rgba(34,211,238,0.2)";
            }
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLDivElement).style.backgroundColor =
              activeYoloTagId === cell.tagId
                ? "rgba(236,72,153,0.25)"
                : "";
          }}
        />
      ))}
    </div>
  );
});
