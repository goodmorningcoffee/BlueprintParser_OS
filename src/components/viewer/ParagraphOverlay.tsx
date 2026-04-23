"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TextractLine, TextRegion } from "@/types";
import type { PendingParagraph, ParagraphTemplate } from "@/stores/viewerStore";
import { clusterLinesByYGap } from "@/lib/specnote-parser/cluster-lines";
import {
  linesInside,
  findClusterIndexByY,
  clusterUnionBbox,
  scaleColBoundariesToBbox,
  rowTextFromClusterKV,
  rowTextFromClusterNumbered,
  rowTextFromClusterSpec,
  rowTextFromClusterGeneric,
} from "@/lib/specnote-parser/paragraph-helpers";
import { useParagraphClipboard } from "@/hooks/useParagraphClipboard";

export type ParagraphRegionKind =
  | "notes-numbered"
  | "notes-key-value"
  | "spec-dense-columns"
  | "notes-general";

interface ParagraphOverlayProps {
  active: boolean;
  outerBbox: [number, number, number, number] | null;
  textRegions: TextRegion[];
  allLines: TextractLine[];
  yGapTolerance: number;
  regionKind: ParagraphRegionKind;
  paragraphBatch: PendingParagraph[];
  paragraphClipboard: ParagraphTemplate | null;
  onParagraphUpsert: (p: PendingParagraph) => void;
  onParagraphRemove: (paragraphId: string) => void;
  onClipboardCapture: (template: ParagraphTemplate) => void;
  onExit: () => void;
  width: number;
  height: number;
  cssScale: number;
}

const HANDLE = 8;
const CLICK_OUTSIDE_EXIT_THRESHOLD = 3;

const HEADER_BY_KIND: Record<ParagraphRegionKind, string[]> = {
  "notes-numbered": ["Key", "Note"],
  "notes-key-value": ["Key", "Value"],
  "spec-dense-columns": ["sectionHeader", "body"],
  "notes-general": ["text"],
};

function bboxLTWH(outer: [number, number, number, number]): [number, number, number, number] {
  const [x0, y0, x1, y1] = outer;
  return [x0, y0, x1 - x0, y1 - y0];
}

