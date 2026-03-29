# Plan: Symbol Search (Template Matching) + Auto-QTO Workflow

## Date: March 29, 2026 — Discussion/Design Phase

---

## Overview

Three tiers of symbol detection, no ML training required for the first two:

```
YOLO models     → trained, high accuracy, works across projects (gold standard)
Template match  → zero training, good accuracy WITHIN one project
Manual BB tool  → human fallback, always works
```

This plan covers the template matching tier — a "Symbol Search" tool that finds all instances of a user-selected symbol across a blueprint set, and an auto-QTO workflow that uses these matches to propose takeoff items.

---

## Feature 1: Symbol Search Tool (Viewer)

### What It Does
User crops one instance of a symbol from the blueprint → system finds all matching instances across all pages → results displayed as highlights with page filtering.

### UX Flow
1. User activates "Symbol Search" mode (new toolbar button, or sub-menu)
2. User draws a BB around one instance of the target symbol on the canvas
3. System crops that region from the page image as the template
4. System runs template matching across all page images
5. Results appear:
   - PageSidebar filters to pages with matches (with count badges)
   - Matched locations highlighted on canvas (similar to search highlights or YOLO boxes)
   - Results panel shows: total matches, per-page counts, confidence slider to filter weak matches
6. User reviews, can click to dismiss false positives
7. "Save as Detection Set" stores results for QTO import

### Technical Implementation

**Template extraction:**
- Crop the page PNG at the user's BB coordinates (need page image at processing resolution)
- Store as the template image (in memory or temp S3)

**Matching engine — multiple strategies, try in order:**

1. **OpenCV `matchTemplate`** with `TM_CCOEFF_NORMED`
   - Fastest, works great when symbols are same size/rotation
   - Returns heatmap of match scores, threshold at ~0.7-0.8
   - Run on each page image (300 DPI PNGs already in S3 from processing)

2. **Multi-scale template matching** (for slight size variations)
   - Resize template at 90%, 95%, 100%, 105%, 110%
   - Run matchTemplate at each scale, take best score per location
   - Handles minor scale differences between plan views and detail views

3. **Feature matching (ORB/SIFT)** as fallback
   - Extract keypoints from template and page
   - Match keypoints, filter by geometric consistency (homography)
   - More robust to rotation/perspective but slower
   - Use when matchTemplate returns too few results

**Where it runs:**
- Option A: Server-side Python endpoint (has OpenCV, runs on page PNGs in S3)
- Option B: Client-side with opencv.js (wasm build, runs in browser on loaded page images)
- **Recommended: Server-side** — page images at 300 DPI are large, server has them cached, and we already have Python infrastructure (keynote extraction uses OpenCV)

**New API endpoint:**
```
POST /api/symbol-search
{
  projectId: string,
  templateBbox: [x, y, w, h],     // normalized 0-1 on source page
  sourcePageNumber: number,
  confidenceThreshold: number,     // default 0.75
  searchPages?: number[],          // optional subset, default all
  multiScale: boolean,             // default true
}

Response (streaming NDJSON for progress):
{ type: "progress", page: 3, matches: 5 }
{ type: "progress", page: 4, matches: 0 }
...
{ type: "done", totalMatches: 47, pages: [3,5,8,12,...], results: [
  { pageNumber: 3, bbox: [0.12, 0.34, 0.04, 0.04], confidence: 0.92 },
  ...
]}
```

**Storage:**
- Results stored as a "symbol search session" — temporary or persistent
- Each match has: pageNumber, bbox (normalized), confidence score
- Can be converted to annotations or takeoff items on user action

### Viewer UI Components

**Toolbar:** New "Symbol Search" button (magnifying glass + shape icon?)

**Search mode:** When active, cursor becomes crosshair. User draws BB on canvas. On mouseup, triggers search API.

**Results panel** (reuse DetectionPanel pattern):
- Template preview thumbnail
- Total matches count
- Confidence slider (filter weak matches in real-time)
- Per-page expandable groups with match count
- Click match → navigate to page + highlight
- "Dismiss" individual matches (false positive removal)
- "Create Takeoff Items" button → QTO import
- "Save Search" → persist for later

---

## Feature 2: Parsed Schedule → Tag Mapping → Page Filter

### The Chain
1. **Parse material schedule** → `{ "D-01": "Hollow Metal 3'-0\" x 7'-0\"", "D-02": "Wood 2'-8\"..." }`
2. **Find tag instances** across drawings → either YOLO detections or template matching results
3. **Click tag in parsed table** → filter all pages with that tag → show count per page

### Disambiguation (Not All Hexagons Are Tags)
When matching schedule tags to YOLO/template detections:

- **Text matching** (strongest signal): OCR text inside detection bbox must match a parsed schedule key. "D-01" matches, "4" or "A-501" doesn't.
- **Size filtering**: Schedule tags are consistent size (from the table). Detections within ±20% of that size are candidates.
- **Fuzzy matching**: Handle OCR errors with edit distance ≤1 ("D-O1" → "D-01")

