// [census F2 2026-10-24] Pure helpers over a census result: the compact per-page record stored at
// pageIntelligence.channels, the project summary stored at projectIntelligence.channels, the
// guarded reader for a stored record and the one viewer line. No I/O.

import {
  CHANNEL_KINDS,
  CHANNELS_INTELLIGENCE_KEY,
  CHANNELS_RECORD_VERSION,
  SCANNED_PAGES_CAP,
  type ChannelKind,
  type PageChannelsRecord,
  type PdfChannelsPage,
  type PdfChannelsResult,
  type ProjectChannelsSummary,
} from "./types";

const KIND_SET = new Set<string>(CHANNEL_KINDS);
const isKind = (v: unknown): v is ChannelKind => typeof v === "string" && KIND_SET.has(v);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The stored record for one reported page; null for a failed page (error, or no kind). */
export function pageChannelsRecord(page: PdfChannelsPage): PageChannelsRecord | null {
  if (page.error || !isKind(page.kind)) return null;
  const record: PageChannelsRecord = {
    v: CHANNELS_RECORD_VERSION,
    kind: page.kind,
    textChars: count(page.textChars),
    textWords: count(page.textWords),
    fonts: count(page.fonts),
    images: count(page.images),
    fullPageImage: page.fullPageImage === true,
    vectorPaths: count(page.vectorPaths),
    formXObjects: count(page.formXObjects),
    annots: count(page.annots),
    links: count(page.links),
    widthPt: num(page.widthPt),
    heightPt: num(page.heightPt),
    rotation: num(page.rotation),
  };
  if (page.capped) record.capped = true;
  if (page.estimated) record.estimated = true;
  return record;
}

/** pageNumber → stored record, for every page the census could read. */
export function pageChannelsByNumber(result: PdfChannelsResult): Map<number, PageChannelsRecord> {
  const out = new Map<number, PageChannelsRecord>();
  for (const page of result.pages) {
    const record = pageChannelsRecord(page);
    if (record && Number.isInteger(page.pageNumber)) out.set(page.pageNumber, record);
  }
  return out;
}

const share = (part: number, whole: number): number => (whole > 0 ? Math.round((part / whole) * 1000) / 1000 : 0);

/** The project summary (projectIntelligence.channels). */
export function summarizeChannels(result: PdfChannelsResult, now: Date = new Date()): ProjectChannelsSummary {
  const kinds = Object.fromEntries(CHANNEL_KINDS.map((k) => [k, 0])) as Record<ChannelKind, number>;
  let read = 0;
  let withText = 0;
  const scannedPages: number[] = [];
  for (const page of result.pages) {
    const record = pageChannelsRecord(page);
    if (!record) continue;
    read++;
    kinds[record.kind]++;
    if (record.textChars > 0) withText++;
    if (record.kind === "scanned" && scannedPages.length < SCANNED_PAGES_CAP) scannedPages.push(page.pageNumber);
  }
  return {
    v: CHANNELS_RECORD_VERSION,
    computedAt: now.toISOString(),
    pages: result.pages.length,
    failedPages: result.pages.length - read,
    kinds,
    textLayerShare: share(withText, read),
    vectorShare: share(kinds.vector + kinds.mixed, read),
    scannedPages,
    ocgLayers: count(result.ocgLayers),
    producer: typeof result.producer === "string" ? result.producer.slice(0, 120) : null,
    truncated: result.truncated === true,
  };
}

/** A stored per-page record, or undefined when absent / not the v1 shape. */
export function storedPageChannels(pageIntelligence: unknown): PageChannelsRecord | undefined {
  if (!pageIntelligence || typeof pageIntelligence !== "object") return undefined;
  const stored = (pageIntelligence as Record<string, unknown>)[CHANNELS_INTELLIGENCE_KEY];
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return undefined;
  const r = stored as Record<string, unknown>;
  if (r.v !== CHANNELS_RECORD_VERSION || !isKind(r.kind) || typeof r.vectorPaths !== "number") return undefined;
  return stored as PageChannelsRecord;
}

/** "PDF layer: text ✓ · 12,345 vector paths · 2 images · vector" */
export function channelsLine(record: PageChannelsRecord): string {
  const plural = (n: number, one: string) => `${n.toLocaleString("en-US")} ${one}${n === 1 ? "" : "s"}`;
  const paths = `${record.capped ? "≥" : record.estimated ? "~" : ""}${plural(record.vectorPaths, "vector path")}`;
  return `PDF layer: text ${record.textChars > 0 ? "✓" : "✗"} · ${paths} · ${plural(record.images, "image")} · ${record.kind}`;
}
