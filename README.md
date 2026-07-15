# BlueprintParser

**Live demo**: https://app.blueprintparser.com/demo  
**BP Docs**: https://app.blueprintparser.com/docs

BlueprintParser is a Next.js web app and a blueprint parsing engine.

---

## Features

- Manual and AI-assisted QTO
- Extract schedules/tables from PDF to Excel/CSV
- LLM chat with entire projects without blowing up context
  - BP includes a context engine that uses multiple methods for creating dense, token-efficient blueprint embeddings
- Agent tool use _(work in progress)_
  - BP tools can be operated by agents
  - Agents can query blueprints and provide more accurate answers with citations
- Blueprint parsing engine
  - Backend tooling that makes PDF CDs machine readable
  - YOLO object detection models detect shapes and spatial zones.
  - Rasterize PDF and OCR all text
  - CSI tagging: tag all CSI codes in the drawings
  - OpenCV tools for extracting shapes and visual information
  - Auto name Sheets / Drawing numbers
  - Network graph engine: build nodes and edges between sheets in a project and between projects in a portfolio.

See all features and more in the BlueprintParser docs, link up top.

### Current YOLO Classes

There are two general categories: "discrete and spatial" classes.

#### Discrete Classes

Examples:

- `door_single`
- `square`
- `schedule_table`

#### Spatial Classes

Examples:

- `title_block`
- `drawings`
- `text_block`

Spatial classes define regions of the drawings, and help with localization and corroboration. Since we use OCR, we also have the pixel coordinates of all text, which we can map against the YOLO outputs.
For instance, when extracting the drawing number, we can check if the drawing number is located inside a title_block region.  
Or, when looking for the door schedule, BP knows to look for the sheet where the words "door schedule" occur inside a "schedule_table" region, and can double check the title_block for coraberating text like "door and window schedule".  
BP uses spatial data to build CSI-heatmaps, which show the distribution of CSI codes on a sheet. YOLO spatial data enables us to differentiate between a cluster of CSI codes that are occuring in a text_block vs the drawings vs inside a schedule vs the title_block. YOLO spatial classes are baby steps towards building a visual-reasoning engine for blueprints.

YOLO acts as the "eyes" for LLMs and agents, enabling them to "see" into the drawings.

## NOTE on YOLO Models

The YOLO models used in the demo were hand-labeled and trained by myself.

- 500+ hours of manual labeling
- More than $3,000 in AWS compute

The trained weights and training datasets are not included in this repository.
BlueprintParser is designed so users can upload and use their own object-detection models.

---

## Project Goal

It started with trying to build a free quantity takeoff tool, expanded with extracting schedules/tables to excel, and eventually evolved into a LLM harness for blueprints.

Its not enough to rely on LLMs, it's necesary to give them tools that empower them to do more with blueprints.

---

## Future Goals as of May, 2026

- Rebuild a headless version of the BP parsing engine
  - Frontend agnostic
  - Usable by tools like Claude Cowork/Code, Codex and agent harnesses.

- Build a lightweight frontend optimized for LLM/"chat with the drawings".

- Expand agent tool use
  - Enable an agent to do a full QTO using BP's tools. With better tool use, agents can more effectively navigate the plans, answer more complex questions with citations derived from the drawings, and actually interact with blueprints.

- Eventually rebuild the frontend entirely, it's full of bugs and the UI is janky.

---

## Training Data requirements for YOLO

I believe there are at least ~200 blueprint object classes that, if trained properly, could enable an AI-QTO engine to handle 80–90% of "each" takeoffs across trades.
A truly comprehensive blueprint object-detection system would likely exceed 400 classes. To label this many classes, it would take 50-100+ annotators working full time for 6-12 months, require hundreds of thousands of bid grade CDs, a robust annotator workforce management system, and lots of data labeling and ML ops. Factor in hosting cost for that many annotators and the compute for training the models, the capital to build this dataset could be a 6 or 7 figure investment.

Then, we have to do this again for image segmentation (surface area), classification, for fine tuning LLMs, and much more.

There is a tremendous data labeling challenge ahead of the AEC industry.

---

## Why This Matters

We have to solve the "drawing problem" if the AEC industry wants to one day, build its own VLM or foundation models. Spatial reasoning is a must. To get there will require a massive and sustained data labeling campaign, that likely will require coordination between unlikely partners to succeed.

BlueprintParser is a small step in that direction, and hopefully contributes toward the development of an open source ai community in AEC and specifically for Estimators.

---

## Quick Start (Local Development)

```bash
git clone https://github.com/goodmorningcoffee/BlueprintParser.git
cd BlueprintParser/blueprintparser_2
cp .env.example .env.local       # Edit DATABASE_URL, NEXTAUTH_SECRET at minimum
docker compose up -d              # PostgreSQL on port 5433
npm install
npm run db:migrate                # Create tables (loopback development DB only)
bash scripts/setup.sh             # Create root admin account (interactive)
npm run dev                       # http://localhost:3000
```

Works without AWS credentials — PDF viewing, annotations, table parsing, QTO, and search are all functional locally. For the full pipeline, add: `GROQ_API_KEY` (free-tier LLM chat), AWS credentials (Textract OCR, S3 storage, SageMaker YOLO inference).

## Setup Scripts

| Script                            | Purpose                                                                                                        | When to Use                                    |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `scripts/setup.sh`                | First-time setup — runs migrations and creates root admin account                                              | After cloning, once PostgreSQL is running      |
| `install_setup.sh`                | Interactive config wizard; schema setup is allowed only for a loopback development database                    | Local setup, or updating service configuration |
| `deploy.sh`                       | Publish an immutable app image, then activate digest-pinned task definitions after migration-history admission | Ordinary AWS production deployments            |
| `scripts/p2-schema-cutover.sh`    | Verify zero writers/readiness, bind and retire old revisions, migrate, and verify restoration                  | One-time P2 schema compatibility boundary      |
| `deploy-yolo.sh`                  | Build and push YOLO inference container to ECR                                                                 | When updating YOLO models or inference code    |
| `hardening.sh`                    | Retired fail-closed tombstone; performs no AWS action                                                           | Never; manage reviewed controls through Terraform |
| `root_admin.sh`                   | Create/reset root admin account on a running instance                                                          | Emergency admin access recovery                |
| `scripts/cost-control.sh`         | Read-only ECS, Step Functions, and SageMaker status report                                                     | Production cost and writer-state inspection    |
| `scripts/sagemaker-killswitch.sh` | Emergency stop all SageMaker resources                                                                         | If costs spike unexpectedly                    |

