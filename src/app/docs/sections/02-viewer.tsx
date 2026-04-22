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