function bboxesOverlap(a: [number, number, number, number], b: [number, number, number, number]): boolean {
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

function rowTextFor(kind: ParagraphRegionKind, cluster: TextractLine[]): Record<string, string> {
  switch (kind) {
    case "notes-numbered":
      return rowTextFromClusterNumbered(cluster);
    case "notes-key-value":
      return rowTextFromClusterKV(cluster);
    case "spec-dense-columns":
      return rowTextFromClusterSpec(cluster);
    case "notes-general":
      return rowTextFromClusterGeneric(cluster);
  }
}

function makeId(): string {
  return `para-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

type EdgeHandle = "top" | "bottom" | "left" | "right";

interface DragTarget {
  paragraphId: string;
  edge: EdgeHandle;
}

export default memo(function ParagraphOverlay({
  active,
  outerBbox,
  textRegions,
  allLines,
  yGapTolerance,
  regionKind,
  paragraphBatch,
  paragraphClipboard,
  onParagraphUpsert,
  onParagraphRemove,
  onClipboardCapture,
  onExit,
  width,
  height,
  cssScale,
}: ParagraphOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hoverClusterIdx, setHoverClusterIdx] = useState<{ regionId: string; clusterIdx: number } | null>(null);
  const hoverRef = useRef<{ regionId: string; clusterIdx: number } | null>(null);
  const [focusedParagraphId, setFocusedParagraphId] = useState<string | null>(null);
  const [clicksOutside, setClicksOutside] = useState(0);
  const [drag, setDrag] = useState<DragTarget | null>(null);
  const dragRef = useRef<DragTarget | null>(null);

  // Cluster cache: per-region clusters + one "__fallback__" for uncategorized lines.
  // Rebuilds only when inputs change (Stage 1 output, page lines, tolerance, outer region).
  const clusterCache = useMemo(() => {
    const cache = new Map<string, TextractLine[][]>();
    if (!outerBbox) return cache;
    const outerLTWH = bboxLTWH(outerBbox);
    for (const tr of textRegions) {
      if (!tr.bbox || tr.bbox.length < 4) continue;
      if (!bboxesOverlap(tr.bbox, outerLTWH)) continue;
      const linesInRegion = linesInside(tr.bbox, allLines);
      if (linesInRegion.length === 0) continue;
      cache.set(tr.id, clusterLinesByYGap(linesInRegion, yGapTolerance));
    }
    cache.set("__fallback__", clusterLinesByYGap(linesInside(outerLTWH, allLines), yGapTolerance));
    return cache;
  }, [textRegions, allLines, yGapTolerance, outerBbox]);

  // Reset hover/focus/counter on outer-region or active change
  useEffect(() => {
    setHoverClusterIdx(null);
    hoverRef.current = null;
    setFocusedParagraphId(null);
    setClicksOutside(0);
  }, [outerBbox, active]);

  // ── Drawing ────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || width === 0 || height === 0 || !outerBbox) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const [x0, y0, x1, y1] = outerBbox;
    const rx = x0 * width;
    const ry = y0 * height;
    const rw = (x1 - x0) * width;
    const rh = (y1 - y0) * height;

    // Outer region dashed stroke
    ctx.strokeStyle = "rgba(34, 211, 238, 0.5)"; // cyan-400
    ctx.lineWidth = 1.25;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(rx, ry, rw, rh);
    ctx.setLineDash([]);

    // Committed paragraphs — solid strokes + edge handles + number badges
    ctx.strokeStyle = "rgba(34, 211, 238, 0.95)";
    ctx.fillStyle = "rgba(34, 211, 238, 0.08)";
    ctx.lineWidth = 2;
    for (let i = 0; i < paragraphBatch.length; i++) {
      const p = paragraphBatch[i];
      const [px0, py0, px1, py1] = p.bbox;
      const px = px0 * width;
      const py = py0 * height;
      const pw = (px1 - px0) * width;
      const ph = (py1 - py0) * height;
      ctx.fillRect(px, py, pw, ph);
      ctx.strokeRect(px, py, pw, ph);

      // 4 edge-midpoint handles
      ctx.save();
      const isFocused = p.id === focusedParagraphId;
      ctx.fillStyle = isFocused ? "rgba(250, 204, 21, 1)" : "rgba(34, 211, 238, 1)";
      ctx.strokeStyle = "rgba(0, 0, 0, 0.6)";
      ctx.lineWidth = 1;
      const midX = px + pw / 2;
      const midY = py + ph / 2;
      for (const [hx, hy] of [
        [midX, py],           // top
        [midX, py + ph],      // bottom
        [px, midY],           // left
        [px + pw, midY],      // right
      ] as const) {
        ctx.fillRect(hx - HANDLE / 2, hy - HANDLE / 2, HANDLE, HANDLE);
        ctx.strokeRect(hx - HANDLE / 2, hy - HANDLE / 2, HANDLE, HANDLE);
      }
      ctx.restore();

      // Number badge
      const badge = `#${i + 1}`;
      ctx.save();
      ctx.font = "bold 11px sans-serif";
      const tw = ctx.measureText(badge).width;
      ctx.fillStyle = "rgba(34, 211, 238, 0.95)";
      ctx.fillRect(px, py - 14, tw + 10, 14);
      ctx.fillStyle = "#0c0a09";
      ctx.fillText(badge, px + 5, py - 3);
      ctx.restore();
    }

    // Hover preview (dashed light stroke) — only when not dragging
    if (hoverClusterIdx && !dragRef.current) {
      const clusters = clusterCache.get(hoverClusterIdx.regionId);
      const cluster = clusters?.[hoverClusterIdx.clusterIdx];
      if (cluster && cluster.length > 0) {
        const [hx0, hy0, hx1, hy1] = clusterUnionBbox(cluster);
        const hx = hx0 * width;
        const hy = hy0 * height;
        const hw = (hx1 - hx0) * width;
        const hh = (hy1 - hy0) * height;
        ctx.save();
        ctx.strokeStyle = "rgba(165, 243, 252, 0.85)"; // cyan-200
        ctx.fillStyle = "rgba(165, 243, 252, 0.12)";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 3]);
        ctx.fillRect(hx, hy, hw, hh);
        ctx.strokeRect(hx, hy, hw, hh);
        ctx.setLineDash([]);
        ctx.restore();
      }
    }

    // Click-outside hint
    if (clicksOutside > 0 && clicksOutside < CLICK_OUTSIDE_EXIT_THRESHOLD) {
      const remaining = CLICK_OUTSIDE_EXIT_THRESHOLD - clicksOutside;
      const hint = `Click ${remaining} more time${remaining === 1 ? "" : "s"} outside to exit paragraph mode`;
      ctx.save();
      ctx.font = "bold 12px sans-serif";
      const tw = ctx.measureText(hint).width;
      const hx = Math.max(6, rx);
      const hy = Math.max(18, ry - 6);
      ctx.fillStyle = "rgba(248, 113, 113, 0.95)";
      ctx.fillRect(hx, hy - 14, tw + 10, 14);
      ctx.fillStyle = "#fff";
      ctx.fillText(hint, hx + 5, hy - 3);
      ctx.restore();
    }
  }, [width, height, outerBbox, paragraphBatch, hoverClusterIdx, clusterCache, clicksOutside, focusedParagraphId]);

  useEffect(() => {
    draw();
  }, [draw]);

  // ── Pos helper ─────────────────────────────────────────
  const toNormalized = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      const x = (clientX - rect.left) * (width / rect.width) / width;
      const y = (clientY - rect.top) * (height / rect.height) / height;
      return { x, y };
    },
    [width, height],
  );

  const isInsideOuter = useCallback((x: number, y: number): boolean => {
    if (!outerBbox) return false;
    const [x0, y0, x1, y1] = outerBbox;
    return x >= x0 && x <= x1 && y >= y0 && y <= y1;
  }, [outerBbox]);

  const findContainingRegionId = useCallback((x: number, y: number): string => {
    for (const tr of textRegions) {
      if (!tr.bbox || tr.bbox.length < 4) continue;
      const [tx, ty, tw, th] = tr.bbox;
      if (x >= tx && x <= tx + tw && y >= ty && y <= ty + th) return tr.id;
    }
    return "__fallback__";
  }, [textRegions]);

  // Hit-test a committed paragraph's edge handle
  const hitTestHandle = useCallback((canvasX: number, canvasY: number): DragTarget | null => {
    for (const p of paragraphBatch) {
      const [x0, y0, x1, y1] = p.bbox;
      const px = x0 * width;
      const py = y0 * height;
      const pw = (x1 - x0) * width;
      const ph = (y1 - y0) * height;
      const midX = px + pw / 2;
      const midY = py + ph / 2;
      const handles: Array<[number, number, EdgeHandle]> = [
        [midX, py, "top"],
        [midX, py + ph, "bottom"],
        [px, midY, "left"],
        [px + pw, midY, "right"],
      ];
      for (const [hx, hy, edge] of handles) {
        if (Math.abs(canvasX - hx) < HANDLE && Math.abs(canvasY - hy) < HANDLE) {
          return { paragraphId: p.id, edge };
        }
      }
    }
    return null;
  }, [paragraphBatch, width, height]);

  // Hit-test inside a committed paragraph (selects focus)
  const hitTestBody = useCallback((x: number, y: number): string | null => {
    for (const p of paragraphBatch) {
      const [x0, y0, x1, y1] = p.bbox;
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return p.id;
    }
    return null;
  }, [paragraphBatch]);

  // ── Mouse handlers ─────────────────────────────────────
  const rafIdRef = useRef<number | null>(null);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (dragRef.current) return; // drag handler owns the cursor
      if (rafIdRef.current !== null) return; // rAF-throttle: one update per frame
      const clientX = e.clientX;
      const clientY = e.clientY;
      rafIdRef.current = window.requestAnimationFrame(() => {
        rafIdRef.current = null;
        const { x, y } = toNormalized(clientX, clientY);
        if (!isInsideOuter(x, y)) {
          if (hoverRef.current !== null) {
            hoverRef.current = null;
            setHoverClusterIdx(null);
          }
          return;
        }
        const regionId = findContainingRegionId(x, y);
        const clusters = clusterCache.get(regionId) ?? [];
        const clusterIdx = findClusterIndexByY(clusters, y);
        const next = clusterIdx === -1 ? null : { regionId, clusterIdx };
        if (next?.regionId !== hoverRef.current?.regionId || next?.clusterIdx !== hoverRef.current?.clusterIdx) {
          hoverRef.current = next;
          setHoverClusterIdx(next);
        }
      });
    },
    [toNormalized, isInsideOuter, findContainingRegionId, clusterCache],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const cx = (e.clientX - rect.left) * (width / rect.width);
      const cy = (e.clientY - rect.top) * (height / rect.height);
      const handle = hitTestHandle(cx, cy);
      if (handle) {
        e.preventDefault();
        e.stopPropagation();
        dragRef.current = handle;
        setDrag(handle);
        setFocusedParagraphId(handle.paragraphId);
        return;
      }
      // Clicked inside a committed paragraph body → focus it
      const { x, y } = toNormalized(e.clientX, e.clientY);
      const bodyHit = hitTestBody(x, y);
      if (bodyHit) {
        e.stopPropagation();
        setFocusedParagraphId(bodyHit);
        setClicksOutside(0);
        return;
      }
      // Clicked outside outer region → increment exit counter
      if (!isInsideOuter(x, y)) {
        e.stopPropagation();
        setClicksOutside((c) => {
          const next = c + 1;
          if (next >= CLICK_OUTSIDE_EXIT_THRESHOLD) {
            onExit();
            return 0;
          }
          return next;
        });
        return;
      }
      // Clicked inside outer region but not on a paragraph → reset counter
      setClicksOutside(0);
    },
    [hitTestHandle, hitTestBody, toNormalized, isInsideOuter, onExit, width, height],
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const { x, y } = toNormalized(e.clientX, e.clientY);
      if (!isInsideOuter(x, y)) return;
      const regionId = findContainingRegionId(x, y);
      const clusters = clusterCache.get(regionId) ?? [];
      const clusterIdx = findClusterIndexByY(clusters, y);
      if (clusterIdx === -1) return;
      const cluster = clusters[clusterIdx];
      if (!cluster || cluster.length === 0) return;
      const bbox = clusterUnionBbox(cluster);
      const p: PendingParagraph = {
        id: makeId(),
        bbox,
        lines: [...cluster],
        rowText: rowTextFor(regionKind, cluster),
      };
      onParagraphUpsert(p);
      setFocusedParagraphId(p.id);
      setClicksOutside(0);
    },
    [toNormalized, isInsideOuter, findContainingRegionId, clusterCache, regionKind, onParagraphUpsert],
  );

  // Global drag handlers
  const dragMoveHandler = useCallback(
    (e: MouseEvent) => {
      const target = dragRef.current;
      if (!target) return;
      const p = paragraphBatch.find((x) => x.id === target.paragraphId);
      if (!p) return;
      const { x, y } = toNormalized(e.clientX, e.clientY);
      const [x0, y0, x1, y1] = p.bbox;
      let nextBbox: [number, number, number, number] = [x0, y0, x1, y1];
      const MIN = 0.003;
      if (target.edge === "top") nextBbox = [x0, Math.min(y1 - MIN, y), x1, y1];
      else if (target.edge === "bottom") nextBbox = [x0, y0, x1, Math.max(y0 + MIN, y)];
      else if (target.edge === "left") nextBbox = [Math.min(x1 - MIN, x), y0, x1, y1];
      else if (target.edge === "right") nextBbox = [x0, y0, Math.max(x0 + MIN, x), y1];
      onParagraphUpsert({ ...p, bbox: nextBbox });
    },
    [paragraphBatch, toNormalized, onParagraphUpsert],
  );

  const dragEndHandler = useCallback(() => {
    dragRef.current = null;
    setDrag(null);
  }, []);

  useEffect(() => {
    if (!drag) return;
    window.addEventListener("mousemove", dragMoveHandler);
    window.addEventListener("mouseup", dragEndHandler);
    return () => {
      window.removeEventListener("mousemove", dragMoveHandler);
      window.removeEventListener("mouseup", dragEndHandler);
    };
  }, [drag, dragMoveHandler, dragEndHandler]);

  // Cursor feedback
  const handleCanvasMouseMoveForCursor = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      if (dragRef.current) return;
      const rect = canvas.getBoundingClientRect();
      const cx = (e.clientX - rect.left) * (width / rect.width);
      const cy = (e.clientY - rect.top) * (height / rect.height);
      const h = hitTestHandle(cx, cy);
      if (h) {
        canvas.style.cursor = h.edge === "top" || h.edge === "bottom" ? "ns-resize" : "ew-resize";
      } else {
        canvas.style.cursor = "crosshair";
      }
      handleMouseMove(e);
    },
    [hitTestHandle, width, height, handleMouseMove],
  );

  // Keyboard Cmd+C / Cmd+V via shared hook
  const handleCopy = useCallback(() => {
    if (!focusedParagraphId) return;
    const p = paragraphBatch.find((x) => x.id === focusedParagraphId);
    if (!p) return;
    const headers = HEADER_BY_KIND[regionKind];
    const template: ParagraphTemplate = {
      colBoundaries: p.colBoundaries ?? [],
      headers,
    };
    onClipboardCapture(template);
  }, [focusedParagraphId, paragraphBatch, regionKind, onClipboardCapture]);

  const handlePaste = useCallback(() => {
    if (!paragraphClipboard || !focusedParagraphId) return;
    const p = paragraphBatch.find((x) => x.id === focusedParagraphId);
    if (!p) return;
    if (paragraphClipboard.colBoundaries.length === 0) return;
    // Source bbox for the template is unknown once captured; we use the
    // capturing paragraph's bbox as the source. A simpler approach: treat
    // clipboard boundaries as already local to a 0..1 range and scale to
    // the target's width. Since captures store colBoundaries in the same
    // normalized page-coord frame as the paragraph's bbox, we can re-scale
    // by treating the source paragraph as the union of boundaries.
    const srcMinX = Math.min(...paragraphClipboard.colBoundaries);
    const srcMaxX = Math.max(...paragraphClipboard.colBoundaries);
    const nextCols = scaleColBoundariesToBbox(
      paragraphClipboard.colBoundaries,
      [srcMinX, 0, srcMaxX, 0],
      [p.bbox[0], 0, p.bbox[2], 0],
    );
    onParagraphUpsert({ ...p, colBoundaries: nextCols });
  }, [paragraphClipboard, focusedParagraphId, paragraphBatch, onParagraphUpsert]);

  useParagraphClipboard({
    enabled: active,
    onCopy: handleCopy,
    onPaste: handlePaste,
  });

  // Delete key: remove focused paragraph
  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.key === "Delete" || e.key === "Backspace") && focusedParagraphId) {
        const target = e.target as HTMLElement | null;
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
        if (target?.isContentEditable) return;
        e.preventDefault();
        onParagraphRemove(focusedParagraphId);
        setFocusedParagraphId(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [active, focusedParagraphId, onParagraphRemove]);

  if (!active || !outerBbox) return null;

  return (
    <canvas
      ref={canvasRef}
      onMouseMove={handleCanvasMouseMoveForCursor}
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: `${width}px`,
        height: `${height}px`,
        pointerEvents: "auto",
        transform: cssScale !== 1 ? `scale(${cssScale})` : undefined,
        transformOrigin: "top left",
        willChange: "transform",
        zIndex: 32,
        cursor: "crosshair",
      }}
    />
  );
});