### Full Setup (with AWS)

Before the first full apply against an existing data bucket, an owner must inventory its complete S3
notification subresource. Terraform's `aws_s3_bucket_notification` resource replaces that whole
subresource, not just the EventBridge field. Save the current configuration outside the repository
with owner-only permissions:

```bash
umask 077
aws s3api get-bucket-notification-configuration \
  --bucket "beaver-data-${AWS_ACCOUNT}" \
  --region "${AWS_REGION}" \
  > /owner/private/beaver-data-notification-before-terraform.json
```

Review and reconcile every `LambdaFunctionConfigurations`, `QueueConfigurations`,
`TopicConfigurations`, and `EventBridgeConfiguration` entry. The declared end state is
EventBridge-only; decide explicitly how every pre-existing target is retired or represented before
setting `acknowledge_beaver_data_notification_takeover = true` in reviewed, untracked Terraform
values. Its false default deliberately blocks takeover. Terraform enables EventBridge only after the
durable queue target and both delivery policies exist.

For an ordinary candidate deployment whose database is already exactly current, keep the old digest
while entering the exact outage tuple, create its local witness, and only then admit the candidate:

```bash
bash install_setup.sh
./deploy.sh publish                       # retain its candidate sha256 digest

# In untracked tfvars keep the CURRENT digest and set exactly 0/0/1, autoscaling
# false, and the maintenance schedule false; apply, drain, and observe 900 seconds.
terraform -chdir=infrastructure/terraform apply
./deploy.sh preflight-outage sha256:CURRENT_DIGEST sha256:CANDIDATE_DIGEST

# Change only to the CANDIDATE digest while the exact outage tuple remains; apply.
terraform -chdir=infrastructure/terraform apply
./deploy.sh bind-quiescent sha256:CANDIDATE_DIGEST

# Restore exactly 1/1/1 with autoscaling and the maintenance schedule true; apply.
terraform -chdir=infrastructure/terraform apply
./deploy.sh verify-restored sha256:CANDIDATE_DIGEST
```

If the candidate apply changes the schedule's `LastModificationDate`, wait another 900 seconds before
`bind-quiescent`. The witness's replay authority is the Terraform-managed writer-mode epoch exposed
on the canonical ECS service: it rotates on every live/outage transition but stays stable during the
candidate-only outage apply. The schedule timestamp is retained as supplemental audit evidence.
Immediately before `UpdateService`, `bind-quiescent` replaces the baseline proof with a short-lived
`candidate-admitted` receipt containing all four exact candidate task definitions, the pinned database
secret version, outage epoch, timestamps, and nonce. If the update response is ambiguous or the local
process stops, rerun `bind-quiescent` while the receipt is valid; it admits only the recorded baseline
or recorded candidate binding and converts to a nonexpiring receipt only after the candidate is proved
stable and quiescent.
`verify-restored` accepts only desired/running/minimum/maximum `1/1/1/1`; there is no count override.
`deploy.sh activate` is reserved for a same-digest configuration or secret restart and refuses to
change the service's image digest.

Do not use that activation sequence for a new empty RDS database or the first upgrade from the
durable `0032` checkpoint. A brand-new AWS account needs a two-stage repository bootstrap because
`deploy.sh publish` cannot push until Terraform has created ECR, while the full stack requires a real
published digest:

1. Configure the required Terraform values, including a reviewed
   `heartexlabs/label-studio@sha256:...` manifest digest. Set app desired/minimum to zero, disable
   autoscaling and the maintenance schedule, and give `beaver_app_image_digest` a syntactically valid
   temporary value (`sha256:` plus 64 zeroes).
2. Apply **only** `-target=aws_ecr_repository.beaver_app`. Never apply the full stack with the
   placeholder digest.
3. Run `./deploy.sh publish`, replace the placeholder with its printed digest, and run the full apply
   with exactly desired/minimum/maximum `0/0/1`, autoscaling disabled, and the maintenance schedule
   disabled.
4. Leave the new schedule disabled for the documented 900-second observation/drain interval, then
   run `BP_APP_IMAGE_DIGEST=sha256:... scripts/p2-schema-cutover.sh bootstrap-empty`. A first attempt's
   read-only readiness task accepts only zero migration history plus no objects in the `public`
   schema. It then writes a short-lived, owner-only `empty-bootstrap-armed` witness bound to the exact
   candidate task definitions, database-secret version, writer-mode epoch, timestamps, and nonce
   before it can launch the armed migrator. Only a retry with that still-valid witness may admit exact
   current history after an ambiguous success; it reuses the nonce-derived ECS client token to
   reconcile the same migration request. Every intermediate or otherwise divergent history is refused.
5. Restore exactly desired/minimum/maximum `1/1/1`, enable autoscaling and the maintenance schedule,
   apply, and run `BP_APP_IMAGE_DIGEST=sha256:... scripts/p2-schema-cutover.sh verify-restored`.
   The empty-database proof is the sole safe exception to the old-digest witness requirement.

Use the P2 cutover sequence below for an existing exact `0032`–`0038` history. Restore normal writer
counts only after `verify-restored` succeeds.

Terraform deliberately ignores the app service's `task_definition`: an apply registers the reviewed
digest for every process role but cannot roll the app. Only `deploy.sh activate` after its remote
migration-history check can restart the already-bound digest. A new digest is bound only by the
witness-backed zero-count cohort or the deliberate empty-database bootstrap.

The setup wizard prompts for: database URL, auth secrets, LLM API keys (Groq/Anthropic/OpenAI), AWS credentials, S3 bucket, CloudFront, Step Functions, SageMaker, and Label Studio. Re-run anytime to update configuration. Its schema command is an operator safety fence for loopback development databases only; it neither proves that a loopback/SSH-tunneled target is non-production nor mutates a cloud database.

Label Studio integration requires `LABEL_STUDIO_URL`, the server-only
`LABEL_STUDIO_API_KEY`, and a stable `LABEL_STUDIO_INSTANCE_ID`. Terraform
also requires an immutable `heartexlabs/label-studio@sha256:...` image reference; resolve and review
the upstream manifest digest rather than supplying a tag. Terraform
combines the EFS filesystem ID with `label_studio_instance_generation`; increment
that generation before restarting BlueprintParser whenever the Label Studio
database is reinitialized, replaced, or restored as a new logical instance,
even if EFS survives. Bootstrap email and password are consumed only by the
Label Studio container. The separate `root_admin_email` variable controls
BlueprintParser root-admin promotion and must never be sourced from the Label
Studio administrator.

