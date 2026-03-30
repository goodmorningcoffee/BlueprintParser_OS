"use client";

import { useEffect, useRef } from "react";
import { useViewerStore, useNavigation, usePageData } from "@/stores/viewerStore";
import { SHAPE_COLORS } from "@/types";
import type { Shape } from "@/types";

interface KeynoteOverlayProps {
  width: number;
  height: number;
  cssScale: number;
}

/**
 * Canvas overlay that draws colored shape outlines for detected keynotes.
 * Positioned on top of the PDF page, same as SearchHighlightOverlay.
 */
export default function KeynoteOverlay({
  width,
  height,
  cssScale,
}: KeynoteOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { pageNumber } = useNavigation();
  const { keynotes } = usePageData();
  const setKeynoteFilter = useViewerStore((s) => s.setKeynoteFilter);
  const activeKeynoteFilter = useViewerStore((s) => s.activeKeynoteFilter);

  const pageKeynotes = keynotes[pageNumber] || [];

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

    if (pageKeynotes.length === 0) return;

    for (const keynote of pageKeynotes) {
      const color = SHAPE_COLORS[keynote.shape as Shape] || "#e6194b";
      const [left, top, right, bottom] = keynote.bbox;

      const x = left * width;
      const y = top * height;
      const w = (right - left) * width;
      const h = (bottom - top) * height;

      // Check if this keynote matches the active filter
      const isMatch =
        activeKeynoteFilter !== null &&
        keynote.shape === activeKeynoteFilter.shape &&
        keynote.text === activeKeynoteFilter.text;
      const filterActive = activeKeynoteFilter !== null;

      // Dim non-matching keynotes when a filter is active
      ctx.globalAlpha = filterActive && !isMatch ? 0.25 : 1;

      // Draw shape outline — highlighted keynotes get bright magenta ring
      ctx.strokeStyle = isMatch ? "#ff00ff" : color;
      ctx.lineWidth = isMatch ? 4 : 2;

      if (keynote.contour && keynote.contour.length > 2) {
        // Draw actual contour polygon
        ctx.beginPath();
        const [cx0, cy0] = keynote.contour[0];
        ctx.moveTo(cx0 * width, cy0 * height);
        for (let i = 1; i < keynote.contour.length; i++) {
          const [cx, cy] = keynote.contour[i];
          ctx.lineTo(cx * width, cy * height);
        }
        ctx.closePath();
        ctx.stroke();

        // Fill — brighter for matches
        ctx.fillStyle = isMatch ? "#ff00ff40" : color + "20";
        ctx.fill();
      } else {
        // Fallback: draw bounding box
        ctx.strokeRect(x, y, w, h);
        ctx.fillStyle = isMatch ? "#ff00ff40" : color + "20";
        ctx.fillRect(x, y, w, h);
      }

      // Draw text label above the shape
      if (keynote.text) {
        const fontSize = Math.max(10, Math.min(14, h * 0.4));
        ctx.font = `bold ${fontSize}px sans-serif`;

        const textWidth = ctx.measureText(keynote.text).width;
        const labelX = x + w / 2 - textWidth / 2;
        const labelY = y - 4;

        // Background for readability
        ctx.fillStyle = isMatch ? "rgba(255, 0, 255, 0.8)" : "rgba(0, 0, 0, 0.7)";
        ctx.fillRect(labelX - 2, labelY - fontSize, textWidth + 4, fontSize + 2);
        ctx.fillStyle = isMatch ? "#ffffff" : color;
        ctx.fillText(keynote.text, labelX, labelY);
      }

      ctx.globalAlpha = 1;
    }
  }, [pageKeynotes, activeKeynoteFilter, width, height]);

  if (pageKeynotes.length === 0) return null;

  return (
    <canvas
      ref={canvasRef}
      onClick={(e) => {
        // Click on a keynote → filter sidebar to pages with this keynote
        const canvas = canvasRef.current;
        if (!canvas) return;

        const rect = canvas.getBoundingClientRect();
        const clickX = (e.clientX - rect.left) / rect.width;
        const clickY = (e.clientY - rect.top) / rect.height;

        for (const keynote of pageKeynotes) {
          const [left, top, right, bottom] = keynote.bbox;
          if (
            clickX >= left &&
            clickX <= right &&
            clickY >= top &&
            clickY <= bottom
          ) {
            setKeynoteFilter({ shape: keynote.shape, text: keynote.text });
            break;
          }
        }
      }}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: `${width}px`,
        height: `${height}px`,
        pointerEvents: "auto",
        transform: cssScale !== 1 ? `scale(${cssScale})` : undefined,
        transformOrigin: "top left",
        cursor: "pointer",
      }}
    />
  );
}