### Schedule Tag Filter UI
- In the parsed schedule viewer (after table is parsed), each tag row is clickable
- Click "D-01" → PageSidebar filters to pages containing "D-01" instances
- Badge shows count: "D-01 (8 pages, 12 instances)"
- Canvas highlights all matched instances on current page
- This works for both YOLO-detected tags AND template-matched tags

---

## Feature 3: Auto-QTO from Template Matching

### Without YOLO (Template Match Only)
1. User does a Symbol Search → finds 47 instances of a duplex symbol
2. Clicks "Create Takeoff Items" in the results panel
3. System creates a takeoff item named after the search (user can rename)
4. Count markers placed at each match bbox center
5. Item appears in QTO panel Count tab with count = 47

### With Parsed Schedule (Template Match + Schedule Data)
1. Schedule parsed → tags extracted with descriptions
2. For each tag, run Symbol Search using the tag symbol from the table as template
3. Each tag becomes a proposed takeoff item:
   - Name: from schedule description ("D-01: Hollow Metal 3'-0\" x 7'-0\"")
   - Count: number of matched instances across drawings
   - Markers: at each match location
   - CSI tag: from schedule CSI classification
4. All proposed items shown in Auto-QTO panel for review
5. User accepts/rejects/edits each item
6. Accepted items become real takeoff items

### Auto-QTO Workflow Sub-Menu
In the QTO panel, alongside "Count" and "Area" tabs, add "Auto QTO" tab:

**Methods available:**
- **From YOLO** — select model + class → propose items from detections (existing plan)
- **From Symbol Search** — select a saved symbol search → propose items from matches (NEW)
- **From Parsed Schedule** — select a parsed schedule → propose items with tag mapping (NEW)

Each method produces the same output: proposed takeoff items with counts and markers. User reviews and accepts.

---

## Feature 4: Cross-Project Considerations

**Material schedules** span multiple pages — door D-01 appears on pages 3, 5, 8, 12. The tag mapping naturally handles this because template matching runs across all pages.

**Keynotes** are page-specific — keynote "01" on page A-100 ≠ "01" on page E-100. The QTO system must scope keynote tag mapping per-page. When creating takeoff items from keynotes, group by page.

**Template reuse** — if the user searches for a duplex symbol in Project A, they might want to reuse that template on Project B (same architect, same symbols). Save templates as reusable assets in a "Symbol Library" (future feature).

---

## Build Order

1. **Symbol Search API** — Python endpoint with OpenCV matchTemplate, multi-scale support
2. **Symbol Search viewer UI** — toolbar button, BB draw mode, results panel
3. **Confidence slider + false positive dismissal** — interactive filtering
4. **"Create Takeoff Items" from search results** — bridge to QTO
5. **Parsed schedule tag mapping** — connect schedule parser output to symbol search
6. **Schedule tag filter UI** — click tag in table → filter pages
7. **Auto-QTO sub-menu** — unified interface for YOLO/template/schedule-based proposals

---

## Dependencies

- Page PNG images in S3 (from processing — ALREADY EXISTS)
- OpenCV available server-side (already used for keynote extraction — ALREADY EXISTS)
- Template matching doesn't need: YOLO models, ML training, or new OCR
- Schedule tag mapping needs: table parsing pipeline (PLANNED, separate plan)
- Auto-QTO needs: takeoff item batch creation API (basic version EXISTS)

---

## Technical Notes

- **Performance**: matchTemplate on a 3000x4000 page at 300 DPI takes ~50-200ms per page. 50 pages = 5-10 seconds total. Acceptable for interactive use with streaming progress.
- **Memory**: Each page image is ~30MB uncompressed. Process one page at a time, don't load all into memory.
- **Multi-scale**: 5 scales × 50 pages = 250 matchTemplate calls. Still under 30 seconds total.
- **opencv.js alternative**: Could run client-side but page images need to be downloaded first. Server-side is faster since images are already in S3.
- **Python endpoint**: Could be a new API route using the existing Python subprocess pattern (same as keynote extraction uses `scripts/extract_keynotes.py`). Or a dedicated FastAPI microservice.

---

## Open Questions

1. Should Symbol Search results be stored as annotations (source: "template-match") or as a separate data structure? Annotations would make them immediately visible on canvas and filterable with existing infrastructure.
2. Should the template library be per-project or per-company? Per-project is simpler. Per-company enables reuse across similar projects.
3. For the Auto-QTO sub-menu — is this a new tab in TakeoffPanel or a new panel entirely? Leaning toward a sub-tab within TakeoffPanel to keep QTO tools together.
4. Should template matching run automatically after schedule parsing (find all tags without user interaction) or only on user request? Auto-run is more magical but could be slow on large projects.