Deployment admission also treats task values as exact identities, not merely present environment
variables. `DOMAIN`, `CLOUDFRONT_DISTRIBUTION_ID`, and the explicitly present `ROOT_ADMIN_EMAIL` come
from the owner-reviewed `.deploy.env`; an intentionally disabled root-admin email is represented by an
explicit empty value. App and maintenance definitions must share the validated
`LABEL_STUDIO_INSTANCE_ID`; all four roles must use the same version-pinned canonical
`DATABASE_URL` Secrets Manager value. The app accepts a varying YOLO digest only beneath the canonical
account/Region `beaver-yolo-pipeline` repository. Canonical HTTPS app/Label Studio/CloudFront
identities, the Step Functions ARN, SageMaker role, data bucket, Region, port, Lambda controls, and
role-specific allowlists are checked before any task is run or service is changed. The singleton
migrator has a dedicated ECS task role with no inline or attached permission policies.

### P2 schema and Label Studio cutover

Migration `0037` is a **writer-outage compatibility boundary**, not a rolling migration. It requires
zero legacy Label Studio sessions/intents and adds columns that every new writer must understand.
Application and worker startup now performs only an exact ordered Drizzle migration-history check
(timestamps and SQL hashes); it never migrates. This does not claim that arbitrary out-of-band DDL is
absent—routine helpers expose no DDL, and direct database authority remains break-glass.
`deploy.sh activate` runs that read-only history check remotely and refuses a pre-0038 database before it
updates the service. The app, CPU worker, maintenance worker, and singleton migrator task definitions
all use one ECR digest, so a delayed scheduled task cannot pull a newer mutable `latest` image.

Use this owner-run order for the first 0037/0038 deployment and for a simultaneous provider reset:

1. While the old provider is available, close labeling admission, retire every Label Studio session
   and pending provisioning intent, verify provider cleanup, and rotate historical bootstrap secrets.
2. Run `./deploy.sh publish` and retain both the currently bound and printed candidate
   `sha256:...` digests. Do not run `activate`.
3. With the **currently bound digest unchanged**, set untracked Terraform values to the exact outage
   tuple: `maintenance_worker_schedule_enabled = false`, `ecs_autoscaling_enabled = false`,
   `ecs_desired_count = 0`, `ecs_min_count = 0`, and `ecs_max_count = 1`. Apply and wait for the
   service to drain. Merely setting minimum/desired zero is insufficient because an unsuspended
   target-tracking policy can scale the service back out. If replacing the provider, also increment
   `label_studio_instance_generation` in this writer-disabled plan.
4. Leave the schedule disabled for at least 900 seconds (its declared 600-second retry/event-age
   window plus a 300-second ECS consistency window), then create the baseline witness while all four
   latest definitions and the zero-count service still use the old digest:

   ```bash
   BP_APP_IMAGE_DIGEST=sha256:CURRENT_DIGEST \
   BP_CANDIDATE_IMAGE_DIGEST=sha256:CANDIDATE_DIGEST \
     scripts/p2-schema-cutover.sh preflight-outage
   ```

5. Change only `beaver_app_image_digest` to the candidate while preserving the exact outage tuple and
   apply. If this changes the schedule's `LastModificationDate`, observe another 900 seconds. Then run:

   ```bash
   BP_APP_IMAGE_DIGEST=sha256:CANDIDATE_DIGEST scripts/p2-schema-cutover.sh run
   ```

   `run` refuses a missing, malformed, expired, replayed-epoch, wrong-candidate, or wrong-identity
   owner-local witness, and proves that
   the zero-count service remains bound to its witnessed old revision before admitting the candidate.
   The Step Functions ARN and all task/schedule family identities are canonical and are not caller
   selectable. The cohort fails unless the schedule is disabled and old enough to drain delayed
   delivery, app desired/minimum/running/pending counts are zero, dynamic-in/dynamic-out/scheduled
   autoscaling are all suspended, there are no live app/CPU/maintenance/migrator tasks (including
   stopping tasks), there are no running Step Functions executions, all four latest task definitions
   use the candidate digest and exact role contracts, and both Step Functions and Scheduler target
   their exact revisions in the canonical cluster. `run` accepts only exact full-history prefixes from
   `0032` through `0038`, rejects invalid legacy company storage namespaces/paths, waits a fixed
   additional 300-second observation interval, and repeats the complete launcher preflight. It then
   runs a separate read-only database-readiness task. For a pre-0037 history that task also requires
   zero legacy sessions/intents; an exact 0037 or 0038 retry may legitimately contain new-protocol
   rows. After readiness passes, the tool first persists the short-lived full-candidate
   `candidate-admitted` receipt, then binds the app revision at desired zero, proves it
   stable, and deregisters every other ACTIVE revision in all four writer families. It observes the
   fixed 600-second ECS deregistration enforcement window, re-verifies the retained ACTIVE sets,
   stable zero-count binding, absence of writer tasks, and the full launcher preflight, then passes the
   migration mode as a one-run ECS override. The request uses a deterministic client token derived
   from the admitted nonce. Within ECS's token lifetime—the lower of 24 hours and the task lifetime
   plus one hour—rerunning `run` with the still-valid receipt reconciles the same RunTask after an
   ambiguous response. A still-valid six-hour receipt can outlive that ECS token; a later retry may
   launch the same guarded request again, so the locked, no-permission migrator repeats the history,
   namespace/path, and conditional legacy-row checks before any SQL and treats exact-current history
   as a no-op. Do not restore writers if RunTask or its waiter has an ambiguous outcome; use the
   printed client token/started-by value to verify tasks and migration history while the outage remains
   in force.

6. With the candidate digest unchanged, restore the exact live tuple:
   `ecs_desired_count = 1`, `ecs_min_count = 1`, `ecs_max_count = 1`,
   `maintenance_worker_schedule_enabled = true`, and `ecs_autoscaling_enabled = true`. Apply, wait for
   ECS stability, then run
   `BP_APP_IMAGE_DIGEST=sha256:CANDIDATE_DIGEST scripts/p2-schema-cutover.sh verify-restored`.
   Reopen labeling only after it consumes the bound witness successfully and provider generation is
   verified. Never use `deploy.sh activate` for the initial boundary.

