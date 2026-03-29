# Plan: Keynote / Table / Schedule / Legend Parsing Pipeline

## Date: March 29, 2026 — Early Design Phase

---

## Overview

One pipeline with specialized handlers. Classification is already built (Systems 1-3). This plan covers **System 4: the actual parsing** that extracts structured data from classified regions, plus the **YOLO-tag-mapping** step that links parsed keynotes back to drawing symbols.

---

## Architecture

```
Table/Schedule/Keynote Pipeline
├── Shared: Region detection + classification (Systems 1-3 — ALREADY BUILT)
│   ├── text-region-classifier.ts (System 1 — OCR structure)
│   ├── heuristic-engine.ts (System 2 — YOLO + keyword rules)
│   └── table-classifier.ts (System 3 — meta-classification)
│
├── Shared: Region cropping + OCR extraction utilities
│   ├── Crop page image to classified region bbox
│   ├── Extract OCR words within region (already have bbox intersection math)
│   └── Optionally send cropped image to visual LLM for structured extraction
│
├── Handler: ScheduleParser
│   ├── Input: classified "door-schedule", "finish-schedule", "material-schedule" regions
│   ├── Strategy: Column boundary detection from X-coordinate clustering of OCR words
│   ├── Identify header row (first row, often bold/larger text)
│   ├── Column A = tag/item number (strong anchor — almost always present)
│   ├── Extract cell-by-cell using column boundaries + row Y-gaps
│   ├── Fallback: Textract AnalyzeDocument TABLES mode, or visual LLM (GPT-4o/Mistral)
│   ├── Output: { headers: string[], rows: { [column]: string }[], csiTags: CsiCode[] }
│   └── CSI tag the schedule (door schedule → Div 08, finish schedule → Div 09)
│
├── Handler: KeynoteParser
│   ├── Input: classified "keynote-table" regions
│   ├── Strategy: Spatial proximity pairing — find tag on left, description on right
│   ├── Tags may be inside YOLO shapes (ovals, hexagons, rectangles) — use shape bbox
│   ├── If no YOLO shapes, use OCR text patterns (short alphanumeric on left, long text on right)
│   ├── Domain rule: Keynotes are PAGE-SPECIFIC (key "01" on A-100 ≠ "01" on E-100)
│   ├── Output: { pageNumber, keynotes: { key: string, description: string, shapeBbox?: bbox }[] }
│   └── Then YOLO-tag-mapping step (see below)
│
├── Handler: LegendParser
│   ├── Input: classified "symbol-legend" regions
│   ├── Strategy: YOLO shape detection + adjacent text pairing
│   ├── Symbols are visual (images/shapes OCR can't read) — YOLO class is the key
│   ├── Pair each YOLO detection in the legend with its nearest text description
│   ├── Output: { symbols: { yoloClass: string, description: string, bbox: bbox }[] }
│   └── Cross-reference with YOLO detections on drawing pages (same as tag-mapping)
│
└── Handler: NotesParser
    ├── Input: classified "general-notes" regions, noteBlocks from page-analysis.ts
    ├── Strategy: Mostly already built in page-analysis.ts detectNoteBlocks()
    ├── Enhancement: Detect boilerplate vs page-specific notes (cross-page text frequency)
    ├── Output: { title: string, notes: string[], isBoilerplate: boolean[] }
    └── CSI tag each note based on keyword content
```

---

## YOLO-Tag-Mapping Step (Post-Parse)

After keynotes/legends are parsed, link them to YOLO detections on the drawing:

1. KeynoteParser produces `{ key: "01", description: "verify conduit routing", shapeClass: "oval" }` from the keynote table
2. On the same page, find all YOLO detections of class "oval" (or whatever shape the keynote uses)
3. For each YOLO detection, check OCR text inside the bbox (reuse `tag-patterns.ts` intersection logic)
4. If text matches a parsed keynote key ("01") → link detection to keynote description
5. Store link: `{ annotationId, keynoteKey, keynoteDescription, pageNumber }`
6. Result: clicking a keynote symbol on the drawing shows its full description

**Infrastructure already exists:**
- `tag-patterns.ts` — YOLO bbox ∩ OCR text → group by pattern
- `spatial.ts` — center-in-bbox algorithm, mapWordsToRegions
- `ocr-utils.ts` — shared word/bbox utilities

---

## OCR Strategy Per Handler

