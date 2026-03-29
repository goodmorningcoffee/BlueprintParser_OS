"use client";

import { useEffect, useRef, useMemo, memo } from "react";
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
export function findPhraseMatches(
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
 * Find individual words from a description that appear in OCR word array.
 * Used as fallback when CSI detection was Tier 2/3 (bag-of-words) and
 * findPhraseMatches fails (words aren't consecutive on page).
 */
const STOP_WORDS = new Set([
  "and", "the", "of", "for", "in", "on", "to", "a", "an", "or",
  "with", "by", "not", "is", "are", "at", "from", "as", "all", "other",
]);

function findWordMatches(
  words: TextractWord[],
  description: string,
): SearchWordMatch[] {
  const descTokens = description
    .toLowerCase()
    .replace(/[-/()]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  if (descTokens.length === 0) return [];

  const descSet = new Set(descTokens);
  return words
    .filter((w) => descSet.has(w.text.toLowerCase().replace(/[-/()]/g, " ")))
    .map((w) => ({ text: w.text, bbox: w.bbox }));
}

/**
 * Canvas overlay that draws highlight boxes at word-level
 * bounding box positions for search matches and CSI code matches.
 */
export default memo(function SearchHighlightOverlay({
  width,
  height,
  cssScale,
}: SearchHighlightOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pageNumber = useViewerStore((s) => s.pageNumber);
  const searchMatches = useViewerStore((s) => s.searchMatches);
  const searchQuery = useViewerStore((s) => s.searchQuery);
  const activeCsiFilter = useViewerStore((s) => s.activeCsiFilter);
  const activeTradeFilter = useViewerStore((s) => s.activeTradeFilter);
  const csiCodes = useViewerStore((s) => s.csiCodes);
  const textractData = useViewerStore((s) => s.textractData);

  const searchHits = searchMatches[pageNumber] || [];

  // Instant local search highlights (no API wait) — fallback when searchMatches empty
  const localSearchHits = useMemo(() => {
    if (!searchQuery || searchQuery.trim().length === 0) return [];
    if (searchHits.length > 0) return []; // API results available, don't double-draw

    const pageWords = textractData[pageNumber]?.words;
    if (!pageWords || pageWords.length === 0) return [];

    const queryLower = searchQuery.toLowerCase().trim();
    const queryTokens = queryLower.split(/\s+/);

    // Single word: match OCR words containing the query
    if (queryTokens.length === 1) {
      return pageWords
        .filter((w) => w.text.toLowerCase().includes(queryTokens[0]))
        .map((w) => ({ text: w.text, bbox: w.bbox }));
    }

    // Multi-word: try phrase first, fall back to individual words
    const phraseHits = findPhraseMatches(pageWords, searchQuery);
    if (phraseHits.length > 0) return phraseHits;

    const tokenSet = new Set(queryTokens.filter((t) => t.length > 1));
    return pageWords
      .filter((w) => tokenSet.has(w.text.toLowerCase()))
      .map((w) => ({ text: w.text, bbox: w.bbox }));
  }, [searchQuery, searchHits.length, textractData, pageNumber]);

  // CSI highlight: try phrase match first (Tier 1), fall back to word match (Tier 2/3)
  const csiHits = useMemo(() => {
    if (!activeCsiFilter) return [];
    const pageCsi = csiCodes[pageNumber] || [];
    const matchingCode = pageCsi.find((c) => c.code === activeCsiFilter);
    if (!matchingCode) return [];

    const pageWords = textractData[pageNumber]?.words;
    if (!pageWords || pageWords.length === 0) return [];

    const phraseHits = findPhraseMatches(pageWords, matchingCode.description);
    if (phraseHits.length > 0) return phraseHits;
    return findWordMatches(pageWords, matchingCode.description);
  }, [activeCsiFilter, csiCodes, textractData, pageNumber]);

  // Trade highlight: phrase match + word fallback for each code, plus trade name words
  const tradeHits = useMemo(() => {
    if (!activeTradeFilter) return [];
    const pageCsi = csiCodes[pageNumber] || [];
    const matchingCodes = pageCsi.filter((c) => c.trade === activeTradeFilter);
    if (matchingCodes.length === 0) return [];

    const pageWords = textractData[pageNumber]?.words;
    if (!pageWords || pageWords.length === 0) return [];

    const hits: SearchWordMatch[] = [];
    for (const code of matchingCodes) {
      const phraseHits = findPhraseMatches(pageWords, code.description);
      if (phraseHits.length > 0) {
        hits.push(...phraseHits);
      } else {
        hits.push(...findWordMatches(pageWords, code.description));
      }
    }
    // Also match the trade name itself as individual words
    const tradeWords = activeTradeFilter.toLowerCase().split(/\s+/);
    for (const word of pageWords) {
      if (tradeWords.includes(word.text.toLowerCase()) && !hits.some((h) => h.bbox === word.bbox)) {
        hits.push({ text: word.text, bbox: word.bbox });
      }
    }
    return hits;
  }, [activeTradeFilter, csiCodes, textractData, pageNumber]);

  // Merge API search hits with local fallback
  const effectiveSearchHits = searchHits.length > 0 ? searchHits : localSearchHits;
  const allMatches = effectiveSearchHits.length > 0 || csiHits.length > 0 || tradeHits.length > 0;

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

    const drawHighlights = (matches: SearchWordMatch[], color: string, stroke: string) => {
      if (matches.length === 0) return;
      ctx.fillStyle = color;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.5;
      for (const match of matches) {
        const [left, top, w, h] = match.bbox;
        const x = left * width;
        const y = top * height;
        const rw = w * width;
        const rh = h * height;
        ctx.fillRect(x, y, rw, rh);
        ctx.strokeRect(x, y, rw, rh);
      }
    };

    drawHighlights(effectiveSearchHits, "rgba(255, 0, 180, 0.3)", "rgba(255, 0, 180, 0.8)");
    drawHighlights(csiHits, "rgba(255, 0, 180, 0.3)", "rgba(255, 0, 180, 0.8)");
    drawHighlights(tradeHits, "rgba(255, 0, 180, 0.3)", "rgba(255, 0, 180, 0.8)");
  }, [effectiveSearchHits, csiHits, tradeHits, width, height]);

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
});