The cutover tool can observe the application-owned service, task families, schedule, and state
machine, but it cannot revoke unrelated IAM principals. During the bounded outage, operators must
also prevent external principals from starting the Step Functions state machine or standalone tasks.
After the boundary, never re-register or directly launch a deregistered pre-boundary task definition:
those images predate exact schema admission. `ecs-tune.sh` and `scripts/cost-control.sh` are read-only;
they cannot scale or restore the app. Change writer counts only through reviewed Terraform, use
the witness-backed `preflight-outage` / `bind-quiescent` / `verify-restored` path for every candidate
digest, and reserve `deploy.sh activate` for a same-digest configuration or secret restart. Complete
`verify-restored` after the P2 outage. A deny on the state-machine execution role does not block caller authorization to start an
execution, so the cost report never labels Step Functions as blocked. Direct ECS Exec/database DDL
remains break-glass owner authority and is intentionally absent from `root_admin.sh`.

Deferred deployment reproducibility item: the Terraform AWS provider is still constrained by
`~> 5.0` while `.terraform.lock.hcl` is not tracked. Treat CI/provider resolution as moving until a
scrubbed, reviewed dependency lock is committed in the planned infrastructure hardening pass.

Label Studio task images use opaque, revocable application URLs because the provider cannot add a
BlueprintParser authorization header to an imported image request. The bearer is consequently in the
URL query and the shared ALB records it in the request target before application redaction is possible.
Treat ALB access logs as secrets: Terraform writes them only to the dedicated
`beaver-alb-access-logs-*` bucket, blocks public access, enforces bucket ownership and TLS, uses the
ALB-compatible SSE-S3 encryption mode, restricts delivery to the named `beaver-alb` in this account
and Region, and expires the `alb-logs/` prefix after one day (the shortest S3 age-based lifecycle
period;
deletion is asynchronous). Do not grant routine operators `s3:GetObject`/`s3:ListBucket` on this
bucket or paste request targets into tickets. A copied bearer remains usable until its grant is
revoked by Label Studio session retirement; lifecycle deletion limits log persistence but is not
revocation.

## Configuration

| File                        | Purpose                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------- |
| `.env.example`              | All environment variables with descriptions. Copy to `.env.local` and fill in your values.              |
| `.deploy.env.example`       | AWS deployment variables (ECS, ECR, S3 bucket names). Copy to `.deploy.env` for production deploy.      |
| `infrastructure/terraform/` | Full AWS infrastructure as code. Copy `backend.hcl.example` outside the repo, set untracked `terraform.tfvars`, and initialize with `-backend-config=/owner/private/beaver-backend.hcl`. |

### Deployment Tiers

| Tier                                 | What You Get                                                                   | Estimated Cost      |
| ------------------------------------ | ------------------------------------------------------------------------------ | ------------------- |
| **Local only** (Docker Compose)      | PDF viewer, annotations, table parsing, QTO, search, LLM chat (Groq free tier) | $0                  |
| **Minimal AWS** (S3 only)            | + Cloud storage for PDFs and thumbnails                                        | ~$5/month           |
| **Full AWS** (ECS + RDS + SageMaker) | + Textract OCR, YOLO inference, Step Functions orchestration, multi-tenant     | ~$150-300/month     |
| **SageMaker GPU** (on-demand)        | YOLO model inference jobs (ml.g4dn.xlarge)                                     | ~$0.75/hour per run |

---

## System Architecture

```
                                 +---------------------------+
                                 | CloudFront viewer gate    |
                                 | deny-all; no S3 read grant|
                                 | (off application path)    |
                                 +---------------------------+

+-------------+    HTTPS    +-------------+-----------+
|   Browser   +------------>+   ALB (TLS termination) |
|  (pdf.js +  |             +-------------+-----------+
|   Zustand)  |                           |
+-------------+                           v
                            +-------------+-----------+  task-role read  +------------------+
                            |   ECS Fargate (2vCPU)   +----------------->+  private S3     |
                            |   Next.js 16 + API      |                  |  (PDFs, thumbs,  |
                            |   asset access gateway |                  |   YOLO results,  |
                            +--+--------+----------+--+                  |   model weights) |
                               |        |          |                     +------------------+
                  +------------+   +----+----+   +-+-----------+
                  |                |         |   |             |
                  v                v         v   v             v
           +------+------+  +-----+---+ +---+---+--+  +-------+--------+
           |  RDS PG 16  |  | Textract| | Secrets  |  | Step Functions  |
           |  (14 tables)|  | (OCR)   | | Manager  |  | (orchestrator)  |
           +-------------+  +---------+ +----------+  +-------+--------+
                                                               |
                                                               v
                                                    +----------+---------+
                                                    | ECS Task (8vCPU)   |
                                                    | CPU Processing     |
                                                    | (GS + Textract +   |
                                                    |  OpenCV + Python)  |
                                                    +--------------------+

                                                    +--------------------+
                                                    | SageMaker GPU      |
                                                    | ml.g4dn.xlarge     |
                                                    | (YOLOv8 inference) |
                                                    +--------------------+
```

Browser PDF, page-image, and thumbnail reads go through the same-origin
`/api/project-assets/` gateway. Canonical project prefixes remain private;
`_bp-public/` is reserved and unused. Immutable generation-qualified public
delivery is deferred until its producer, edge activation/revocation authority,
and cleanup worker can land as one protocol.

---

## Processing Pipeline (6-System Cascade)

The processing pipeline transforms PDFs into 'structured data' through six interconnected systems. Upstream system's outputs feed as inputs into downstream systems. The final processed outputs are machine readable, and context optimised for LLMs.

### System Overview

```
Raw pixels → OCR words → spatial clusters → semantic regions →
classified tables → YOLO-text bindings → tag patterns →
page intelligence → project graph → LLM context
```

### Upload Processing (per page, concurrency configurable via admin)

