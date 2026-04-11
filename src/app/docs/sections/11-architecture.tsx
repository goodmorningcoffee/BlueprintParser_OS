import { Section } from "../_components/Section";
import { SubSection } from "../_components/SubSection";
import { Figure } from "../_components/Figure";
import { InlineCode } from "../_components/InlineCode";
import { Callout } from "../_components/Callout";
import { CodeBlock } from "../_components/CodeBlock";
import { TableEl } from "../_components/TableEl";
import { ArchitectureSvgDiagram } from "../_components/demos/ArchitectureSvgDiagram";
import { TerraformFileList } from "../_components/demos/TerraformFileList";

export function Section11Architecture() {
  return (
    <Section id="architecture" eyebrow="Operations" title="System Architecture">
      <p>
        This section is a tour of where BP actually runs on AWS and how the
        pieces fit together. It is intentionally not a deployment tutorial
        &mdash; the README and the Terraform variables file are better starting
        points for that. The goal here is to answer questions like &quot;what
        talks to what,&quot; &quot;where does the LLM call come from,&quot;
        and &quot;what part of this would I rip out if I wanted to run BP
        offline.&quot;
      </p>

      <SubSection title="Topology at a glance">
        <Figure
          kind="live"
          caption="ArchitectureSvgDiagram — the BP runtime on AWS, color-coded by service family."
          size="full"
        >
          <ArchitectureSvgDiagram />
        </Figure>
        <p>
          A browser hits CloudFront at <InlineCode>assets.*</InlineCode> for
          page images and thumbnails, and the ALB at the primary domain for
          everything else. The ALB routes HTTPS to two ECS services: the main
          app (a Next.js container) and Label Studio (a separate labeling UI for
          training data work). Both run in Fargate &mdash; no EC2 to manage.
          Secrets come from Secrets Manager; the DB is RDS PostgreSQL; durable
          storage is S3 behind CloudFront.
        </p>
      </SubSection>

      <SubSection title="The main app service">
        <p>
          <InlineCode>blueprintparser-app</InlineCode> is the Next.js 16
          container defined in <InlineCode>infrastructure/terraform/ecs.tf</InlineCode>.
          Task definition: <strong>2 vCPU / 4 GB</strong>. It serves the entire
          React app, handles every API route, runs Drizzle queries against RDS,
          pushes processing jobs to Step Functions, and proxies LLM calls. Auto
          scaling is CPU-based (target 70%) with memory as a guardrail (80%). A
          circuit breaker is enabled on deployments so a broken image rolls back
          automatically.
        </p>
        <CodeBlock lang="ts" caption="Task definition highlights (from ecs.tf)">
{`name            = "blueprintparser-app"
cpu             = 2048          // vCPU × 1024
memory          = 4096          // MiB
container_image = "{{ecr}}/beaver_app:latest"
container_port  = 3000
health_check    = { path = "/api/health", interval = 30, timeout = 5 }
execution_role  = "beaver_ecs_execution_role"   // ECR pull, logs, secrets read
task_role       = "beaver_ecs_task_role"         // S3, Textract, SageMaker, SFN
desired_count   = var.ecs_desired_count          // auto-scaled
deployment_controller = "ECS"
circuit_breaker = { enable = true, rollback = true }`}
        </CodeBlock>
        <p>
          The app task needs direct access to Secrets Manager (to pull{" "}
          <InlineCode>DATABASE_URL</InlineCode>,{" "}
          <InlineCode>NEXTAUTH_SECRET</InlineCode>, LLM keys), S3 (to write
          uploads and read page images), Textract (OCR), SageMaker (start/stop
          jobs), and Step Functions (start executions). Those are all attached
          to the task role in <InlineCode>iam.tf</InlineCode>.
        </p>
      </SubSection>

      <SubSection title="The cpu-pipeline task">
        <p>
          Long-running processing is offloaded to a second ECS task named{" "}
          <InlineCode>blueprintparser-cpu-pipeline</InlineCode>. It&apos;s the
          same container image as the main app, just started with a different
          command (<InlineCode>node scripts/process-worker.js</InlineCode>) and
          a much bigger footprint (8&nbsp;vCPU, 16&nbsp;GB memory). The task
          runs the full preprocessing pipeline for a single project and then
          exits. This keeps the web task responsive during heavy PDF ingest.
        </p>
        <p>
          The state machine in <InlineCode>stepfunctions.tf</InlineCode>
          (<InlineCode>blueprintparser-process-blueprint</InlineCode>) is what
          starts cpu-pipeline tasks. It&apos;s a straight line:{" "}
          <strong>ValidateInput → CPUProcessing → ProcessingComplete</strong>{" "}
          with a failure branch. Retries happen on <InlineCode>TaskFailed</InlineCode>{" "}
          with a 30-second interval and 2.0× backoff, up to 2 attempts. The
          state machine logs to a CloudWatch log group{" "}
          (<InlineCode>/aws/states/blueprintparser-process-blueprint</InlineCode>)
          for debuggability.
        </p>
        <Callout variant="info" title="Local path bypasses Step Functions">
          On a local dev machine with no AWS, <InlineCode>processProject()</InlineCode>{" "}
          runs inline from the <InlineCode>/api/projects</InlineCode> handler in
          a fire-and-forget promise. Same code, no state machine. This is why
          the local tier in Section 01 works &mdash; you don&apos;t need
          anything AWS just to see the pipeline run.
        </Callout>
      </SubSection>

      <SubSection title="SageMaker Processing for YOLO">
        <p>
          YOLO inference runs out-of-band on SageMaker Processing jobs. BP calls{" "}
          <InlineCode>sagemaker:CreateProcessingJob</InlineCode> from the app
          task with inputs pointing to the project&apos;s{" "}
          <InlineCode>pages/</InlineCode> prefix in S3 and outputs pointing to{" "}
          <InlineCode>yolo-output/</InlineCode>. The container image comes from
          a second ECR repo (<InlineCode>beaver_yolo_pipeline</InlineCode>) built
          separately from the app image. The default instance type is{" "}
          <InlineCode>ml.g4dn.xlarge</InlineCode>, billed per run, which is the
          exact reason the sagemakerEnabled toggle exists.
        </p>
      </SubSection>

      <SubSection title="Storage layout">
        <p>
          S3 is the durability layer. The bucket is{" "}
          <InlineCode>blueprintparser-data-&#123;account_id&#125;</InlineCode> and the
          layout is stable:
        </p>
        <CodeBlock lang="text" caption="S3 layout per project">
{`{dataUrl}/                             // {company_id}/{project_public_id}
├── original.pdf                       // raw upload
├── thumbnail.png                      // 72 DPI cover image
├── pages/
│   ├── page_0001.png                  // 300 DPI display image
│   └── page_0002.png
├── thumbnails/
│   ├── page_0001.png                  // 72 DPI thumbnail
│   └── page_0002.png
├── yolo-output/                       // written by SageMaker
│   ├── page_0001_detections.json
│   └── page_0002_detections.json
└── exports/
    ├── takeoff.csv                    // user-exported CSVs
    └── labels.zip                     // Label Studio exports`}
        </CodeBlock>
        <p>
          Every file under <InlineCode>pages/</InlineCode> and{" "}
          <InlineCode>thumbnails/</InlineCode> is cached as{" "}
          <InlineCode>public, max-age=31536000, immutable</InlineCode> so
          CloudFront holds them forever. The cache-warming pass at the end of
          preprocessing primes edge locations so the first viewer open is fast.
          Filenames include the page number so they&apos;re effectively
          content-addressed.
        </p>
        <p>
          Database storage uses PostgreSQL 16 on a{" "}
          <InlineCode>db.t4g.medium</InlineCode> with 50&nbsp;GB gp3 that can
          auto-grow to 200&nbsp;GB. Backups retained 7 days. Multi-AZ in
          production. All writes go through Drizzle; the schema lives in{" "}
          <InlineCode>src/lib/db/schema.ts</InlineCode>.
        </p>
      </SubSection>

      <SubSection title="The database schema at 50,000 feet">
        <TableEl
          headers={["Table", "Purpose"]}
          rows={[
            ["companies", "Multi-tenant boundary. Holds pipelineConfig (CSI thresholds, heuristics, pageConcurrency, csiSpatialGrid)."],
            ["users", "Auth + RBAC. isRootAdmin, canRunModels, companyId."],
            ["sessions", "NextAuth session tokens."],
            ["projects", "One row per uploaded PDF set. status, numPages, projectIntelligence JSONB, projectSummary text."],
            ["pages", "One row per page. rawText, drawingNumber, csiCodes, textAnnotations, pageIntelligence JSONB, search_vector tsvector."],
            ["annotations", "YOLO + user markups + takeoff items. bbox, className, confidence, source, data JSONB."],
            ["yolo_tags", "Map Tags output — tag text ↔ YOLO shape instances."],
            ["qto_workflows", "Auto-QTO state machines with materialType, step, parsedSchedule, lineItems, userEdits."],
            ["takeoff_groups", "Groups in the takeoff panel sidebar."],
            ["takeoff_items", "Individual takeoff items (count/area/linear) organized into groups."],
            ["chat_messages", "Conversation history, keyed by project + page + scope."],
            ["llm_configs", "Company- or user-scoped LLM provider + model + encrypted API key + context section overrides."],
            ["user_api_keys", "User-level API keys (encrypted at rest)."],
            ["models", "YOLO model registry — name, type, s3Path, config, isDefault."],
            ["model_access", "Per-company access grants for models owned by another company."],
            ["processing_jobs", "SageMaker / Step Functions job tracking with status + CloudWatch refs."],
            ["labeling_sessions", "Label Studio integration state."],
            ["app_settings", "Global key/value (root admin only). Includes the sagemakerEnabled toggle password."],
            ["audit_log", "Admin action history."],
          ]}
        />
      </SubSection>

      <SubSection title="Terraform file map">
        <p>
          The full stack is in <InlineCode>infrastructure/terraform/</InlineCode>.
          Each file has a single responsibility:
        </p>
        <Figure kind="live" caption="infrastructure/terraform/ — 13 files, single source of truth for AWS." size="full">
          <TerraformFileList />
        </Figure>
      </SubSection>

      <SubSection title="Label Studio side-car">
        <p>
          Label Studio runs as a separate ECS task with an EFS volume mounted at{" "}
          <InlineCode>/label-studio/data</InlineCode>. The ALB routes{" "}
          <InlineCode>labelstudio.*</InlineCode> to the task; the main app
          integrates via <InlineCode>/api/labeling/*</InlineCode> routes. It
          reads from the same S3 bucket the main app writes to, so
          round-tripping a project from ingest to labeling and back works
          without cross-service copying.
        </p>
      </SubSection>

      <SubSection title="Running without AWS">
        <p>
          Everything in this section is the deployed tier. You can ignore most
          of it and still run BP: the repo ships a{" "}
          <InlineCode>docker-compose.yml</InlineCode> that brings up a local
          PostgreSQL on port 5433 and lets you run{" "}
          <InlineCode>npm run dev</InlineCode> against it. Textract, S3, and
          SageMaker are all gated by env vars &mdash; when they&apos;re missing,
          BP falls back to Tesseract for OCR, the local filesystem for images
          (or a dev-mode S3 emulator if you prefer), and nothing for YOLO.
          LLM chat still works if you have a Groq free-tier key. The table
          parsers (img2table, Camelot, TATR) all run locally from{" "}
          <InlineCode>scripts/</InlineCode>. Bucket Fill runs locally. Auto-QTO
          runs locally given a parsed schedule. The only hard dependency on AWS
          is YOLO inference.
        </p>
      </SubSection>
    </Section>
  );
}
