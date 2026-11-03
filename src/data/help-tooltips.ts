/**
 * Centralized tooltip content for Help Mode (`helpMode` in the UI store — hover tips).
 * Edit THIS FILE to change any tooltip wording — no component changes needed.
 *
 * Every id here is used by a `<HelpTooltip>` under src/components, and every wrapper's id has an
 * entry here; `src/data/__tests__/help-tooltips.test.ts` checks both directions. Ids are string
 * literals, except TextPanel's tab bar, which the test expands by hand (`text-tab-<tab>`).
 * (The 2026-11 review found 52 entries for controls that no longer existed and 5 wrappers with no
 * entry, so hovering those buttons showed nothing.)
 *
 * Format: { title: "Short Name", body: "What it does. How to use it." }
 */
export const HELP_TOOLTIPS: Record<string, { title: string; body: string }> = {

  // ═══════════════════════════════════════════════════════════
  // TOOLBAR MODES
  // ═══════════════════════════════════════════════════════════
  "pointer-mode": {
    title: "Pointer/Select",
    body: "Double-click any OCR'd word on the blueprint to search all pages for it. Select and edit all annotations — click a markup to see the edit (pencil) and delete (x) icons. Drag selected markups to reposition them. Double-click any annotation to filter pages showing that item. Shortcut: A.",
  },
  "pan-mode": {
    title: "Pan/Zoom",
    body: "Click and drag to scroll around the blueprint. Mouse wheel zooms in this mode. Tip: Ctrl + scroll wheel zooms in ANY mode, so you rarely need to switch here. Shortcut: V; hold V while another tool is active to pan temporarily.",
  },
  "group-mode": {
    title: "Group / Select",
    body: "Drag on empty canvas to lasso annotations; click annotations to toggle them. With 2 or more selected, a bar at the bottom of the screen offers Group, Add to… (an existing group) and Delete.",
  },
  "markup-mode": {
    title: "Add Markup",
    body: "Click and drag to draw a rectangle on the blueprint. A dialog will ask for a name and optional notes — notes are visible in the Text panel's Markups tab and are shared with the AI chat for context.",
  },

  // ═══════════════════════════════════════════════════════════
  // ZOOM
  // ═══════════════════════════════════════════════════════════
  "zoom-in": {
    title: "Zoom In",
    body: "Increase zoom level. Shortcut: Ctrl + scroll wheel works in any mode.",
  },
  "zoom-out": {
    title: "Zoom Out",
    body: "Decrease zoom level. Shortcut: Ctrl + scroll wheel works in any mode.",
  },
  "zoom-fit": {
    title: "Fit to Window",
    body: "Fit the whole page in the window (adapts to open side panels) and scroll it into view. Shortcut: Ctrl/Cmd + 0.",
  },

  // ═══════════════════════════════════════════════════════════
  // MENU
  // ═══════════════════════════════════════════════════════════
  "menu-button": {
    title: "Menu",
    body: "Data Labeling (Label Studio integration), Settings, the Admin page, and the two help switches: Help mode turns these hover tips on and off, Help banner shows a one-line legend of the toolbar buttons.",
  },

  // ═══════════════════════════════════════════════════════════
  // SEARCH & FILTERS
  // ═══════════════════════════════════════════════════════════
  "search-bar": {
    title: "Text Search",
    body: "Search OCR-extracted text across all pages. Matching pages are filtered in the sidebar with word-count badges. Words are highlighted in magenta on the blueprint. Tip: double-click any word on the blueprint to auto-populate this search box.",
  },
  "trade-filter": {
    title: "Trade Filter",
    body: "Filter pages by construction trade (Electrical, Mechanical, Plumbing, etc.). Based on CSI code detection. Matching text is highlighted on the blueprint. Select 'All Trades' to clear the filter.",
  },
  "csi-filter": {
    title: "CSI Code Filter",
    body: "Filter pages by a specific CSI MasterFormat code (e.g., 09 21 16 — Gypsum Board). Shows word-level highlighting on matching pages. CSI codes are auto-detected from OCR text during processing.",
  },
  "csi-network-graph": {
    title: "CSI Network Graph",
    body: "Opens an interactive force-directed graph showing relationships between CSI divisions across the project. Nodes = divisions, edges = co-occurrence on same pages. Clusters group related trades (MEP, Architectural, Structural). Click 'Refresh Graph' to update after parsing new tables.",
  },

  // ═══════════════════════════════════════════════════════════
  // PANEL BUTTONS (right side of toolbar)
  // ═══════════════════════════════════════════════════════════
  "view-all-button": {
    title: "View All",
    body: "One tree over everything parsed in the project, grouped by page: groups, detections (YOLO models and classes, shape-parse, symbol search), markups, takeoff items, text annotations, tables (schedules, keynotes, legends, notes), proposed tables and CSI codes. Eye toggles hide or show each level on the canvas; the top-level eyes are the master switches.",
  },
  "tools-button": {
    title: "Tools",
    body: "CSI codes (filter and network graph), Text annotations (phone numbers, abbreviations, markups and the OCR text of the page) and Page Intelligence (what the page is and what it references).",
  },
  "yolo-toggle": {
    title: "YOLO AI Detections",
    body: "Opens the detections panel: each model and class with show/hide eyes, a Min Confidence filter for this list, Show All / Hide All for the boxes on the canvas, and CSI Tags (view and edit the CSI codes each detected class maps to). Use the ▾ arrow beside YOLO to set each model's confidence cutoff on the canvas.",
  },
  "parse-button": {
    title: "Parse",
    body: "Shape Parse (find keynote symbols — circles, hexagons, pills — on the rasterized page and read the text inside them, for this page, a drawn region or every page), Template Parse (draw a symbol, find every instance of it) and YOLO-Tag-Map (turn a detected tag's text into a named tag across pages).",
  },
  "qto-button": {
    title: "Quantity Takeoff (QTO)",
    body: "Opens the takeoff panel: Count (create items, click to place markers), Area (calibrate the scale, then draw polygons or bucket-fill a room), Linear (polylines) and Auto-QTO (count from detections). Click an item's page badge to filter the sidebar; double-click a name to rename it.",
  },
  "chat-button": {
    title: "Chat with AI",
    body: "Opens the LLM chat panel. Ask questions about the blueprint in natural language. The AI has context from OCR text, CSI codes, detected annotations, YOLO results, and your notes, and can navigate, highlight and annotate the drawings for you. Toggle between page-scope and project-scope context.",
  },
  "table-panel-button": {
    title: "Schedules / Tables",
    body: "Opens the schedule/table parser: All Tables, Auto Parse (draw a box around a table, then Process Region), Guided, Manual and Compare/Edit Cells. On projects with the Tables workspace enabled it opens the workspace instead (detector proposals, + Region, Classic tools ▸; keynotes and legends are grouped there under Schedules).",
  },
  "specs-notes-button": {
    title: "Specs / Notes",
    body: "Keynote legends, specification text, general notes and tag mapping — the text blocks that explain the drawings rather than draw them.",
  },

  // ═══════════════════════════════════════════════════════════
  // HELP MODE
  // ═══════════════════════════════════════════════════════════
  "help-mode-toggle": {
    title: "Help Mode",
    body: "While on, hovering any button or control that has a help entry shows a short description like this one. On by default in the demo. Click to turn it off, or use Menu → Help mode.",
  },

  // ═══════════════════════════════════════════════════════════
  // PANEL CONTROLS
  // ═══════════════════════════════════════════════════════════
  "text-tab-ocr": {
    title: "OCR Text",
    body: "Raw text extracted from the current page by AWS Textract. Search terms are highlighted in context. Use the copy button to copy all of it to your clipboard.",
  },
  "text-tab-annotations": {
    title: "Text Annotations",
    body: "Patterns auto-detected in the OCR text: phone numbers, addresses, equipment tags (AHU-1), material codes, sheet numbers (A-001.00), abbreviations with meanings, CSI codes, dimensions and trade callouts. Click one to filter all pages containing it.",
  },
  "text-tab-markups": {
    title: "Markups",
    body: "The markups you drew on this page (Add Markup mode), with their names and notes. Click one to select it on the canvas.",
  },
  "text-tab-graph": {
    title: "Cross-References & Equipment",
    body: "Sheet references found on this page (e.g. 'SEE SHEET A-101') with links that jump to that page, plus the equipment tags detected here.",
  },
  "text-tab-textract": {
    title: "Textract",
    body: "The raw AWS Textract result for this page — word, line and table counts — and a button to re-run OCR on just this page.",
  },
  "text-ocr-copy": {
    title: "Copy OCR Text",
    body: "Copy the full raw extracted text for this page to your clipboard. Useful for pasting into other tools or documents.",
  },
  "table-auto-draw": {
    title: "Draw Table Region",
    body: "Draw a box around ONLY the table grid (leave out a title such as DOOR SCHEDULE above it — it breaks header detection). Draw more boxes to merge a table split across columns, then click Process Region. Click again while drawing to cancel.",
  },
  "keynote-guided-draw": {
    title: "Draw Keynote Region",
    body: "Drag a box around the keynote table only (leave out the KEYNOTES title), then click Propose Grid, then Parse Keynotes. Click again to cancel.",
  },
  "yolo-create-tag": {
    title: "Create Tag",
    body: "Enter tag-picking mode — click any YOLO annotation on the canvas to create a named tag from its OCR text. The system scans all pages for matching instances of that text inside the same YOLO class. Tags appear in the tree below.",
  },
};