```
Upload PDF → S3
  │
  v
Step Functions → ECS Task
  │
  ├── 1. Ghostscript: PDF → PNG per page (300 DPI, -dMaxBitmap=500M)
  ├── 2. Textract OCR with fallback chain:
  │     ├── Textract full-res (with retry+backoff for throttling)
  │     ├── Textract half-res (50% downscale if UnsupportedDocument)
  │     └── Tesseract local (if Textract unavailable)
  │     Returns: words[], lines[], tables[] (never throws — empty on total failure)
  │
  ├── 3. Drawing number extraction (title block regex + position scoring)
  ├── 4. CSI code detection (3-tier matching against 8,951-row MasterFormat DB)
  ├── 5. Text annotation detection (30+ regex detectors: phone, email, equipment, dims...)
  ├── 6. Page intelligence:
  │     ├── System 1: Text region classification (OCR word clustering → table-like, notes, key-value)
  │     ├── System 2: Heuristic engine (rule-based: text keywords + YOLO spatial + CSI affinity)
  │     └── System 3: Table meta-classifier (combines Systems 1+2 → door-schedule, finish-schedule, etc.)
  ├── 7. CSI spatial heatmap (NxN configurable grid + title-block + right-margin zones)
  ├── 8. tsvector generation (full-text search index)
  └── 9. Project-level analysis (discipline breakdown, reference graph, CSI topology, summaries)

Page concurrency: 8 (configurable via admin dashboard, Textract limit: 10 TPS)
Each step wrapped in independent try-catch — one step failing doesn't block the pipeline.
```

### Post-YOLO Processing (user-triggered)

```
POST /api/yolo/run → SageMaker Processing Job (ml.g4dn.xlarge GPU)
  │
  v
POST /api/yolo/load → Load results from S3
  ├── Create annotations (source='yolo') with class-level CSI codes from model config
  ├── Re-run heuristic engine with YOLO spatial signals (System 2, phase 2)
  ├── Reclassify tables with YOLO-enriched heuristic data
  └── Merge YOLO CSI codes into page-level csiCodes
```

---

## CSI Code Detection (3-Tier Matching)

CSI MasterFormat codes are the universal embedding layer that connects every system — OCR text, YOLO detections, parsed tables, spatial zones, and LLM context all tagged with CSI codes.

### Detection Algorithm (`csi-detect.ts`)

Matches raw OCR text against the 8,951-row MasterFormat 2004 database (`csi-masterformat.tsv`). Three independent tiers, each with configurable thresholds:

| Tier  | Method          | Confidence | Description                                                                |
| ----- | --------------- | ---------- | -------------------------------------------------------------------------- |
| **1** | Exact subphrase | 0.95       | Consecutive words from CSI description appear together in text             |
| **2** | Bag-of-words    | up to 0.75 | Score = `(matched/total)²` — squared penalty rewards near-complete overlap |
| **3** | Keyword anchors | up to 0.50 | Rare words weighted by inverse document frequency (IDF-like)               |

- Multi-tier boost: +0.05 when both Tier 2 and Tier 3 agree (independent signals confirming each other)
- Stop-word filtering, minimum word count thresholds per tier
- All thresholds admin-configurable via pipeline control panel

### CSI Embedding Strategy

Every element in the system gets CSI-tagged:

```
Textract words → CSI codes (via csi-detect)
YOLO detections → CSI codes (via model config classCsiCodes)
Parsed table rows → CSI codes (via content matching)
Text annotations → CSI tags (via csi-detect on annotation text)
Spatial zones → CSI divisions (via csi-spatial heatmap)
User markups → CSI codes (via manual tagging in annotation editor)
```

All sources merge into `pages.csiCodes` (page-level). The CSI co-occurrence graph (`csi-graph.ts`) tracks which divisions appear together across pages, building a project-wide network with clusters (MEP, Architectural, Structural, Site) and cross-reference edges.

### CSI Spatial Heatmap (`csi-spatial.ts`)

Each page is divided into a configurable NxN grid (3x3 default, up to 12x12). Special zones: title-block (y > 0.85), right-margin (x > 0.75). All CSI-tagged elements (text annotations, YOLO detections, classified tables, parsed regions, YOLO tags) are binned into zones by bbox center.

Output: per-zone division breakdown + natural language summary (e.g., "Door-related content (Div 08) clusters in center drawing area; Plumbing (Div 22) clusters in bottom-right").

Fed to LLM at priority 7.0 in the context builder. Recomputed client-side after user parsing or YOLO load via `refreshPageCsiSpatialMap()`.

---

## Table & Schedule Parsing

Three parsing methods run in parallel on user-drawn bounding boxes, results merged by a grid merger that selects the highest-confidence alignment:

### Method 1: OCR Word Positions (`ocr-grid-detect.ts`)

- Cluster OCR words by Y-center (row tolerance: configurable, default 0.006)
- Detect columns by X left-edge gap analysis (min gap: configurable, default 0.015)
- Column stability filter: column must appear in ≥30% of rows (configurable)
- Layout hint support: force N columns (e.g., 2 for keynotes)
- Output: row/column boundaries + confidence score

### Method 2: Textract TABLES Feature

- AWS Textract returns structured TABLE blocks with CELL children
- Extract row/column indices, cell text, bounding boxes
- Higher confidence on structured tables with clear borders

### Method 3: OpenCV Line Detection (`detect_table_lines.py`)

- Rasterize page region → Hough transform → detect horizontal/vertical lines
- Build grid from line intersections
- Best for tables with visible rule lines

### Guided Parse (Tunable)

New "Guided" tab in the Schedules/Tables panel. User draws BB, system auto-proposes grid via `/api/table-parse/propose`, then user can tune with live sliders:

| Slider             | Controls                            | Default | Effect                         |
| ------------------ | ----------------------------------- | ------- | ------------------------------ |
| Row Sensitivity    | `rowTolerance` in `clusterRows()`   | 0.006   | Lower = tighter row clustering |
| Column Sensitivity | `minColGap` in `detectColumns()`    | 0.015   | Lower = more columns detected  |
| Column Confidence  | `minHitsRatio` in `detectColumns()` | 0.3     | Lower = keeps weaker columns   |
| Expected Columns   | `layoutHint.columns`                | Auto    | Force exact column count       |

Slider changes trigger debounced re-proposal (300ms). Grid lines rendered as draggable overlays on canvas (GuidedParseOverlay). Repeat Down / Repeat Right buttons tile uniform rows/columns. Available in both table and keynote parsing flows.

### Post-Parse Pipeline

1. Cell extraction via `extractCellsFromGrid()` — reads OCR words within grid boundaries
2. Generic column headers ("Column 1", "Column 2") — user renames via edit UI
3. CSI auto-detection on parsed content
4. Persistence to `pageIntelligence.parsedRegions` + DB
5. CSI spatial map recomputation
6. Optional tag mapping (see YOLO-Tag Engine below)

