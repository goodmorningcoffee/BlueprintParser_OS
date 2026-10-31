# BlueprintParser

[![ci](https://github.com/goodmorningcoffee/BlueprintParser_OS/actions/workflows/ci.yml/badge.svg)](https://github.com/goodmorningcoffee/BlueprintParser_OS/actions/workflows/ci.yml)

**Live demo:** https://app.blueprintparser.com/demo · **Docs:** https://app.blueprintparser.com/docs

BlueprintParser turns a set of construction drawings into machine-readable, CSI-tagged data, and
puts a PDF viewer, takeoff tools, schedule and note parsers and an LLM chat on top of it.

Upload a drawing set and the pipeline rasterises every sheet, OCRs it, finds the sheet number, tags
the text with MasterFormat (CSI) codes, classifies text regions, tables, keynotes and zones, builds
per-sheet "page intelligence" and a project knowledge graph, and indexes everything for search. In
the viewer you count, measure and bucket-fill, parse schedules and notes, map schedule tags back onto
the drawings, and chat with the whole set through an LLM that can call BlueprintParser's own tools
and point at what it found.

**v2** is a complete refactor of the v1 code previously published in this repository: a layered
server (`src/server/`), a query layer (`src/queries/`), split viewer stores, a deterministic CSI
tagger, a Tables & Notes workspace on a new parse engine, and a hardened AWS deployment. It is
**source-available, not open source** — see [License](#license).

---

## Contents

- [What it does](#what-it-does)
- [How it works](#how-it-works)
- [Architecture on AWS](#architecture-on-aws)
- [LLM chat and agent tools](#llm-chat-and-agent-tools)
- [YOLO models](#yolo-models)
- [Quick start (local development)](#quick-start-local-development)
- [Build prerequisites: data and models that are not in this repository](#build-prerequisites-data-and-models-that-are-not-in-this-repository)
- [Running the tests](#running-the-tests)
- [Deploying to AWS](#deploying-to-aws)
- [Security model](#security-model)
- [Repository layout](#repository-layout)
- [Tech stack](#tech-stack)
- [Project goal](#project-goal)
- [License](#license)

---

## What it does

### Takeoff

- **Count, linear and area takeoffs** with groups, per-item notes and CSV export.
- **Scale calibration** per sheet; every length and area is derived from the scale you set.
- **Bucket fill** — click inside a boundary to fill it. The default raster engine works on the page
  image; the vector engine (adapted from OpenTakeoff, Apache-2.0) traces the PDF's own linework.
  Bucket fill outputs a polygon; square footage comes from your calibration.
- **Auto-QTO** — a guided workflow that turns parsed schedules plus tag instances found on the
  drawings into takeoff line items.
- **Markup**: rectangles, polygons, text; annotation groups; split an annotation along a drawn
  boundary; lasso multi-select.

### Parsing

- **Tables & Notes workspace** — every table, keynote legend, general-note block and spec block
  found during processing lands in one inbox per project, sorted by confidence. Focus one, pick the
  row/column method, correct lines and cells on the page, add a continuation box when a table runs
  onto another sheet, and commit it as tag maps. It runs on one **parse engine** that replaces the
  legacy parsers tool by tool behind admin flags, with a kill switch back to the classic path.
- **Classic parsers** — table parsing with OCR grid, Textract, OpenCV line detection, img2table and
  Table Transformer methods (auto, guided and manual), plus keynote, general-note and spec parsers.
- **Tag mapping** — schedule tags (`D-01`, `T-03`, …) are matched to their instances on the drawings
  by five matchers that combine YOLO boxes, nearby text and inferred tag patterns.
- **Symbol search** — draw a box around a symbol and template-match it across the set.
- **Export** parsed tables to CSV, and the whole project as a portable `bp-export/1` bundle.

### Understanding the set

- **CSI tagger v2** — a deterministic span tagger over a MasterFormat 2018 lookup table. No model at
  tagging time, same page → same codes, and every code points at the words that produced it.
- **Page intelligence** — text-region classification, a heuristic engine (keywords + YOLO spatial
  signals + CSI affinity), a table meta-classifier (door schedule, finish schedule, …), page zones,
  and a per-page evidence layer that the LLM context builder reads.
- **Classifier builder** — rule recipes (CSI-tagged table words, sheet number, title-block and
  header text) with fitted weights for recognising schedules and other regions, built in the admin.
- **YOLO object detection** — bring your own Ultralytics model; inference runs as a SageMaker job
  and the results re-score the heuristics, create annotations and feed the CSI heatmap.
- **Knowledge graph and cross-set links** — which sheets reference which, within a project and across
  projects; discipline breakdown, CSI topology and summaries per project.
- **Duplicate detection** — hidden duplicate pages (hide, restore or permanently delete them) and
  duplicate projects.
- **Search** across OCR text, with ranked, highlighted results.

### Operating it

- An **admin dashboard** with 19 tabs owns every tunable: pipeline toggles and page concurrency,
  reprocess by scope, LLM context budgets and system prompt, CSI settings, heuristics, classifiers,
  table parsing, AI models and RBAC, companies and users, quotas and usage, data tools (stuck jobs,
  duplicates, annotation cleanup, export), security and visitor logs.
- **Multi-tenant** by company, with per-user and per-company quotas and a public demo mode.
- **Label Studio integration** for building YOLO datasets from your own drawings.

---

## How it works

Every sheet goes through the same cascade. Each stage is wrapped on its own, so one failing stage
does not stop the sheet, and everything a stage produces is stored in PostgreSQL and fed, priority
ordered and budgeted, into the LLM context.

```mermaid
flowchart TB
  U["Upload a PDF set"] --> S3[("S3")]
  S3 --> SFN["Step Functions"]
  SFN --> T["ECS processing task<br/>8 sheets in parallel by default"]

  subgraph sheet ["Per sheet"]
    direction TB
    R["Ghostscript raster at 300 DPI<br/>optional tile pyramid"] --> O["OCR<br/>Textract → half-res retry → local Tesseract"]
    O --> N["Sheet number<br/>title-block regex + position scoring"]
    N --> C["CSI span tagger<br/>MasterFormat lookup table"]
    C --> D["Text-annotation detectors<br/>keynote and shape extraction"]
    D --> PI["Page intelligence<br/>text regions · heuristics · table classifier · zones · evidence"]
    PI --> H["CSI spatial heatmap"]
    H --> FTS["Full-text search index"]
  end

  T --> R
  FTS --> P["Project analysis<br/>disciplines · summaries · CSI topology"]
  P --> KG["Knowledge graph · cross-set links<br/>duplicate detection"]
  KG --> DB[("PostgreSQL")]

  subgraph demand ["On demand"]
    direction TB
    Y["YOLO on SageMaker GPU<br/>→ annotations, heuristic re-scoring"]
    L["CV Lambda fan-out<br/>symbol search · shape parse"]
    E["Parse engine<br/>tables · keynotes · notes · specs → tag maps"]
  end

  DB --> demand
  demand --> DB
  DB --> V["Viewer"]
  DB --> LLM["LLM context builder → chat"]
```

Read bottom-up, the outputs form a cascade where each system's output is the next one's input:

```
raw pixels → OCR words → spatial clusters → semantic regions → classified tables
→ YOLO–text bindings → tag patterns → page intelligence → project graph → LLM context
```

Locally, the same code runs in-process inside `npm run dev` when `STEP_FUNCTION_ARN` is empty, so
no Step Functions is needed to develop. The full tour — pipeline, CSI tagger, table parsing, tag
mapping, Auto-QTO, bucket fill, LLM context builder, viewer architecture, admin tabs, database tables
and the key design decisions — is in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

---

## Architecture on AWS

The production stack is Terraform under `infrastructure/terraform/`, driven by `./deploy-aws.sh`.
The browser never sees an S3 key: every PDF, page image and thumbnail is served by the app's own
same-origin asset gateway with tenant checks, and the CloudFront distribution in front of the bucket
is a deny-all gate with no read grant.

```mermaid
flowchart LR
  B["Browser<br/>pdf.js viewer + canvas overlays"] -->|"HTTPS"| ALB["Application Load Balancer<br/>TLS 1.3 / 1.2 · circuit breaker"]

  subgraph vpc ["VPC · private subnets behind NAT"]
    direction LR
    ALB --> APP["ECS Fargate · app<br/>Next.js 16 + API<br/>asset gateway"]
    APP --> RDS[("RDS PostgreSQL 16<br/>Multi-AZ in production")]
    APP --> S3[("Private S3<br/>PDFs · page images · results · weights")]
    APP --> SEC["Secrets Manager"]
    APP --> SFN["Step Functions"]
    SFN --> CPU["ECS Fargate · processing task<br/>8 vCPU · Ghostscript · OpenCV · Python"]
    CPU --> S3
    CPU --> RDS
    APP -.->|"root-only, on demand"| SAGE["SageMaker processing job<br/>YOLO on ml.g4dn.xlarge"]
    APP -.->|"fan-out"| LAM["Lambda · CV<br/>symbol search · shape parse"]
    S3 -->|"delete events"| EB["EventBridge → SQS"] --> DEL["ECS · asset deletion worker"]
    ALB -.->|"optional"| LS["Label Studio on ECS + EFS"]
  end

  CPU --> TX["Textract OCR"]
  CF["CloudFront<br/>deny-all gate, no S3 read grant"] -.->|"404"| S3
```

| Resource | Config |
| --- | --- |
| ECS Fargate | 2 vCPU / 4 GB app service (capacity capped by `ecs_max_count`), 8 vCPU / 16 GB processing tasks, a singleton schema migrator, a maintenance worker and the asset-deletion worker; task definitions are digest-pinned |
| RDS | PostgreSQL 16, db.t4g.medium, 50 GB gp3, encrypted, 7-day backups |
| S3 + CloudFront | One versioned private bucket; app-gated reads; CloudFront answers 404 |
| ECR | 4 repositories (app, processing, YOLO, CV Lambda), scan on push |
| SageMaker | On-demand processing jobs for YOLO; no local inference path |
| Secrets Manager | 9 secrets, 7-day recovery window, injected through the task definitions |
| Budgets / CloudWatch | Cost budget and CloudWatch alarms; one-day private ALB access logs |

WAF, GuardDuty and CloudTrail are owner-managed and not created by this Terraform. Everything else,
including the first-deploy bootstrap and the schema-change outage procedure, is in
**[docs/DEPLOY.md](docs/DEPLOY.md)**.

---

## LLM chat and agent tools

The context builder is the compression engine: it turns roughly 250K tokens of raw OCR for a set into
about 6K tokens of structured, priority-ordered context, which is what makes small models viable for
blueprint questions. Twenty page-level sections and six project-wide sections each have a priority
and a percentage of a model-aware budget, with unused allocation flowing to an overflow pool. The
section list, budgets, presets and system prompt are edited in Admin → LLM / Context, which also has
a context preview.

```mermaid
flowchart LR
  Q["Question in the viewer"] --> CB["Context builder<br/>26 sections · priority · budget"]
  CB --> M["Provider<br/>Anthropic · OpenAI · Groq · OpenAI-compatible"]
  M -->|"tool call (Anthropic)"| T["20 BlueprintParser tools<br/>search · read · analyse · act"]
  T --> M
  M -->|"streamed answer"| A["Answer with citations"]
  T -.->|"navigate · highlight · markup"| V["Viewer follows along"]
```

With Anthropic models the chat runs an agentic loop of up to ten tool rounds over these tools:

| Group | Tools |
| --- | --- |
| Find and read | `searchPages`, `getProjectOverview`, `getPageDetails`, `lookupPagesByIndex`, `getPageOcrText`, `getOcrTextInRegion`, `getAnnotations`, `getParsedSchedule` |
| Spatial and structural | `getCsiSpatialMap`, `getSpatialContext`, `getCrossReferences` |
| Analyse | `detectCsiFromText`, `scanYoloClassTexts`, `mapTagsToPages`, `detectTagPatterns` |
| Act in the viewer | `navigateToPage`, `highlightRegion`, `createMarkup`, `addNoteToAnnotation`, `batchAddNotes` |

OpenAI, Groq and OpenAI-compatible endpoints (for example Ollama) get the same context without tool
use. Keys resolve per user, then per company, then from the environment; root admins can grant
company users the owner's keys with caps.

---

## YOLO models

The YOLO models used in the demo were hand-labeled and trained by myself.

- 500+ hours of manual labeling
- More than $3,000 in AWS compute

The trained weights and training datasets are not included in this repository.
BlueprintParser is designed so users can upload and use their own object-detection models.
(In this version, uploading weights is a root-admin action that stays off until `ALLOW_MODEL_UPLOAD=true`,
and inference runs as an AWS SageMaker job — see [YOLO models (bring your own)](#yolo-models-bring-your-own) below.)

There are two general categories of class: **discrete** and **spatial**.

| Discrete classes (examples) | Spatial classes (examples) |
| --- | --- |
| `door_single` | `title_block` |
| `square` | `drawings` |
| `schedule_table` | `text_block` |

Spatial classes define regions of the drawings and help with localisation and corroboration. Since we
use OCR, we also have the pixel coordinates of all text, which we can map against the YOLO outputs.
For instance, when extracting the drawing number, we can check whether it is located inside a
`title_block` region. When looking for the door schedule, BP knows to look for the sheet where the
words "door schedule" occur inside a `schedule_table` region, and can double-check the title block
for corroborating text like "door and window schedule".

BP uses spatial data to build CSI heatmaps, which show the distribution of CSI codes on a sheet. YOLO
spatial data lets us differentiate between a cluster of CSI codes occurring in a `text_block`, in the
`drawings`, inside a schedule, or in the `title_block`. YOLO spatial classes are baby steps towards a
visual-reasoning engine for blueprints: YOLO acts as the "eyes" for LLMs and agents, enabling them to
"see" into the drawings.

---

## Quick start (local development)

**Prerequisites:** Node.js 24 (`.nvmrc` pins 24.21.0), Docker (for PostgreSQL), and for local page
processing [Ghostscript](https://ghostscript.com/) (`gs`) and [Tesseract](https://github.com/tesseract-ocr/tesseract)
on your `PATH`. Python 3.10+ with the packages in `scripts/requirements.txt` (plus PyTorch for TATR)
adds table-line detection, img2table, TATR and template matching.

```bash
git clone https://github.com/goodmorningcoffee/BlueprintParser_OS.git
cd BlueprintParser_OS
nvm use                           # Node 24.21.0 from .nvmrc
npm ci
cp .env.example .env.local        # set NEXTAUTH_SECRET (openssl rand -base64 32); DATABASE_URL already matches compose
docker compose up -d              # PostgreSQL 16 on 127.0.0.1:5433 (add --profile labeling for a local Label Studio)
bash scripts/setup.sh             # runs the migrations, creates a "Default" company and your root admin (interactive)
npm run dev                       # http://localhost:3000
```

The first root-admin login asks you to enrol an authenticator app (TOTP); root two-factor is
mandatory. Registering through the sign-up page needs a company access key, so on a fresh database
`scripts/setup.sh` is the way in. `npm run db:seed` adds a demo user (`demo@demo.com` / `password123` —
local development only) and a sample project record.

**What works without AWS, and what does not:**

- **Uploading a PDF needs an S3 bucket.** Uploads are staged in S3 before a project is created, so set
  `S3_BUCKET`, `AWS_REGION` and credentials in `.env.local` (a small personal bucket is enough).
- **Processing runs in-process** in `npm run dev` (no Step Functions needed). Without Textract
  credentials, OCR falls back to local Tesseract.
- **CSI tagging needs the lookup table** you build yourself (next section). Without it the app runs
  normally, every page simply gets no CSI codes (logged once on the server, no warning in the UI).
- **YOLO** needs your own model and AWS SageMaker; there is no local inference.
- **LLM chat** needs one provider key: `GROQ_API_KEY` (free tier), `ANTHROPIC_API_KEY` (the only
  provider with agent tool use) or `OPENAI_API_KEY`, or a per-user key in the app.

---

## Build prerequisites: data and models that are not in this repository

Three inputs are deliberately kept out of git. The app runs without them, with less capability; the
production container image (`docker build`) needs the first two.

### CSI lookup table (MasterFormat)

CSI tagging matches drawing text against a lookup table of MasterFormat section titles and index
phrases, `src/data/csi-kb.json` (≈ 6.4 MB, 8,935 codes, ≈ 20,300 phrases). It is built from the
**MasterFormat® 2018 Edition** PDF, which is published by the Construction Specifications Institute
(CSI); CSI reserves its copyrights and the MASTERFORMAT trademark. So this repository publishes the
**tools** and not the table: the table and the parser's page fixture are gitignored, and
`scripts/prepush-check.sh` refuses any push that would add them.

What *is* in the repository: `src/data/csi-masterformat.tsv` and `src/data/csi.tsv` (CSI code numbers
with section titles and a 1995↔2004 numbering crosswalk; both have been here since v1), the curated
abbreviation list `src/data/csi_terms.tsv`, and small test samples. What is *not*: the keyword and
index phrases, and any page text from the PDF.

To build the table, use your own licensed copy of the PDF (the parser was developed against the
714-page "as of May 2018" printing; another printing may trip the build's self-checks or the
`csi-mf-parse` census test):

```bash
# from the repository root, after npm ci
export BP_MF_PDF=/path/to/masterformat-2018.pdf     # or pass the path as the last argument
npx esbuild eval/csi/build-kb-v2.ts --bundle --platform=node --target=node24 \
  --alias:@=./src --external:pg-native --outfile=build/csi-kbv2-build.js
node build/csi-kbv2-build.js        # ≈ 5 s → src/data/csi-kb.json (gitignored) + eval/csi/kb-report.json
node scripts/verify-csi-kb.mjs      # expect: "ok — … csi-kb/2 and current against 4 inputs"
```

`build-kb-v2` also rewrites the tracked `eval/csi/kb-report.json` (counts and hashes only, no phrases);
a different printing of the PDF leaves that file modified — do not commit it unless you mean to.
Optional, for the parser tests: build `eval/csi/mf-fixture-extract.ts` the same way
(`--outfile=build/csi-mf-fixture.js`, then `node build/csi-mf-fixture.js`) to write the gitignored
`src/lib/__tests__/fixtures/csi-v2/mf-pages-excerpt.json`.

Without the table: CSI tagging returns no codes, the tests that need it skip (or fail under
`BP_REQUIRE_CSI_KB=1`), `docker build` stops at `scripts/verify-csi-kb.mjs`, and `deploy-aws.sh`
refuses to release. The tool headers in `eval/csi/` (and `eval/csi/README.md` for the evaluation
harness) have the details.

### Table Transformer checkpoint (`models/tatr/`)

The TATR table-structure method loads Microsoft's
[Table Transformer](https://github.com/microsoft/table-transformer) structure-recognition model
(MIT licence; the PubTables-1M + FinTabNet.c v1.1 checkpoint, e.g. Hugging Face
`microsoft/table-transformer-structure-recognition-v1.1-all`) from `models/tatr/` — `config.json`,
`preprocessor_config.json`, `model.safetensors`, ≈ 115 MB. Download it there yourself; `/models/` is
gitignored and the `Dockerfile` copies it into the image (`COPY … models/tatr`), so `docker build`
fails without it. Locally, TATR is simply unavailable when the folder is missing.

### YOLO models (bring your own)

The demo's YOLO weights are the maintainer's own work and are not distributed (see
[YOLO models](#yolo-models) above); every weight file is gitignored and `scripts/prepush-check.sh`
refuses weights in any pushed commit. To use your own:

- **Train** an [Ultralytics](https://docs.ultralytics.com/) YOLO detection model (`.pt`) on your
  classes. The in-app Label Studio integration (labeling sessions; `docker compose --profile labeling`
  locally) helps build a dataset.
- **Upload** it in Admin → AI Models as a root admin, with `ALLOW_MODEL_UPLOAD=true` set (the upload is
  off by default), then map its classes to CSI codes and keywords there.
- **Run** it: inference is an AWS SageMaker Processing job using the image from `Dockerfile.yolo`,
  built and pushed by `deploy-yolo.sh`. There is no local inference path.

Ultralytics is AGPL-3.0 (see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)).

---

## Running the tests

```bash
npm run test:scripts                     # node:test suites for the shell/gate scripts (incl. prepush-check)
npm test -- --maxWorkers=4               # vitest; fewer workers is faster on slow or networked disks
npm run check:architecture               # layering and size ratchets
npm run check:project-security-policy    # security invariants over code and Terraform
npm run check:schema-cutover             # migration/deploy safety invariants
npm run check:lint-baseline              # no-growth lint gate
npx tsc --noEmit
npm run e2e                              # Playwright golden paths (boots its own servers; needs the test DB)
```

The route and migration tests need their own PostgreSQL database
(`postgres://bp_test:bp_test@localhost:5433/bp_test` by default). Port 5433 is also the compose dev
database, so either run `scripts/test-db.sh start` (a user-owned cluster, Debian/Ubuntu layout or
`BP_PG_BIN`) instead of compose, or start one on another port and point the tests at it:

```bash
docker run -d --name bp-test-db -p 127.0.0.1:5434:5432 \
  -e POSTGRES_USER=bp_test -e POSTGRES_PASSWORD=bp_test -e POSTGRES_DB=bp_test postgres:17
BP_TEST_DATABASE_URL=postgres://bp_test:bp_test@localhost:5434/bp_test BP_REQUIRE_TEST_DB=1 npm test -- --maxWorkers=4
```

**The suite skips rather than fails** when an input is missing, and prints why: DB-backed tests skip
without a test database (fatal under `BP_REQUIRE_TEST_DB=1`, as in CI), CSI tests skip without the
lookup table and parser fixture (fatal under `BP_REQUIRE_CSI_KB=1`), and the private-golden table
tests always skip on a public clone. The suite **drops and recreates the `public` schema** of the test
database on every run — never point `BP_TEST_DATABASE_URL` at data you care about. (Some test headers
mention `scripts/bp-suite`: that is the maintainer's private wrapper, which runs vitest with
`--maxWorkers=4`, both `BP_REQUIRE_*` flags set and the full log written to a file.)

CI (`.github/workflows/ci.yml`) runs Terraform fmt and validate, the four policy checks, the
typecheck, the script tests, the unit tests against a seeded PostgreSQL service, the production
build, and the offline golden-path e2e.

---

## Deploying to AWS

The deployment is the maintainer's production stack, published as a reference: Terraform for ECS
Fargate, RDS PostgreSQL, private S3 behind an app gateway, Step Functions, SageMaker, Lambda and
Secrets Manager, driven by `./deploy-aws.sh` (`doctor`, `bootstrap`, `release`, `rollback`, …). Expect
roughly $150–300 a month. Read **[docs/DEPLOY.md](docs/DEPLOY.md)** first — it covers the scripts, the
Terraform resources, the first-deploy bootstrap and the schema-change outage procedure.

### Configuration

| File | Purpose |
| --- | --- |
| `.env.example` | The app's environment variables, with descriptions. Copy to `.env.local`. The server validates its env contract at boot in `src/lib/env.ts`. |
| `.deploy.env.example` | Identities the deploy scripts use. Copy to `.deploy.env` (gitignored). |
| `infrastructure/terraform/*.example` | `terraform.tfvars.example`, `backend.hcl.example`; real values stay outside git. |

---

## Security model

| Layer | Implementation |
| --- | --- |
| Auth | NextAuth `5.0.0-beta.30` credentials + optional Google OAuth (`GOOGLE_CLIENT_ID`), bcrypt (cost 12), JWT sessions (24 h) |
| Root admins | Mandatory authenticator-app (TOTP) second factor (`ROOT_2FA_ENFORCE`, default on; seeds sealed with `ROOT_2FA_KEY` when set); recovery via `root_admin.sh 2fa-reset` |
| Brute force | Lockout from 5 failures (1 min), doubling every 2 further failures up to 60 min, keyed by e-mail + IP, plus an account-wide ceiling of 50 failures per hour; stored in PostgreSQL (`login_lockouts`) |
| Rate limiting | Per-endpoint, in-process: sign-in 10/min, register and forgot-password 3/15 min, reset 5/15 min, 2FA 5–10/15 min, chat 30/h, CSI detect 20/min, general API 120/min (YOLO runs are bounded by the daily quota instead) |
| Quotas | Per company per rolling day: uploads 3 (member) / 10 (admin), YOLO jobs 10, chat messages 200, CV Lambda pages 20,000; root admins exempt; per-user and per-company overrides (Admin → Usage) |
| Multi-tenancy | All queries scoped by `companyId`; registration requires a company access key |
| Browser assets | Same-origin `/api/project-assets/` gateway with tenant/demo checks and private, no-store responses; CloudFront viewer delivery is deny-all |
| API key encryption | AES-256-GCM with random IV + auth tag |
| Secrets | AWS Secrets Manager via the ECS task definitions |
| Webhooks | HMAC-SHA256 + timestamp validation (reject > 5 min) |
| Audit | Login, registration, create/delete, YOLO runs, password changes |
| Headers | nosniff, `X-Frame-Options: DENY`, XSS protection, strict referrer |
| WAF / GuardDuty / CloudTrail | Owner-managed; not created by this Terraform |

Report vulnerabilities privately — see [SECURITY.md](SECURITY.md).

---

## Repository layout

| Path | What |
| --- | --- |
| `src/app/` | Next.js App Router pages and 163 API route files (thin shells over `src/server/`); in-app docs at `src/app/docs/` |
| `src/server/` | HTTP shell + services: routes declare `defineRoute()`, every project write goes through `withProjectWrite` |
| `src/queries/` | TanStack Query layer (canonical keys in `queryKeys.ts`) |
| `src/lib/` | Processing, OCR, CSI, parsing, tag mapping, LLM context, parse engine, classifier engine, knowledge graph |
| `src/components/`, `src/stores/` | React viewer/admin UI and Zustand stores |
| `src/workers/` | Web workers (bucket fill, vector tracing) |
| `drizzle/` | SQL migrations (`0000`–`0039`) and the migration journal; 31 tables |
| `scripts/` | Gate scripts (`check-*.mjs`), Python CV helpers (`*.py`), setup and operator scripts, `prepush-check.sh` |
| `eval/` | CSI tagger and parse-engine evaluation harnesses (numbers only; private inputs stay outside) |
| `e2e/`, `perf/`, `playwright*.config.ts` | Playwright golden paths and performance harnesses |
| `infrastructure/terraform/` | AWS infrastructure |
| repo root `*.sh`, `Dockerfile*` | Deploy and operator tools (paths are referenced by the deploy docs, so they stay at the root) |
| `docs/` | [ARCHITECTURE.md](docs/ARCHITECTURE.md), [DEPLOY.md](docs/DEPLOY.md) |

---

## Tech stack

| | |
| --- | --- |
| **Runtime** | Next.js 16 (App Router), React 19, TypeScript 5, Node.js 24 |
| **State** | Zustand 5 (session/UI/core/tool owners with narrow selectors) + TanStack Query (project-keyed server collections) |
| **Rendering** | pdfjs-dist 4 (PDF), HTML5 Canvas overlay layers, CSS transform zoom |
| **Styling** | Tailwind 4, 3 dark themes (Midnight/Slate/Graphite) |
| **Database** | PostgreSQL 16, Drizzle ORM |
| **AI/LLM** | Groq / Anthropic / OpenAI / OpenAI-compatible (e.g. Ollama), streaming SSE, priority-ordered context |
| **CV / OCR** | AWS Textract, Tesseract, Ghostscript, OpenCV, img2table, Table Transformer, Ultralytics YOLO |
| **Search** | PostgreSQL tsvector + GIN index, ts_rank + ts_headline |
| **Infra** | Terraform, ECS Fargate, RDS, private S3 + CloudFront deny gate, Step Functions, SageMaker, Lambda |
| **Tests** | Vitest, node:test, Playwright |

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: run the checks above, install the push guard
(`scripts/prepush-check.sh --install`), and commit with your GitHub noreply e-mail address.

---

## Project goal

It started with trying to build a free quantity takeoff tool, expanded with extracting
schedules/tables to spreadsheets, and eventually evolved into an LLM harness for blueprints.

It's not enough to rely on LLMs; it's necessary to give them tools that empower them to do more with
blueprints.

---

## License

BlueprintParser is source-available software.

Free for:

- Personal use
- Research
- Education
- Internal evaluation

Commercial use requires a separate written license.

Third-party code vendored in this repository (OpenTakeoff, pdf.js) keeps its own licence — see
[NOTICE](NOTICE) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
