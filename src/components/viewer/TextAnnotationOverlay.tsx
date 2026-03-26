"use client";

import { useEffect, useRef, useMemo, useCallback } from "react";
import { useViewerStore } from "@/stores/viewerStore";
import { TEXT_ANNOTATION_COLORS } from "@/types";
import type { TextAnnotation } from "@/types";

interface TextAnnotationOverlayProps {
  width: number;
  height: number;
  cssScale: number;
}

export default function TextAnnotationOverlay({
  width,
  height,
  cssScale,
}: TextAnnotationOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pageNumber = useViewerStore((s) => s.pageNumber);
  const textAnnotations = useViewerStore((s) => s.textAnnotations);
  const showTextAnnotations = useViewerStore((s) => s.showTextAnnotations);
  const activeTypes = useViewerStore((s) => s.activeTextAnnotationTypes);
  const hiddenSet = useViewerStore((s) => s.hiddenTextAnnotations);
  const customColors = useViewerStore((s) => s.textAnnotationColors);
  const activeFilter = useViewerStore((s) => s.activeTextAnnotationFilter);
  const setFilter = useViewerStore((s) => s.setTextAnnotationFilter);
  const mode = useViewerStore((s) => s.mode);
  const textractData = useViewerStore((s) => s.textractData);
  const setSearch = useViewerStore((s) => s.setSearch);
  const searchQuery = useViewerStore((s) => s.searchQuery);

  const annotations = textAnnotations[pageNumber] || [];

  // Filter visible annotations
  const visible = useMemo(() => {
    if (!showTextAnnotations) return [];
    return annotations.filter((ann, i) => {
      if (activeTypes[ann.type] === false) return false;
      if (hiddenSet.has(`${pageNumber}:${i}`)) return false;
      return true;
    });
  }, [annotations, showTextAnnotations, activeTypes, hiddenSet, pageNumber]);

  // Click handler — double-click: OCR word search, single-click: text annotation filter
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (mode !== "pointer") return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const clickX = (e.clientX - rect.left) / (rect.width / width);
      const clickY = (e.clientY - rect.top) / (rect.height / height);
      const normX = clickX / width;
      const normY = clickY / height;

      // Double-click: search for OCR word under cursor
      if (e.detail === 2) {
        const pageWords = textractData[pageNumber]?.words;
        if (pageWords) {
          for (const word of pageWords) {
            const [left, top, w, h] = word.bbox;
            if (normX >= left && normX <= left + w && normY >= top && normY <= top + h) {
              if (searchQuery.toLowerCase() === word.text.toLowerCase()) {
                setSearch("");
              } else {
                setSearch(word.text);
              }
              e.stopPropagation();
              return;
            }
          }
        }
        // No OCR word hit — let event fall through
        return;
      }

      // Single-click: check text annotation bboxes
      for (const ann of visible) {
        const [left, top, w, h] = ann.bbox;
        const ax = left * width;
        const ay = top * height;
        const aw = w * width;
        const ah = h * height;
        if (clickX >= ax && clickX <= ax + aw && clickY >= ay && clickY <= ay + ah) {
          e.stopPropagation();
          if (activeFilter && activeFilter.type === ann.type && activeFilter.text === ann.text) {
            setFilter(null);
            setSearch("");
          } else {
            setFilter({ type: ann.type, text: ann.text });
            setSearch(ann.text);
          }
          return;
        }
      }
      // No text annotation hit — don't stopPropagation, let AnnotationOverlay handle it
    },
    [mode, visible, width, height, activeFilter, setFilter, textractData, pageNumber, setSearch, searchQuery]
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width === 0 || height === 0) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    if (visible.length === 0) return;

    const hasFilter = activeFilter !== null;

    for (const ann of visible) {
      const isMatch = hasFilter && ann.type === activeFilter.type && ann.text === activeFilter.text;
      const baseColor = customColors[ann.type] || TEXT_ANNOTATION_COLORS[ann.category] || "#f59e0b";
      const [left, top, w, h] = ann.bbox;
      const x = left * width;
      const y = top * height;
      const rw = w * width;
      const rh = h * height;

      // Dim non-matching annotations when filter is active
      if (hasFilter && !isMatch) {
        ctx.globalAlpha = 0.15;
      } else {
        ctx.globalAlpha = 1;
      }

      // Fill
      ctx.fillStyle = hexToRgba(baseColor, isMatch ? 0.4 : 0.25);
      ctx.fillRect(x, y, rw, rh);

      // Stroke
      ctx.strokeStyle = hexToRgba(baseColor, isMatch ? 1 : 0.7);
      ctx.lineWidth = isMatch ? 2 : 1;
      ctx.strokeRect(x, y, rw, rh);

      // Tiny type label above the highlight
      const label = shortLabel(ann.type);
      ctx.font = "bold 7px sans-serif";
      const textWidth = ctx.measureText(label).width;
      const labelX = x;
      const labelY = y - 2;

      if (labelY > 8) {
        ctx.fillStyle = hexToRgba(baseColor, 0.85);
        ctx.fillRect(labelX - 1, labelY - 7, textWidth + 4, 9);
        ctx.fillStyle = "#fff";
        ctx.fillText(label, labelX + 1, labelY);
      }

      ctx.globalAlpha = 1;
    }
  }, [visible, width, height, customColors, activeFilter]);

  if (visible.length === 0) return null;

  return (
    <canvas
      ref={canvasRef}
      onClick={handleClick}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: `${width}px`,
        height: `${height}px`,
        pointerEvents: mode === "pointer" ? "auto" : "none",
        transform: cssScale !== 1 ? `scale(${cssScale})` : undefined,
        transformOrigin: "top left",
      }}
    />
  );
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const SHORT_LABELS: Record<string, string> = {
  phone: "PH", fax: "FX", address: "ADDR", email: "EMAIL", url: "URL", "zip-code": "ZIP",
  "csi-code": "CSI", "spec-section": "SPEC", "building-code": "CODE", "code-compliance": "COMPL",
  "imperial-dim": "DIM", "metric-dim": "DIM", scale: "SCALE", slope: "SLOPE",
  "equipment-tag": "EQUIP", "material-code": "MAT", "door-window-tag": "D/W",
  "finish-code": "FIN", "panel-circuit": "PNL",
  "sheet-number": "SHT#", "sheet-ref": "SHEET", "detail-ref": "DET", revision: "REV", "action-marker": "ACT",
  structural: "STR", mechanical: "MECH", electrical: "ELEC", plumbing: "PLMB",
  "fire-protection": "FIRE",
  abbreviation: "ABBR",
  "general-note": "NOTE", "typical-marker": "TYP", "coordination-note": "COORD",
  "room-number": "RM#", "room-name": "ROOM", "area-designation": "AREA",
};

function shortLabel(type: string): string {
  return SHORT_LABELS[type] || type.slice(0, 4).toUpperCase();
}