---

## YOLO-Tag Engine (`yolo-tag-engine.ts`)

Maps YOLO shape detections to nearby OCR text, creating tag instances that link visual symbols to their alphanumeric identifiers.

### Core Algorithm: `mapYoloToOcrText()`

```
For each YOLO annotation matching the target class:
  1. Find all OCR words whose center falls inside the YOLO bbox
  2. Sort left-to-right, concatenate → candidateText
  3. Match against target tag:
     - Exact match → confidence 1.0
     - Edit distance ≤ 1 (for text ≥ 3 chars) → confidence 0.9
     - Short tags (1-2 chars) require exact match (prevents "3" matching "8")
```

### Free-Floating Mode

For tags without YOLO shapes (OCR-only detection):

- Single-word tags: scan all words on page
- Multi-word tags: sliding window over adjacent words with bbox merging

### Tag Pattern Detection (`tag-patterns.ts`)

Discovers repeating YOLO+text patterns:

```
Input: 5 circles containing "T-01", "T-02", "T-03", "T-04", "T-05"
  1. For each YOLO detection, extract overlapping OCR text
  2. Extract prefix pattern: "T-01" → prefix "T-"
  3. Group by (yoloClass, prefix): "circle__T-" → 5 instances
  4. Build TagGroup: { pattern: "T-\\d+", instances: 5, confidence: "confirmed" }
```

Used by: keynote parsing (auto-create tags after parse), schedule parsing (Map Tags section), Auto-QTO workflow.

---

## Auto-QTO Workflow

Guided, material-specific Quantity Takeoff workflow. Walks estimators through: find schedule → parse it → define tag column → scan all pages for tags → review counts → CSV export.

### Workflow State Machine

```
Step 1: Pick Material → Step 2: Find Schedule Page → Step 3: Parse Schedule
                                                           ↓
Step 6: CSV Editor ← Step 5: Review Counts ← Step 4: Map Tags to Drawings
```

### Key Concepts

- **Tag Column**: User marks which parsed column contains the tag identifiers (e.g., "MARK", "NO."). Auto-suggested via regex + header keyword matching.
- **Multi-Signal Tag Engine**: OCR text matching (always) + YOLO shape proximity (optional boost). YOLO not required — works on day one without models.
- **Confidence Scoring**: Each tag instance includes signal breakdown (OCR match, OCR confidence, YOLO proximity, YOLO class).
- **Flags**: Auto-detected discrepancies (tag in schedule but not found on drawings, tag on drawings but not in schedule, low confidence, qty mismatch).

### Data Model

- `qto_workflows` table: persists workflow state across sessions
- Phases A-B implemented: foundation + schedule finding/parsing
- Phases C-E planned: enhanced tag engine (`findTagInstances()` with multi-signal return), review table, CSV editor

---

## LLM Context System

The core compression engine. Transforms 250K tokens of raw OCR into ~6K tokens of structured, priority-ordered context — a 40:1 compression ratio that makes small models (Haiku, Llama) viable for blueprint Q&A.

### Context Assembly (`context-builder.ts`)

12+ sections, each with stable ID, priority, and configurable budget allocation:

| Priority | Section                     | Source                                    |
| -------- | --------------------------- | ----------------------------------------- |
| 0.5      | Project Intelligence Report | projectIntelligence (auto-generated)      |
| 1.0      | YOLO Detection Counts       | annotations (source='yolo')               |
| 1.0      | CSI Network Graph           | projectIntelligence.csiGraph              |
| 1.5      | Page Classification         | pageIntelligence.classification           |
| 2.0      | User Annotations            | annotations (source='user')               |
| 3.0      | Takeoff Notes               | takeoffItems                              |
| 3.5      | Cross-References            | pageIntelligence.crossRefs                |
| 4.0      | CSI Codes                   | pages.csiCodes                            |
| 5.0      | Text Annotations            | pages.textAnnotations (37 types)          |
| 5.5      | Note Blocks                 | pageIntelligence.noteBlocks               |
| 5.8      | Parsed Tables/Keynotes      | pageIntelligence.parsedRegions            |
| 6.0      | Detected Regions            | pageIntelligence.classifiedTables         |
| 7.0      | CSI Spatial Distribution    | pageIntelligence.csiSpatialMap            |
| 8.0      | Spatial OCR→YOLO Context    | OCR words mapped to YOLO regions          |
| 10.0     | Raw OCR Text                | pages.rawText (fallback, often truncated) |

### Percentage-Based Budgeting with Overflow

Each section gets a % of the model-aware budget (Opus: 200K chars, Sonnet: 80K, GPT-4o: 60K, Groq: 24K). Unused allocation flows to a shared overflow pool that redistributes to sections needing more space. Three presets:

- **Balanced**: equal distribution
- **Structured**: parsed tables 25%, CSI spatial 8%, spatial context 12%, raw OCR 5%
- **Verbose**: raw OCR 40%, spatial 15%, parsed tables 10%

All configurable via admin LLM/Context tab (4 panels: section control, system prompt, budget, context preview tool).

### Multi-Provider Support

Resolution chain: User API key → Company config → Environment variable. Streaming SSE for all providers.

| Provider      | Models                   | Tool-Use     |
| ------------- | ------------------------ | ------------ |
| Anthropic     | Claude Opus/Sonnet/Haiku | Planned      |
| OpenAI        | GPT-4o, o1/o3            | Planned      |
| Groq          | Llama 3.3 70B            | Partial      |
| Custom/Ollama | Any                      | Context-only |

---

## Frontend Architecture

### Viewer Component Hierarchy

```
PDFViewer (root — scroll, zoom, keyboard shortcuts)
├── ViewerToolbar (mode, zoom, search, panel toggles)
├── PageSidebar (thumbnails, page filtering, lazy-loaded)
├── SymbolSearchPanel (floating popup, 4 states)
├── PDFPage (canvas + overlays)
│   ├── SearchHighlightOverlay (memo) — search + CSI word highlights
│   ├── TextAnnotationOverlay — auto-detected text patterns
│   ├── KeynoteOverlay — keynote markers
│   ├── GuidedParseOverlay — draggable grid lines for guided parse
│   ├── ParseRegionLayer (memo) — table/keynote parse BBs
│   └── AnnotationOverlay (orchestrator — ALL mouse events)
│       └── DrawingPreviewLayer (memo) — in-progress BB/polygon/calibration
├── Right panels (toggled):
│   ├── TextPanel, ChatPanel, TakeoffPanel, DetectionPanel
│   ├── CsiPanel, PageIntelligencePanel
│   ├── TableParsePanel (5 tabs: All Tables, Auto Parse, Guided, Manual, Compare/Edit)
│   ├── KeynotePanel (3 tabs: All Keynotes, Auto Parse, Guided)
│   └── TableCompareModal (fullscreen side-by-side + overlay mode)
└── MarkupDialog (modal)
```