| Handler | Primary OCR | Fallback OCR | When to use fallback |
|---------|------------|--------------|---------------------|
| ScheduleParser | Textract word positions (column/row inference) | Textract TABLES mode or visual LLM (Mistral/GPT-4o) | When column detection fails or table has >50 rows |
| KeynoteParser | Textract word positions (spatial pairing) | Visual LLM | Rarely — keynotes are simple enough for positional OCR |
| LegendParser | YOLO shapes + Textract text | Visual LLM | When YOLO doesn't detect legend symbols |
| NotesParser | Textract word positions | N/A | Already works with current OCR |

**Cofounder's code reference:** `schedule_table_parse_LS_INSPIRATION_donotPUSH/blueprint_parser_lambda-main/table_parse/`
- `LLM_ocr.py` — GPT-4o-mini table-to-CSV prompt + Mistral OCR markdown→table parser (both work in practice)
- `table_outline_detect.py` — OpenCV line detection for grid-based tables
- `table_parser.py` — orchestrator with AWS/YOLO overlap filtering

---

## Shared Output Format

All handlers produce structured data stored in `pageIntelligence.parsedRegions[]`:

```typescript
interface ParsedRegion {
  id: string;
  type: "schedule" | "keynote" | "legend" | "notes";
  category: string;              // "door-schedule", "keynote-table", "symbol-legend", etc.
  bbox: BboxLTWH;               // region location on page
  confidence: number;
  csiTags?: CsiCode[];
  data: ScheduleData | KeynoteData | LegendData | NotesData;
}

interface ScheduleData {
  headers: string[];
  rows: Record<string, string>[];  // { "TAG": "D-01", "TYPE": "Hollow Metal", "WIDTH": "3'-0\"" }
  tagColumn?: string;              // which column has the item tags
}

interface KeynoteData {
  keynotes: { key: string; description: string; shapeClass?: string }[];
  isPageSpecific: boolean;         // always true by default
}

interface LegendData {
  symbols: { yoloClass: string; description: string }[];
}

interface NotesData {
  title: string;
  notes: string[];
  isBoilerplate?: boolean[];
}
```

---

## Viewer UI: Semi-Manual Parsing Tool

A viewer tool (its own button/menu) for manual table definition and correction:

**Sub-menus:**
- **Tables/Schedules** — draw BB around table, system auto-detects columns/rows, user corrects
- **Keynotes** — draw BB around keynote table, draw BBs around individual keys (OCR auto-suggests tag text), draw BBs around descriptions (OCR auto-suggests text)
- **Symbol Legends** — draw BB around legend, system uses YOLO to detect symbols, user pairs with descriptions
- **Notes** — draw BB around notes block, system extracts numbered items

**Shared UX pattern:**
1. User draws BB around region (or selects auto-detected region from Page Intelligence panel)
2. System runs appropriate handler, shows preliminary parse results
3. User reviews/edits structured output inline
4. "Accept" saves to pageIntelligence.parsedRegions
5. "Export CSV" downloads the parsed table as CSV

**Auto-parse button:** Runs all handlers on all classified regions automatically. User then reviews results.

---

## Build Order

1. **ScheduleParser** — highest user value (people pay for table-to-CSV). Start with OCR column detection on medium tables. Add Textract TABLES mode fallback.
2. **KeynoteParser** — high LLM value. Simple spatial pairing + YOLO-tag-mapping.
3. **YOLO-tag-mapping** — links parsed keynotes/legends to drawing symbols. Reuses tag-patterns.ts.
4. **LegendParser** — similar to KeynoteParser but with YOLO shape focus.
5. **NotesParser enhancement** — boilerplate detection via cross-page frequency analysis.
6. **Viewer UI** — manual definition/correction tool. Build after automated handlers work.
7. **Visual LLM integration** — add Mistral/GPT-4o as fallback OCR for complex tables.
8. **Admin OCR sub-menu** — configure base OCR + table OCR providers.

---

## Dependencies

- Systems 1-3 (classification) — ALREADY BUILT
- tag-patterns.ts + spatial.ts (bbox intersection) — ALREADY BUILT
- CSI universal tagging — ALREADY BUILT
- Page Intelligence panel (to display parsed results) — ALREADY BUILT
- OCR provider abstraction (for swappable table OCR) — NOT BUILT, needed for step 7

---

## Open Questions

1. Should parsed schedule data be stored in `pageIntelligence.parsedRegions` or its own JSONB column on pages? (JSONB is flexible, parsedRegions keeps everything together)
2. For the viewer UI manual parsing tool — should it be a new panel or a mode within the existing annotation system? (Probably a new panel — it has different interactions than markup/takeoff)
3. How do we handle multi-page tables (schedule continues across 2+ sheets)? Defer to future — flag as "continued" and let user manually link.
4. Export format: CSV only, or also JSON/Excel? (Start CSV, add others later)
