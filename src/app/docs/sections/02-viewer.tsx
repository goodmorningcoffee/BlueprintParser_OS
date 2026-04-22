import { Section } from "../_components/Section";
import { SubSection } from "../_components/SubSection";
import { Figure } from "../_components/Figure";
import { InlineCode } from "../_components/InlineCode";
import { Callout } from "../_components/Callout";
import { TableEl } from "../_components/TableEl";
import { ToolbarDemo } from "../_components/demos/ToolbarDemo";
import { ModeToggleDemo } from "../_components/demos/ModeToggleDemo";
import { ColorSwatchDemo } from "../_components/demos/ColorSwatchDemo";
import { MenuDropdownDemo } from "../_components/demos/MenuDropdownDemo";
import { ConfidenceSliderDemo } from "../_components/demos/ConfidenceSliderDemo";
import { MarkupDialogDemo } from "../_components/demos/MarkupDialogDemo";
import { AreaUnitChipDemo } from "../_components/demos/AreaUnitChipDemo";
import { ViewerAnatomyDiagram } from "../_components/demos/ViewerAnatomyDiagram";
import { CanvasRenderGateDiagram } from "../_components/demos/CanvasRenderGateDiagram";
import { StoreSliceHookMap } from "../_components/demos/StoreSliceHookMap";

