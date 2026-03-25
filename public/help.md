# BlueprintParser — Viewer Tools Guide

## PDF Navigation
- **Page sidebar** (left): Click any page thumbnail to navigate. Pages show drawing numbers extracted from title blocks.
- **Zoom**: Ctrl+scroll to zoom, or use the +/- buttons and Fit button in the toolbar.
- **Pan**: Select "Pan" mode and click-drag to scroll around the blueprint.

## Search
- **Text search** (top right): Search across all pages. Results highlight matching words in magenta on the blueprint and filter the page sidebar to show only matching pages.
- **Exact phrase**: Wrap your query in quotes for exact phrase matching.

## YOLO Object Detection
- **Toggle**: Click the purple "YOLO" button to show/hide AI-detected objects (doors, windows, text boxes, symbols, etc.).
- **Confidence slider**: Adjust the threshold to filter detections by confidence score. Lower = more detections, higher = only high-confidence ones.
- **Filter by class**: Click any detection label in the annotation panel (bottom) to filter pages to only those containing that object type. The page sidebar shows how many instances are on each page.

## AI Chat
- **Open**: Click the "Chat" button to open the AI assistant panel.
- **Page scope**: Ask questions about the current page — the AI sees the OCR text and detected objects for that page.
- **Project scope**: Switch to "Project" to ask questions across all pages (text is truncated to fit context).
- **Example questions**: "What doors are on this page?", "Summarize the specifications", "What CSI codes are referenced?", "How many windows are in this project?"

## Quantity Takeoff (QTO)
- **Open**: Click the green "QTO" button to open the takeoff panel.
- **Count (EA) tab**: Create named count items with shapes and colors. Click on the blueprint to place count markers. Great for counting doors, fixtures, outlets, etc.
- **Area (SF) tab**: Measure surface areas by drawing polygons.
  1. **Set Scale**: Click "Set Scale", then click two points on a known dimension (like a scale bar), and enter the real-world distance.
  2. **Create area item**: Give it a name and color.
  3. **Draw polygon**: Click to place vertices. Click the first point (it glows when you're close) to close the polygon. Press Enter or double-click to close.
  4. **Area calculation**: The polygon fills with color and shows the calculated area at its center.
- **CSV Export**: Click "CSV" to download all takeoff data (both count and area items).

## Annotations / Markups
- **Add Markup**: Select "Add Markup" mode, then click-drag to draw a rectangle. Enter a label name.
- **Move Markup**: Select "Move Markup" mode to reposition or resize existing annotations.
- **Pointer**: Click on any annotation, keynote, or detection to select it. Press Delete to remove.
- **Keynote filtering**: Click a detected keynote symbol on the blueprint to filter pages containing that keynote.

## Trade & CSI Filtering
- **Trade filter** (toolbar dropdown): Filter pages by construction trade (Electrical, Mechanical, etc.).
- **CSI code filter** (toolbar dropdown): Filter by specific CSI division codes detected in the OCR text.

## Keyboard Shortcuts
- Arrow Left/Right or PageUp/PageDown: Navigate pages
- Home/End: Jump to first/last page
- Ctrl +/-/0: Zoom in/out/fit
- Escape: Cancel current action (polygon drawing, calibration, etc.)
- Ctrl+Z: Undo last polygon vertex while drawing
- Delete/Backspace: Delete selected annotation