### Performance Architecture

**Drawing state decoupling**: `_drawing`, `_drawStart`, `_drawEnd`, `_mousePos` live in the Tool Zustand store. AnnotationOverlay writes but does NOT subscribe (uses `getState()` for reads in event handlers). Only DrawingPreviewLayer subscribes → only lightweight canvas redraws during BB drawing. The main 1500-line overlay stays frozen during mouse movement.

**Event handler precedence (AnnotationOverlay)**: Strict sequential dispatch with early returns. Order matters:

1. Calibration mode → place points
2. Takeoff placement → polygon/marker
3. YOLO/tag picking → select shape
4. Symbol search / parse drawing → draw BB
5. Pointer mode → select/click/double-click OCR
6. Markup mode → draw annotation

**Zoom**: CSS transform for instant feedback, debounced pdf.js re-render (300ms). Cursor-centric (keeps point under cursor stable during zoom).

**Chunking**: 15-page sliding window with catalog/detail split. Catalog data (~100KB — trade lists, schedule names, CSI directory) loads once. Detail data (~80KB/page — textract words, page intelligence) loads on demand with eviction. State snapshot before async fetch prevents race conditions during rapid navigation.

### Zustand Store

Viewer state is split into explicit owners: `sessionStore` owns project identity/demo/page-label/labeling-session metadata; `uiStore` owns presentation state; `viewerCoreStore` owns page navigation, zoom, and page dimensions; `toolStore` owns interaction mode, the drawing cursor, calibration, takeoff placement, bucket/split/tag/symbol sessions, and tool history; `parseFlowStore` owns parse workflows; server collections use publicId-keyed Query facades. The residual `viewerStore` temporarily owns mutable project drafts/metadata. Prefer the domain hook or leaf store over direct cross-domain field access; cross-owner behavior belongs in `viewerCommands`.

---

## Admin Dashboard (9 Tabs)

| Tab               | Purpose                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| Overview          | Project list, reprocess controls, system status                                                          |
| Pipeline          | Processing step toggles, page concurrency, CSI spatial grid resolution, table proposals config           |
| AI Models         | YOLO model registry, S3 upload, run/load/status per project                                              |
| Heuristics        | Rule editor with YOLO class picker (dropdown from registered models), text keywords, spatial conditions  |
| LLM / Context     | 4 panels: section control (toggle/priority/%), system prompt editor, budget config, context preview tool |
| CSI Codes         | CSI database browser, class-level CSI tagging for YOLO models                                            |
| Text Annotations  | Detector toggle (30+ types), preview per page                                                            |
| Page Intelligence | Classification results, heuristic inferences, reprocess by scope                                         |
| Users             | User management, role assignment, API key management                                                     |

All customization lives in admin — code provides defaults only. Different companies have different YOLO models with different class names; the admin dashboard is the authority.

---

## Database Schema (14 tables)

| Table              | Purpose             | Key Fields                                                            |
| ------------------ | ------------------- | --------------------------------------------------------------------- |
| **companies**      | Multi-tenant orgs   | pipelineConfig (JSONB), features (JSONB), dataKey (S3 prefix)         |
| **users**          | Auth + permissions  | role (admin/member), canRunModels, companyId                          |
| **userApiKeys**    | BYOK LLM keys       | provider, encryptedKey (AES-256-GCM)                                  |
| **projects**       | PDF documents       | dataUrl (S3), status, projectIntelligence (JSONB), isDemo             |
| **pages**          | Per-page OCR data   | textractData (JSONB), csiCodes, pageIntelligence, search_vector (GIN) |
| **annotations**    | YOLO + user markups | bbox [minX,minY,maxX,maxY], source (yolo/user/takeoff), data (JSONB)  |
| **takeoffItems**   | QTO categories      | name, shape, color, size, notes                                       |
| **qtoWorkflows**   | Auto-QTO state      | step, parsedSchedule, lineItems, userEdits (JSONB)                    |
| **chatMessages**   | Chat history        | role, content, model, pageNumber (nullable = project-wide)            |
| **processingJobs** | SageMaker tracking  | status, stepFunctionArn                                               |
| **models**         | YOLO model registry | s3Path, config (JSONB: classCsiCodes, classKeywords)                  |
| **llmConfigs**     | LLM provider config | provider, model, encryptedApiKey, baseUrl                             |
| **auditLog**       | Security audit      | action, userId, details (JSONB), ip                                   |
| **inviteRequests** | Signup queue        | email, name, company                                                  |

---

## Security Model

| Layer              | Implementation                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Auth               | NextAuth 5 credentials, bcrypt (cost 12), JWT (24hr)                                                                                       |
| Brute force        | 5 failures = 15min lockout, 10 = 1hr, per email                                                                                            |
| Rate limiting      | In-memory middleware, per-endpoint (auth: 3-5/15min, chat: 30/hr, YOLO: 5/hr, general: 120/min)                                            |
| Multi-tenancy      | All queries scoped by `companyId`. Registration requires company access key                                                                |
| Browser assets     | Same-origin `/api/project-assets/` gateway with tenant/demo checks and private, no-store responses; CloudFront viewer delivery is deny-all |
| API key encryption | AES-256-GCM with random IV + auth tag                                                                                                      |
| Quotas             | Per-company daily: uploads (3 member/10 admin), YOLO (5), chat (200)                                                                       |
| Secrets            | AWS Secrets Manager via ECS task definition                                                                                                |
| Webhooks           | HMAC-SHA256 + timestamp validation (reject > 5min)                                                                                         |
| Audit              | Login, registration, create/delete, YOLO runs, password changes                                                                            |
| Headers            | nosniff, DENY frame, XSS protection, strict referrer                                                                                       |
| WAF                | Owner-managed AWS control; the retired `hardening.sh` cannot create or alter it                                                          |
| Monitoring         | Terraform-managed CloudWatch alarms and secret-bearing ALB logs; audit/import any legacy GuardDuty or CloudTrail controls separately       |

