import { Section } from "../_components/Section";
import { SubSection } from "../_components/SubSection";
import { Figure } from "../_components/Figure";
import { InlineCode } from "../_components/InlineCode";
import { Callout } from "../_components/Callout";
import { CodeBlock } from "../_components/CodeBlock";
import { PipelineFlowDiagram } from "../_components/demos/PipelineFlowDiagram";

export function Section03Preprocessing() {
  return (
    <Section id="preprocessing" eyebrow="Engines" title="From PDF to Structured Data">
      {/* Plain-English lead */}
      <div className="max-w-3xl text-[15px] text-[var(--fg)]/80 leading-relaxed border-l-2 border-[var(--accent)]/40 pl-4 py-1 mb-4">
        In plain English: when you upload a PDF, BP opens it, splits it into
        pages, reads every word with OCR, and runs a sequence of small analyses
        &mdash; what kind of drawing is this, what&apos;s in the title block,
        what CSI codes appear, are there tables &mdash; and stores the result
        in a compact JSON per page. A 200-page set finishes in roughly 5 to 10
        minutes on the default Fargate tier.
      </div>

      <p>
        The preprocessing pipeline is the load-bearing part of BP. Everything the
        viewer, the LLM, and the takeoff engine depend on &mdash; CSI codes,
        page classifications, text annotations, detected tables, cross-references,
        note blocks, the CSI spatial heatmap, and the CSI network graph &mdash; is
        computed during preprocessing and then read back on demand. This section
        walks through what actually happens between <InlineCode>POST /api/projects</InlineCode> and
        the moment the viewer loads its first page.
      </p>

      <SubSection title="Entry point and orchestration">
        <p>
          The pipeline is triggered when the projects route creates a project
          row. On local development, it&apos;s invoked inline via{" "}
          <InlineCode>processProject(projectId)</InlineCode> in{" "}
          <InlineCode>src/lib/processing.ts</InlineCode>. On AWS, the same function
          runs inside the <InlineCode>cpu-pipeline</InlineCode> ECS task, launched
          by an AWS Step Functions state machine{" "}
          (<InlineCode>infrastructure/terraform/stepfunctions.tf</InlineCode>). In
          both cases the public-ID lookup, the processing body, and the post-
          processing project analysis are identical &mdash; the state machine just
          gives you durable retries, CloudWatch logging, and isolation from the
          web task.
        </p>
        <CodeBlock lang="ts" caption="src/lib/processing.ts — entry signature">
{`export async function processProject(projectId: number): Promise<{
  pagesProcessed: number;
  pageErrors: number;
  processingTime: number;
}> {
  // ... fetch project, download PDF, count pages ...
  // ... mapConcurrent(pageNums, pageConcurrency, processOnePage) ...
  // ... analyzeProject + computeProjectSummaries + warmCloudFrontCache
}`}
        </CodeBlock>
      </SubSection>

      <SubSection title="The 14 per-page stages">
        <p>
          The diagram below shows the exact order each page moves through. Every
          stage is individually wrapped in a <InlineCode>try/catch</InlineCode>:
          a failure in Textract doesn&apos;t prevent text annotation detection
          from running on the (possibly empty) output, a failure in CSI detection
          doesn&apos;t prevent heuristics from firing, and so on. Per-page errors
          are written to <InlineCode>pages.error</InlineCode> so you can spot
          partial results in the admin dashboard without the whole project being
          marked as failed.
        </p>
        <Figure
          kind="live"
          caption="PipelineFlowDiagram — all 14 per-page stages, in order, pulled from processing.ts:processProject()."
          size="full"
        >
          <PipelineFlowDiagram />
        </Figure>

        <ol className="list-decimal pl-6 space-y-2 text-[13px]">
          <li>
            <strong>Rasterize at 300 DPI</strong> (<InlineCode>rasterizePage()</InlineCode>) &mdash;
            the full-resolution PNG for display. This is what the viewer&apos;s canvas
            eventually renders.
          </li>
          <li>
            <strong>Upload PNG + 72 DPI thumbnail to S3</strong> &mdash; both get{" "}
            <InlineCode>Cache-Control: public, max-age=31536000, immutable</InlineCode>{" "}
            so CloudFront can cache forever. The thumbnail backs the sidebar.
          </li>
          <li>
            <strong>Re-rasterize at a safe DPI if the 300 DPI image exceeds 9500 px
            in either dimension</strong> &mdash; Textract rejects images above 10000 px.
            A 24×36&quot; sheet at 300 DPI is 10800 px; the pipeline re-rasterizes at{" "}
            roughly 263 DPI in that case. The re-rasterized buffer is only used
            for OCR; the display image stays at 300 DPI.
          </li>
          <li>
            <strong>OCR via Textract with Tesseract fallback</strong>{" "}
            (<InlineCode>analyzePageImageWithFallback()</InlineCode>) &mdash; produces
            a structured <InlineCode>TextractPageData</InlineCode> with per-word
            bounding boxes and confidence scores. If Textract is unreachable or
            credentials are missing, it falls through to Tesseract.
          </li>
          <li>
            <strong>Flatten OCR into raw text</strong>{" "}
            (<InlineCode>extractRawText()</InlineCode>) &mdash; the concatenation
            used by the PostgreSQL <InlineCode>search_vector</InlineCode> column
            for <InlineCode>/api/search</InlineCode>.
          </li>
          <li>
            <strong>Extract the drawing number from the title block</strong>{" "}
            (<InlineCode>extractDrawingNumber()</InlineCode>). This is what becomes
            <InlineCode>pages.name</InlineCode> &mdash; e.g., &quot;A-101&quot;.
          </li>
          <li>
            <strong>Detect CSI codes</strong>{" "}
            (<InlineCode>detectCsiCodes()</InlineCode>) &mdash; the 3-tier matcher.
            Output is written to <InlineCode>pages.csi_codes</InlineCode>. Section
            04 explains the algorithm.
          </li>
          <li>
            <strong>Detect text annotations</strong>{" "}
            (<InlineCode>detectTextAnnotations()</InlineCode>) &mdash; runs the 10
            detector modules from <InlineCode>src/lib/detectors/registry.ts</InlineCode>:
            contact, codes, dimensions, equipment, references, trade,
            abbreviations, notes, rooms, csi-annotations. Produces a grouped
            annotation list with sub-categories.
          </li>
          <li>
            <strong>Analyze page intelligence</strong>{" "}
            (<InlineCode>analyzePageIntelligence()</InlineCode>) &mdash; discipline and
            drawing-type classification, cross-references to other sheets, note
            blocks. This is the first place the pipeline produces a structured
            summary of the page.
          </li>
          <li>
            <strong>Classify text regions</strong>{" "}
            (<InlineCode>classifyTextRegions()</InlineCode>) &mdash; OCR-based
            identification of where the tables, schedules, legends, and note
            blocks live on the page. Produces <InlineCode>textRegions[]</InlineCode>{" "}
            with confidence scores.
          </li>
          <li>
            <strong>Run the heuristic engine in text-only mode</strong>{" "}
            (<InlineCode>runHeuristicEngine()</InlineCode>). Rules that do not
            require YOLO classes fire here. Section 05 explains how YOLO-augmented
            heuristics re-run later, after a YOLO job completes.
          </li>
          <li>
            <strong>Classify tables</strong>{" "}
            (<InlineCode>classifyTables()</InlineCode>) &mdash; combines text regions
            and heuristic inferences into classified table candidates (door schedule,
            finish schedule, keynote table, etc.).
          </li>
          <li>
            <strong>Compute CSI spatial heatmap</strong>{" "}
            (<InlineCode>computeCsiSpatialMap()</InlineCode>) &mdash; divides the page
            into a 9×9 grid plus <InlineCode>title-block</InlineCode> and{" "}
            <InlineCode>right-margin</InlineCode> special zones and tallies CSI
            instances per zone. Initial pass is OCR-only; a YOLO pass can refresh
            later.
          </li>
          <li>
            <strong>Upsert the <InlineCode>pages</InlineCode> row and rebuild the search_vector</strong> via
            a raw SQL <InlineCode>to_tsvector(&apos;english&apos;, rawText)</InlineCode>.
            This is the single write-point for the whole per-page pipeline.
          </li>
        </ol>
      </SubSection>

      <SubSection title="Project-level analysis (after all pages complete)">
        <p>
          Once every page has finished (or errored), the pipeline switches gears.
          It reads all processed pages back, passes them to{" "}
          <InlineCode>analyzeProject()</InlineCode> which computes the discipline
          breakdown, hub pages, cross-reference graph, and the CSI network graph
          via <InlineCode>buildCsiGraph()</InlineCode>. The result &mdash; a
          structured <InlineCode>projectIntelligence</InlineCode> blob and a short
          text <InlineCode>projectSummary</InlineCode> &mdash; is written back to the{" "}
          <InlineCode>projects</InlineCode> row. A separate{" "}
          <InlineCode>computeProjectSummaries()</InlineCode> pass then builds the
          per-index lookup tables (CSI → pages, trade → pages, keynote → pages,
          text-annotation → pages) that <InlineCode>lookupPagesByIndex()</InlineCode>{" "}
          reads at O(1) from LLM tool calls.
        </p>
        <p>
          The final step is a best-effort CloudFront cache warm: each page PNG
          gets a HEAD request so CloudFront edge locations pull it ahead of the
          first viewer hit. Failures are logged and ignored.
        </p>
      </SubSection>

      <SubSection title="Concurrency and tuning">
        <p>
          Pages run in parallel via a small <InlineCode>mapConcurrent()</InlineCode> helper
          with a default limit of <strong>8</strong>. The limit is
          per-company configurable through{" "}
          <InlineCode>companies.pipelineConfig.pipeline.pageConcurrency</InlineCode>{" "}
          and the <InlineCode>Admin → Pipeline</InlineCode> tab &mdash; raise it on a
          beefy Fargate task, lower it if Textract throttles you. The spatial
          grid size is also configurable via{" "}
          <InlineCode>pipelineConfig.pipeline.csiSpatialGrid</InlineCode>.
        </p>
        <Callout variant="info" title="Idempotency">
          If a page already has <InlineCode>textract_data</InlineCode> stored, the
          per-page body is skipped. Re-triggering processing on an existing
          project (via <InlineCode>/api/admin/reprocess</InlineCode>) will reuse
          completed pages and only work on missing or errored ones. To force a
          full re-run, delete the project rows in the DB first or zero out the{" "}
          <InlineCode>textract_data</InlineCode> column for the pages you want
          redone.
        </Callout>
      </SubSection>

    </Section>
  );
}
