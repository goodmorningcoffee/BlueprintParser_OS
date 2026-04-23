import type { TextractLine } from "@/types";

export interface LineFeature {
  line: TextractLine;
  top: number;
  bottom: number;
  left: number;
  right: number;
  height: number;
  firstWord: string;
  upperText: string;
}

export const RE_NUMBERED_ITEM = /^\s*\(?(\d{1,3})\s*[.):]\s*/;

export function buildLineFeatures(lines: readonly TextractLine[]): LineFeature[] {
  const features: LineFeature[] = [];
  for (const line of lines) {
    if (!line.words || line.words.length === 0) continue;
    if (!line.text || line.text.trim().length === 0) continue;
    features.push({
      line,
      top: line.bbox[1],
      bottom: line.bbox[1] + line.bbox[3],
      left: line.bbox[0],
      right: line.bbox[0] + line.bbox[2],
      height: line.bbox[3],
      firstWord: line.words[0].text,
      upperText: line.text.toUpperCase(),
    });
  }
  return features;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