---

## Infrastructure (Terraform)

| Resource        | Config                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------ |
| VPC             | 10.0.0.0/16, 2 public + 2 private subnets, NAT gateway                                     |
| ECS Fargate     | 2 vCPU / 4 GB app, 8 vCPU / 16 GB processing tasks, live app capacity fixed at 1 until P5 |
| ALB             | HTTPS with ACM cert, TLS 1.3, 300s idle, circuit breaker rollback                          |
| RDS             | PostgreSQL 16, db.t4g.medium, 50GB gp3, encrypted, 7-day backups, Multi-AZ                 |
| S3 + CloudFront | Versioned private bucket; app-gated reads; CloudFront viewer 404 with no OAC S3 read grant |
| ECR             | 3 repos (app, cpu-pipeline, yolo-pipeline), scan-on-push                                   |
| Step Functions  | Blueprint processing orchestrator with retry/catch                                         |
| SageMaker       | Processing jobs for YOLO (ml.g4dn.xlarge GPU, on-demand)                                   |
| Secrets Manager | 8 secrets with 7-day recovery window                                                       |

Estimated: ~$155/month baseline. SageMaker GPU ~$0.75/hr on-demand.

### First private CloudFront cutover (owner-run once)

This is a deliberate one-time owner operation, not a routine deploy.

1. Review a targeted plan and apply only `aws_cloudfront_function.beaver_public_snapshot_gate` and `aws_cloudfront_distribution.beaver` plus their required dependencies. Confirm that `aws_s3_bucket_policy.beaver_data` is absent from that apply.
2. Wait until the distribution status is `Deployed`.
3. Probe known legacy cached asset URLs and require an HTTP 404 with no asset bytes.
4. Create a `/*` CloudFront invalidation and wait for it to complete.
5. Review and run the full Terraform plan/apply, re-read the live data-bucket policy, and repeat the 404 probes.

Never add a reopen/public flag to this gate. Any future public edge delivery requires a separately reviewed publication and revocation protocol; the retired `hardening.sh` is not a cutover path.

---

## Python Scripts

| Script                  | Purpose                                                     | Called By             |
| ----------------------- | ----------------------------------------------------------- | --------------------- |
| `yolo_inference.py`     | YOLOv8 inference on pages                                   | SageMaker job         |
| `template_match.py`     | Two-tier template matching (cv2.matchTemplate + SIFT/FLANN) | /api/symbol-search    |
| `extract_keynotes.py`   | Keynote shape extraction + OCR                              | /api/keynotes/extract |
| `detect_table_lines.py` | Table grid line detection (Hough transform)                 | /api/table-parse      |

All communicate via JSON stdin/stdout. Called with `execFile` (not `exec`) — no shell injection surface.

---

## Local Development

Prerequisites: Node.js 20+, Docker

```bash
docker compose up -d          # PostgreSQL on port 5433
npm install
cp .env.example .env.local    # Edit: DATABASE_URL, NEXTAUTH_SECRET
npm run db:migrate             # Refuses production and non-loopback databases
npm run dev                   # http://localhost:3000
```

Works without AWS credentials — PDF viewing, annotations, QTO, search all functional. For full pipeline: add `GROQ_API_KEY` (chat), AWS credentials (Textract, S3, SageMaker).

---

## Tech Stack

|                |                                                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Runtime**    | Next.js 16 (App Router), React 19, TypeScript 5                                                                            |
| **State**      | Zustand 5 (session/UI/core/tool/residual owners with narrow selectors) + TanStack Query (project-keyed server collections) |
| **Rendering**  | pdfjs-dist 4 (PDF), HTML5 Canvas (7 overlay layers), CSS transform zoom                                                    |
| **Styling**    | Tailwind 4, 3 dark themes (Midnight/Slate/Graphite)                                                                        |
| **Database**   | PostgreSQL 16, Drizzle ORM, 15 migrations                                                                                  |
| **Auth**       | NextAuth 5 (credentials), bcrypt, JWT                                                                                      |
| **AI/LLM**     | Multi-provider (Groq/Anthropic/OpenAI/Custom), streaming SSE, priority-ordered context                                     |
| **CV**         | OpenCV (table lines, keynotes), Tesseract (fallback OCR), YOLOv8/ultralytics                                               |
| **Search**     | PostgreSQL tsvector + GIN index, ts_rank + ts_headline, global cross-project                                               |
| **Infra**      | Terraform, ECS Fargate, private S3 + CloudFront deny gate, RDS, SageMaker, Step Functions                                  |
| **Monitoring** | CloudWatch alarms, one-day private ALB access logs, GuardDuty, WAF, CloudTrail                                             |

---

## Key Design Decisions

**CSI codes as universal embedding layer.** Every pixel, annotation, tag, table cell, keynote, and spatial zone gets CSI-tagged. The CSI graph is a condensed project representation giving the LLM efficient navigation without reading raw OCR. This is the core architectural insight — structured tags compress information 40:1.

**Confidence scores, never binary decisions.** Every system outputs 0.0–1.0 confidence. A text region at 0.6 flows downstream; the table classifier might boost it to 0.85 if keywords match, or decay it to 0.3. Multiple independent signals that agree compound confidence.

**Normalized coordinates everywhere.** All annotations stored as 0-1 ratios. Rendering multiplies by current canvas dimensions. Zoom-independent, DPI-independent, resolution-independent.

**No migrations for new annotation types.** The `data` jsonb column on annotations absorbs new types without schema changes. Count markers, area polygons, scale calibrations, and YOLO detections all share one table.

**Admin dashboard is the authority.** All customization (heuristic rules, YOLO class names, CSI mappings, LLM config, pipeline toggles) lives in admin UI. Code provides defaults only. Different companies have different models with different class names — the admin adapts without code changes.

**Two-phase heuristic execution.** Rules work in text-only mode during OCR processing, then get re-scored with YOLO spatial signals after model load. Same rules, richer evidence.

**Graceful degradation everywhere.** Each processing step has independent try-catch. Textract failure falls through to Tesseract then to empty. Missing YOLO data → text-only heuristics. Missing CSI database → empty codes. The pipeline always completes.

---

## License

BlueprintParser is source-available software.

Free for:

- Personal use
- Research
- Education
- Internal evaluation

Commercial use requires a separate written license.
