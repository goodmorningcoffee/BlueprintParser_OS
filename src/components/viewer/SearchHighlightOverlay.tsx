"use client";

import { useEffect, useRef, useMemo } from "react";
import { useViewerStore } from "@/stores/viewerStore";
import type { SearchWordMatch, TextractWord } from "@/types";

interface SearchHighlightOverlayProps {
  width: number;
  height: number;
  cssScale: number;
}

/**
 * Find Textract words that match a phrase (consecutive word sequence).
 * Returns matching word bboxes in SearchWordMatch format.
 */
function findPhraseMatches(
  words: TextractWord[],
  phrase: string
): SearchWordMatch[] {
  const phraseWords = phrase.toLowerCase().replace(/-/g, " ").split(/\s+/).filter(Boolean);
  if (phraseWords.length === 0 || words.length === 0) return [];

  const matches: SearchWordMatch[] = [];
  const limit = words.length - phraseWords.length;

  for (let i = 0; i <= limit; i++) {
    let allMatch = true;
    for (let j = 0; j < phraseWords.length; j++) {
      if (words[i + j].text.toLowerCase().replace(/-/g, " ") !== phraseWords[j]) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) {
      for (let j = 0; j < phraseWords.length; j++) {
        matches.push({ text: words[i + j].text, bbox: words[i + j].bbox });
      }
    }
  }
  return matches;
}

/**
 * Canvas overlay that draws yellow highlight boxes at word-level
 * bounding box positions for search matches and CSI code matches.
 */
export default function SearchHighlightOverlay({
  width,
  height,
  cssScale,
}: SearchHighlightOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pageNumber = useViewerStore((s) => s.pageNumber);
  const searchMatches = useViewerStore((s) => s.searchMatches);
  const activeCsiFilter = useViewerStore((s) => s.activeCsiFilter);
  const csiCodes = useViewerStore((s) => s.csiCodes);
  const textractData = useViewerStore((s) => s.textractData);

  const searchHits = searchMatches[pageNumber] || [];

  // Compute CSI highlight matches: find words that triggered the active CSI code
  const csiHits = useMemo(() => {
    if (!activeCsiFilter) return [];
    const pageCsi = csiCodes[pageNumber] || [];
    const matchingCode = pageCsi.find((c) => c.code === activeCsiFilter);
    if (!matchingCode) return [];

    const pageWords = textractData[pageNumber]?.words;
    if (!pageWords || pageWords.length === 0) return [];

    // Use the CSI description as the trigger phrase
    return findPhraseMatches(pageWords, matchingCode.description);
  }, [activeCsiFilter, csiCodes, textractData, pageNumber]);

  const allMatches = searchHits.length > 0 || csiHits.length > 0;

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

    // Draw search highlight rectangles (magenta)
    if (searchHits.length > 0) {
      ctx.fillStyle = "rgba(255, 0, 180, 0.3)";
      ctx.strokeStyle = "rgba(255, 0, 180, 0.8)";
      ctx.lineWidth = 1.5;

      for (const match of searchHits) {
        const [left, top, w, h] = match.bbox;
        const x = left * width;
        const y = top * height;
        const rw = w * width;
        const rh = h * height;
        ctx.fillRect(x, y, rw, rh);
        ctx.strokeRect(x, y, rw, rh);
      }
    }

    // Draw CSI highlight rectangles (slightly different tint — orange-yellow)
    if (csiHits.length > 0) {
      ctx.fillStyle = "rgba(255, 180, 0, 0.4)";
      ctx.strokeStyle = "rgba(255, 150, 0, 0.9)";
      ctx.lineWidth = 1.5;

      for (const match of csiHits) {
        const [left, top, w, h] = match.bbox;
        const x = left * width;
        const y = top * height;
        const rw = w * width;
        const rh = h * height;
        ctx.fillRect(x, y, rw, rh);
        ctx.strokeRect(x, y, rw, rh);
      }
    }
  }, [searchHits, csiHits, width, height]);

  if (!allMatches) return null;

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: `${width}px`,
        height: `${height}px`,
        pointerEvents: "none",
        transform: cssScale !== 1 ? `scale(${cssScale})` : undefined,
        transformOrigin: "top left",
      }}
    />
  );
}
