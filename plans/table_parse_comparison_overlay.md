# Plan: Table Parse Comparison & Overlay Correction View

## Date: March 29, 2026 — Design Phase

---

## Overview

After a table is parsed (auto or manual), the user needs a way to verify and correct the results against the original blueprint. This plan covers a dedicated comparison view with two modes:

1. **Side-by-side mode**: cropped source image on left, editable parsed table on right
2. **Overlay mode**: parsed table overlaid on the source image with color-coded layers for visual diff

---

## Feature 1: Side-by-Side Comparison View

### What It Does
Opens a dedicated view (new route or modal) where the user sees the original table region cropped from the blueprint image next to the parsed structured data. They can go cell-by-cell correcting OCR errors while looking at the source.

### UX Flow
1. User clicks "Compare" button in TableParsePanel after parsing
2. View opens with two panels:
   - **Left panel**: Cropped image of the table region from the page PNG (at processing resolution)
   - **Right panel**: Editable table grid (same as review grid but larger, more comfortable)
3. User clicks a cell on the right → corresponding region highlights on the left image
4. User corrects cell text, moves to next cell (Tab key navigation)
5. "Done" closes the view, saves corrections back to the parsed grid

### Technical Implementation

**Cropping the source image:**
- Page PNGs already exist in S3 from processing (300 DPI)
- Crop using the `tableParseRegion` bbox (normalized 0-1 → pixel coordinates at page image resolution)
- Option A: Server-side crop via API endpoint (return cropped PNG)
- Option B: Client-side crop using canvas drawImage with source rect (page image already loaded in viewer)
- **Recommended: Client-side** — page image is already in the browser, canvas crop is instant

**Cell-to-source highlighting:**
- Each cell maps to a word cluster at known bbox positions (from the parse step)
- When user clicks a cell, draw a highlight rectangle on the left image at the corresponding word positions
- Uses the same normalized coordinates, just scaled to the cropped image dimensions

**Route or modal?**
- Modal keeps context (page, project) without navigation
- But the comparison view needs screen real estate — a fullscreen modal or a new route `/viewer/[id]/table-compare` both work
- **Recommended: Fullscreen modal** — simpler, no routing changes, dismiss with Escape

### Data Flow
```
TableParsePanel (parsed grid + region bbox)
  → "Compare" button click
  → ComparisonModal opens
  → Fetches page image (already in browser cache or S3)
  → Crops to region bbox using client-side canvas
  → Displays side-by-side: cropped image | editable grid
  → On "Done" → saves corrections back to tableParsedGrid in store
```

---

## Feature 2: Overlay Mode (Visual Diff)

### What It Does
Overlays the parsed table structure on top of the original image to visually spot discrepancies. Parsed text rendered in translucent blue, original image in red/neutral. Where they align = purple/matching. Where they differ = visible red (original) or blue (parsed-only).

### UX Flow
1. In the comparison view, user clicks "Overlay" toggle button
2. View switches from side-by-side to overlay mode:
   - **Bottom layer**: Original cropped image (tinted red or neutral)
   - **Top layer**: Parsed table rendered as translucent text at the computed cell positions (blue)
3. User can:
   - **Drag** the parsed overlay to reposition (if initial alignment is off)
   - **Resize** the parsed overlay (scale handle at corners) to match the original
   - **Adjust opacity** of the parsed layer (slider)
4. Mismatches visible as color gaps — red showing through means the parsed text doesn't cover that area

### Technical Implementation

**Rendering the parsed overlay:**
- Create a canvas/SVG overlay matching the cropped image dimensions
- For each cell in the parsed grid, render the text at the cell's computed position
- Text rendered in semi-transparent blue (#3b82f680)
- Cell boundaries drawn as thin blue lines

**Alignment:**
- Initial position: parsed cell positions come from OCR word bboxes (already in normalized coords)
- Scale: match cropped image resolution → parsed coords should already align if using same coordinate system
- User can drag to offset (transform: translate) and resize (transform: scale) if auto-alignment is slightly off
- This handles the case where the crop isn't pixel-perfect or the table has slight perspective distortion

**Tinting the original:**
- Apply a CSS filter or canvas composite to tint the original image red-ish
- Or just use the natural grayscale blueprint as-is — the blue parsed overlay stands out enough on white/gray backgrounds
- Red tint is optional — could be toggled

**Scale matching concern:**
- If the page image is 300 DPI and the crop uses normalized 0-1 coordinates, the pixel dimensions of the crop = pageImageWidth * (regionMaxX - regionMinX) × pageImageHeight * (regionMaxY - regionMinY)
- Parsed cell positions are in the same 0-1 normalized space, so scaling to the crop canvas gives pixel-accurate alignment
- No user drag/resize needed in the ideal case — only for correction if something is off

### Canvas Stack
```
<div style="position: relative">
  <!-- Bottom: original cropped image (optionally tinted) -->
  <img src={croppedImageUrl} style="..." />

  <!-- Top: parsed overlay canvas (draggable, resizable) -->
  <canvas
    style="position: absolute; top: 0; left: 0; opacity: overlayOpacity;
           transform: translate(offsetX, offsetY) scale(scaleX, scaleY);"
  />

  <!-- Controls: opacity slider, drag handle, scale corners -->
</div>
```

---

## Feature 3: Row/Column Manual Naming

### What It Does
Allows users to name rows (not just headers/columns). Useful for schedules where row identifiers aren't tags but room numbers or descriptive labels.

### Implementation
- Add a "row label" field to each parsed row (optional)
- In the review grid, show a fixed first column with editable row labels
- Default: row number (1, 2, 3...) or auto-detect from tag column
- User can double-click to rename

---

## Build Order

1. **Row naming in existing grid** — small, add to current TableParsePanel
2. **Side-by-side comparison modal** — client-side image crop + editable grid
3. **Cell-to-source highlighting** — click cell → highlight on image
4. **Tab navigation between cells** — keyboard-driven correction workflow
5. **Overlay mode** — translucent parsed layer on original image
6. **Drag/resize alignment** — for overlay fine-tuning
7. **Opacity slider** — for overlay mode

---

## Dependencies

- Page PNG images accessible in browser (already loaded for viewer — ALREADY EXISTS)
- Canvas API for client-side image cropping (browser native)
- tableParseRegion bbox + parsed grid with cell positions (ALREADY BUILT in this session)
- Word-level bboxes from Textract stored per-page (ALREADY EXISTS)

---

## Open Questions

1. Should this be a fullscreen modal, a slide-over panel, or a new route? Modal is simplest but may feel cramped for large tables.
2. For the overlay mode — should we render parsed text using the exact OCR font size estimates, or use a fixed font? Fixed is simpler but less accurate for alignment.
3. Should the comparison view support editing ALL cells (including adding new rows/columns) or just correcting existing parsed values?
4. Performance: large table images at 300 DPI could be several MB. Should we use a lower resolution for the comparison view, or is full resolution needed for readability?
