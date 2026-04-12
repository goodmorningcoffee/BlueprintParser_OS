import { Section } from "../_components/Section";
import { SubSection } from "../_components/SubSection";
import { InlineCode } from "../_components/InlineCode";
import { Callout } from "../_components/Callout";
import { DeploymentTierTable } from "../_components/demos/DeploymentTierTable";

export function Section01Overview() {
  return (
    <Section id="overview" eyebrow="Intro" title="What BlueprintParser Is">
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

      <SubSection title="Who it is for">
        <p>
          The primary audience is <strong>estimators, project managers, and
          construction technology builders</strong> who are tired of manually
          extracting quantities from PDF drawing sets and want to put an LLM in the
          loop without giving up the ability to inspect, correct, and override the
          model&apos;s work. Secondary audiences include <strong>applied
          researchers</strong> building pipelines around Textract, YOLO, and LLM
          tool-use for document intelligence, and <strong>open-source
          contributors</strong> who want a reference implementation of a multi-stage
          construction-document preprocessing pipeline.
        </p>
        <p>
          BP is deliberately technically dense. The viewer is built for people who
          know what a cross-reference, a keynote, and a finish schedule are. The
          admin dashboard exposes company-level pipeline tuning (CSI confidence
          thresholds, heuristic rule overrides, LLM context presets, per-page
          concurrency) rather than hiding it behind defaults. If you want a turnkey
          SaaS takeoff tool, BP is not that &mdash; it is a platform to build one on.
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
