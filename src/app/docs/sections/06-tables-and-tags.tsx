import { Section } from "../_components/Section";
import { SubSection } from "../_components/SubSection";
import { Figure } from "../_components/Figure";
import { InlineCode } from "../_components/InlineCode";
import { Callout } from "../_components/Callout";
import { TableEl } from "../_components/TableEl";
import { TableParseTabsDemo } from "../_components/demos/TableParseTabsDemo";
import { GuidedSlidersDemo } from "../_components/demos/GuidedSlidersDemo";
import { MapTagsDemoShell } from "../_components/demos/MapTagsDemoShell";
import { MapTagsBindingDiagram } from "../_components/demos/MapTagsBindingDiagram";

export function Section06TablesAndTags() {
  return (
    <Section id="tables-and-tags" eyebrow="Engines" title="Parsing Schedules and Mapping Tags">
      <p>
        Schedules &mdash; door schedules, finish schedules, equipment lists,
        plumbing fixture schedules, electrical panel schedules &mdash; are where
        the ground-truth quantities live on a drawing set. Each row has a tag
        (<InlineCode>D-01</InlineCode>, <InlineCode>W-03</InlineCode>,{" "}
        <InlineCode>P-12</InlineCode>) that shows up as a circle, hexagon, or
        diamond somewhere on the floor plans, and the job of turning a schedule
        into a quantity is the job of (a) extracting the schedule into rows and
        headers, (b) identifying which column holds the tag, and (c) finding
        every occurrence of those tags elsewhere in the drawings. BP&apos;s table
        parsing and Map Tags system exists to do exactly that.
      </p>

      <SubSection title="The Schedules/Tables panel">
        <p>
          Open the <InlineCode>Schedules/Tables</InlineCode> panel from the
          toolbar (the pink-accented button). The panel renders{" "}
          <InlineCode>TableParsePanel.tsx</InlineCode>, which orchestrates five
          tabs: <strong>All Tables</strong>, <strong>Auto Parse</strong>,{" "}
          <strong>Guided</strong>, <strong>Manual</strong>, and{" "}
          <strong>Compare/Edit Cells</strong>. Each tab points at the same saved
          region data (<InlineCode>pageIntelligence.parsedRegions[]</InlineCode>)
          but exposes a different parsing strategy.
        </p>
        <Figure
          kind="live"
          caption="Panel tabs exactly as TableParsePanel.tsx renders them (labels verbatim from lines 306–319)."
          size="md"
        >
          <TableParseTabsDemo />
        </Figure>
      </SubSection>

      <SubSection title="Auto Parse — try everything, pick the best">
        <p>
          Auto Parse is the default path. You draw a bounding box around the
          table region on the canvas and click <strong>Process Regions</strong>.
          The backend runs a multi-method parse pipeline and merges the results
          into a single grid. Each method is a fallback for the others &mdash; a
          grid-line-heavy schedule is easy for Camelot; a crowded CAD-printed one
          is easier for TATR or img2table.
        </p>
        <TableEl
          headers={["Method", "Strengths", "Implementation"]}
          rows={[
            ["img2table", "Fast, handles grid-based tables well, returns cell-level bboxes.", <InlineCode key="1">src/lib/img2table-extract.ts</InlineCode>],
            ["Camelot (pdfplumber-backed)", "PDF-native extraction via vector paths. Works when the PDF has text layers.", <InlineCode key="2">src/lib/camelot-extract.ts</InlineCode>],
            ["TATR (Table Transformer)", "Transformer-based structure inference. Robust to scanned / image-only tables.", <InlineCode key="3">src/lib/tatr-structure.ts</InlineCode>],
            ["OCR grid detect", "OpenCV line detection + OCR word clustering. Pure-image fallback.", <InlineCode key="4">src/lib/ocr-grid-detect.ts</InlineCode>],
          ]}
        />
        <p>
          Results are merged via{" "}
          <InlineCode>src/lib/grid-merger.ts</InlineCode> and persisted through{" "}
          <InlineCode>POST /api/table-parse</InlineCode>. The saved parse becomes
          a <InlineCode>parsedRegion</InlineCode> on the page with{" "}
          <InlineCode>{"{ type: \"schedule\", data: { headers, rows, tagColumn, colBoundaries, rowBoundaries, csiTags } }"}</InlineCode>.
        </p>
      </SubSection>

      <SubSection title="Guided Parse — tune row/column detection">
        <p>
          Sometimes auto parse gets the structure nearly right but misplaces a
          row boundary or merges two columns. Guided Parse is the answer. You
          still draw a region, but the panel exposes three tuning sliders whose
          defaults live in <InlineCode>GuidedParseTab.tsx:44</InlineCode>:
        </p>
        <Figure
          kind="live"
          caption="Guided Parse tuning sliders. Defaults: rowTolerance=0.006, minColGap=0.015, minHitsRatio=0.3."
          size="md"
        >
          <GuidedSlidersDemo />
        </Figure>
        <ul className="list-disc pl-5 space-y-1 text-[13px]">
          <li>
            <strong>Row tolerance</strong> &mdash; maximum vertical drift between
            OCR tokens considered part of the same row. Too tight and valid rows
            split; too loose and adjacent rows merge.
          </li>
          <li>
            <strong>Min column gap</strong> &mdash; smallest horizontal gap that
            separates two columns. If the panel is merging columns, widen this.
          </li>
          <li>
            <strong>Min hits ratio</strong> &mdash; fraction of rows a column must
            appear in to count as a real column. Filters out one-off blobs.
          </li>
        </ul>
        <p>
          As you drag a slider, the panel re-posts to{" "}
          <InlineCode>POST /api/table-parse/propose</InlineCode> with debounce and
          redraws the grid line overlay on the canvas. When the grid looks right,
          you save the parse through the same <InlineCode>/api/table-parse</InlineCode>{" "}
          endpoint as Auto Parse.
        </p>
      </SubSection>

      <SubSection title="Manual Parse and Compare/Edit Cells">
        <p>
          For hostile tables that defeat both Auto and Guided &mdash; scanned PDFs
          with faint grid lines, handwritten schedules, tables that mix multiple
          scales &mdash; Manual Parse lets an estimator define every header and
          every row by hand. The Compare/Edit Cells tab is an after-the-fact
          review surface: pick two parse attempts (e.g. Auto with default config
          and Auto after tweaking), diff the cells, and keep the better one.
          Both live in the same panel for workflow continuity.
        </p>
      </SubSection>

      <SubSection title="Map Tags — the bridge to Auto-QTO">
        <p>
          Parsing a schedule into a grid is useful, but the real leverage comes
          from <strong>Map Tags</strong>: binding each row&apos;s tag value to
          every YOLO shape instance that contains that tag text somewhere on the
          drawings. Once a schedule has been parsed with a tag column identified,
          the Map Tags section appears. The user picks which YOLO class the tag
          is drawn inside (usually <InlineCode>circle</InlineCode> or{" "}
          <InlineCode>hexagon</InlineCode>) &mdash; or selects &quot;no shape&quot;
          to let BP find free-floating text matches &mdash; and clicks{" "}
          <strong>Map Tags</strong>. The binding is processed by{" "}
          <InlineCode>POST /api/projects/[id]/map-tags-batch</InlineCode>, which
          calls into <InlineCode>src/lib/yolo-tag-engine.ts</InlineCode> to do
          bbox-intersection + OCR text matching across every page.
        </p>
        <Figure
          kind="live"
          caption="MapTagsDemoShell — the real MapTagsSection.tsx mounted with fake props. Click a YOLO class to bind, then Map Tags."
          size="md"
        >
          <MapTagsDemoShell />
        </Figure>
        <p>
          The result is a set of <strong>YoloTags</strong> written to the{" "}
          <InlineCode>yolo_tags</InlineCode> table and surfaced in the Detection
          Panel&apos;s Tags sub-tab. Each YoloTag is the anchor data structure
          that Auto-QTO reads from to compute final quantities &mdash; one row per
          tag value, one instance per YOLO match, pages tracked per instance. The
          connection from <em>schedule</em> to <em>drawings</em> to{" "}
          <em>counts</em> is literally this step.
        </p>
        <Figure
          kind="live"
          caption="MapTagsBindingDiagram — schedule rows on the left, drawing pages on the right. Each row's tag value gets bound to every YOLO shape instance whose inner OCR text matches it. Regions tagged tables / title_block are excluded so the schedule's own tag column doesn't double-count."
          size="full"
        >
          <MapTagsBindingDiagram />
        </Figure>
      </SubSection>

      <SubSection title="Output shape">
        <p>
          The persisted data after a successful parse + map is:
        </p>
        <ul className="list-disc pl-5 space-y-1 text-[13px]">
          <li>
            <InlineCode>pages.page_intelligence.parsedRegions[]</InlineCode> &mdash; one entry
            per parsed table, with <InlineCode>{"{ type: \"schedule\", bbox, data: { headers, rows, tagColumn, ... } }"}</InlineCode>.
          </li>
          <li>
            <InlineCode>annotations</InlineCode> &mdash; no new rows (parse alone
            doesn&apos;t add annotations).
          </li>
          <li>
            <InlineCode>yolo_tags</InlineCode> &mdash; one row per unique tag value
            discovered during Map Tags, with a list of matched annotation IDs
            and page numbers.
          </li>
          <li>
            <InlineCode>projectIntelligence.schedules[]</InlineCode> catalog is
            updated by the post-processing summarizer on the next run of{" "}
            <InlineCode>computeProjectSummaries()</InlineCode>, so Auto-QTO can
            find the schedule without loading every page.
          </li>
        </ul>
        <Callout variant="info" title="Schedules are what Auto-QTO reads first">
          Auto-QTO&apos;s first step (&quot;select schedule&quot;) reads from the
          <InlineCode>projectIntelligence.schedules[]</InlineCode> catalog to suggest
          pages that match the chosen material type. If a schedule hasn&apos;t been
          parsed yet, Auto-QTO will take you into this panel to parse it before
          continuing. See Section 07.
        </Callout>
      </SubSection>
    </Section>
  );
}
