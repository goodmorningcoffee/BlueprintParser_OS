import { Section } from "../_components/Section";
import { SubSection } from "../_components/SubSection";
import { InlineCode } from "../_components/InlineCode";
import { Callout } from "../_components/Callout";
import { DeploymentTierTable } from "../_components/demos/DeploymentTierTable";

export function Section01Overview() {
  return (
    <Section id="overview" eyebrow="Intro" title="What BlueprintParser Is">
      {/* Plain-English lead */}
      <div className="max-w-3xl text-[15px] text-[var(--fg)]/80 leading-relaxed border-l-2 border-[var(--accent)]/40 pl-4 py-1 mb-4">
        In plain English: BP reads a construction drawing set the same way a
        junior estimator would &mdash; it looks at each page, recognizes the
        text, identifies which part of the project it&apos;s about, finds the
        schedules and callouts, and produces a structured summary. Then it
        gives you a viewer to review everything and a chat window to ask
        questions. Nothing leaves the LLM&apos;s context without a tool call
        that cites a page or a row; every number is traceable.
      </div>

      <p>
        BlueprintParser (BP) is an open-source, self-hostable platform that turns
        construction PDFs into structured, LLM-queryable data. You upload a
        multi-page drawing set; BP rasterizes each page, runs OCR, detects CSI
        MasterFormat codes, extracts structured text annotations, parses tables and
        schedules, classifies drawing regions, and produces a per-project{" "}
        <InlineCode>projectIntelligence</InlineCode> bundle &mdash; a compact
        description of the project that is small enough to fit inside an LLM
        context window but rich enough to answer detailed questions about quantities,
        trades, cross-references, and specifications.
      </p>
      <p>
        On top of that structured layer, BP ships a full blueprint viewer with
        markup, takeoff, tag-mapping, and chat &mdash; plus an admin dashboard that
        runs on-demand YOLO object detection via SageMaker when you want the
        project to become spatially aware as well as textually.
      </p>

      <SubSection title="Feature map: engines + viewer">
        <p>
          BP is organized as a set of <strong>engines</strong> that produce structured
          data and a single <strong>Viewer</strong> that consumes it, with a
          <strong> Graph/Output layer</strong> that feeds everything back to the LLM
          and the Admin dashboard. Data flows upload &rarr; Preprocessing Engine
          &rarr; (optional) YOLO Post-Pipeline &rarr; Viewer surfaces (display +
          user parsing) &rarr; ParsedRegions &rarr; Graph/Output &rarr; LLM chat and
          downstream tools. Every stage persists to <InlineCode>pageIntelligence</InlineCode> or{" "}
          <InlineCode>projectIntelligence</InlineCode>; nothing is ephemeral.
        </p>
        <ul className="list-disc pl-5 space-y-1 text-[13px]">
          <li>
            <strong>Preprocessing Engine</strong> (upload-time, always runs per page):
            rasterize at 300 DPI &rarr; Textract OCR (LAYOUT + TABLES) &rarr; drawing-number
            extraction &rarr; CSI code detection (3-tier matching) &rarr; text annotations
            (phones, equipment tags, abbreviations, 37+ types) &rarr; shape parse (keynote
            symbols via Python/OpenCV) &rarr; page intelligence analyze (classification,
            cross-refs, noteBlocks) &rarr; text-region classify (6-stage composite: LINE
            consumption, column-aware proposal, whitespace-rect discovery, Union-Find merge,
            per-region analysis, decision tree) &rarr; heuristic engine (9 rules, text-only
            mode) &rarr; table classifier &rarr; CSI spatial map (9&times;9 grid with title-block
            + right-margin zones).
          </li>
          <li>
            <strong>YOLO Post-Pipeline</strong> (admin-triggered, optional): SageMaker
            Processing job on g4dn.xlarge &rarr; YOLO annotations ingested &rarr; re-run
            heuristic engine with YOLO data &rarr; re-classify tables &rarr; composite
            region classifier (<InlineCode>classifiedRegions</InlineCode>) &rarr; YOLO
            density heatmap (text_box + vertical_area + horizontal_area aggregated on
            a 16&times;16 grid) &rarr; ensemble reducer (cross-signal agreement, suppresses
            keyword-only false positives) &rarr; auto-table-detector (emits{" "}
            <InlineCode>AutoTableProposal[]</InlineCode>, read-only until user commits).
          </li>
          <li>
            <strong>Viewer</strong> (user surface, <InlineCode>/project/[id]</InlineCode>):
            canvas with pdf.js rasterizer + nine overlay layers, a dense toolbar,
            three mutually-exclusive modes (pointer/move/markup), a stack of toggleable
            right-side panels (Text, CSI, LLM Chat, QTO, Schedules/Tables, Keynotes,
            Specs/Notes, Page Intelligence, View All), a bottom Annotation Panel, and
            user-driven parsing tools (Table Parse, Keynote Parse, Notes Parse, Spec Parse
            [planned], Symbol Search, Bucket Fill, Shape Parse, Split Area, Scale
            Calibration). Section 02 enumerates the full tree.
          </li>
          <li>
            <strong>Graph / Output Layer</strong> (downstream consumers): every
            user-committed ParsedRegion promotes via <InlineCode>/api/regions/promote</InlineCode>{" "}
            into <InlineCode>pageIntelligence.parsedRegions</InlineCode>; CSI tags merge
            into <InlineCode>pages.csiCodes</InlineCode> via idempotent{" "}
            <InlineCode>mergeCsiCodes</InlineCode>;{" "}
            <InlineCode>computeProjectSummaries</InlineCode> rebuilds{" "}
            <InlineCode>projectIntelligence.summaries</InlineCode> (schedules, notesRegions,
            specRegions, parsedTables, yoloTags). The <InlineCode>context-builder</InlineCode>{" "}
            assembles a budget-allocated LLM payload from all of the above; the CSI
            network graph + hub pages are derived once per project and surfaced in chat
            and the View All panel.
          </li>
          <li>
            <strong>Admin Dashboard</strong>: Pipeline config (toggle stages,
            concurrency, per-company heuristic overrides), Heuristics tab (DSL editor for
            rules), AI Models tab (register YOLO models, trigger runs), LLM Config (provider
            + context-budget allocations across 19 sections), Overview (reprocess
            controls + Lambda CV job status). Every viewer feature has a corresponding
            admin tuning surface.
          </li>
        </ul>
        <p className="pt-2">
          <strong>How they connect</strong>: Preprocessing runs once per upload and
          populates JSONB blobs on <InlineCode>pages</InlineCode>. YOLO Post-Pipeline
          augments those blobs on admin trigger. The Viewer reads them into a Zustand
          store (17 slice hooks) and renders overlays; user parsing tools write back
          to the same blobs via the generic <InlineCode>/api/regions/promote</InlineCode>{" "}
          commit route. The Graph/Output layer re-derives summaries on every commit and
          serves them to Chat and the Admin dashboard. The whole stack is one database
          shape with one write path per mutation, which is why every number in the UI
          traces back to a pixel on a page.
        </p>
      </SubSection>

      <SubSection title="The two data models">
        <p>
          Everything in BP ultimately fits into two axes. Horizontally, a project
          is a list of <strong>pages</strong>; each page carries OCR text, a
          classification, detected text annotations, detected tables, CSI codes,
          and (optionally) YOLO detections. Vertically, a project is a bundle of
          cross-cutting data: <strong>annotations</strong> (user markups + YOLO +
          takeoff), <strong>pageIntelligence</strong> (per-page structured
          analysis), and <strong>projectIntelligence</strong> (a project-wide
          summary including the CSI network graph, hub pages, and discipline
          breakdown).
        </p>
        <p>
          The preprocessing pipeline, the LLM context builder, the takeoff engine,
          and the viewer all read and write through those two shapes. Section 03
          walks through how the data actually arrives; Section 11 walks through
          where it is stored and why.
        </p>
      </SubSection>

      <SubSection title="What runs locally vs. what needs AWS">
        <p>
          BP is the same codebase in every deployment tier &mdash; the difference is
          purely which external services are configured. A development machine with
          Docker and a Groq free-tier API key can run the full viewer against a
          locally-hosted PostgreSQL instance, parse tables with img2table and
          Camelot, and chat with an LLM, all without a single AWS credential. Add
          an S3 bucket and page images become durable; add the full Terraform
          stack and you get CloudFront, Textract, Step Functions, and Label Studio;
          add a SageMaker Processing role and a YOLO ECR image and YOLO object
          detection becomes available on-demand.
        </p>
        <DeploymentTierTable />
        <Callout variant="info" title="Try it without credentials">
          The <InlineCode>/demo</InlineCode> route hosts a read-only view of a
          seeded demo project, including YOLO detections, parsed schedules, and
          chat. It&apos;s the fastest way to kick the tires without installing
          anything.
        </Callout>
      </SubSection>

      <SubSection title="Tech stack snapshot">
        <p>
          BP is a single Next.js 16 application (App Router, React 19, TypeScript)
          backed by PostgreSQL 16 via <InlineCode>drizzle-orm</InlineCode>. State in
          the viewer lives in a single <InlineCode>zustand</InlineCode> store with
          slice selectors. LLM access goes through a thin adapter layer over the
          Anthropic, OpenAI, and Groq SDKs, plus a generic OpenAI-compatible
          endpoint for Ollama and self-hosted models. The CSI network graph is
          rendered with <InlineCode>d3-force</InlineCode>. Python sidecars
          (pdfplumber, Camelot, img2table, TATR, OpenCV, Tesseract, and the YOLO
          inference container) are spawned from TypeScript via stdin/stdout JSON.
          AWS deployment is codified in <InlineCode>infrastructure/terraform/</InlineCode> &mdash;
          13 files totaling the full stack including ECS, RDS, S3, Step Functions,
          IAM, Secrets Manager, and CloudFront.
        </p>
      </SubSection>
    </Section>
  );
}