export function Section02Viewer() {
  return (
    <Section id="viewer" eyebrow="User Guide" title="Inside the Viewer">
      {/* Plain-English lead */}
      <div className="max-w-3xl text-[15px] text-[var(--fg)]/80 leading-relaxed border-l-2 border-[var(--accent)]/40 pl-4 py-1 mb-4">
        In plain English: the viewer looks like a dense PDF review tool. Sidebar
        on the left with page thumbnails. Big canvas in the middle showing the
        current page with interactive overlays for markup, measurements, YOLO
        detections, and search hits. A toolbar across the top picks the current
        mode. Panels on the right slide in for each feature &mdash; text, CSI,
        chat, takeoff, schedules, keynotes. Everything is one click away.
      </div>

      <p>
        The viewer lives at <InlineCode>/project/[id]</InlineCode> and is the
        primary surface for every user-facing feature in BP. It is a single React
        tree driven by a Zustand store with 17 slice selectors, backed by a
        client-side pdf.js rasterizer for the canvas and a series of overlay
        layers for annotations, markups, YOLO detections, keynotes, parse
        regions, and search highlights. Everything you do inside a project flows
        through this view.
      </p>

      <SubSection title="Feature tree — brute-force inventory">
        <p>
          Every feature under the Viewer, nested by the DOM/panel hierarchy it
          renders into. One-line description under each. If a feature has sub-modes
          or tabs, those are indented under the parent. This is deliberately
          exhaustive; skim for the shape, read for the specifics.
        </p>
        <ul className="list-disc pl-5 space-y-1.5 text-[13px]">
          <li>
            <strong>Canvas core</strong>
            <ul className="list-[circle] pl-5 pt-1 space-y-1">
              <li>
                <InlineCode>PDFPage.tsx</InlineCode> pdf.js rasterizer
                <div className="text-[var(--muted)]">Renders the current page as a bitmap at the user&apos;s zoom scale; caches the last 8 rendered pages as ImageBitmaps for instant tab-back.</div>
              </li>
              <li>
                Zoom / Fit / Pan controls
                <div className="text-[var(--muted)]">+/&minus; buttons, Fit-to-window, wheel-zoom in Move mode, drag-to-pan in Move mode.</div>
              </li>
              <li>
                Thumbnail sidebar
                <div className="text-[var(--muted)]">Collapsible left-side page list with page-name + drawing-number labels; click to jump, scrolls synchronously with the main canvas.</div>
              </li>
            </ul>
          </li>
          <li>
            <strong>Modes</strong> (mutually exclusive, keyboard-bound)
            <ul className="list-[circle] pl-5 pt-1 space-y-1">
              <li>
                Pointer (<InlineCode>A</InlineCode>)
                <div className="text-[var(--muted)]">Click-to-select overlays; double-click opens edit dialogs for markups, annotations, parsed regions.</div>
              </li>
              <li>
                Move / Pan (<InlineCode>V</InlineCode>)
                <div className="text-[var(--muted)]">Click-drag pans the canvas, wheel zooms. No overlay interaction.</div>
              </li>
              <li>
                Markup
                <div className="text-[var(--muted)]">Draw rectangle, polygon, or freehand stroke. Opens MarkupDialog on finish for name + note + color pick from 20-color palette.</div>
              </li>
              <li>
                Group / multi-select
                <div className="text-[var(--muted)]">Shift-click-add plus empty-canvas lasso; applies bulk ops (delete, recolor, category change) across selection.</div>
              </li>
            </ul>
          </li>
          <li>
            <strong>Canvas overlay layers</strong> (stable z-order, normalized 0&ndash;1 coordinates)
            <ul className="list-[circle] pl-5 pt-1 space-y-1">
              <li>
                <InlineCode>SearchHighlightOverlay</InlineCode>
                <div className="text-[var(--muted)]">Yellow boxes around <InlineCode>tsvector</InlineCode> search hits from the toolbar text-search.</div>
              </li>
              <li>
                <InlineCode>TextAnnotationOverlay</InlineCode>
                <div className="text-[var(--muted)]">Boxes around detected phones, equipment tags, room names, abbreviations (37+ annotation types).</div>
              </li>
              <li>
                <InlineCode>KeynoteOverlay</InlineCode>
                <div className="text-[var(--muted)]">Keynote shape detections (circles, hexagons, diamonds) with inner-text OCR; gated by the <InlineCode>showKeynotes</InlineCode> toggle.</div>
              </li>
              <li>
                <InlineCode>AnnotationOverlay</InlineCode>
                <div className="text-[var(--muted)]">The master layer &mdash; YOLO detections, user markups, takeoff items, shape-parse output, symbol-search results. Click-to-select, drag-to-move, vertex-edit on polygons. Also hosts the draw-rect state machine for Parse flows.</div>
              </li>
              <li>
                <InlineCode>ParseRegionLayer</InlineCode>
                <div className="text-[var(--muted)]">Saved ParsedRegion outlines + grid preview, color-coded by type (keynote amber, notes blue, spec violet, schedule pink). Also renders the shared <InlineCode>parseDraftRegion</InlineCode> dashed preview while a user is actively parsing.</div>
              </li>
              <li>
                <InlineCode>GuidedParseOverlay</InlineCode>
                <div className="text-[var(--muted)]">Draggable row + column boundary lines rendered during a Guided Parse (keynote and notes share this via a prop-based API).</div>
              </li>
              <li>
                <InlineCode>FastManualParseOverlay</InlineCode>
                <div className="text-[var(--muted)]">Stage 4 Notes primitive &mdash; double-click snaps to Textract LINE, derives columns from line margins. Pending rework into <InlineCode>ParagraphOverlay</InlineCode> (paragraph-level hit-test + adjustable BB + Cmd+C/V template paste).</div>
              </li>
              <li>
                <InlineCode>DrawingPreviewLayer</InlineCode>
                <div className="text-[var(--muted)]">Rubber-band preview while the user is dragging to draw a new markup or bbox.</div>
              </li>
              <li>
                <InlineCode>ParsedTableCellOverlay</InlineCode>
                <div className="text-[var(--muted)]">TATR cell-structure overlay for parsed tables; click-a-cell to search by its text, double-click to toggle highlight.</div>
              </li>
            </ul>
          </li>
          <li>
            <strong>Toolbar</strong>
            <ul className="list-[circle] pl-5 pt-1 space-y-1">
              <li>
                Back-to-dashboard + click-to-rename project name
                <div className="text-[var(--muted)]">Inline edit on the project name, persists to <InlineCode>projects.name</InlineCode>.</div>
              </li>
              <li>
                Zoom controls (&minus; / % / +) + Fit
                <div className="text-[var(--muted)]">Symmetric bracketed zoom; Fit recalculates for the current page dimensions.</div>
              </li>
              <li>
                Mode toggle (Pointer / Pan / Markup)
                <div className="text-[var(--muted)]">3-state button; keyboard shortcuts A, V.</div>
              </li>
              <li>
                Symbol Search button
                <div className="text-[var(--muted)]">Draw a template bbox to find all instances; exposes Lite / Power / Custom presets for confidence thresholds.</div>
              </li>
              <li>
                Menu dropdown
                <div className="text-[var(--muted)]">Labeling wizard (YOLO training export), Settings, Page Intelligence toggle, Admin link, Help tips toggle, Export PDF (disabled placeholder).</div>
              </li>
              <li>
                Text search
                <div className="text-[var(--muted)]">Full-text search over OCR via Postgres <InlineCode>tsvector</InlineCode>; highlights on canvas + lists hits in Text panel.</div>
              </li>
              <li>
                Trade filter / CSI code filter
                <div className="text-[var(--muted)]">Filter the CSI Network Graph, View All, and QTO lists by trade or specific CSI division.</div>
              </li>
              <li>
                YOLO toggle (+ per-model confidence sliders)
                <div className="text-[var(--muted)]">Shows when any YOLO annotation is loaded. Dropdown chevron opens per-model sliders (yolo_medium / yolo_primitive / yolo_precise).</div>
              </li>
              <li>
                Six panel toggles
                <div className="text-[var(--muted)]">Text / CSI / LLM Chat / QTO / Schedules/Tables / Keynotes (+ Specs/Notes in the D2 panel orchestrator).</div>
              </li>
            </ul>
          </li>
          <li>
            <strong>Right-side panels</strong> (toggleable, stackable)
            <ul className="list-[circle] pl-5 pt-1 space-y-1">
              <li>
                Text Panel (<InlineCode>TextPanel.tsx</InlineCode>)
                <div className="text-[var(--muted)]">OCR text viewer, searchable, per-word Textract confidence, click-to-jump-to-canvas-position.</div>
              </li>
              <li>
                CSI Panel (<InlineCode>CsiPanel.tsx</InlineCode>)
                <div className="text-[var(--muted)]">Detected CSI MasterFormat codes grouped by division; toggle between page-scope and project-scope; click a code to highlight triggers on canvas.</div>
              </li>
              <li>
                LLM Chat Panel (<InlineCode>ChatPanel.tsx</InlineCode>)
                <div className="text-[var(--muted)]">Project- or page-scoped chat, streams via SSE; has 20 tools (search, read-page, highlight, zoom, list-schedules, count-takeoff, etc.).</div>
              </li>
              <li>
                QTO Panel (<InlineCode>TakeoffPanel.tsx</InlineCode>) &mdash; quantity takeoff
                <ul className="list-[square] pl-5 pt-0.5 space-y-0.5">
                  <li>
                    Count tab
                    <div className="text-[var(--muted)]">Click-to-count with color-coded markers; auto-deduplicates via YOLO tag bindings where available.</div>
                  </li>
                  <li>
                    Area tab (+ Scale Calibration + Bucket Fill + Split Area)
                    <div className="text-[var(--muted)]">Polygon draw or bucket-fill flood with text-as-wall barrier detection; Scale Calibration is a 2-point known-dimension flow; Split Area slices a saved polygon.</div>
                  </li>
                  <li>
                    Linear tab
                    <div className="text-[var(--muted)]">Polyline length; same scale-calibration model as Area.</div>
                  </li>
                  <li>
                    Auto-QTO tab
                    <div className="text-[var(--muted)]">Suggests pages with likely schedules (ensemble-driven after Stage 2b); &ldquo;Find &amp; Parse Doors Schedule&rdquo; style shortcuts auto-trigger Table Parse.</div>
                  </li>
                  <li>
                    All tab
                    <div className="text-[var(--muted)]">Flat list of every committed takeoff item, exportable to CSV.</div>
                  </li>
                </ul>
              </li>
              <li>
                Schedules/Tables Panel (<InlineCode>TableParsePanel.tsx</InlineCode>)
                <ul className="list-[square] pl-5 pt-0.5 space-y-0.5">
                  <li>
                    Auto Parse
                    <div className="text-[var(--muted)]">Multi-method merger: OCR-positions, Textract TABLES, OpenCV lines, img2table. Returns a consolidated grid + confidence.</div>
                  </li>
                  <li>
                    Guided Parse
                    <div className="text-[var(--muted)]">User draws region, server proposes row/col boundaries, user drags to adjust, client extracts cells.</div>
                  </li>
                  <li>
                    Manual Parse
                    <div className="text-[var(--muted)]">User draws column BBs + row BBs; grid extraction runs client-side via word-center hit-test.</div>
                  </li>
                  <li>
                    Compare / Edit
                    <div className="text-[var(--muted)]">Side-by-side method outputs; edit cell text and re-save.</div>
                  </li>
                  <li>
                    Map Tags section
                    <div className="text-[var(--muted)]">Bind tag column of a parsed table to YOLO tag instances; auto-infers scope + pattern.</div>
                  </li>
                </ul>
              </li>
              <li>
                Specs/Notes Panel (<InlineCode>SpecsNotesPanel.tsx</InlineCode>) &mdash; D2 orchestrator
                <ul className="list-[square] pl-5 pt-0.5 space-y-0.5">
                  <li>
                    Spec Parse tab
                    <div className="text-[var(--muted)]">Stage 5 scope, currently stubbed. Will target full-page vertical-column spec layouts (PART / SECTION / GENERAL NOTES dense prose).</div>
                  </li>
                  <li>
                    Notes Parse tab (<InlineCode>NotesPanel.tsx</InlineCode>)
                    <ul className="list-[disc] pl-5 pt-0.5 space-y-0.5">
                      <li>
                        Index
                        <div className="text-[var(--muted)]">Project-wide table of detected note regions from <InlineCode>summaries.notesRegions</InlineCode>; row click jumps to page and opens Parser pre-filled with the region bbox.</div>
                      </li>
                      <li>
                        Classifier
                        <div className="text-[var(--muted)]">Per-page Accept / Edit / Reject cards for Layer-1 classified textRegions (notes-numbered + notes-key-value). Accept one-click-promotes via <InlineCode>/api/regions/promote</InlineCode>; Reject persists to <InlineCode>rejectedTextRegionIds</InlineCode> with stale-ID cleanup.</div>
                      </li>
                      <li>
                        Parser &mdash; Auto sub-mode
                        <div className="text-[var(--muted)]">Server runs <InlineCode>parseNotesFromRegion</InlineCode> (numbered-first, K:V fallback) + CSI detection; client shows dashed preview on canvas.</div>
                      </li>
                      <li>
                        Parser &mdash; Guided sub-mode
                        <div className="text-[var(--muted)]">Propose row/col boundaries, user drags on GuidedParseOverlay, client extracts grid.</div>
                      </li>
                      <li>
                        Parser &mdash; Fast-manual sub-mode (pending rework)
                        <div className="text-[var(--muted)]">Double-click Textract LINE to snap columns. Known-broken on dense multi-line paragraphs; scheduled for redesign as <InlineCode>ParagraphOverlay</InlineCode> primitive.</div>
                      </li>
                      <li>
                        Parser &mdash; Manual sub-mode
                        <div className="text-[var(--muted)]">Draw column BBs + row BBs; grid extracted client-side via word-center hit-test. The always-works fallback.</div>
                      </li>
                    </ul>
                  </li>
                  <li>
                    Keynotes tab (<InlineCode>KeynotePanel.tsx</InlineCode>)
                    <ul className="list-[disc] pl-5 pt-0.5 space-y-0.5">
                      <li>
                        All Keynotes
                        <div className="text-[var(--muted)]">Flat list of every parsed keynote table across the project; CSV export.</div>
                      </li>
                      <li>
                        Auto / Guided / Manual / Compare
                        <div className="text-[var(--muted)]">Same sub-mode taxonomy as Table Parse but scoped to bubble-keyed keynote grids.</div>
                      </li>
                    </ul>
                  </li>
                </ul>
              </li>
              <li>
                Page Intelligence Panel (<InlineCode>PageIntelligencePanel.tsx</InlineCode>)
                <div className="text-[var(--muted)]">Read-only dump of <InlineCode>pageIntelligence</InlineCode> for the current page &mdash; classification, crossRefs, textRegions, noteBlocks, heuristicInferences, ensembleRegions. Debug/inspection surface.</div>
              </li>
              <li>
                View All Panel (<InlineCode>ViewAllPanel.tsx</InlineCode>)
                <div className="text-[var(--muted)]">Project-wide list with per-entity eye toggles (master-eye memento); surfaces schedules, parsed tables, keynotes, notes, specs, YOLO tags, CSI codes. Clickable-graph substrate for future LLM-side reasoning.</div>
              </li>
            </ul>
          </li>
          <li>
            <strong>Bottom Annotation Panel</strong>
            <div className="text-[var(--muted)]">Horizontal summary row grouping Markups, YOLO detections, and takeoff items by source; filter chips per category.</div>
          </li>
          <li>
            <strong>Dialogs / modals</strong>
            <ul className="list-[circle] pl-5 pt-1 space-y-1">
              <li>
                Markup dialog
                <div className="text-[var(--muted)]">Name + note + color on markup save.</div>
              </li>
              <li>
                Bucket Fill Assign dialog
                <div className="text-[var(--muted)]">Assign a filled region to an Area item + color; surfaces HTTP errors inline.</div>
              </li>
              <li>
                Scale Calibration dialog
                <div className="text-[var(--muted)]">Two-point calibration with known real-world distance + unit selector (ft, in, m, mm).</div>
              </li>
              <li>
                Symbol Search config
                <div className="text-[var(--muted)]">Confidence presets (Lite / Power / Custom) + per-project defaults.</div>
              </li>
              <li>
                Export CSV modal
                <div className="text-[var(--muted)]">Keynote / Schedule / Notes export with column selection.</div>
              </li>
            </ul>
          </li>
          <li>
            <strong>Standalone tools</strong> (trigger from toolbar or panels)
            <ul className="list-[circle] pl-5 pt-1 space-y-1">
              <li>
                Symbol Search
                <div className="text-[var(--muted)]">Draw a bbox around any symbol on the page; CV matcher finds every other instance across the project.</div>
              </li>
              <li>
                Bucket Fill
                <div className="text-[var(--muted)]">Flood-fill area computation from a click point; text-as-wall paradigm with 1k/2k/3k/4k resolution slider; assigns to Area item with error surfacing.</div>
              </li>
              <li>
                Split Area
                <div className="text-[var(--muted)]">Slice a saved polygon with a user-drawn line into two children.</div>
              </li>
              <li>
                Shape Parse
                <div className="text-[var(--muted)]">Python/OpenCV keynote-shape detector (circles, hexagons, diamonds, pills, squares). Runs at upload; results live in <InlineCode>pages.keynotes</InlineCode>.</div>
              </li>
              <li>
                Scale Calibration
                <div className="text-[var(--muted)]">Per-page; stored in <InlineCode>scaleCalibrations[pageNumber]</InlineCode>. Required before any Area/Linear takeoff produces real-world units.</div>
              </li>
            </ul>
          </li>
          <li>
            <strong>ParsedRegion outputs</strong> (write path from Viewer into the graph)
            <ul className="list-[circle] pl-5 pt-1 space-y-1">
              <li>
                <InlineCode>type: &quot;schedule&quot;</InlineCode>
                <div className="text-[var(--muted)]">Tabular grid from Schedules/Tables panel.</div>
              </li>
              <li>
                <InlineCode>type: &quot;keynote&quot;</InlineCode>
                <div className="text-[var(--muted)]">Key &rarr; Description grid from the Keynotes tab.</div>
              </li>
              <li>
                <InlineCode>type: &quot;notes&quot;</InlineCode>
                <div className="text-[var(--muted)]">Notes-numbered or notes-key-value grid from Notes Parse.</div>
              </li>
              <li>
                <InlineCode>type: &quot;spec&quot;</InlineCode> (Stage 5 planned)
                <div className="text-[var(--muted)]">Section-header &rarr; body list from Spec Parse.</div>
              </li>
              <li>
                <InlineCode>type: &quot;legend&quot;</InlineCode>
                <div className="text-[var(--muted)]">Symbol legend variant; shares NotesData shape.</div>
              </li>
            </ul>
            <div className="text-[var(--muted)] pt-1">All types commit through the generic <InlineCode>POST /api/regions/promote</InlineCode> route. Server merges CSI tags into <InlineCode>pages.csiCodes</InlineCode> via <InlineCode>mergeCsiCodes</InlineCode> and refreshes <InlineCode>projectIntelligence.summaries</InlineCode> after the transaction commits.</div>
          </li>
        </ul>
      </SubSection>

      <SubSection title="Anatomy">
        <p>
          Top: the toolbar. Left: a collapsible page sidebar with thumbnails.
          Center: the canvas, which renders the current page and its overlays.
          Right: a stack of toggleable panels &mdash; Text, CSI, LLM Chat, QTO,
          Schedules/Tables, Keynotes, Page Intelligence &mdash; which fly in from
          the right edge when activated. Bottom: the Annotation Panel, a summary
          row grouping markups, YOLO detections, and takeoff items by source.
        </p>
        <Figure
          kind="live"
          caption="ViewerAnatomyDiagram — toolbar, sidebar, canvas with overlay layers, the right-side panel stack, and the bottom annotation panel. Each region toggles independently."
          size="full"
        >
          <ViewerAnatomyDiagram />
        </Figure>
      </SubSection>

      <SubSection title="The toolbar">
        <p>
          The toolbar is dense by design &mdash; a working estimator needs every
          mode and every panel within one click of the canvas. Below is a live
          static rendition with fake data so you can see the exact layout and
          control styling without loading a real project.
        </p>
        <Figure
          kind="live"
          caption="ToolbarDemo — a pixel-for-pixel copy of src/components/viewer/ViewerToolbar.tsx, minus the Zustand wiring."
          size="full"
        >
          <ToolbarDemo />
        </Figure>
        <p>
          From left to right: the back arrow returns to the project dashboard;
          the project name is click-to-rename; the <InlineCode>-</InlineCode>{" "}
          and <InlineCode>+</InlineCode> buttons bracket the current zoom percentage
          and the <InlineCode>Fit</InlineCode> button auto-fits the page; the
          3-state mode toggle selects Pointer / Pan / Markup; the Symbol button
          opens a draw-a-bbox-to-find-all-instances workflow; the <InlineCode>Menu</InlineCode>{" "}
          button opens the dropdown (shown below). The right half of the toolbar
          carries the text search, the trade filter, the CSI code filter, the
          YOLO toggle (with per-model dropdown when multiple models are loaded),
          and the six panel toggles.
        </p>
      </SubSection>

      <SubSection title="Modes: pointer, move, markup">
        <p>
          The canvas has three mutually-exclusive modes, controlled by{" "}
          <InlineCode>setMode()</InlineCode> in the viewer store. The internal mode
          values are <InlineCode>&quot;pointer&quot;</InlineCode>,{" "}
          <InlineCode>&quot;move&quot;</InlineCode>, and{" "}
          <InlineCode>&quot;markup&quot;</InlineCode>. Keyboard shortcuts are{" "}
          <InlineCode>A</InlineCode> (pointer), <InlineCode>V</InlineCode> (pan/move),
          and switching to Markup mode activates the drawing tools. Pointer mode
          clicks on overlays to select them; move mode click-drags the canvas to
          pan and mouse-wheel zooms; markup mode lets you draw rectangles, polygons,
          or freehand strokes.
        </p>
        <Figure
          kind="live"
          caption="ModeToggleDemo — click to cycle through pointer / move / markup."
          size="sm"
        >
          <ModeToggleDemo />
        </Figure>
      </SubSection>

      <SubSection title="Markup mode">
        <p>
          Markup annotations are user-authored overlays: a rectangle, polygon, or
          freehand stroke with an associated name and optional multi-line note.
          Each markup gets one of twenty colors drawn from the{" "}
          <InlineCode>TWENTY_COLORS</InlineCode> palette (<InlineCode>src/types/index.ts</InlineCode>),
          and the markup dialog captures a name and note on save. Markups show up
          in the Annotation Panel at the bottom of the viewer under the{" "}
          <InlineCode>MARKUPS</InlineCode> category, and they&apos;re persisted to
          the <InlineCode>annotations</InlineCode> table with{" "}
          <InlineCode>source = &quot;user&quot;</InlineCode>.
        </p>
        <Figure
          kind="live"
          caption="ColorSwatchDemo — the 20-color palette. Import is live from TWENTY_COLORS so it stays in sync."
          size="md"
        >
          <ColorSwatchDemo />
        </Figure>
        <Figure
          kind="live"
          caption="MarkupDialogDemo — the real MarkupDialog.tsx mounted inside the docs. Click to open it."
          size="md"
        >
          <MarkupDialogDemo />
        </Figure>
      </SubSection>

      <SubSection title="Menu dropdown">
        <p>
          The menu collects operations that don&apos;t belong on the main toolbar:
          a labeling wizard for building YOLO training sets, a settings modal,
          a toggle for the Page Intelligence panel, a link to the admin dashboard,
          and a help tips toggle that reveals contextual tooltips across the UI.
          <InlineCode>Export PDF</InlineCode> is present but disabled &mdash;
          it&apos;s the obvious future feature.
        </p>
        <Figure kind="live" caption="MenuDropdownDemo — items verbatim from ViewerToolbar.tsx:288–331." size="sm">
          <MenuDropdownDemo />
        </Figure>
      </SubSection>

      <SubSection title="YOLO controls in the toolbar">
        <p>
          When a project has any YOLO annotations loaded, the purple{" "}
          <InlineCode>YOLO</InlineCode> button appears. It toggles the canvas
          overlay and opens the Detection Panel. When multiple models are loaded,
          the dropdown chevron reveals a per-model panel with independent
          confidence sliders &mdash; useful for tuning the output on a project
          where <InlineCode>yolo_medium</InlineCode> is noisy but{" "}
          <InlineCode>yolo_precise</InlineCode> is conservative.
        </p>
        <Callout variant="warn" title="YOLO runs from admin only">
          The toolbar YOLO toggle <strong>only displays</strong> results. To
          actually run YOLO inference, go to <InlineCode>Admin → AI Models</InlineCode> and
          start a SageMaker Processing job. Section 05 explains the full pipeline.
        </Callout>
        <Figure
          kind="live"
          caption="ConfidenceSliderDemo — per-model confidence slider mirroring the viewer toolbar dropdown."
          size="sm"
        >
          <ConfidenceSliderDemo />
        </Figure>
      </SubSection>

      <SubSection title="Right-side panel toggles">
        <p>
          The right half of the toolbar holds six panel toggles. Panels slide in
          from the right edge and can be stacked. Each is independently toggleable
          and each keeps its own internal state.
        </p>
        <TableEl
          headers={["Panel", "Purpose", "Lives in"]}
          rows={[
            ["Text", "OCR text viewer, searchable, shows per-word confidence from Textract.", <InlineCode key="1">TextPanel.tsx</InlineCode>],
            ["CSI", "Detected CSI MasterFormat codes grouped by division. Page / project scope.", <InlineCode key="2">CsiPanel.tsx</InlineCode>],
            ["LLM Chat", "Project- or page-scoped chat with 20 tools. Streams via SSE.", <InlineCode key="3">ChatPanel.tsx</InlineCode>],
            ["QTO", "Quantity takeoff: Count, Area, Linear, Auto-QTO, and All tabs.", <InlineCode key="4">TakeoffPanel.tsx</InlineCode>],
            ["Schedules/Tables", "Parsed tables with Auto / Guided / Manual / Compare tabs and Map Tags.", <InlineCode key="5">TableParsePanel.tsx</InlineCode>],
            ["Keynotes", "Detected keynote symbols (circles, hexagons) with per-shape summaries.", <InlineCode key="6">KeynotePanel.tsx</InlineCode>],
          ]}
        />
      </SubSection>

      <SubSection title="Canvas overlays">
        <p>
          The canvas mounts several overlay layers on top of the rendered page.
          They stack in a stable z-order and each can be toggled or filtered
          independently. All overlays operate in normalized 0–1 page coordinates
          so they stay aligned when the user zooms or the page dimensions change
          across pages.
        </p>
        <ul className="list-disc pl-5 space-y-1 text-[13px]">
          <li>
            <InlineCode>SearchHighlightOverlay</InlineCode> &mdash; yellow boxes around tsvector search hits.
          </li>
          <li>
            <InlineCode>TextAnnotationOverlay</InlineCode> &mdash; boxes around detected phone numbers, equipment tags, room names, and other text-annotation matches.
          </li>
          <li>
            <InlineCode>KeynoteOverlay</InlineCode> &mdash; detected keynote shapes (circles, hexagons, diamonds) with their inner text.
          </li>
          <li>
            <InlineCode>AnnotationOverlay</InlineCode> &mdash; the main YOLO + user markup layer. Click-to-select, click-to-edit.
          </li>
          <li>
            <InlineCode>ParseRegionLayer</InlineCode> &mdash; saved table parse regions, click to jump to the parsed data.
          </li>
          <li>
            <InlineCode>GuidedParseOverlay</InlineCode> &mdash; the live grid lines rendered while tuning a Guided Parse.
          </li>
          <li>
            <InlineCode>DrawingPreviewLayer</InlineCode> &mdash; the rubber-band preview while the user is drawing a new markup.
          </li>
        </ul>
      </SubSection>

      <SubSection title="State management: the 17 slice hooks">
        <p>
          The viewer&apos;s state lives in a single Zustand store at{" "}
          <InlineCode>src/stores/viewerStore.ts</InlineCode> (1,986 lines). The
          store is large but access is scoped through seventeen{" "}
          <em>slice hooks</em> &mdash; each hook returns a narrow set of fields
          memoized by <InlineCode>useShallow</InlineCode>, so components only
          re-render on changes to their own slice.
        </p>
        <Figure
          kind="live"
          caption="17 slice hooks fan out from useViewerStore. Line numbers are from the current viewerStore.ts."
          size="full"
        >
          <StoreSliceHookMap />
        </Figure>
        <Callout variant="tip" title="Rule of thumb for new UI">
          Before adding a new visibility flag or filter, grep the store for an
          existing slice that fits. Binding a new panel to an existing slice
          means two-way sync with the toolbar and ViewAllPanel eye icons is
          automatic &mdash; no drift risk. Adding a parallel state field
          usually re-discovers a bug that was already fixed once.
        </Callout>
      </SubSection>

      <SubSection title="The canvas render gate (drift hazard)">
        <p>
          <InlineCode>src/components/viewer/AnnotationOverlay.tsx</InlineCode>{" "}
          is the center of the drawing logic &mdash; 2,581 lines that handle
          every canvas mode, hit testing, bucket fill commit, split-area,
          vertex edit, polygon drawing, symbol search, markup, calibration,
          and keynote/table parse region selection. The file has one structural
          trap that bit the group-tool fix on 2026-04-19 and keeps coming back:
          <strong> adding a new mode requires touching four places.</strong>
        </p>
        <Figure
          kind="live"
          caption="Canvas render gate — four coupled conditions in AnnotationOverlay.tsx. Missing any one produces a different silent regression."
          size="full"
        >
          <CanvasRenderGateDiagram />
        </Figure>
        <p>
          The companion architecture doc at{" "}
          <InlineCode>featureRoadMap/BPArchitecture_422.md</InlineCode>{" "}
          contains the full mode table and exact line numbers if you&apos;re
          about to add a new tool.
        </p>
      </SubSection>

      <SubSection title="Scale calibration and measurement units">
        <p>
          Before any area or linear takeoff will produce real-world numbers, the
          user has to calibrate the page scale. You click <strong>Set Scale</strong> in
          the Area tab, click two points on a known dimension (a grid line, a
          labeled wall), and enter the real-world distance plus a unit.
          Calibration is stored per page in{" "}
          <InlineCode>scaleCalibrations[pageNumber]</InlineCode> &mdash; reusing a
          polygon on a new page requires recalibrating unless the pages share the
          same scale.
        </p>
        <Figure kind="live" caption="AreaUnitChipDemo — the four base units from src/components/viewer/AreaTab.tsx." size="sm">
          <AreaUnitChipDemo />
        </Figure>
      </SubSection>
    </Section>
  );
}
