// [census F2 2026-10-24] Pure helpers: the stored per-page record, the project summary, the guarded
// reader and the viewer line.
import { describe, expect, it } from "vitest";
import {
  channelsLine,
  pageChannelsByNumber,
  pageChannelsRecord,
  SCANNED_PAGES_CAP,
  storedPageChannels,
  summarizeChannels,
  type PdfChannelsPage,
  type PdfChannelsResult,
} from "@/lib/pdf-channels";

const page = (pageNumber: number, kind: PdfChannelsPage["kind"], extra: Partial<PdfChannelsPage> = {}): PdfChannelsPage => ({
  pageNumber, kind, widthPt: 2592, heightPt: 1728, rotation: 0, textChars: kind === "scanned" || kind === "blank" ? 0 : 500,
  textWords: 80, fonts: 2, images: kind === "scanned" ? 1 : 0, fullPageImage: kind === "scanned", vectorPaths: kind === "vector" ? 12345 : 3,
  formXObjects: 1, annots: 0, links: 0, ms: 40, ...extra,
});

const result = (pages: PdfChannelsPage[], extra: Partial<PdfChannelsResult> = {}): PdfChannelsResult => ({
  status: "ok", v: 1, pageCount: pages.length, ocgLayers: 4, producer: "Some CAD exporter", creator: "x", encrypted: false,
  truncated: false, seconds: 1, pages, ...extra,
});

describe("pageChannelsRecord", () => {
  it("keeps counts + kind, drops ms/slow/pageNumber; capped only when set", () => {
    expect(pageChannelsRecord(page(3, "vector", { slow: true }))).toEqual({
      v: 1, kind: "vector", textChars: 500, textWords: 80, fonts: 2, images: 0, fullPageImage: false, vectorPaths: 12345,
      formXObjects: 1, annots: 0, links: 0, widthPt: 2592, heightPt: 1728, rotation: 0,
    });
    expect(pageChannelsRecord(page(3, "vector", { capped: true, vectorPaths: 200000 }))).toMatchObject({ capped: true, vectorPaths: 200000 });
  });
  it("a failed or kind-less page has no record; junk counts become 0", () => {
    expect(pageChannelsRecord({ pageNumber: 2, error: "budget" })).toBeNull();
    expect(pageChannelsRecord({ pageNumber: 2, kind: "nonsense" as never })).toBeNull();
    expect(pageChannelsRecord({ pageNumber: 2, kind: "blank", textChars: -4, images: Number.NaN })).toMatchObject({ textChars: 0, images: 0, widthPt: 0 });
  });
});

describe("summarizeChannels", () => {
  it("counts kinds, shares over READ pages, lists scanned pages, keeps ocg/producer/truncated", () => {
    const r = result([page(1, "vector"), page(2, "vector"), page(3, "scanned"), page(4, "text-only"), page(5, "mixed", { textChars: 0 }), { pageNumber: 6, error: "budget" }], { truncated: true });
    expect(summarizeChannels(r, new Date("2026-10-24T00:00:00Z"))).toEqual({
      v: 1, computedAt: "2026-10-24T00:00:00.000Z", pages: 6, failedPages: 1,
      kinds: { vector: 2, "text-only": 1, scanned: 1, mixed: 1, blank: 0 },
      textLayerShare: 0.6, vectorShare: 0.6, scannedPages: [3], ocgLayers: 4, producer: "Some CAD exporter", truncated: true,
    });
  });
  it("caps the scanned page list; an empty census has zero shares", () => {
    const many = result(Array.from({ length: SCANNED_PAGES_CAP + 10 }, (_, i) => page(i + 1, "scanned")));
    const s = summarizeChannels(many);
    expect(s.scannedPages).toHaveLength(SCANNED_PAGES_CAP);
    expect(s.kinds.scanned).toBe(SCANNED_PAGES_CAP + 10);
    expect(summarizeChannels(result([]))).toMatchObject({ pages: 0, textLayerShare: 0, vectorShare: 0, scannedPages: [] });
  });
  it("pageChannelsByNumber maps only readable pages", () => {
    const m = pageChannelsByNumber(result([page(1, "blank"), { pageNumber: 2, error: "boom" }, page(3, "vector")]));
    expect([...m.keys()]).toEqual([1, 3]);
  });
});

describe("storedPageChannels + channelsLine", () => {
  it("reads only a v1 record", () => {
    const record = pageChannelsRecord(page(1, "vector"))!;
    expect(storedPageChannels({ channels: record, other: 1 })).toEqual(record);
    expect(storedPageChannels(null)).toBeUndefined();
    expect(storedPageChannels({ channels: { ...record, v: 2 } })).toBeUndefined();
    expect(storedPageChannels({ channels: [] })).toBeUndefined();
    expect(storedPageChannels({ channels: { v: 1, kind: "vector" } })).toBeUndefined();
  });
  it("renders the one panel line", () => {
    expect(channelsLine({ ...pageChannelsRecord(page(1, "vector"))!, images: 2 })).toBe("PDF layer: text ✓ · 12,345 vector paths · 2 images · vector");
    expect(channelsLine(pageChannelsRecord(page(1, "scanned", { vectorPaths: 1 }))!)).toBe("PDF layer: text ✗ · 1 vector path · 1 image · scanned");
    expect(channelsLine({ ...pageChannelsRecord(page(1, "vector"))!, vectorPaths: 200000, capped: true })).toBe(
      "PDF layer: text ✓ · ≥200,000 vector paths · 0 images · vector",
    );
  });
});
