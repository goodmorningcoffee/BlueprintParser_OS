// [census F2 2026-10-24] Upload channel census — the shapes. scripts/pdf_channels.py (PyMuPDF)
// reports, per PDF page, which channels the file itself carries: a text layer, vector line-work,
// raster images, form XObjects, annotations, links. Recorded so later tools know which proposers
// can fire (master_plan_2026-10-24 archive_ideas I-18). RECORD ONLY — nothing downstream reads it.
//
// Storage (no migration, no S3 key anywhere — pageIntelligence reaches members and the data export):
//   • pages.pageIntelligence.channels        PageChannelsRecord (counts + kind), server-owned
//   • projects.projectIntelligence.channels  ProjectChannelsSummary (kind counts, shares)

export const CHANNELS_INTELLIGENCE_KEY = "channels";
export const CHANNELS_RECORD_VERSION = 1;

/**
 * Derived per-page kind (definitions live in scripts/pdf_channels.py `classify`; VECTOR_MIN = 50):
 *   vector    ≥ 50 path draws, no full-page image — born-digital line-work
 *   text-only a text layer, < 50 paths, no full-page image — specs, covers, notes
 *   scanned   raster geometry only — a full-page image (text = OCR overlay) or images and no text
 *   mixed     ≥ 50 paths over a full-page image — raster underlay with a vector overlay
 *   blank     no text, no image, < 50 paths
 */
export type ChannelKind = "vector" | "text-only" | "scanned" | "mixed" | "blank";
export const CHANNEL_KINDS: readonly ChannelKind[] = ["vector", "text-only", "scanned", "mixed", "blank"];

/** One page as the script reports it. A failed page carries only pageNumber + error (+ ms). */
export interface PdfChannelsPage {
  pageNumber: number;
  widthPt?: number;
  heightPt?: number;
  rotation?: number;
  textChars?: number;
  textWords?: number;
  fonts?: number;
  images?: number;
  fullPageImage?: boolean;
  vectorPaths?: number;
  capped?: boolean;
  formXObjects?: number;
  annots?: number;
  links?: number;
  kind?: ChannelKind;
  ms?: number;
  slow?: boolean;
  error?: string;
}

/** The script's success line. */
export interface PdfChannelsResult {
  status: "ok";
  v: number;
  pageCount: number;
  ocgLayers: number;
  producer: string | null;
  creator: string | null;
  encrypted: boolean;
  /** The total budget ran out; the remaining pages carry error "budget". */
  truncated: boolean;
  seconds: number;
  pages: PdfChannelsPage[];
}

/** pages.pageIntelligence.channels — the compact per-page record (failed pages get none). */
export interface PageChannelsRecord {
  v: number;
  kind: ChannelKind;
  textChars: number;
  textWords: number;
  fonts: number;
  images: number;
  fullPageImage: boolean;
  vectorPaths: number;
  /** vectorPaths hit the script's maxPaths cap (the true count is higher). */
  capped?: boolean;
  formXObjects: number;
  annots: number;
  links: number;
  widthPt: number;
  heightPt: number;
  rotation: number;
}

/** projects.projectIntelligence.channels. */
export interface ProjectChannelsSummary {
  v: number;
  computedAt: string;
  /** Pages the census reported (failed pages included). */
  pages: number;
  /** Pages the census could not read (per-page error or the budget ran out). */
  failedPages: number;
  kinds: Record<ChannelKind, number>;
  /** Share of censused pages with a text layer (textChars > 0), 0..1, 3 dp. */
  textLayerShare: number;
  /** Share of censused pages whose kind is vector or mixed, 0..1, 3 dp. */
  vectorShare: number;
  /** Page numbers of kind "scanned", first SCANNED_PAGES_CAP only. */
  scannedPages: number[];
  ocgLayers: number;
  producer: string | null;
  truncated: boolean;
}

export const SCANNED_PAGES_CAP = 50;
