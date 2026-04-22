import { Section } from "../_components/Section";
import { SubSection } from "../_components/SubSection";
import { Figure } from "../_components/Figure";
import { InlineCode } from "../_components/InlineCode";
import { Callout } from "../_components/Callout";
import { CodeBlock } from "../_components/CodeBlock";
import { TableEl } from "../_components/TableEl";
import { YoloClassChipDemo } from "../_components/demos/YoloClassChipDemo";
import { ConfidenceSliderDemo } from "../_components/demos/ConfidenceSliderDemo";
import { YoloRunFlowDiagram } from "../_components/demos/YoloRunFlowDiagram";

export function Section05YoloPipeline() {
  return (
    <Section id="yolo-pipeline" eyebrow="Engines" title="YOLO Object Detection — Run, Load, Display">
      {/* Plain-English lead */}
      <div className="max-w-3xl text-[15px] text-[var(--fg)]/80 leading-relaxed border-l-2 border-[var(--accent)]/40 pl-4 py-1 mb-4">
        In plain English: YOLO is the object-detection model that finds the
        visual shapes on a drawing &mdash; doors, windows, tables, title blocks,
        tag circles. It&apos;s optional and gated behind admin controls because
        it runs on a GPU instance and costs real money. Once it&apos;s run,
        every downstream feature (Auto-QTO, Map Tags, the spatial heatmap)
        gets sharper.
      </div>

      <Callout variant="warn" title="YOLO runs only from Admin → AI Models">
        The viewer&apos;s <InlineCode>YOLO</InlineCode> toolbar button{" "}
        <strong>only shows and hides already-loaded detections</strong>. It does
        not kick off inference. To actually run YOLO, you go to{" "}
        <InlineCode>Admin → AI Models</InlineCode>, pick a model and a project, and
        click Run. The backend launches a SageMaker Processing job and webhook-
        ingests the results when the job finishes. Running YOLO costs money
        (GPU instance hours) and is gated behind a per-company feature toggle and
        an admin-only permission.
      </Callout>

      <p>
        YOLO in BP is the layer that turns blueprints from textual documents into
        spatially-aware ones. The text pipeline (Section 03) already extracts OCR,
        CSI codes, classifications, and tables. What it doesn&apos;t know is where
        the doors, windows, grid lines, tables, and title blocks physically
        <em>are</em> on each page. YOLO solves that. Once YOLO has identified{" "}
        <InlineCode>tables</InlineCode>, <InlineCode>title_block</InlineCode>,{" "}
        <InlineCode>drawings</InlineCode>, <InlineCode>door_single</InlineCode>,{" "}
        <InlineCode>circle</InlineCode>, and so on, every downstream feature in
        BP &mdash; Auto-QTO, Map Tags, the spatial heatmap, the heuristic engine,
        and LLM spatial queries &mdash; becomes significantly sharper.
      </p>

      <SubSection title="Where the run actually happens">
        <p>
          The run path is: admin opens <InlineCode>Admin → AI Models</InlineCode>, a
          tab rendered by <InlineCode>src/app/admin/tabs/AiModelsTab.tsx</InlineCode>,
          picks a model from the <InlineCode>models</InlineCode> table and a project,
          confirms the cost warning, and clicks <strong>Run</strong>. That fires{" "}
          <InlineCode>POST /api/yolo/run</InlineCode>, which writes a new{" "}
          <InlineCode>processingJobs</InlineCode> row and calls{" "}
          <InlineCode>startYoloJob()</InlineCode> in <InlineCode>src/lib/yolo.ts</InlineCode>.
          That function creates an AWS SageMaker Processing job pointing at the
          YOLO ECR container, mounts the project&apos;s{" "}
          <InlineCode>pages/</InlineCode> prefix in S3 as input, and sets{" "}
          <InlineCode>yolo-output/</InlineCode> as the output destination.
        </p>
        <p>
          While the job runs (usually a few minutes per project on an{" "}
          <InlineCode>ml.g4dn.xlarge</InlineCode>), the admin UI polls{" "}
          <InlineCode>GET /api/yolo/status</InlineCode> every ~5 seconds and shows
          live status, execution ID, and CloudWatch logs. When the container
          finishes, it writes per-page detection JSONs to S3; a webhook hits{" "}
          <InlineCode>POST /api/yolo/load</InlineCode>, which reads the JSONs,
          normalizes them into the <InlineCode>annotations</InlineCode> table
          (with <InlineCode>source = &quot;yolo&quot;</InlineCode>), and triggers a
          refresh of the CSI spatial heatmap + heuristic engine in YOLO-augmented
          mode.
        </p>
        <Figure
          kind="live"
          caption="YoloRunFlowDiagram — admin click → POST /api/yolo/run → SageMaker Processing → S3 yolo-output → POST /api/yolo/load → annotations + CSI heatmap refresh. Four safety layers gate the run path."
          size="full"
        >
          <YoloRunFlowDiagram />
        </Figure>
      </SubSection>

      <SubSection title="Safety toggles">
        <p>
          Because a SageMaker Processing job can cost real money if mis-triggered,
          BP has several layers of safety:
        </p>
        <ul className="list-disc pl-5 space-y-1 text-[13px]">
          <li>
            <strong>Company-level <InlineCode>sagemakerEnabled</InlineCode> toggle.</strong>{" "}
            Flipped off by default. Flipping it on requires the admin password
            stored in <InlineCode>app_settings</InlineCode>. When off, the entire
            YOLO run path returns an error immediately without touching AWS.
          </li>
          <li>
            <strong>Quota enforcement.</strong> Per-company concurrent-job caps
            check against the <InlineCode>processingJobs</InlineCode> table before
            starting a new job. Toggleable in the same admin panel.
          </li>
          <li>
            <strong>Per-user <InlineCode>canRunModels</InlineCode> flag.</strong>{" "}
            Regular members can view YOLO results but cannot initiate a run.
            Admins get the flag by default; root admins can grant it selectively.
          </li>
          <li>
            <strong>Root-admin-only model sharing.</strong> A YOLO model uploaded
            by one company is not automatically visible to others. The root admin
            has to grant model access per-company via the{" "}
            <InlineCode>modelAccess</InlineCode> table.
          </li>
        </ul>
      </SubSection>

      <SubSection title="The Detection Panel">
        <p>
          Once a YOLO run completes and results are loaded, they show up in the
          viewer&apos;s Detection Panel (<InlineCode>DetectionPanel.tsx</InlineCode>,
          ~780 lines of React). The panel has three sub-tabs:
        </p>
        <TableEl
          headers={["Sub-tab", "What it shows", "How it's built"]}
          rows={[
            [
              <strong key="1">Models</strong>,
              "Every YOLO annotation grouped by model → class → individual detection. Per-class and per-annotation visibility toggles, a global confidence slider, and a search filter.",
              <span key="1b">
                Primary view. Reads from <InlineCode>annotations</InlineCode> where{" "}
                <InlineCode>source === &quot;yolo&quot;</InlineCode>.
              </span>,
            ],
            [
              <strong key="2">Tags</strong>,
              "YoloTags — user-created tags that bind OCR text (like 'D-01') to specific YOLO shape instances. Created by the Map Tags step (Section 06) or by scan-ins. Each tag shows its instance count, pages, and CSI codes.",
              <span key="2b">
                Powered by the <InlineCode>yolo_tags</InlineCode> table. The Tags
                sub-tab is the main input into Auto-QTO.
              </span>,
            ],
            [
              <strong key="3">Shape</strong>,
              "Detected primitive shapes on the current page — circles, hexagons, diamonds, etc. Built for keynote tagging and tag-shape discovery. Run on-demand via /api/shape-parse.",
              <span key="3b">
                Shape-parse is OCR + OpenCV — it does not require a YOLO model run
                and can be triggered for free.
              </span>,
            ],
          ]}
        />
      </SubSection>

      <SubSection title="Confidence thresholds and filters">
        <p>
          Each YOLO model in BP carries a confidence threshold (default 0.25).
          The threshold applies both to storage (low-confidence detections can be
          filtered at ingest by the admin config) and to display &mdash; the
          toolbar&apos;s per-model slider in the YOLO dropdown filters the overlay
          live without mutating the underlying data.
        </p>
        <Figure
          kind="live"
          caption="ConfidenceSliderDemo — matches the per-model slider in the viewer's YOLO dropdown."
          size="sm"
        >
          <ConfidenceSliderDemo />
        </Figure>
        <p>
          On top of confidence, the toolbar exposes a <strong>trade filter</strong>{" "}
          (dropdown populated from the distinct trades inferred from CSI codes) and
          a <strong>CSI code filter</strong> (searchable dropdown). Both apply to
          the canvas overlay independently of confidence; they let estimators
          zero in on a single scope without fighting with confidence sliders.
        </p>
      </SubSection>

      <SubSection title="Sample YOLO classes">
        <p>
          BP ships reference models trained on construction drawings. The
          specific classes available depend on which models are registered in
          the <InlineCode>models</InlineCode> table for your company. Some
          commonly-useful classes:
        </p>
        <Figure kind="live" caption="Sample YOLO class chips with illustrative counts." size="full">
          <YoloClassChipDemo />
        </Figure>
        <p>
          The <InlineCode>tables</InlineCode>, <InlineCode>title_block</InlineCode>,
          and <InlineCode>drawings</InlineCode> classes are special: Auto-QTO
          (Section 07) strictly requires them. The{" "}
          <InlineCode>drawings</InlineCode> class marks the content region of a
          sheet, and <InlineCode>tables</InlineCode> + <InlineCode>title_block</InlineCode>{" "}
          mark regions to exclude from counts (so you don&apos;t double-count tags
          that appear <em>inside</em> a schedule).
        </p>
      </SubSection>

      <SubSection title="How YOLO stacks with heuristics">
        <p>
          The heuristic engine (<InlineCode>src/lib/heuristic-engine.ts</InlineCode>)
          runs in two modes. Text-only mode fires during the initial processing
          pass; YOLO-augmented mode re-runs after YOLO data loads. Each rule has
          optional <InlineCode>yoloRequired</InlineCode> and{" "}
          <InlineCode>yoloBoosters</InlineCode> fields. A rule like &quot;if the
          page contains the word &apos;concrete&apos; AND a <InlineCode>tables</InlineCode> class
          was detected, infer <InlineCode>schedule_present</InlineCode> with CSI
          division 03&quot; will skip silently during text-only mode and fire when
          YOLO runs later.
        </p>
        <CodeBlock lang="ts" caption="Shape of a heuristic rule (src/lib/heuristic-engine.ts)">
{`{
  id: "concrete-schedule",
  outputLabel: "schedule_present",
  outputCsiCode: "03",
  minConfidence: 0.6,
  textKeywords: ["concrete", "mix design"],
  yoloRequired: ["tables"],          // will skip until YOLO runs
  yoloBoosters: ["title_block"],     // adds confidence if present
  spatialConditions: [
    { type: "contains", region: "tables", textRegion: "header" },
  ],
}`}
        </CodeBlock>
        <p>
          This is the stacking story the rest of the docs will refer back to:
          YOLO models are not a replacement for heuristics, they&apos;re an
          additional signal that heuristics can chain on top of. A new YOLO class
          becomes a new input for existing rules, a new input for Auto-QTO, and a
          new input for the CSI spatial heatmap &mdash; without anyone having to
          touch the rules. Tools stack.
        </p>
        <Callout variant="tip" title="Per-class CSI auto-tagging">
          You can assign CSI codes directly to a YOLO class in the admin model
          config. Once set, every annotation of that class automatically
          inherits the codes &mdash; so detecting a <InlineCode>water_heater</InlineCode> class
          immediately contributes to Division 22 on the CSI heatmap and graph.
          That&apos;s another place where a new model or a tagged class
          automatically flows into every other feature without code changes.
        </Callout>
      </SubSection>

    </Section>
  );
}
