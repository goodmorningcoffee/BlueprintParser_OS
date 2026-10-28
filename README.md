# BlueprintParser

**Live demo**: https://app.blueprintparser.com/demo  
**BP Docs**: https://app.blueprintparser.com/docs

BlueprintParser is a Next.js PDF-viewer [web app] and a blueprint parsing engine.

BlueprintParser **v2** is a complete refactor of the v1 code previously published in this
repository: a layered server (`src/server/`), a query layer (`src/queries/`), split viewer stores,
a deterministic CSI tagger, a Tables & Notes workspace on a new parse engine, and a hardened AWS
deployment. It is **source-available, not open source** — see [License](#license).

---

## Features


- Manual and AI-assisted quantity takeoffs 
- Extract schedules/tables from PDF to CSV
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

### New in v2

- **Tables & Notes workspace** — table, keynote, general-note and spec proposals found during processing land in one inbox per project; focus one, parse it, correct it, commit it as tag maps. Runs on a new parse engine that replaces the legacy parsers tool by tool behind flags.
- **CSI tagger v2** — a deterministic span tagger over a MasterFormat lookup table: no model at tagging time, same page → same codes, and every code points at the words that produced it.
- **Bucket fill** — click inside a boundary to fill it; a raster engine by default and a vector engine (adapted from OpenTakeoff, Apache-2.0) that traces the PDF's own linework.
- **Project knowledge graph and cross-set links** — sheets that reference each other, within a project and across projects.
- **Classifier builder** — rule recipes with fitted weights for recognising schedules and other page regions.
- **Admin data tools** — stuck jobs, duplicate pages and projects, annotation cleanup, permanent delete, and a portable `bp-export/1` project export; per-user and per-company usage quotas; security and usage logs.
- **Mandatory two-factor login for root admins**, optional Google sign-in, database-backed login lockouts.

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
(In this version, uploading weights is a root-admin action that stays off until `ALLOW_MODEL_UPLOAD=true`, and inference runs as an AWS SageMaker job — see [YOLO models](#yolo-models-bring-your-own) below.)

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

## How it works

```
Upload PDF ─► S3 ─► Step Functions ─► processing task (per page, 8 at a time)
   Ghostscript raster ─► OCR (AWS Textract → half-res retry → local Tesseract)
   ─► drawing number ─► CSI codes ─► text annotations ─► page intelligence
      (text regions, heuristics, table/schedule classification) ─► CSI heatmap ─► search index
   ─► project analysis ─► knowledge graph and cross-set links
User-triggered: YOLO (SageMaker GPU job) ─► YOLO-aware re-scoring; table/keynote parsing; Auto-QTO; LLM chat
```

Every step is independent: one failing step does not stop the page. Everything a step produces is
stored in PostgreSQL and fed, priority-ordered and budgeted, into the LLM context. The full tour —
pipeline, CSI tagger, table parsing, tag mapping, Auto-QTO, bucket fill, LLM context builder, viewer
architecture, admin tabs, database tables and the key design decisions — is in
**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

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

The demo's YOLO weights are the maintainer's own work and are not distributed (see "NOTE on YOLO
Models" above); every weight file is gitignored and `scripts/prepush-check.sh` refuses weights in any
pushed commit. To use your own:

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

---

## Deploying to AWS

The deployment is the maintainer's production stack, published as a reference: Terraform for ECS
Fargate, RDS PostgreSQL, private S3 behind an app gateway, Step Functions, SageMaker, Lambda and
Secrets Manager, driven by `./deploy-aws.sh` (`doctor`, `bootstrap`, `release`, `rollback`, …). Expect
roughly $150–300 a month. Read **[docs/DEPLOY.md](docs/DEPLOY.md)** first — it covers the scripts, the
Terraform resources, the first-deploy bootstrap and the schema-change outage procedure.

## Configuration

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
| `src/app/` | Next.js App Router pages and API routes (route files are thin shells); in-app docs at `src/app/docs/` |
| `src/server/` | HTTP shell + services: routes declare `defineRoute()`, every project write goes through `withProjectWrite` |
| `src/queries/` | TanStack Query layer (canonical keys in `queryKeys.ts`) |
| `src/lib/` | Processing, OCR, CSI, parsing, tag mapping, LLM context, parse engine, classifier engine |
| `src/components/`, `src/stores/` | React viewer/admin UI and Zustand stores |
| `src/workers/` | Web workers (bucket fill) |
| `drizzle/` | SQL migrations (`0000`–`0039`) and the migration journal |
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
