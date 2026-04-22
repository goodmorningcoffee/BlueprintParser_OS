# BPArchitecture_422.md — Technical Current State (2026-04-22)

> **Purpose.** A deep, greppable navigation manual for future Claude Code sessions. Every section carries a `[NAV:slug]` anchor so you can `grep -n '\[NAV:canvas-render-gate\]'` and jump. Every code claim is followed by `file:line-range`. Paragraph-level editorial is minimized — tables and bullet trees are the primary format.
>
> **Companion.** This doc supersedes the older bootstrap `featureRoadMap/currentstate_april116.md` for depth; that file stays as the lite "start here" entry. For the full pipeline exec order in prose, see `featureRoadMap/PROCESSING_PIPELINE.md` (972 lines).
>
> **Working directory.** All file paths in this doc are relative to `/workspaces/BlueprintParser_OS/blueprintparser_2/`. The outer `BlueprintParser_OS/` dir is just a wrapper; the repo root with `package.json` is `blueprintparser_2/`.

---

## 0. Preface + navigation index `[NAV:index]`

**How to use.** Skim the anchor list below. Grep the tag you need. Click the file:line citations in your tool. Do not read end-to-end — this is a reference.

### Anchor index

| Anchor | Section | Purpose |
|---|---|---|
| `[NAV:index]` | §0 | This index |
| `[NAV:vision]` | §1 | Product thesis + 4-phase roadmap pointers |
| `[NAV:repo-map]` | §2 | Top-level tree, heaviest files, where to put what |
| `[NAV:system-layers]` | §3 | Browser → Next.js → AWS diagram |
| `[NAV:aws-infra]` | §4 | AWS infra umbrella |
| `[NAV:aws-network]` | §4.1 | VPC, subnets, NAT, SGs |
| `[NAV:aws-services]` | §4.2 | Service-by-service map (ECS, Lambda, SageMaker, S3, RDS, CloudFront, SFN, Textract, Secrets) |
| `[NAV:terraform-files]` | §4.3 | 14 `.tf` files at a glance |
| `[NAV:deploy-scripts]` | §4.4 | `deploy.sh`, `ecs-tune.sh`, `ecs-health.sh`, `hardening.sh`, `root_admin.sh`, etc. |
| `[NAV:dockerfiles]` | §4.5 | `Dockerfile`, `Dockerfile.lambda`, `Dockerfile.yolo` |
| `[NAV:env-vars]` | §4.6 | Env var catalog by category |
| `[NAV:observability]` | §4.7 | Log groups + alarms + `ecs-health.sh` |
| `[NAV:data-layer]` | §5 | DB umbrella |
| `[NAV:db-tables]` | §5.1 | 20 tables |
| `[NAV:jsonb-shapes]` | §5.2 | Shape of every big JSONB blob |
| `[NAV:db-indexes]` | §5.3 | Indexes + FK cascades |
| `[NAV:migrations]` | §5.4 | All 28 drizzle migrations |
| `[NAV:auto-pipeline]` | §6 | Auto pipeline umbrella |
| `[NAV:pipeline-entry]` | §6.1 | SFN → ECS → process-worker → processProject |
| `[NAV:pipeline-stages]` | §6.2 | 14 per-page stages |
| `[NAV:pipeline-concurrency]` | §6.3 | `mapConcurrent`, idempotency, head-check pattern |
| `[NAV:pipeline-constants]` | §6.4 | Hardcoded tuning knobs |
| `[NAV:parsers]` | §7 | User-triggered parsers umbrella |
| `[NAV:parser-yolo]` | §7.1 | YOLO / SageMaker |
| `[NAV:parser-bucket-fill]` | §7.2 | Three-variant bucket fill |
| `[NAV:parser-shape-parse]` | §7.3 | Keynote detection |
| `[NAV:parser-symbol-search]` | §7.4 | Template match + Lambda fan-out |
| `[NAV:parser-table-parse]` | §7.5 | 5-method table parser |
| `[NAV:parser-csi]` | §7.6 | CSI detect + spatial |
| `[NAV:parser-classifiers]` | §7.7 | Composite + table classifier |
| `[NAV:parser-heuristics]` | §7.8 | Heuristic engine rules |
| `[NAV:parser-map-tags]` | §7.9 | Tag mapping entry point |
| `[NAV:tag-mapping]` | §8 | 5-type matcher subsystem |
| `[NAV:llm]` | §9 | LLM subsystem |
| `[NAV:api-catalog]` | §10 | All 91 API routes |
| `[NAV:auth]` | §11 | NextAuth, brute force, rate limits |
| `[NAV:frontend]` | §12 | Frontend umbrella |
| `[NAV:viewer-shell]` | §12.1 | `PDFViewer.tsx` |
| `[NAV:canvas]` | §12.2 | `AnnotationOverlay.tsx` umbrella |
| `[NAV:canvas-render-gate]` | §12.2.1 | THE three-condition render gate |
| `[NAV:canvas-modes]` | §12.2.2 | Every tool mode table |
| `[NAV:canvas-handlers]` | §12.2.3 | Mouse event dispatch |
| `[NAV:canvas-draw-passes]` | §12.2.4 | Loop 1 / Loop 2 / special renders |
| `[NAV:canvas-helpers]` | §12.2.5 | `computeRealArea`, vertex save, isSavingRef |
| `[NAV:canvas-preview]` | §12.3 | `DrawingPreviewLayer.tsx` |
| `[NAV:store]` | §12.4 | `viewerStore.ts` (18 slice hooks) |
| `[NAV:panels]` | §12.5 | Every `*Panel.tsx` / `*Tab.tsx` |
| `[NAV:ui-primitives]` | §12.6 | Shared components |
| `[NAV:hooks]` | §12.7 | `src/hooks/` |
| `[NAV:toolbar]` | §12.8 | `ViewerToolbar.tsx` |
| `[NAV:post-processing]` | §13 | End-to-end user flows |
| `[NAV:upload]` | §14 | Multi-file upload flow |
| `[NAV:admin]` | §15 | Admin UI |
| `[NAV:module-graph]` | §16 | Who imports whom |
| `[NAV:gotchas]` | §17 | Known landmarks + traps |
| `[NAV:symbol-index]` | §18 | Alphabetical symbol index |
| `[NAV:related-docs]` | §19 | Other `featureRoadMap/*.md` pointers |
| `[NAV:extend]` | §20 | Recipes for "how do I add X" |

### Quick lookups ("if you're doing X, go to Y")

| Goal | Section(s) |
|---|---|
| Add a new canvas tool mode | §12.2.1 (render gate) + §12.2.2 (modes) + §20 (recipe) |
| Add a new visibility filter | §12.4 (store) + §20 |
| Add a new side panel | §12.1 (`ViewerPanels()`) + §12.5 + §20 |
| Add a new parser | §6 (pipeline) + §7 (user-triggered pattern) + §20 |
| Add a new LLM tool | §9.2 (tool registry) + §20 |
| Debug pointer events not firing | §12.2.1 + §17 |
| Trace an API route | §10 (catalog) |
| Look up a DB column | §5.1 (tables) + §5.2 (JSONB shapes) |
| Understand a Terraform resource | §4.3 |
| Fix a deploy | §4.4 (deploy scripts) + §4.7 (observability) |
| Understand multi-tenancy | §5.1 (companyId column) + §11 (auth scope) |
| Find all 23 consumers of composite-classifier | §7.7 + §18 |

---

## 1. Product thesis `[NAV:vision]`

**One-liner.** Best open-source 2D PDF takeoff tool. Upload PDFs → auto pipeline (Textract + page intelligence + shape parse) → user triggers YOLO / bucket-fill / table-parse / symbol-search / QTO → export BoQ. Self-hostable (MIT). Differentiators: transparent debugability, custom classic CV (Shape Search), agentic LLM backend (Phase 3), trade-agnostic 5-type QTO engine.

**Deeper thesis** (from user memory, not repeated here in full):

- **Graph builder.** BP is a graph builder for blueprints; takeoff, QTO, and discrepancy engine are downstream consumers of the graph.
- **Measurement = labeling.** Parsing tools are measurement instruments; the resulting graph is a labeled dataset. The headless-fork thesis trains a blueprint VLM off this.
- **Auditability.** Positioning wedge: "takeoffs you can defend in court." Every number links back to pixels.

**Roadmap.** 4-phase plan in `featureRoadMap/aiQTOroadmap.md`:
1. Parity (trade classifier, auto scale, CSI BoQ, no-schedule mode, floor multipliers)
2. Signature (Shape Search rebuild, Discrepancy Engine, scope tagging, typical-floor clustering, revision diff)
3. Agentic (MCP-wrapped tools; LLM orchestrates full takeoff)
4. Community (shared templates, models, plugins)

Related planning docs: `featureRoadmap.md` (signature features catalog), `tableSteaksFeatureRoadmap.md` (parity catch-up), `note_suite_4layer_plan.md` (in-progress note classifier), `forward_plan_2026_04_21.md`.

---

## 2. Repo map `[NAV:repo-map]`

```
blueprintparser_2/
├── src/
│   ├── app/                              # Next.js App Router
│   │   ├── (auth) (dashboard)            # Route groups — auth pages, dashboard
│   │   ├── admin/                        # /admin UI + AdminTabs
│   │   ├── api/                          # 91 route.ts files (§10)
│   │   ├── docs/ project/ demo/
│   │   └── middleware.ts                 # rate-limit + security headers (§11.4)
│   ├── components/
│   │   ├── viewer/                       # 56 *.tsx (§12)
│   │   ├── admin/                        # AdminTabs + per-tab panels
│   │   └── dashboard/                    # UploadWidget (§14)
│   ├── stores/viewerStore.ts             # 1986 LOC, Zustand, 18 slice hooks (§12.4)
│   ├── lib/                              # 56 ts files + subdirs (§16)
│   │   ├── db/{index,migrate,schema,seed}.ts   # Drizzle Postgres (§5)
│   │   ├── detectors/                    # 13 files (9 detector types + orchestrator)
│   │   ├── llm/                          # 10 files (§9)
│   │   └── tag-mapping/                  # 5 matchers + orchestrator + primitives (§8)
│   ├── workers/bucket-fill.worker.ts     # ~540 LOC Web Worker flood fill (§7.2)
│   ├── types/index.ts                    # Shared types
│   └── hooks/                            # 5 hook files (§12.7)
├── scripts/                              # 14 Python + 3 TS
│   ├── process-worker.ts                 # ECS entry (§6.1)
│   ├── build_project_pdf.py              # Multi-file concat (§14)
│   ├── bucket_fill.py extract_keynotes.py template_match.py
│   ├── detect_table_lines.py img2table_extract.py camelot_pdfplumber_extract.py
│   ├── tatr_structure.py yolo_inference.py
│   └── lambda_handler.py                 # Lambda CV entry (§7.4)
├── infrastructure/terraform/             # 14 .tf files (§4.3)
├── drizzle/                              # 28 .sql migrations + meta/ (§5.4)
├── models/tatr/                          # Bundled HuggingFace TATR weights
├── Dockerfile Dockerfile.lambda Dockerfile.yolo  (§4.5)
├── deploy.sh deploy-lambda.sh deploy-yolo.sh deploy-label-studio.sh
├── ecs-tune.sh ecs-health.sh hardening.sh root_admin.sh
├── install_setup.sh setup-lambda-iam.sh entrypoint.sh
└── featureRoadMap/                       # Product plans + session logs + THIS doc
```

### Heaviest files (where complexity lives)

| File | LOC | Why heavy |
|---|---:|---|
| `src/components/viewer/AnnotationOverlay.tsx` | **2581** | Every canvas tool, render gates, event handlers, 2 draw loops (§12.2) |
| `src/stores/viewerStore.ts` | **1986** | Zustand store + 17 slice hooks (§12.4) |
| `src/components/viewer/ViewAllPanel.tsx` | 1504 | Unified tree (Groups / Detections / Markup / Takeoffs / Text / CSI) with eyeballs at every level |
| `src/components/viewer/AutoQtoTab.tsx` | 1468 | Auto-QTO wizard UI |
| `src/components/viewer/KeynotePanel.tsx` | 1174 | Keynote parse workflow + export (§12.5) |
| `src/components/viewer/DetectionPanel.tsx` | 1035 | YOLO detections + CSI editor + tag mapping |
| `src/components/viewer/DrawingPreviewLayer.tsx` | 818 | Marquee + polygon + split + bucket-fill previews |
| `src/components/viewer/PDFViewer.tsx` | 687 | Viewer shell + keyboard + zoom + pan + viewport persist |
| `src/lib/processing.ts` | 605 | Auto pipeline orchestrator (§6) |
| `src/components/viewer/ViewerToolbar.tsx` | 630 | All toggle buttons |
| `src/lib/llm/tools.ts` | 586 | 20 tool executors |
| `src/lib/context-builder.ts` | 625 | Context assembly for LLM |
| `src/lib/db/schema.ts` | 515 | 20 tables |
| `src/lib/textract.ts` | ~197 | 3-tier fallback chain |

### Tests

Sparse: ~7 `.test.ts` files. Best coverage: `src/lib/tag-mapping/__tests__/` (187 tests) and `src/lib/__tests__/bucket-fill-hole-detection.test.ts` (10 cases). Near-zero coverage on: grid-merger, yolo-tag-engine, composite-classifier, csi-detect, heuristic-engine.

---

## 3. Three-layer system architecture `[NAV:system-layers]`

```
┌─────────────────────────────────────────────────────────────┐
│ BROWSER                                                     │
│  • Next.js pages + PDFViewer.tsx                             │
│  • Zustand store + pdf.js range-loading                      │
│  • Direct S3 upload via presigned POST                       │
│  • bucket-fill.worker.ts runs in a Web Worker                │
└─────────────────────────────────────────────────────────────┘
                │                         │
                ▼                         ▼  (S3 presign PUT direct)
┌─────────────────────────────────────────────────────────────┐
│ Next.js App (ECS Fargate)                                    │
│  • 91 API route.ts handlers                                  │
│  • src/lib/processing.ts orchestrator (in-process + SFN)     │
│  • src/lib/llm/*.ts provider + tool-use loop                 │
│  • Drizzle ORM → RDS Postgres                                │
│  • Spawns Python subprocesses (bucket-fill, table-parse,     │
│    shape-parse, tatr, build_project_pdf)                     │
│  • Invokes AWS services: Textract, S3, Lambda, SageMaker, SFN│
└─────────────────────────────────────────────────────────────┘
   │             │                   │               │
   │             ▼                   ▼               ▼
   │   ┌──────────────┐    ┌─────────────────┐  ┌──────────┐
   │   │ Lambda CV    │    │ SageMaker YOLO  │  │ Textract │
   │   │ (batch=1     │    │ ml.g4dn.xlarge  │  │ sync API │
   │   │  fan-out)    │    │ processing-job  │  │          │
   │   └──────────────┘    └─────────────────┘  └──────────┘
   ▼
┌─────────────────────────────────────────────────────────────┐
│ Storage                                                      │
│  • S3 bucket: blueprintparser-data-{account}                 │
│    ├── {proj}/original.pdf                                   │
│    ├── {proj}/staging/*.pdf|*.png|*.tif|*.heic   (multi-upload)│
│    ├── {proj}/pages/page_NNNN.png (300 DPI rasters)          │
│    ├── {proj}/thumbnails/*                                   │
│    ├── {proj}/yolo/{modelId}/annotations.json                │
│    └── tmp/cv-jobs/{jobId}/   (Lambda fan-out scratch)       │
│  • RDS Postgres: blueprintparser-db (t4g.medium)             │
│  • CloudFront assets.{domain} fronts S3 with Range support   │
└─────────────────────────────────────────────────────────────┘
```

**Key boundary.** Python scripts in `scripts/` do **not** talk to S3. TS callers handle download → local tempdir → spawn Python with paths via stdin JSON → read output → S3 upload. No `boto3` in `Dockerfile`. Confirm: `scripts/build_project_pdf.py`, `scripts/bucket_fill.py`, `scripts/extract_keynotes.py`, `scripts/template_match.py`, `scripts/tatr_structure.py` all use this pattern. Only `scripts/lambda_handler.py` talks to S3 directly (because Lambda fan-out needs per-batch I/O without a TS wrapper).

---

## 4. AWS infrastructure `[NAV:aws-infra]`

### 4.1 Network topology `[NAV:aws-network]`

Defined in `infrastructure/terraform/vpc.tf`.

- **VPC CIDR:** 10.0.0.0/16
- **Public subnets (2):** 10.0.0.0/20 + 10.0.1.0/20 (2 AZs). Host: ALB, NAT GW.
- **Private subnets (2):** 10.0.2.0/20 + 10.0.3.0/20. Host: ECS Fargate tasks, RDS.
- **NAT Gateway:** single, in public[0].
- **Routing:** public → IGW; private → NAT.
- **S3 gateway endpoint:** **absent**. Fargate reaches S3 via NAT (costs ~$0.04/GB egress but keeps routing simple). If you plan large S3 traffic workloads, this is a candidate optimization.

**Security groups:**

| SG name | Ingress | Used by |
|---|---|---|
| `blueprintparser-alb-sg` | 80, 443 from 0.0.0.0/0 | ALB |
| `blueprintparser-ecs-sg` | 3000 from `alb-sg` | Fargate tasks |
| `blueprintparser-rds-sg` | 5432 from `ecs-sg` | RDS |
| `blueprintparser-label-studio-sg` | 8080 from `alb-sg` | Label Studio ECS service |
| `blueprintparser-efs-sg` | 2049 from `label-studio-sg` | Label Studio EFS mount |

### 4.2 AWS service map `[NAV:aws-services]`

| Service | Resource name | Terraform file | Where code touches it | Notes |
|---|---|---|---|---|
| **ECS cluster** | `blueprintparser-cluster` | `ecs.tf:10` | (none — infra) | Fargate-only |
| **ECS task (app)** | `blueprintparser-app` (family) | `ecs.tf:43-...` | `entrypoint.sh` runs migrations + `node server.js` | CPU 2048 / memory 4096 in TF; current live is Performance tier 4/8 per ecs-tune |
| **ECS task (processor)** | `blueprintparser-cpu-pipeline` | `ecs.tf:375` | `scripts/process-worker.ts` | Launched by SFN |
| **ECS service (Label Studio)** | `blueprintparser-label-studio` | `ecs.tf:641` | `deploy-label-studio.sh` | EFS-backed |
| **Lambda CV** | `blueprintparser-cv-pipeline` | `lambda.tf` | `src/lib/lambda-cv.ts:isLambdaCvEnabled()` + `fanOutTemplateMatch`/`fanOutShapeParse` | 6144 MB / 600s (post-2026-04-19 bumps); image-packaged via `Dockerfile.lambda` |
| **SageMaker YOLO** | processing-job (async) | (created at runtime, not in TF) | `src/lib/yolo.ts` via `CreateProcessingJobCommand` | ml.g4dn.xlarge GPU; image from `blueprintparser-yolo-pipeline` ECR |
| **S3 bucket** | `blueprintparser-data-${account_id}` | `s3.tf:10` | `src/lib/s3.ts` | OAC + CloudFront front; CORS at edge |
| **RDS** | `blueprintparser-db` | `rds.tf` | `src/lib/db/index.ts` via `DATABASE_URL` | Postgres 16, db.t4g.medium, 50 GB gp3, Multi-AZ prod |
| **CloudFront** | distribution (alias `assets.{domain}`) | `s3.tf:167` | `src/lib/s3.ts#getS3Url` | PriceClass_100; Range header forwarded for PDF.js; CORS policy at edge (`beaver_cors`) |
| **Step Functions** | `blueprintparser-process-blueprint` | `stepfunctions.tf` | `POST /api/projects` → `StartExecutionCommand` | States: ValidateInput → CPUProcessing (ECS runTask.sync) → ProcessingComplete/Failed |
| **Textract** | (AWS service, no resource) | n/a | `src/lib/textract.ts` `AnalyzeDocumentCommand` | LAYOUT + TABLES features; 10 MB sync cap |
| **ECR (4 repos)** | `blueprintparser-{app,cpu-pipeline,yolo-pipeline,cv-lambda}` | `ecr.tf` | `deploy*.sh` | scan-on-push + lifecycle (keep last 10 tagged, expire untagged after 7d) |
| **Secrets Manager** | 8 secrets `beaver/*` | `secrets.tf` | Injected into ECS task env | `DATABASE_URL`, `NEXTAUTH_SECRET`, `PROCESSING_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `LABEL_STUDIO_*` (3 vars) |
| **CloudWatch logs** | `/ecs/blueprintparser-app`, `/aws/lambda/blueprintparser-cv-pipeline`, `/aws/states/blueprintparser-process-blueprint` | `ecs.tf:34`, `lambda.tf`, `stepfunctions.tf` | `src/lib/logger.ts` | 30-day retention |
| **CloudWatch alarms** | (optional via `hardening.sh`) | n/a | `hardening.sh:80-172` | 5xx>10/5min, unhealthy targets>0, ECS CPU>80%/10min, RDS CPU>80%/10min → SNS |
| **WAF / GuardDuty / CloudTrail** | optional | n/a (created by `hardening.sh`) | | Not on by default |

**Note on TF resource vs AWS resource names.** Terraform resource identifiers use `aws_*.beaver_*` (e.g., `aws_ecs_cluster.beaver`) as the Terraform symbol, while the actual AWS resource `name` attribute is `blueprintparser-*`. When grepping AWS CLI output, use `blueprintparser-*`; when editing `.tf` files, use `beaver_*`.

### 4.3 Terraform files `[NAV:terraform-files]`

Directory: `infrastructure/terraform/`.

| File | Key resources |
|---|---|
| `main.tf` | Provider (AWS ~>5.0), backend S3+DynamoDB, data sources (caller identity, region, ECR auth) |
| `variables.tf` | `aws_region`, `environment`, `account_id`, `vpc_cidr`, `ecs_cpu/memory`, `rds_instance_class`, 4 secret vars |
| `vpc.tf` | VPC, 2 public + 2 private subnets, IGW, NAT GW, route tables |
| `ecr.tf` | 4 ECR repos (app, cpu-pipeline, yolo-pipeline, cv-lambda), scan-on-push, lifecycle rules |
| `ecs.tf` | Cluster, log group, task def (app), ALB + SG + target group, service, CPU + memory autoscaling policies, Label Studio task + service + EFS |
| `rds.tf` | DB subnet group, RDS SG, Postgres 16 instance, parameter group (slow-query log, pg_stat_statements) |
| `s3.tf` | Data bucket + versioning + SSE + lifecycle + CORS + OAC + CloudFront distribution + cache/origin-request/response-headers policies |
| `lambda.tf` | CV Lambda function, log group, execution role + inline S3 policy |
| `stepfunctions.tf` | `blueprintparser-process-blueprint` state machine, log group |
| `iam.tf` | ECS execution role, ECS task role (S3 + Step Functions + SSM + Textract + SageMaker + Lambda invoke), SageMaker role, SFN role |
| `secrets.tf` | 8 Secrets Manager secrets with 7-day recovery |
| `outputs.tf` | VPC / ECS / ALB / RDS / S3 / CF / ECR / IAM / SFN / Lambda / Secrets ARNs |
| `terraform.tfvars.example` | Template for user-filled tfvars (not committed) |
| `terraform.tfvars` | **gitignored** — actual secret values |

### 4.4 Deploy & ops scripts `[NAV:deploy-scripts]`

All at repo root. `.deploy.env` (gitignored) provides env. No Terraform is run by these scripts — infra is applied once via `terraform apply`, then these deploy code.

| Script | Purpose | Key env vars | When to run |
|---|---|---|---|
| `deploy.sh` | Main app deploy: Docker build → ECR push → `ecs update-service --force-new-deployment` | `AWS_ACCOUNT`, `AWS_REGION`, `ECR_REPO`, `ECS_CLUSTER`, `ECS_SERVICE` | Every code change; ~8-12 min |
| `deploy-lambda.sh` | CV Lambda deploy: build `Dockerfile.lambda` → ECR → `lambda update-function-code` | `ECR_CV_REPO`, `LAMBDA_FUNCTION_NAME`, `LAMBDA_ROLE_ARN` | When `scripts/lambda_handler.py` / `template_match.py` / `extract_keynotes.py` changes |
| `deploy-yolo.sh` | Build `Dockerfile.yolo` → ECR push (no Lambda update; SageMaker pulls on job submit) | `ECR_YOLO_REPO` | When `scripts/yolo_inference.py` changes |
| `deploy-label-studio.sh` | Force redeploy Label Studio ECS service (Docker Hub image, no build) | `ECS_LABEL_STUDIO_SERVICE` | Rolling restart |
| `ecs-tune.sh` | Interactive TUI: pick Fargate tier (Cheap 1/2, Balanced 2/4, Performance 4/8, Overpowered 8/16), register new task-def, optional redeploy. End-of-flow offers Lambda CV memory bump | `AWS_REGION`, `ECS_CLUSTER`, `ECS_SERVICE`, `LAMBDA_CV_FUNCTION_NAME` | Capacity tuning |
| `ecs-health.sh` | Diagnostic TUI: service status, task failures, ALB health, recent errors, CW alarms. Interactive actions: [L]=tail logs, [E]=errors, [M]=migrations, [T]=Textract throttles, [F]=fix grace period, [D]=force deploy, [R]=combo, [A]=dump JSON | `AWS_REGION`, `ECS_CLUSTER`, `ECS_SERVICE`, `ALB_NAME`, `RDS_ID` | When something's wrong in prod |
| `hardening.sh` | One-time: ECR scan on push, SNS alerts, CloudWatch alarms (5xx, unhealthy, CPU), ALB access logs, GuardDuty, WAF rate-limit + SQLi, CloudTrail | positional `$1` ALERT_EMAIL | Initial prod setup (~$10-25/mo) |
| `setup-lambda-iam.sh` | One-time: create Lambda execution role + add `lambda:InvokeFunction` to ECS task role | `LAMBDA_FUNCTION_NAME`, `ECS_TASK_ROLE` | Before first `deploy-lambda.sh` |
| `root_admin.sh` | SQL ops via ECS Exec: list/promote/demote users, list companies, reset password, custom SQL | `ECS_CLUSTER`, `ECS_SERVICE` | User admin, needs Session Manager plugin |
| `install_setup.sh` | Interactive first-time setup for `.env.local` + `.deploy.env` | (writes vars) | New deployment bootstrap |
| `entrypoint.sh` | Inside container: Drizzle migrate → clean stale projects >1hr → `exec node server.js` | `DATABASE_URL` | Runs every task start |

### 4.5 Docker images `[NAV:dockerfiles]`

**`Dockerfile`** (main app, multi-stage, ~3-4 GB final):
- **Stage 1 `deps`** (`node:20-alpine`): npm install with BuildKit cache mount
- **Stage 2 `builder`** (`node:20-alpine`): Next.js build + esbuild bundle of `scripts/process-worker.ts` → `dist/process-worker.js`. `NEXT_PUBLIC_*` vars baked in at build time.
- **Stage 3 `runner`** (`node:20-slim`): glibc needed for img2table/polars/camelot. Non-root `nextjs` user (1001). Python deps: numpy, opencv-python-headless, pytesseract, pdfplumber, pdfminer.six, pymupdf, tabulate, openpyxl, Pillow≥10, pillow-heif≥0.16, camelot-py[base], img2table==0.0.12, torch==2.5.1+cpu, torchvision==0.20.1+cpu, transformers≥4.40, timm≥0.9. drizzle-orm + pg installed *in the runner layer* (not via `npm`) so the cache doesn't bust on source changes.
- **Patches:** TATR `preprocessor_config.json` normalized for transformers ≥4.40; img2table `patch_img2table.py` disables numba cache (`NUMBA_CACHE_DIR=/tmp/numba_cache`).

**`Dockerfile.lambda`** (Lambda CV, `python:3.11-slim`):
- System: tesseract-ocr + eng, libglib2.0-0, libsm6, libxext6, libxrender1, libgl1
- Python: awslambdaric, numpy, opencv-python-headless, pytesseract, boto3
- Code: `scripts/lambda_handler.py` + `template_match.py` + `extract_keynotes.py` → `/opt/code/`
- Entry: `awslambdaric` + `lambda_handler.handler`
- ~400-500 MB image, 5-8s cold start

**`Dockerfile.yolo`** (SageMaker processing, `python:3.10-slim`):
- System: libgl1, libglib2.0-0
- Python: torch+torchvision from `download.pytorch.org/whl/cu118` (CUDA 11.8), ultralytics, pyyaml
- BuildKit cache keeps the 2 GB torch download across rebuilds
- Entry: `python3 /opt/ml/code/yolo_inference.py`

### 4.6 Environment variable catalog `[NAV:env-vars]`

Grouped by purpose; names only (no values).

**AWS core.** `AWS_REGION`, `AWS_ACCOUNT`, `AWS_ACCESS_KEY_ID` (usually IAM role), `AWS_SECRET_ACCESS_KEY`.

**Database.** `DATABASE_URL` (Secrets Manager injected).

**S3 / CDN.** `S3_BUCKET`, `NEXT_PUBLIC_S3_BUCKET`, `CLOUDFRONT_DOMAIN`, `NEXT_PUBLIC_CLOUDFRONT_DOMAIN`.

**Auth.** `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ROOT_ADMIN_EMAIL`.

**Webhooks.** `PROCESSING_WEBHOOK_SECRET`.

**Lambda CV.** `LAMBDA_CV_ENABLED` (="true"), `LAMBDA_CV_FUNCTION_NAME` (default `blueprintparser-cv-pipeline`), `LAMBDA_CV_BATCH_SIZE` (default 1).

**SageMaker YOLO.** `YOLO_ECR_IMAGE`, `SAGEMAKER_ROLE_ARN`.

**Step Functions.** `STEP_FUNCTION_ARN`.

**LLM providers.** `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `OPENAI_API_KEY`, `LLM_PROVIDER`, `LLM_MODEL`, `LLM_BASE_URL`, `LLM_KEY_SECRET`.

**Label Studio.** `LABEL_STUDIO_URL`, `LABEL_STUDIO_API_KEY`, `LABEL_STUDIO_ADMIN_EMAIL`, `LABEL_STUDIO_ADMIN_PASSWORD`.

**Email.** `SES_FROM_EMAIL` (optional).

**Dev flags.** `NODE_ENV`, `DEV_PROCESSING_ENABLED`, `LOG_LEVEL`, `NEXT_PUBLIC_TABLE_PARSE_DEBUG`.

### 4.7 Observability `[NAV:observability]`

- **App logs:** `/ecs/blueprintparser-app` (30-day retention). Emitted via `src/lib/logger.ts` which does structured console output.
- **Lambda CV logs:** `/aws/lambda/blueprintparser-cv-pipeline`.
- **SFN logs:** `/aws/states/blueprintparser-process-blueprint` (errors only by default).
- **Health endpoint:** `GET /api/health` — polled by ECS every 30s, 5s timeout, 3 retries, 60s grace.
- **Alarms (optional, via `hardening.sh`):** 5xx>10/5min, unhealthy targets>0/5min, ECS CPU>80%/10min, RDS CPU>80%/10min — all → SNS.
- **Live diagnostic tool:** `./ecs-health.sh` (see §4.4).
- **No X-Ray.** Not configured.

---

## 5. Data layer `[NAV:data-layer]`

ORM: Drizzle on Postgres 16. Schema: `src/lib/db/schema.ts` (515 LOC). Migrations apply on every task boot via `entrypoint.sh:5-28`.

### 5.1 Table catalog `[NAV:db-tables]`

| Table | Purpose | Multi-tenancy key |
|---|---|---|
| `companies` | Tenants, `pipelineConfig` JSONB, feature flags | root |
| `users` | Auth + role (`member`/`admin`), `isRootAdmin`, `canRunModels`, OAuth fields | `companyId` |
| `userApiKeys` | BYOK for LLM providers | via `userId.companyId` |
| `projects` | PDF projects; status; summaries; `stagingManifest` JSONB | `companyId` |
| `pages` | Per-page OCR + intelligence; has `search_vector` tsvector | via `projectId.companyId` |
| `annotations` | YOLO detections, keynotes, user markups; `source` column + `data` JSONB | via `projectId.companyId` |
| `takeoffGroups` | User categories (count/area/linear scoped) | via `projectId.companyId` |
| `takeoffItems` | Individual count/area/linear items; groups link via `groupId` | via `projectId.companyId` |
| `annotationGroups` | User-created ring-color groupings; `isActive` boolean | via `projectId.companyId` |
| `annotationGroupMembers` | M:N junction (composite PK `groupId + annotationId`) | via `groupId` |
| `qtoWorkflows` | Auto-QTO parsed schedules (`parsedSchedule` JSONB) | via `projectId.companyId` |
| `chatMessages` | LLM conversation history | via `projectId.companyId` |
| `sessions` | NextAuth JWT sessions | — |
| `processingJobs` | SFN / processing execution tracking | via `projectId.companyId` |
| `models` | YOLO/CV model registry | `companyId` |
| `modelAccess` | Cross-company model grants | both sides |
| `appSettings` | Global admin key/value | — |
| `auditLog` | All mutating actions (user, company, IP) | optional `companyId` |
| `inviteRequests` | Signup queue | — |
| `llmConfigs` | Per-company LLM provider config (+ per-user override) | `companyId` + optional `userId` |
| `labelingSessions` | Label Studio integration state | `companyId` + `projectId` |

### 5.2 Key JSONB shapes `[NAV:jsonb-shapes]`

```typescript
// companies.pipelineConfig
{
  textAnnotation?: { enabledDetectors?: string[] };
  csi?: { matchingConfidenceThreshold, taggerKeywordOverlap, customDatabaseS3Key, ... };
  heuristics?: HeuristicRule[];
  llm?: { systemPrompt, sectionConfig, toolUse: boolean, domainKnowledge };
  pipeline?: { pageConcurrency: number; csiSpatialGrid };
  demo?: Record<string, boolean>;
  pageNaming?: { enabled: boolean; yoloSources: string[] };
  disabledSteps?: string[];    // e.g., ["shape-parse"]
}

// projects.projectIntelligence (ProjectIntelligence)
{
  disciplines?: string[];
  summaries?: Record<string, string>;
  csiGraph?: { nodes, clusters, ... };
  classCsiOverrides?: Record<string, string>;   // preserved across reprocess
}

// projects.stagingManifest   (null for legacy single-file projects)
StagingFile[] = Array<{ filename: string; stagingKey: string; size: number }>;

// pages.pageIntelligence (PageIntelligence)
{
  classification?: { discipline, drawingType };
  crossRefs?: Array<{ sheetNumber, description }>;
  noteBlocks?: Array<{ bbox, content }>;
  textRegions?: TextRegion[];
  heuristicInferences?: HeuristicInference[];
  classifiedTables?: Array<{ type, bbox, ... }>;
  csiSpatialMap?: { zones: Array<{ zone, divisions[] }> };
}

// pages.textractData (TextractPageData)
{
  width: number; height: number;
  words: Array<{ text, bbox: [x,y,w,h], confidence }>;
  lines: Array<{ text, bbox, wordIndices }>;
  tables?: Array<{ cells, rows, cols, ... }>;
}

// pages.textAnnotations (TextAnnotationResult from src/lib/text-annotations.ts)
{
  annotations: Array<{ type, value, wordIndices, confidence, ... }>;
  groups: Array<{ prefix, type, values[] }>;
  summary: Record<string, number>;
}

// annotations.data (5-variant discriminated union — tech-debt 'as any' casts throughout viewer)
// - YOLO:        { modelName, className, confidence }
// - shape-parse: { modelName:"shape-parse", shapeType, text, contour, confidence }
// - user-markup: { label?, note?, csiCode? }
// - count-marker:{ type:"count-marker", shape, color }
// - area-polygon:{ type:"area-polygon", vertices: [[x,y], ...], color, areaSqUnits }

// qtoWorkflows.parsedSchedule (QtoParsedSchedule)
{
  headers: string[];
  rows: Array<Record<string, string | number>>;
  tagColumn: string;
  csiCodes?: string[];
}
```

### 5.3 Indexes + FK cascades `[NAV:db-indexes]`

**Composite indexes** (migration 0019):
- `idx_pages_project_page` on `(projectId, pageNumber)` — fast per-page lookup
- `idx_annotations_project_page` on `(projectId, pageNumber)` — viewer filter
- `idx_takeoff_groups_project_kind` on `(projectId, kind)` — QTO by type
- `idx_model_access_company` + `idx_model_access_model` — cross-company access checks
- `idx_llm_configs_company` — per-company LLM lookup

**Full-text:** `pages.search_vector` as `tsvector` with GIN index. Created via raw SQL in migration 0001 (Drizzle has no native tsvector). Updated in processing stage 14 with `to_tsvector('english', rawText)`.

**Cascade behavior:**
- `users.companyId` → `companies.id` — **no** cascade (keep users on accidental company delete)
- `projects.companyId`, `projects.authorId` — **no** cascade
- `pages.projectId`, `annotations.projectId` — **no** cascade (preserve forensics)
- `takeoffGroups.projectId`, `annotationGroups.projectId` — **CASCADE** (user-owned ephemera)
- `annotationGroupMembers.annotationId/groupId` — **both CASCADE**

### 5.4 Migrations catalog `[NAV:migrations]`

Directory: `drizzle/*.sql` (28 migrations as of 2026-04-22).

| # | File | Purpose |
|--:|---|---|
| 0000 | `0000_youthful_madrox.sql` | Initial schema (all core tables) |
| 0001 | `0001_add_search_vector.sql` | `pages.search_vector` tsvector + GIN |
| 0002 | `0002_add_demo_flag.sql` | `projects.is_demo` boolean |
| 0003 | `0003_add_takeoff_items.sql` | Create `takeoff_items` |
| 0004 | `0004_add_audit_log.sql` | Create `audit_log` |
| 0005 | `0005_add_invite_requests.sql` | Create `invite_requests` |
| 0006 | `0006_add_takeoff_size_notes.sql` | `takeoffItems.notes` text |
| 0007 | `0007_add_labeling_sessions.sql` | Create `labeling_sessions` |
| 0008 | `0008_labeling_tiling.sql` | Tiling support on labeling sessions |
| 0009 | `0009_add_can_run_models.sql` | `users.can_run_models` |
| 0010 | `0010_add_text_annotations.sql` | `pages.text_annotations` JSONB |
| 0011 | `0011_add_llm_configs.sql` | `llm_configs` table (BYOK) |
| 0012 | `0012_add_page_intelligence.sql` | `pages.page_intelligence` JSONB |
| 0013 | `0013_add_project_intelligence.sql` | `projects.project_intelligence` JSONB |
| 0014 | `0014_add_pipeline_config.sql` | `companies.pipeline_config` JSONB |
| 0015 | `0015_add_qto_workflows.sql` | `qto_workflows` table |
| 0016 | `0016_add_root_admin.sql` | `users.is_root_admin` |
| 0017 | `0017_add_oauth_fields.sql` | `users.oauth_provider`/`oauth_provider_id` |
| 0018 | `0018_add_password_reset.sql` | `users.password_reset_token`/`password_reset_expires` |
| 0019 | `0019_add_composite_indexes.sql` | Composite indexes (see §5.3) |
| 0020 | `0020_add_model_access.sql` | `model_access` table |
| 0021 | `0021_add_app_settings.sql` | `app_settings` key/value |
| 0022 | `0022_set_root_admin.sql` | Bootstrap `ROOT_ADMIN_EMAIL` |
| 0023 | `0023_add_takeoff_groups.sql` | `takeoff_groups` table |
| 0024 | `0024_qto_itemtype_cleanup.sql` | `qtoWorkflows` refactor (drop `yolo_model_filter`, `tag_pattern`; add `item_type`, `tag_shape_class`) |
| 0025 | `0025_open_millenium_guard.sql` | `annotation_groups` + `annotation_group_members` |
| 0026 | `0026_add_group_is_active.sql` | `annotationGroups.is_active` |
| 0027 | `0027_add_project_staging_manifest.sql` | `projects.staging_manifest` JSONB (multi-file upload) |

**Snapshot gap (known, benign).** `drizzle/meta/` only has `0000_snapshot.json` and `0025+`; 0001–0024 are missing. Running `db:generate` from current state produces bloated diffs. Not blocking deploy. Candidate fix: rebuild snapshots.

---

## 6. Processing pipeline (auto) `[NAV:auto-pipeline]`

### 6.1 Entry chain `[NAV:pipeline-entry]`

```
POST /api/projects
  → INSERT projects row (status "uploading")
  → Step Functions StartExecution (production)
    → Pass: ValidateInput
    → Task: CPUProcessing (ECS runTask.sync, Fargate, family=blueprintparser-cpu-pipeline)
      → Container entrypoint runs: node scripts/process-worker.ts
        → reads process.env.PROJECT_ID
        → calls processProject(projectId) from @/lib/processing
        → optionally POSTs /api/processing/webhook with HMAC + timestamp
        → exit 0 (ok) or 1 (fatal)
    → Succeed: ProcessingComplete
    │  (or) Catch: ProcessingFailed
```

**Canonical entry function:** `processProject(projectId: number)` at `src/lib/processing.ts:165-605`. Also callable in dev from `POST /api/processing/dev`.

**Step Functions contract (from `scripts/process-worker.ts:12-49`):** exit 0 means the container succeeded (even if some pages errored); exit 1 is a fatal container failure (bad projectId, DB unreachable, etc).

### 6.2 Stage-by-stage `[NAV:pipeline-stages]`

All stages in `src/lib/processing.ts`. Per-page stages run concurrently (default 8) via `mapConcurrent`.

| # | Stage | Location | Inputs → outputs | Gating | Fatal? |
|--:|---|---|---|---|---|
| 0 | **Pre-stage multi-file concat** | `processing.ts:191-207` + `buildProjectPdf` at `:123-157` + `runPythonConcat` at `:58-112` | `projects.stagingManifest` → `{projectPath}/original.pdf` on S3 | Only if `stagingManifest` set AND `headS3Object(originalKey)` returns `exists:false` | No (SFN retry skips if already exists) |
| 1 | **PDF download + page count** | `processing.ts:209-223` | S3 PDF → `Buffer` → `getPdfPageCount()` → `pages.numPages` | unconditional | Yes |
| 2 | **Thumbnail** | `processing.ts:225-235` | page 1 at 72 DPI → `{projectPath}/thumbnail.png` | unconditional | No |
| 3 | **Company config load** | `processing.ts:237-252` | `companies.pipelineConfig` → `heuristics`, `pageConcurrency` (default 8), `csiSpatialGrid`, `disabledSteps` | — | No |
| 4 | **Per-page rasterize 300 DPI** | `processing.ts:279` | PDF → `{projectPath}/pages/page_NNNN.png` + thumbnail | — | No (image upload failures swallowed) |
| 5 | **Textract dimension check** | `processing.ts:292-304` | PNG magic header → if max>9500 re-rasterize at safe DPI | — | No |
| 6 | **Textract OCR** | `processing.ts:306-308` + `textract.ts#analyzePageImageWithFallback` | PNG → `TextractPageData` + `rawText` | 3-tier fallback: full-res Textract → half-res Textract → Tesseract → empty | Per-page only |
| 7 | **Drawing number** | `processing.ts:310-316` | Textract → title-block OCR → `pages.drawingNumber` | — | No (swallows) |
| 8 | **CSI code detection** | `processing.ts:318-325` + `csi-detect.ts#detectCsiCodes(rawText, words?)` | rawText + Textract words → `CsiCode[]` | — | No |
| 9 | **Text annotations** (9 detectors) | `processing.ts:327-336` + `src/lib/text-annotations.ts` + `src/lib/detectors/orchestrator.ts` | Textract + CSI codes → `{annotations, groups, summary}` | enabled list from `companies.pipelineConfig.textAnnotation.enabledDetectors` | No |
| 10 | **Shape parse (keynotes)** | `processing.ts:338-370` + `keynotes.ts#extractKeynotes` → `scripts/extract_keynotes.py` (OpenCV + Tesseract) | PNG → circles/diamonds/hexagons with text → `pages.keynotes` JSONB + per-keynote row in `annotations` (`source:"shape-parse"`) | **skipped if** `disabledSteps.has("shape-parse")` | No |
| 11 | **Page intelligence** | `processing.ts:372-381` + `page-analysis.ts#analyzePageIntelligence` | drawingNumber + Textract + CSI → classification + cross-refs + noteBlocks | — | No |
| 12 | **Text region classification** | `processing.ts:383-392` + `text-region-classifier.ts` | Textract + CSI → tables/notes/specs | — | No |
| 13 | **Heuristic engine (text-only)** | `processing.ts:394-409` + `heuristic-engine.ts#runHeuristicEngine` | rawText + textRegions + CSI → `HeuristicInference[]` | no YOLO yet | No |
| 14 | **Table classification** | `processing.ts:411-428` + `table-classifier.ts#classifyTables` | textRegions + heuristics + CSI → `classifiedTables[]` | — | No |
| 15 | **CSI spatial heatmap** | `processing.ts:434-452` + `csi-spatial.ts#computeCsiSpatialMap` | text annotations + classifiedTables → 3×3 zone grid | YOLO undefined during auto-pipeline | No |
| 16 | **Page upsert** | `processing.ts:454-490` | Build JSONB → UPDATE / INSERT `pages` + `to_tsvector('english', rawText)` | — | No |
| 17 | **Project analysis** | `processing.ts:521-560` + `project-analysis.ts#analyzeProject` | all pages → disciplines + summaries + csiGraph; preserves `classCsiOverrides` | — | No |
| 18 | **Project summaries** | `processing.ts:562-568` + `project-analysis.ts#computeProjectSummaries` | chunking index for sidebar | — | No |
| 19 | **Status update + CF warm** | `processing.ts:570-587` | `status="completed"` or `"error"` if all pages failed; `warmCloudFrontCache()` | — | — |

### 6.3 Concurrency + idempotency `[NAV:pipeline-concurrency]`

- **Concurrency:** `mapConcurrent` at `processing.ts:35-52`. Default pool size `DEFAULT_PAGE_CONCURRENCY=8` (`:32`). Override per company via `pipelineConfig.pipeline.pageConcurrency`.
- **Page-level idempotency:** `processing.ts:261-276` skips pages where `pages.textractData` already exists. SFN retry won't re-Textract the same page.
- **Project-level idempotency:** the multi-file concat checks `headS3Object(originalKey)` (direct to S3, **not** CloudFront — avoids 404 caching) at `:195-207`.
- **Stale cleanup:** `entrypoint.sh:18-27` marks projects stuck in `uploading`/`processing` >1hr as `error` at container boot.

### 6.4 Hardcoded constants `[NAV:pipeline-constants]`

| Constant | Value | Location |
|---|---|---|
| `DEFAULT_PAGE_CONCURRENCY` | 8 | `processing.ts:32` |
| Textract max safe dim | 9500 px | `processing.ts:~295` |
| `runPythonConcat` timeout | 300_000 ms (5 min) | `processing.ts:76` |
| `PROJECT_MAX_FILES` | 30 | `src/app/api/projects/route.ts:14` |
| Project aggregate size cap | 2 GB | `src/app/api/projects/route.ts` |
| Per-file upload cap | 500 MB | `src/lib/s3.ts` (content-length-range on presigned POST) |
| JWT `maxAge` | 86400 (1 day) | `src/lib/auth.ts:193` |
| Brute-force: 5 fails → 15 min | — | `auth.ts:68-72` |
| Brute-force: 10 fails → 1 hr | — | `auth.ts:68-72` |
| `rate limit` general fallback | 120/min/IP | `src/middleware.ts:~132` |
| LLM max tool rounds | 10 | `src/lib/llm/anthropic.ts:88` |
| LLM default max_tokens | 4096 | `anthropic.ts:109` |
| LLM default temperature | 0.3 | `anthropic.ts:110` |

---

## 7. User-triggered parsers `[NAV:parsers]`

Everything in this section is launched by user action, not the auto pipeline. For each, the standard block is: **API route · Core lib · Python/native deps · Storage · UI consumer**.

### 7.1 YOLO `[NAV:parser-yolo]`

- **API routes:** `POST /api/yolo/run`, `GET /api/yolo/status`, `GET /api/yolo/load`, `DELETE /api/admin/yolo-purge`.
- **Core:** `src/lib/yolo.ts` (~86 LOC) — `CreateProcessingJobCommand` on SageMaker, instance `ml.g4dn.xlarge`, timeout 3600s.
- **Script:** `scripts/yolo_inference.py` — reads `/opt/ml/processing/input/{images,models}/`, writes `/opt/ml/processing/output/page_*.json + _manifest.json`. Device auto-detect CUDA.
- **Storage:** S3 `{projectPath}/yolo/{modelId}/annotations.json`; loaded into `annotations` rows (`source:"yolo"`) by `POST /api/yolo/load`.
- **UI:** `DetectionPanel.tsx` (browse, filter by confidence/class/model), `ViewerToolbar.tsx` YOLO button (global show/hide).
- **Consumers downstream:** tag-mapping (§8), LLM tools (`getAnnotations`, `scanYoloClassTexts`), CSI spatial map (after YOLO load), heuristic engine (YOLO-augmented mode).

### 7.2 Bucket fill `[NAV:parser-bucket-fill]`

**Three live variants** — pick by preference order:

1. **Client Web Worker (primary).** `src/workers/bucket-fill.worker.ts` (~540 LOC). Pipeline: `ImageBitmap` → downscale to `maxDimension` → Otsu threshold → `morphClose` → burn barriers + polygon exclusions → text blocks flood (text-as-wall, post-2026-04-22) → flood fill → trace → simplify. Returns polygon + holes.
2. **Server TS fallback.** `src/lib/bucket-fill.ts` via `POST /api/bucket-fill` (`src/app/api/bucket-fill/route.ts`). Called from `AnnotationOverlay.tsx:~1315` inside a `serverFallback` function when the worker fails. Clamps negative tolerance defensively (2026-04-22).
3. **Python fallback.** `scripts/bucket_fill.py` via the server route. Live, confirmed active.

**Tuning hierarchy (as of 2026-04-22):**
1. **Dominant: `maxDimension`** (1k/2k/3k/4k slider in `AreaTab.tsx`). Downscaling before Otsu is what kills thin walls. Raise for overflow.
2. Tolerance (-20 to 80): Otsu offset. Secondary.
3. Dilation (0 to 10): morphClose radius. Secondary.
4. Barriers: user-drawn line exclusions. Tertiary.

The worker's returned `areaFraction` is **decorative**. Downstream square feet flow through `computeRealArea(vertices, ...)` at `AnnotationOverlay.tsx:~904-917` using the simplified polygon + calibration.

**Client wrapper:** `src/lib/bucket-fill-client.ts:95` — `maxDimension ?? 1000` fallback default. Real value passed from `AnnotationOverlay.tsx:~1384-1395` reading `bucketFillResolution` store field.

**UI:** `AreaTab.tsx` bucket-fill controls; `BucketFillAssignDialog.tsx` for "which takeoff item?" assignment after fill.

### 7.3 Shape parse (keynote detection) `[NAV:parser-shape-parse]`

- **API route:** `POST /api/shape-parse` (`src/app/api/shape-parse/route.ts`). Also runs automatically in stage 10 of the auto pipeline when `!disabledSteps.has("shape-parse")`.
- **Core:** `src/lib/keynotes.ts` — `extractKeynotes(pngBuffer)` spawns the Python script.
- **Script:** `scripts/extract_keynotes.py` — unified sliding-window BB pipeline post-2026-04-18. Constants: `TILE_OVERLAP=300`, `MIN_KN_ABS=15`, `MAX_KN_ABS=200`, no downscale. OpenCV contour + Tesseract OCR.
- **Storage:** `pages.keynotes` JSONB + per-keynote row in `annotations` table with `data.{shapeType, text, contour}`.
- **UI:** `KeynotePanel.tsx`, `KeynoteOverlay.tsx`, `KeynoteItem.tsx`.
- **Lambda variant:** `scripts/lambda_handler.py` exposes `shape_parse` action, invoked via `lambda-cv.ts#fanOutShapeParse` when `LAMBDA_CV_ENABLED=true`. (Lambda shape-parse not yet wired into `api/shape-parse/route.ts` as of 2026-04-16 — verify current state before asserting.)

### 7.4 Symbol search `[NAV:parser-symbol-search]`

- **API route:** `POST /api/symbol-search` (~414 LOC).
- **Core:** `src/lib/template-match.ts` (~235 LOC).
- **Script:** `scripts/template_match.py` (local fallback path).
- **Lambda path:** `src/lib/lambda-cv.ts#fanOutTemplateMatch` — batch=1 fan-out, NDJSON streaming progress, per-batch failure → per-page retry, cleanup of `tmp/cv-jobs/{jobId}/`.
- **OCR binding:** `src/lib/ocr-shape-binding.ts` binds Textract words to shape bboxes (inside → nearest fallback) post-Lambda.
- **Storage:** DB `annotations` rows with matched bboxes.
- **UI:** `SymbolSearchPanel.tsx`, `ParsePanel.tsx` (Template tab). Draw-release behavior is tool-gated by `symbolSearchActive` store field.

### 7.5 Table parse (5 methods) `[NAV:parser-table-parse]`

- **API routes:** `POST /api/table-parse`, `POST /api/table-parse/propose`, `POST /api/table-structure`.
- **Methods (attempted & merged):**
  1. **Textract tables** — reuse OCR grid
  2. **Camelot** — `src/lib/camelot-extract.ts` → `scripts/camelot_pdfplumber_extract.py` (ruling-line + stream)
  3. **img2table** — `src/lib/img2table-extract.ts` → `scripts/img2table_extract.py`
  4. **TATR** — `src/lib/tatr-structure.ts` → `scripts/tatr_structure.py` (HuggingFace Table Transformer; weights in `models/tatr/`)
  5. **OpenCV lines** — `src/lib/table-lines.ts` → `scripts/detect_table_lines.py`
- **Classifier:** `src/lib/table-classifier.ts` (~265 LOC) decides which regions are table-like (semantic, e.g. `"door-schedule"`). Separate from composite-classifier.
- **Storage:** `qtoWorkflows.parsedSchedule` JSONB (headers + rows + tagColumn + csiCodes).
- **UI:** `TableParsePanel.tsx`, `AutoQtoTab.tsx`, `ParsedTableCellOverlay.tsx`, `ParsedTableItem.tsx`, `EditableGrid.tsx`, `TableCompareModal.tsx`.
- **Debug:** `appSettings.tableParse.debugMode` admin toggle → in-memory `parseHistory` ring buffer at `src/lib/parse-history.ts` → `/admin → Table Parsing → Recent Parses` page.

### 7.6 CSI detect + spatial `[NAV:parser-csi]`

- **API routes:** `POST /api/csi/detect` (unauth'd by design — pure text, no DB/AWS calls), `POST /api/pages/csi-recompute`.
- **Core libs:**
  - `src/lib/csi-detect.ts` (~393 LOC) — `detectCsiCodes(rawText, textractWords?, config?)`. Early-return on text < 10 chars. Trie + keyword matching over MasterFormat.
  - `src/lib/csi-detect-defs.ts` — MasterFormat database constants.
  - `src/lib/csi-colors.ts` — color per division.
  - `src/lib/csi-spatial.ts` (~450 LOC) — `computeCsiSpatialMap(pageNum, textAnnotations, yoloMap?, classifiedTables, ...)`, 3×3 grid + title + margin zones.
  - `src/lib/csi-graph.ts` (~430 LOC) — project-level CSI relationship graph.
  - `src/lib/csi-utils.ts` — shared helpers.
  - `src/lib/csi-spatial-refresh.ts` — recompute after YOLO load.
- **Storage:** `pages.csiCodes` JSONB; `pages.pageIntelligence.csiSpatialMap`; `projects.projectIntelligence.csiGraph`.
- **UI:** `CsiPanel.tsx`, `MapTagsSection.tsx` (embedded in DetectionPanel for auto-CSI), LLM tool `detectCsiFromText`.
- **Auto-CSI plumbing (fully complete 2026-04-19):**
  - `detectCsiCodes` early-return for short text (cheap for bulk saves with empty notes)
  - `src/app/api/annotations/route.ts` + `[id]/route.ts` have a `mergeAutoCsi` helper used in bulk + single POST + PUT branches
  - `src/app/api/takeoff-groups/route.ts` POST + `[id]/route.ts` PUT — fill-when-empty pattern
- **⚠ Server-only import.** `csi-detect.ts` uses `fs`/`path`. Do not import from client components — Turbopack build will fail even though tsc/vitest pass. Use only from route files or server libs.

### 7.7 Composite + table classifiers `[NAV:parser-classifiers]`

- `src/lib/composite-classifier.ts` (~470 LOC) — **Layer 1 of Auto-QTO rebuild.** Unifies YOLO (`tables`/`titleBlocks`/`drawings`) + OCR header keywords + grid detection + parsed regions → spatial exclusion/inclusion zones for takeoff filtering. 18+ files reference it.
- `src/lib/table-classifier.ts` (~265 LOC) — semantic OCR-keyword classifier producing typed tables like `"door-schedule"`. Feeds symbol search / CSI map.
- **No direct API route.** Called internally during `processProject` and by Auto-QTO workflows.

### 7.8 Heuristic engine `[NAV:parser-heuristics]`

- **Core:** `src/lib/heuristic-engine.ts` (~476 LOC). 14 built-in rules (keynote-table, door-schedule, finish-schedule, symbol-legend, general-notes, material-schedule, ...).
- **Modes:** text-only (during auto-processing, no YOLO) vs YOLO-augmented (post-YOLO-load with spatial conditions).
- **Rules are data:** `companies.pipelineConfig.heuristics` JSONB (admin-editable via `/admin → Heuristics`).
- **Storage:** `pages.pageIntelligence.heuristicInferences` JSONB array.

### 7.9 Tag mapping (`map-tags-batch`) `[NAV:parser-map-tags]`

- **API route:** `POST /api/projects/[id]/map-tags-batch`.
- **Core:** `src/lib/tag-mapping/` (see §8 for full subsystem).
- **Consumers:** LLM `mapTagsToPages` tool; QTO engine; UI tag-mapping request; `MapTagsSection.tsx`.

---

## 8. Tag-mapping subsystem `[NAV:tag-mapping]`

Canonical import: `@/lib/tag-mapping` (re-exported from `src/lib/tag-mapping/index.ts`). **Do not deep-import** from `src/lib/tag-mapping/matchers/...`.

### 8.1 Orchestrator — `find-occurrences.ts` (~182 LOC)

`findOccurrences(item: CountableItem, ctx: MatchContext): ScoredMatch[]` at `src/lib/tag-mapping/find-occurrences.ts:171-182`:
1. Dispatch to right matcher based on `item.itemType`
2. For each raw match, `scoreRawMatch` — compose `ScoreSignals`
3. Sort by score descending (ties preserve order)

### 8.2 The 5 matcher types — `matchers/`

| Type | File | Input | Output | Example |
|--:|---|---|---|---|
| 1 | `type1-yolo-only.ts` | YOLO class + scope | All YOLO annotations of that class | "find all CIRCLE annotations" |
| 2 | `type2-text-only.ts` | Text tag (uppercase) + Textract grid | All word sequences matching | "find `D-01`" → all occurrences |
| 3 | `type3-yolo-with-inner-text.ts` | Text + YOLO class | YOLO annotations containing the text (overlap) + free-floating fallback | "circles containing T-05" |
| 4 | `type4-yolo-object-with-tag-shape.ts` | YOLO object class + tag shape class (circle/diamond) | Object annotations with nearby tag shape containing the tag | "door with circle tag" |
| 5 | `type5-yolo-object-with-nearby-text.ts` | YOLO object class + text | Objects with text adjacent (not inside) | "door with D-01 next to it" |

### 8.3 Scoring primitives — `primitives/`

`ScoreSignals` (shape emitted by `scoreRawMatch`):

```typescript
interface ScoreSignals {
  patternMatch: boolean;
  patternStrength: "weak" | "medium" | "strong" | "none";
  windowMatch: boolean;          // hardcoded true at find-occurrences.ts:131
  regionType: "title" | "table" | "drawing" | "unclassified";
  regionWeight: number;          // 0-1 via weightFor(regionType, config)
  shapeContainBoost: number;     // hardcoded 0 at :141
  objectAdjacencyBoost: number;  // hardcoded 0 at :142
  scopeMatch: boolean;
  fuzzy: boolean;                // confidence < 1.0
}
```

Helpers:
- `inferTagPattern(texts)` → regex + confidence (e.g., "T-01, T-02, T-03" → `T-\d{2}` strong)
- `buildScope(isPageScoped, pageNum, allPages)` → scope predicate
- `resolveRegionType(bbox, pageIntelligence)` → one of "title"/"table"/"drawing"/"unclassified"
- `composeScore(signals, config, pageHasDrawings)` → `{score, tier, dropReason}`
- `weightFor(regionType, config)` → 1.0 title, 0.8 table, 0.6 drawing, 0.5 unclassified (defaults)

### 8.4 Signal valve state — as of 2026-04-22

**Valves closed** at `find-occurrences.ts:141-142`:
```typescript
shapeContainBoost: 0,     // not yet produced by matchers; future refinement
objectAdjacencyBoost: 0,  // not yet produced by matchers; future refinement
```

And `windowMatch: true` at `:131` (hardcoded true — "future refinement can thread this from type2-text-only").

**The Discrepancy Engine unlocks by having matchers populate these.** See `featureRoadMap/featureRoadmap.md` for the planned feature.

### 8.5 Consumers

- **LLM tools:** `mapTagsToPages`, `scanYoloClassTexts`, `detectTagPatterns` (`src/lib/llm/tools.ts`).
- **Back-compat shim:** `src/lib/yolo-tag-engine.ts#findItemOccurrences` wraps `findOccurrences` and strips scoring fields for old callers.
- **API route:** `src/app/api/projects/[id]/map-tags-batch/route.ts`.
- **UI:** `MapTagsSection.tsx`, `TagBrowseBar.tsx`.

### 8.6 Tests

`src/lib/tag-mapping/__tests__/` — **187/187 green as of 2026-04-18.** The most thoroughly tested subsystem in the codebase.

---

## 9. LLM subsystem `[NAV:llm]`

Directory: `src/lib/llm/` (10 files, ~1500 LOC total).

### 9.1 Provider abstraction — `index.ts` + `types.ts`

```typescript
interface LLMClient {
  provider: "anthropic" | "openai" | "groq";
  streamChat(options): AsyncIterable<string>;
  streamChatWithTools(options): AsyncIterable<ToolStreamEvent>;
}
```

Implementations:
- `anthropic.ts` (170 LOC) — **full tool-use at `:85-169`**
- `openai.ts` (43 LOC) — stub; returns "Provider does not support tool use" for tool-enabled paths
- `groq.ts` (35 LOC) — stub, same behavior

### 9.2 Tool registry — `tools-defs.ts` (262 LOC) — 20 tools

Client-safe tool definitions. `BP_TOOLS` re-exported from `tools-defs.ts` (not `tools.ts`) so client bundles don't pull `db`/`fs`.

**Data retrieval (10 tools):**
| # | Tool | Line | Purpose |
|--:|---|---|---|
| 1 | `searchPages` | `tools-defs.ts:17` | FTS on page text |
| 2 | `getProjectOverview` | `:28` | Disciplines, trades, CSI graph, summaries |
| 3 | `getPageDetails` | `:36` | pageIntelligence, classifications, text regions, heuristics |
| 4 | `lookupPagesByIndex` | `:47` | O(1) lookup by CSI / trade / keynote / text annotation |
| 5 | `getAnnotations` | `:59` | YOLO detections filtered (page, class, source, confidence) |
| 6 | `getParsedSchedule` | `:72` | Structured table rows + headers |
| 7 | `getCsiSpatialMap` | `:84` | Zone-based CSI heatmap |
| 8 | `getCrossReferences` | `:95` | Sheet-to-sheet graph |
| 9 | `getSpatialContext` | `:105` | OCR text mapped to YOLO regions |
| 10 | `getPageOcrText` | `:116` | Full raw Textract text |

**Processing (1 tool):**
| # | Tool | Line | Purpose |
|--:|---|---|---|
| 11 | `detectCsiFromText` | `:127` | Run CSI detection on arbitrary text |

**YOLO + tags (3 tools):**
| # | Tool | Line | Purpose |
|--:|---|---|---|
| 12 | `scanYoloClassTexts` | `:140` | Find unique OCR texts inside YOLO class |
| 13 | `mapTagsToPages` | `:153` | Find instances of text tags via tag-mapping |
| 14 | `detectTagPatterns` | `:167` | Auto-discover repeating patterns |

**OCR region (1 tool):**
| # | Tool | Line | Purpose |
|--:|---|---|---|
| 15 | `getOcrTextInRegion` | `:175` | Read text in bbox (normalized 0-1) |

**Actions (5 tools):**
| # | Tool | Line | Purpose |
|--:|---|---|---|
| 16 | `navigateToPage` | `:192` | Frontend navigation |
| 17 | `highlightRegion` | `:203` | Pulsing cyan outline |
| 18 | `createMarkup` | `:219` | Create annotation with name + note |
| 19 | `addNoteToAnnotation` | `:236` | Append note to existing annotation |
| 20 | `batchAddNotes` | `:248` | Bulk append to matching annotations |

**Note:** prior docs claimed 23 tools; current count is **20** (verified 2026-04-22).

### 9.3 Tool-use loop — `anthropic.ts:85-169`

```
streamChatWithTools(options):
  maxRounds = options.maxToolRounds ?? 10         // :88
  for round in 0..maxRounds:
    stream = client.messages.stream({ max_tokens: 4096, temperature: 0.3, tools })  // :101-112
    for event in stream:
      content_block_delta text_delta → yield text_delta
      content_block_start tool_use   → yield tool_call_start
    finalMsg = await stream.finalMessage()
    toolUseBlocks = finalMsg.content.filter(b.type === "tool_use")
    if toolUseBlocks.empty OR finalMsg.stop_reason !== "tool_use":
      yield done; return
    for block in toolUseBlocks:
      result = executeToolCall(block.name, block.input)
      yield tool_call_result
    msgHistory.push assistant response + user tool_results
  yield "Reached maximum tool call rounds"; yield done
```

### 9.4 Scoped config — `resolve.ts` (~153 LOC)

`resolveConfig(companyId)` reads from `companies.pipelineConfig.llm`:
- Custom system prompts per company
- Section-specific config (disable certain tools per discipline)
- Domain knowledge injection
- `toolUse` boolean (intentional cost gate, admin-toggleable)

(Note: memory mentions `scoped.ts` at `:98` and `:~446` for tool-use gate + "Provider does not support tool use" error for OpenAI/Groq — current file is named `resolve.ts` in ls output. Verify the filename if this matters for a specific task.)

### 9.5 Streaming — `stream.ts` + `ToolStreamEvent`

```typescript
type ToolStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call_start"; name: string; id: string }
  | { type: "tool_call_result"; name: string; id: string; result: string }
  | { type: "done" };
```

### 9.6 UI entry — `POST /api/ai/chat`

Two scopes: `"global"` (cross-project RAG) and `"scoped"` (single project/page). Messages persisted to `chatMessages` table. Client: `ChatPanel.tsx`.

**Domain knowledge** lives in `domain-knowledge.md` (~80 lines of construction conventions). Currently **injected into tool-use system prompt only** — universal application is pending.

---

## 10. API routes catalog `[NAV:api-catalog]`

91 `route.ts` files under `src/app/api/`. Grouped:

**Auth (4):**
- `POST /api/auth/[...nextauth]` — NextAuth handler
- `POST /api/auth/forgot-password` — request reset
- `POST /api/auth/reset-password` — apply reset
- `POST /api/register` — signup
- `POST /api/invite` — request invite code

**Projects (3):** `GET/POST /api/projects` · `GET/PATCH/DELETE /api/projects/[id]`.

**Pages (7):** `GET /api/projects/[id]/pages` · `GET /api/projects/[id]/thumbnail/[page]` · `POST /api/pages/update` · `GET /api/pages/textract` · `POST /api/pages/textract-rerun` · `POST /api/pages/intelligence` · `POST /api/pages/csi-recompute`.

**Annotations (5):**
- `GET /api/annotations`
- `POST /api/annotations` (auto-CSI via `mergeAutoCsi`)
- `GET/PATCH/DELETE /api/annotations/[id]` (PUT seeds `data` from existing row so note-only edits don't drop codes)
- `POST /api/annotations/batch-delete`

**Annotation groups (4):**
- `GET/POST /api/annotation-groups` (POST auto-detects CSI)
- `GET/PATCH/DELETE /api/annotation-groups/[id]` (PATCH accepts `isActive: boolean`)
- `POST/DELETE /api/annotation-groups/[id]/members`

**YOLO (3):** `POST /api/yolo/run` · `GET /api/yolo/status` · `GET /api/yolo/load`.

**Parsers (8):**
- `POST /api/bucket-fill`
- `POST /api/shape-parse`
- `POST /api/symbol-search`
- `POST /api/table-parse`
- `POST /api/table-parse/propose`
- `POST /api/table-structure`
- `POST /api/csi/detect`
- `GET /api/csi` (CSI config read)

**Tag mapping + QTO (5):**
- `POST /api/projects/[id]/map-tags-batch`
- `POST /api/projects/[id]/classify-regions`
- `GET/POST /api/qto-workflows`
- `GET/PATCH/DELETE /api/qto-workflows/[id]`

**Takeoff (4):**
- `GET/POST /api/takeoff-groups`
- `GET/PATCH/DELETE /api/takeoff-groups/[id]`
- `GET/POST /api/takeoff-items`
- `GET/PATCH/DELETE /api/takeoff-items/[id]`

**Chat (1):** `POST/DELETE /api/ai/chat`.

**Search (2):** `GET /api/search` · `GET /api/search/global`.

**Labeling (4):** `GET/POST /api/labeling/sessions` · `GET/PATCH /api/labeling/sessions/[id]` · `POST /api/labeling/create` · `GET /api/labeling/credentials`.

**S3 (2):** `POST /api/s3/credentials` · `POST /api/s3/staging-credentials` (multi-file upload).

**Processing & health (3):** `GET /api/health` · `POST /api/processing/dev` · `POST /api/processing/webhook` (HMAC + timestamp anti-replay).

**Admin (29):**
- Users: `POST/GET /api/admin/users`, `POST /api/admin/users/reset-password`, `POST /api/admin/password`
- Companies: `GET/POST/PATCH /api/admin/companies`
- Models: `GET/POST /api/admin/models`, `PATCH /api/admin/models/reprocess-csi`
- LLM config: `GET/POST /api/admin/llm-config`, `POST /api/admin/llm-config/test`, `GET /api/admin/llm/config`, `POST /api/admin/llm/preview`
- CSI: `GET /api/admin/csi/config`, `POST /api/admin/csi/upload`
- Heuristics: `GET/PATCH /api/admin/heuristics/config`
- Text annotations: `GET/PATCH /api/admin/text-annotations/config`
- Toggles: `GET/POST /api/admin/toggles`
- Pipeline: `GET/PATCH /api/admin/pipeline`
- App settings: `GET/PATCH /api/admin/app-settings`
- Reprocess: `GET/POST /api/admin/reprocess`, `POST /api/admin/remerge`
- Diagnostics: `GET /api/admin/running-jobs`, `GET /api/admin/recent-parses`, `GET /api/admin/parser-health`, `GET /api/admin/sagemaker-details`, `GET /api/admin/s3-browser`
- YOLO: `GET /api/admin/yolo-status`, `DELETE /api/admin/yolo-purge`
- Invites + demo: `POST /api/admin/invites`, `DELETE /api/admin/demo`, `GET /api/admin/demo/config`

**Demo (unauthed mirror, 8+):** `GET /api/demo/config`, `GET/POST /api/demo/projects`, `GET /api/demo/projects/[id]`, `GET /api/demo/projects/[id]/pages`, `GET/POST /api/demo/chat`, `GET /api/demo/csi`, `GET /api/demo/domain-knowledge`, `GET /api/demo/search`, `GET /api/demo/labeling/sessions`, `POST /api/demo/labeling/credentials`, `POST /api/demo/admin`.

**Route-level helpers.** `src/lib/api-utils.ts` (~286 LOC) provides `requireAuth`, `requireAdmin`, `requireRootAdmin`, `requireCompanyAccess`, `resolveProjectAccess` (scopes: `member`/`admin`/`root`/`demo`), `parseBboxMinMax`, `apiError`. Used in 63+ of 91 routes.

---

## 11. Auth + security `[NAV:auth]`

### 11.1 Strategy — `src/lib/auth.ts` (~288 LOC)

**Providers:**
- **Credentials** — email + bcrypt(passwordHash)
- **Google OAuth** — if `GOOGLE_CLIENT_ID` set. Auto-links by email.

**Session shape:**
```typescript
{ user: {
  email, name, companyId, dbId, username,
  role: "member" | "admin",
  canRunModels: boolean,
  isRootAdmin: boolean,
}}
```

### 11.2 Brute force — `auth.ts:41-79`

In-memory `Map<email, {count, lockedUntil}>`:
- 5+ failures → 15 min lockout
- 10+ failures → 1 hr lockout
- 10-min janitor removes expired entries
- **Not persisted** (resets on restart)

### 11.3 Rate limit — `src/middleware.ts` (~159 LOC)

In-memory `Map<key, {count, resetAt}>`. Table (by `RATE_RULES`):

| Route | Method | Limit | Window | Key |
|---|---|---:|---:|---|
| `/api/register` | POST | 3 | 15m | IP |
| `/api/auth/forgot-password` | POST | 3 | 15m | IP |
| `/api/auth/reset-password` | POST | 5 | 15m | IP |
| `/api/ai/chat` | POST | 30 | 1h | user |
| `/api/yolo/run` | POST | 9999 | 1h | user |
| `/api/projects` | POST | 10 | 1h | user |
| `/api/takeoff-items` | POST | 50 | 1h | user |
| `/api/annotations` | POST | 200 | 1h | user |
| default (all API) | any | 120 | 1m | IP |

### 11.4 Security headers (`middleware.ts:~74-81`)

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `X-XSS-Protection: 1; mode=block`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`

### 11.5 Root admin bootstrap

`auth.ts:~166-173` auto-promotes a logged-in user to `isRootAdmin` if their email matches `ROOT_ADMIN_EMAIL` env. **Compromising that env = instant root admin.**

### 11.6 Known pending

- In-memory brute-force + rate-limit won't scale past 1 ECS replica. Candidate: move to Redis/ElastiCache.
- OAuth **no domain allowlist** (`auth.ts:~215-218` assigns company by email domain). Any `@example.com` user can register if a `example.com` company exists.

---

## 12. Frontend architecture `[NAV:frontend]`

### 12.1 Viewer shell — `PDFViewer.tsx` (687 LOC) `[NAV:viewer-shell]`

Mounts:
1. `ViewerToolbar` (top)
2. `GroupActionsBar` (floats when ≥2 annotations selected)
3. `PageSidebar` (left, collapsible via L584-590)
4. Center canvas stack (L602-624):
   - `PDFPage` (rasterized page image, pdf.js)
   - `AnnotationOverlay` (absolutely positioned canvas; §12.2)
   - `DrawingPreviewLayer` (absolutely positioned; §12.3)
5. Right panels via `ViewerPanels()` at L664-687 — conditionally renders TextPanel, ChatPanel, TakeoffPanel, DetectionPanel, CsiPanel, PageIntelligencePanel, TableParsePanel, KeynotePanel, SpecsNotesPanel, ParsePanel, ToolsPanel, ViewAllPanel.

**Keyboard (`:151-189`):**
- `a` → `setMode("pointer")`
- `v` → if any tool active, temp pan mode; else `setMode("move")`. Release via `vReleasedDuringPanRef`.
- window blur → clear `tempPanMode`.

**Wheel zoom (`:407-456`):** document capture-phase handler.
- Ctrl/Meta + wheel = zoom in any mode
- Plain wheel in `mode="move"` = zoom (trackpad)
- Cursor-centered: adjusts scroll to keep cursor stable during scale change
- Trackpad fine steps (1%) vs mouse wheel (3%)

**Click-drag pan (`:462-510`):** only in `mode="move"` or `tempPanMode`.

**Viewport persistence (`:250-344`):** per-project localStorage via `src/lib/viewer-state.ts` keyed by `publicId`. Restore uses two effects (intent + apply) — the apply effect waits for `restorePageDimensions[targetPage]` populated by PDFPage. Debounced 500 ms save; unmount flush gated by store still having this `publicId`.

**Other effects:**
- PDF load (`:209-248`) — pdf.js async + worker (`/pdf.worker.min.mjs`)
- Textract prefetch (`:64-96`) — lazy, 200 ms debounce
- PNG preload (`:99-111`) — `<link rel="preload" as="image">` for current page
- Adjacent page prefetch (`:114-123`) — next 3 pages via `new Image()`
- LLM highlight scroll (`:126-146`) — smooth scroll to highlighted region
- Container resize observer (`:192-206`) — track width for fit-to-width

### 12.2 Canvas layer — `AnnotationOverlay.tsx` (2581 LOC) `[NAV:canvas]`

#### 12.2.1 Render gate (single source of truth) `[NAV:canvas-render-gate]`

**The three-condition gate at `AnnotationOverlay.tsx:2508-2527` — memorize this.**

```typescript
// :2508  Single source of truth — render-null and pointer-events cannot drift.
// Drift here has caused lasso + markup disappear bugs (group-tool fix 2026-04-19).
const canvasWantsEvents = (
  activeTakeoffItemId !== null ||
  bucketFillActive ||
  calibrationMode !== "idle" ||
  polygonDrawingMode === "drawing" ||
  mode === "markup" || mode === "pointer" || mode === "group" ||
  tableParseStep !== "idle" ||
  keynoteParseStep !== "idle" ||
  symbolSearchActive ||
  splitAreaActive
);
const canvasShouldRender = (
  pageAnnotations.length > 0 ||
  polygonDrawingMode !== "idle" ||
  pendingMarkup !== null ||
  canvasWantsEvents
);
if (!canvasShouldRender) return null;  // :2527
```

Then on the `<canvas>` element:
- **`:2550` `pointerEvents`:** `tempPanMode ? "none" : canvasWantsEvents ? "auto" : "none"`
- **`:2554` `cursor`:** large ternary chain — split / bucket-fill loading / bucket-fill barrier / bucket-fill / symbol / calibration / polygon / takeoff / markup / group / keynote-yolo-picking / yolo-picking / table-or-keynote-parse / pointer / default

**Adding a new canvas mode ⇒ edit ALL of: `canvasWantsEvents` (`:2510-2520`), optionally `canvasShouldRender`, `pointerEvents` (`:2550`), `cursor` (`:2554`).** Forgetting any of the four breaks the tool silently.

#### 12.2.2 Mode table `[NAV:canvas-modes]`

| Mode | Trigger condition | Key handler block | Store fields |
|---|---|---|---|
| Count marker | `activeTakeoffItemId !== null && item.type === "count"` | mouseDown via `drawCountMarker` helper (`:31-99`) | `activeTakeoffItemId`, `takeoffItems`, `hiddenTakeoffItemIds` |
| Area polygon draw | `polygonDrawingMode === "drawing"` | mouseDown `addPolygonVertex()` (`:~1751+`); doubleClick finalize (`:1800-1821`) | `polygonVertices`, `polygonDrawingMode` |
| Bucket fill | `bucketFillActive` | mouseDown `:1289-1410` — client worker path or server fallback | `bucketFillActive`, `bucketFillTolerance`, `bucketFillResolution`, `bucketFillBarriers`, `bucketFillBarrierMode`, `bucketFillLoading`, `bucketFillPreview`, `bucketFillPendingPolygon` |
| Split area | `splitAreaActive` | 2-click define lineA + lineB; `findSplittablePolygons()` auto-detect | `splitAreaActive`, `splitLineA`, `splitLineB`, `splitPreview`, `splitError` |
| Vertex edit | Drag corner of area polygon | mouseDown corner hit detect; mouseMove updates `data.vertices` (not bbox); mouseUp `saveVertexEdit()` | `draggingVertex`, `draggingVertexRef` |
| Polygon markup | `mode === "markup"` + click-drag | mouseDown start rect (`:1521+`); mouseUp open MarkupDialog (`:1645+`); save `:2444-2506` | `mode`, `pendingMarkup`, `markupName`, `markupNote`, `markupCsi` |
| Calibration | `calibrationMode !== "idle"` | mouseDown point1 (`:1226`) then point2 (`:1234`); CalibrationInput dialog | `calibrationMode`, `calibrationPoints`, `scaleCalibrations` |
| Symbol search | `symbolSearchActive` | mouseDown sets template bbox | `symbolSearchActive`, `symbolSearchTemplateBbox` |
| Table parse region | `tableParseStep === "select-region"` | mouseDown drag rectangle (`:1468+`) | `tableParseStep`, `tableParseRegion`, `tableParseColumnBBs`, `tableParseRowBBs` |
| Keynote region + YOLO picking | `keynoteParseStep === "define-column"` + YOLO picking | mouseDown region (`:1425+`); Column A filter | `keynoteParseStep`, `keynoteColumnBBs`, `isKeynoteYoloPicking` |
| Pointer selection | `mode === "pointer"` | mouseDown drag-to-move OR click via `useMultiSelectInteraction()` (`:1546-1609`) | `selectedId`, `selectedAnnotationIds`, `multiSelect` helpers |
| Group tool | `mode === "group"` | mouseDown lasso rect via `useMultiSelectInteraction()` | `mode`, `selectedAnnotationIds` |
| YOLO tag picking | `yoloTagPickingMode` | mouseDown (`:1425`) selects YOLO annotation as keynote class | `yoloTagPickingMode`, `setKeynoteYoloClass` |

#### 12.2.3 Event handlers `[NAV:canvas-handlers]`

- **`handleMouseDown` (`:1221-1792`):** big switch by mode. Keys:
  - Calibration `:1226-1241`
  - Split area `:1244-1287`
  - Bucket fill `:1289-1410`
  - Annotation selection + drag + multi-select `:1412-1609`
  - Table parse region `:1468-1512`
  - Keynote parse region + YOLO picking `:1425-1466`
  - Markup start `:1521-1540`
- **`handleMouseMove` (`:1610-1700`):**
  - Resize corner `:1610-1629`
  - Annotation drag-to-move `:1630-1644`
  - Vertex drag `:1645-1655`
  - Drawing preview updates `_drawEnd` in store `:1656-1670`
  - Mouse position tracking for symbol-search / yolo-picking / barrier-pending `:1671-1700`
- **`handleMouseUp` (`:1701-1792`):**
  - Drag finish → `saveDragPosition()` `:1701-1708`
  - Vertex finish → `saveVertexEdit()` `:1709-1715`
  - Markup finish → open dialog `:1716-1732`
  - Drawing finish → finalize `:1733-1742`
  - Bucket fill preview accept/cancel `:1743-1792`
- **`handleDoubleClick` (`:1800-1821`):** polygon finalize → `saveAnnotation()` or takeoff group selector.

#### 12.2.4 Draw passes `[NAV:canvas-draw-passes]`

- **Loop 1 — BBox rectangles (`:366-471`).** Iterate `pageAnnotations` (visibility-filtered, CSI-filtered, annotation-filtered). Skip area polygons. Draw BBox + label + color-coded stroke. Selected: edit pencil / delete ×, corner handles (except area polygons). Active YOLO tag instances: bright magenta fill + tag color stroke. Visible tag instances (non-active): dashed strokes (red low, amber medium, custom high).
- **Loop 2 — Area polygons (`:650-718`).** Filter `type === "area-polygon"`. Draw vertices path with `ctx.fill("evenodd")` (holes supported for courtyards). Stroke outer + each hole separately. 40% opacity fill from `data.color`.
- **Special renders:**
  - Symbol search matches (`:519-546`) — cyan rect + confidence
  - Table cell structure / TATR overlay (`:553-582`) — solid 1px borders, tinted by cell type
  - LLM highlight (`:584-604`) — dashed cyan + pulsing fill + label
  - Table/keynote tag views (`:607-647`) — blue region highlight + magenta padded tag instances

#### 12.2.5 Key helpers `[NAV:canvas-helpers]`

- `computeRealArea(vertices, pageWidth, pageHeight, calibration)` at `src/lib/areaCalc.ts` (called from `AnnotationOverlay.tsx:~904-917`). Shoelace formula → normalized area → `(normArea × pageW × pageH) / (pixelsPerUnit²)`. **Downstream sqft must flow through this**, not through worker `areaFraction`.
- `prepareBucketFillPolygon` — client worker invocation at `:1384-1410` via `bucket-fill-client.ts:95`.
- `saveAnnotation()` (`:1159-1175`), `saveDragPosition()` (`:1176-1202`), `saveVertexEdit()` (`:1207-1217`), `saveMarkup()` (`:2444-2506`). All use `isSavingRef` to guard against double-dispatch; reset on success.

### 12.3 Drawing preview layer — `DrawingPreviewLayer.tsx` (818 LOC) `[NAV:canvas-preview]`

Separate React tree that subscribes independently to `_drawing`/`_drawStart`/`_drawEnd`/`_mousePos` store fields. `pointerEvents: "none"` so it never intercepts events. Renders:
- Polygon in-progress (vertices + dashed preview edge to mouse)
- Calibration points + ruler line
- Bucket fill preview polygon (+ holes, evenodd)
- Split area lineA / lineB / preview
- Markup rectangle in progress

### 12.4 Zustand store — `viewerStore.ts` (1986 LOC) `[NAV:store]`

Main: `export const useViewerStore = create<ViewerState>(...)` at `:609`.

**17 slice hooks** (all exported; subscribe via `useShallow`):

| Hook | Line | Exposes |
|---|---|---|
| `useNavigation` | `:1675` | `pageNumber`, `numPages`, `mode`, `setPage`, `setMode` |
| `usePanels` | `:1686` | `showTextPanel`, `showChatPanel`, `showTakeoffPanel`, `showDetectionPanel`, `showCsiPanel`, `showViewAllPanel`, `showParsePanel`, `showPageIntelligencePanel`, `showToolsPanel`, `showTableParsePanel`, `showKeynotePanel`, `showSpecsNotesPanel`, `toggleX()` |
| `useSelection` | `:1726` | `selectedAnnotationIds`, `setSelectedAnnotationIds`, `toggleSelection`, `addToSelection`, `clearSelection` |
| `useAnnotationGroups` | `:1737` | `annotationGroups`, `annotationGroupMemberships`, `groupMembers`, `hydrateGroupMemberships`, `addAnnotationToGroup`, `upsertAnnotationGroup` |
| `useDrawingState` | `:1751` | `_drawing`, `_drawStart`, `_drawEnd`, `_mousePos`, setters (used by DrawingPreviewLayer only) |
| `useSymbolSearch` | `:1764` | `symbolSearchActive`, `symbolSearchResults`, `symbolSearchConfidence`, `symbolSearchTemplateBbox`, `dismissedSymbolMatches` |
| `useChat` | `:1792` | `chatMessages`, `chatScope`, `setChatScope` |
| `useTableParse` | `:1803` | `tableParseStep`, `tableParseRegion`, `tableParsedGrid`, `tableParseColumnBBs`, `tableParseRowBBs`, `tableParseMeta` |
| `useKeynoteParse` | `:1832` | `keynoteParseStep`, `keynoteParseRegion`, `keynoteColumnBBs`, `keynoteRowBBs`, `setKeynoteYoloClass`, `parsedKeynoteData` |
| `useProject` | `:1859` | `projectId`, `publicId`, `dataUrl`, `isDemo`, `demoFeatureConfig` |
| `usePageData` | `:1882` | `pageNames`, `pageDrawingNumbers`, `setPageName` |
| `useDetection` | `:1901` | `annotations`, `showDetections`, `activeModels`, `confidenceThreshold`, `hiddenClasses`, `hiddenAnnotationIds`, `toggleDetections` |
| `useYoloTags` | `:1921` | `yoloTags`, `activeYoloTagId`, `yoloTagVisibility`, `yoloTagPickingMode`, `tagScanResults`, `activeYoloTagFilter` |
| `useTextAnnotationDisplay` | `:1940` | `textAnnotations`, `showTextAnnotations`, `activeTextAnnotationTypes`, `textAnnotationColors`, `activeTextAnnotationFilter`, `hiddenTextAnnotations` |
| `useAnnotationFilters` | `:1956` | `activeAnnotationFilter`, `activeCsiFilter`, `activeTradeFilter` |
| `useQtoWorkflow` | `:1969` | `activeQtoWorkflow`, `qtoWorkflows`, `tableCellStructure`, `showTableCellStructure`, `toggleCellHighlight` |
| `useSummaries` | `:1977` | project/page summary arrays, chunk loader state |

**Field categories** (not exhaustive):
- **Navigation & zoom** (`:31-44`): `pageNumber`, `numPages`, `scale`, `setPage`, `zoomIn/Out/Fit`, `pendingCenter`
- **Drawing tools:**
  - Polygon (`:289-294`): `polygonDrawingMode`, `polygonVertices`, `addPolygonVertex`, `resetPolygonDrawing`, `undoLastVertex`
  - Bucket fill (`:296-334`): ...all `bucketFill*` fields + `commitBucketFillToItem`
  - Split area (`:335-356`)
  - Calibration (`:284-288`)
- **Annotations & selection** (`:68-109`): `annotations`, `setAnnotations/addAnnotation/removeAnnotation/updateAnnotation`; `focusAnnotationId` (one-shot); `selectedAnnotationIds`; `annotationGroups` + memberships + `groupMembers`
- **Panels** (`:185-227`): visibility + tabs
- **Filters** (`:198-275`): detection, takeoff items, text annotations, YOLO tags
- **Takeoff data** (`:260-371`): items, groups, undo/redo stacks
- **Drawing intermediate state** (`:555-562`): `_drawing`, `_drawStart`, `_drawEnd`, `_mousePos` (used only by DrawingPreviewLayer)

**Canonical actions** (cross-slice):
- `resetAllTools()` — composes `setMode("move") + resetTableParse + resetKeynoteParse + resetGuidedParse + clearSymbolSearch`. Called on panel close, cancel buttons.
- `focusAnnotationId` — one-shot signal read + clear by `AnnotationOverlay` effect at `:158-163`. Panels set it to "teleport" focus to an annotation.
- `toggleDetections()`, `toggleTextAnnotations()` — master toggles synced across toolbar, DetectionPanel, ViewAllPanel eye.

**Tech debt — `as any` casts.** `(a.data as any)?.type === "count-marker"`, `.vertices`, `.color`, `.confidenceTier`, `.csiCodes` sprinkled throughout `AnnotationOverlay.tsx`. Root cause: `ClientAnnotation.data` is a 5-variant discriminated union and narrowing-by-`data.type` isn't threaded. Known; avoid adding more.

### 12.5 Panels & tabs catalog `[NAV:panels]`

The 56 files in `src/components/viewer/` break into panels (right side), tabs (inside TakeoffPanel / ParsePanel / SpecsNotesPanel / ToolsPanel), overlays (render on canvas area), and utility components.

**Primary panels:**

| Panel | LOC | Store fields | API routes called |
|---|--:|---|---|
| `DetectionPanel.tsx` | 1035 | `annotations`, `showDetections`, `activeModels`, `confidenceThreshold`, `yoloTags`, `activeYoloTagId`, `hiddenClasses` | GET/POST `/api/annotations`; `/api/projects/[id]/map-tags-batch`; nested CSI editor |
| `TakeoffPanel.tsx` | 466 | `takeoffTab`, `takeoffItems`, `takeoffGroups`, `activeTakeoffItemId` | `/api/takeoff-items`, `/api/takeoff-groups` |
| `ChatPanel.tsx` | ~338 | `chatMessages`, `chatScope` | `POST /api/ai/chat` |
| `TextPanel.tsx` | ~338 | `textAnnotations`, `showTextAnnotations`, `activeTextAnnotationTypes` | `GET /api/pages/textract`, `GET /api/search` |
| `CsiPanel.tsx` | ~280 | `allCsiCodes`, `activeCsiFilter` | `GET /api/csi` |
| `PageIntelligencePanel.tsx` | — | `pageIntelligence` | `POST /api/pages/intelligence` |
| `KeynotePanel.tsx` | 1174 | `keynoteParseStep`, `keynoteParseRegion`, `keynoteColumnBBs`, `keynoteRowBBs`, `parsedKeynoteData` | `POST /api/shape-parse`, keynote PUT/GET (via pages) |
| `TableParsePanel.tsx` | — | `tableParseStep`, `tableParseRegion`, `tableParsedGrid`, `tableParseMeta` | `POST /api/table-parse*`, `POST /api/table-structure` |
| `SpecsNotesPanel.tsx` | — | `specsNotesTab` | — (aggregates) |
| `ParsePanel.tsx` | — | `showParsePanel`, `parsePanelTab`, `symbolSearchActive` | `POST /api/shape-parse`, `POST /api/symbol-search` |
| `ToolsPanel.tsx` | — | `toolsPanelTab` | — (aggregates) |
| `SymbolSearchPanel.tsx` | — | `symbolSearchActive`, `symbolSearchResults`, `symbolSearchConfidence` | `POST /api/symbol-search` |
| `ViewAllPanel.tsx` | **1504** | `annotations`, `selectedAnnotationIds`, `annotationGroups`, `showDetections`, + many visibility fields | read-only; binds to canonical toggles |
| `AnnotationPanel.tsx` | ~146 | `annotations`, `focusAnnotationId`, `hiddenAnnotationIds` | delegate to AnnotationListItem |

**Tabs (inside TakeoffPanel):**

| Tab | LOC | Purpose |
|---|--:|---|
| `CountTab.tsx` | ~383 | Count markers (shapes) + instance list |
| `AreaTab.tsx` | 649 | Area polygons, bucket fill controls (including the `maxDimension` 1k/2k/3k/4k slider), split area, instance picker |
| `LinearTab.tsx` | ~300 | Polyline distance measurement |
| `AutoQtoTab.tsx` | 1468 | Auto-QTO wizard — trigger parse, review grid, CSI mapping, toggle cell-structure overlay |

**Tabs (inside ParsePanel):** `AutoParseTab.tsx`, `ManualParseTab.tsx`, `GuidedParseTab.tsx`, `CompareEditTab.tsx`, `MapTagsSection.tsx`, `TagBrowseBar.tsx`.

**Overlays (mount in the canvas area, not in a right panel):**

- `GuidedParseOverlay.tsx` — step-through UI for guided parse
- `KeynoteOverlay.tsx` — region highlight during keynote parse
- `ParseRegionLayer.tsx` — draws table/keynote parse region during definition
- `ParsedTableCellOverlay.tsx` — renders TATR cell boundaries on canvas
- `SearchHighlightOverlay.tsx` — highlights FTS hits
- `TextAnnotationOverlay.tsx` — overlay of text-annotation boxes

### 12.6 Shared UI primitives `[NAV:ui-primitives]`

| Component | LOC | Purpose |
|---|--:|---|
| `AnnotationListItem.tsx` | ~135 | Row in annotation list; expand to edit note/CSI; confidence %; visibility toggle. Used by DetectionPanel, TextPanel, AnnotationPanel. |
| `ClassGroupHeader.tsx` | ~58 | Collapsible group header (e.g., "Door (5 detections)") with model-wide visibility toggle. |
| `TreeSection.tsx` | ~35 | Shared collapsible wrapper (chevron + title + count badge) for ViewAllPanel. Has internal `SubHeader` for deeper nesting. |
| `VisibilityEye.tsx` | ~75 | Shared eye toggle (👁/👁‍🗨 for categories, 👁/— for rows). States: `all-visible`/`all-hidden`/`partial`. Extracted 2026-04-19 from 5+ inline sites (DetectionPanel, ClassGroupHeader, TextPanel, AnnotationListItem, yolo tag row). |
| `MarkupDialog.tsx` | ~100+ | Modal for create/edit annotation or group. Two modes: annotation (name+note+CSI) and group (adds color picker). Used by AnnotationOverlay + GroupActionsBar + ViewAllPanel group-row pencil. |
| `GroupActionsBar.tsx` | ~384 | Floating toolbar when ≥2 annotations selected. Actions: Group (create), Add to existing, Delete, Clear. Calls `/api/annotation-groups` POST/PUT. "Add to existing" rows have ✎ pencil → opens MarkupDialog with Active checkbox. |
| `BucketFillAssignDialog.tsx` | ~261 | Modal to select which takeoff item receives the bucket fill polygon. |
| `CalibrationInput.tsx` | ~160 | Modal for entering real-world distance after 2-point calibration. |
| `ExportCsvModal.tsx`, `TakeoffCsvModal.tsx`, `TableCompareModal.tsx`, `SettingsModal.tsx`, `HelpTooltip.tsx`, `LabelingWizard.tsx`, `EditableGrid.tsx`, `KeynoteItem.tsx`, `ParsedTableItem.tsx`, `TakeoffGroupSection.tsx`, `TakeoffShared.tsx`, `PDFPage.tsx`, `PageSidebar.tsx` | various | Self-explanatory modals, shared building blocks. |

### 12.7 Hooks — `src/hooks/` `[NAV:hooks]`

| Hook | Purpose |
|---|---|
| `useMultiSelectInteraction.ts` | Multi-select logic: lasso rect, shift-click toggle, group-click expansion via `activeGroupIds` memo (2026-04-19 — `groupIdToColor` skips `isActive===false`). Returns handlers used by AnnotationOverlay + GroupActionsBar + ViewAllPanel. |
| `useChunkLoader.ts` | Lazy-load project summary chunks + page ranges beyond current via `/api/projects/[id]/summaries/chunks` |
| `useKeyboardShortcuts.ts` | Global keyboard (inferred; PDFViewer uses `a`/`v`) |
| `useSearch.ts` | Text search via `GET /api/search`; used in TextPanel |
| `useShapeParseInteraction.ts` | Shape parse interaction model for DetectionPanel Shape tab |

### 12.8 Toolbar — `ViewerToolbar.tsx` (630 LOC) `[NAV:toolbar]`

All top-level toggle buttons. Order (left to right, post-2026-04-19):
- Mode group: Move (`v`) / Pointer (`a`) / Markup / Group
- **View All** (violet, moved to left of YOLO 2026-04-19 PM) — opens ViewAllPanel
- **YOLO** (green when showDetections=true, red+"Show All" when false) — toggles `showDetections` via `toggleDetections()`
- Text (toggles `showTextAnnotations`)
- CSI, Detection, Takeoff, Chat, TableParse, Keynote, SpecsNotes, Parse, Tools, PageIntelligence — each toggles its respective panel via `usePanels()`

Master state has 3 synchronized UI surfaces: toolbar button + Panel master toggle + ViewAllPanel sub-section eye. All read/write the same store field. (Applies to `showDetections` + `showTextAnnotations` at minimum.)

---

## 13. Post-processing flows `[NAV:post-processing]`

End-to-end stories. Each is "user action → API → DB/S3 → store update → canvas re-render".

### 13.1 Auto-pipeline done → frontend hydrate

```
SFN marks project status="completed"
  ↓
Frontend polls GET /api/projects/[id] periodically
  ↓ (status flips to "completed")
PDFViewer mounts; fetches page data via GET /api/projects/[id]/pages
  ↓
Fetches annotations via GET /api/annotations?projectId=...
  ↓
Store populated: annotations, pageIntelligence, csiCodes, textAnnotations
  ↓
AnnotationOverlay re-renders, Loop 1 + Loop 2 draw all annotations
```

### 13.2 User runs YOLO

```
User clicks "Run YOLO" (DetectionPanel or admin)
  ↓
POST /api/yolo/run { projectId, modelId }
  → resolveProjectAccess + canRunModels check
  → Validate model access
  → startYoloJob() → SageMaker CreateProcessingJob → returns jobId
  ↓
GET /api/yolo/status { jobId } (client polls)
  ↓ (completes)
POST /api/yolo/load
  → fetch annotations.json from S3
  → INSERT annotations (source:"yolo") in bulk
  → Recompute CSI spatial maps (new YOLO context available)
  ↓
Frontend re-fetches annotations → Store update → canvas re-render
```

### 13.3 User draws a manual area polygon

```
User selects Area tab + (optional) existing takeoff item
  → sets activeTakeoffItemId in store
  ↓
Clicks canvas in AreaTab → polygonDrawingMode="drawing"
  → each click: addPolygonVertex()
  → DrawingPreviewLayer renders in-progress polygon
  ↓
Double-click to finalize
  → computeRealArea(vertices, pageW, pageH, calibration) using scaleCalibrations[pageNumber]
  → POST /api/annotations (source="takeoff", data.type="area-polygon", vertices, areaSqUnits)
  → updateTakeoffItem() with new area
  ↓
AreaTab instance list refreshes with new polygon + area total
```

### 13.4 User creates an annotation group

```
User multi-selects ≥2 annotations (lasso in mode="group" or shift-click)
  → GroupActionsBar appears
User clicks "Group N annotations" → MarkupDialog opens (mode="group" shows color picker)
  ↓
User fills name + color → Save
  → POST /api/annotation-groups { projectId, annotationIds, name, color, csiCode? }
  → Server: detectCsiCodes from member names/notes → merge into response
  ↓
Frontend: upsertAnnotationGroup(group), hydrateGroupMemberships(pairs)
  → Canvas re-renders with colored outline ring on members
  → Click any member → expandSelectionViaGroups() selects all siblings
  → ViewAllPanel tree shows group node with checkboxes
```

### 13.5 Bucket fill (client worker path, post-2026-04-22)

```
User enables bucket-fill in AreaTab → bucketFillActive=true
  ↓
User clicks canvas at seed point
  ↓
AnnotationOverlay.handleMouseDown:
  1. Collect existing polygons + textract words + barriers + barrier mode
  2. Call clientBucketFill() from bucket-fill-client.ts:95:
     - maxDimension passed from store.bucketFillResolution (default 1000)
     - Worker posts ImageBitmap + options
  ↓
Worker (bucket-fill.worker.ts):
  1. Downscale to maxDimension
  2. Otsu threshold
  3. morphClose by dilation px
  4. Burn barriers (user lines) + polygon exclusions
  5. Treat text blocks as walls (post-2026-04-22 — was pre-erase pre-2026-04-22)
  6. Flood fill from seed
  7. Trace contour + find holes (RETR_CCOMP → evenodd)
  8. Simplify polygon
  9. Return { polygon, holes, retryHistory, areaFraction (decorative) }
  ↓
Store bucketFillPreview; overlay renders preview with evenodd fill
  ↓
User accepts → BucketFillAssignDialog → choose takeoff item
  ↓
POST /api/annotations (area-polygon with vertices + holes)
  → computeRealArea(vertices, ..., calibration) updates item total
```

**Server fallback:** if worker fails, `AnnotationOverlay.tsx:~1315` calls `POST /api/bucket-fill` which spawns `scripts/bucket_fill.py`.

### 13.6 Auto-QTO

```
User opens AutoQtoTab → selects an existing qtoWorkflow or creates one
  → POST /api/qto-workflows { ... }
  → POST /api/qto-workflows/[id]/run { pageRange }  (implicit via update)
  ↓
Server pipeline (table-parse → AI parse → CSI map)
  → Updates qtoWorkflows.parsedSchedule JSONB
  → Updates qtoWorkflows.status through stages
  ↓
Frontend polls or server push
  → Tab shows grid (headers, rows), allow inline edits
  → Toggle showTableCellStructure to overlay TATR cell boundaries
  → Swap method results via tableParseMeta
  ↓
User accepts → PUT /api/qto-workflows/[id]  (persist grid)
  → Bulk-create takeoff-items from rows (POST /api/takeoff-items batch)
```

### 13.7 LLM chat with tool-use

```
User types message in ChatPanel → POST /api/ai/chat { projectId, pageNumber?, message, scope }
  ↓
Server: resolveProjectAccess + quota check
  → handleScopedChat / handleGlobalChat
  → Load project intelligence + company-scoped LLM config (resolve.ts)
  → Build system prompt + domain-knowledge (if tool-use enabled)
  → anthropic.ts#streamChatWithTools
    for round in 0..10:
      stream LLM response (yield text_delta live)
      if tool_use blocks:
        executeToolCall(name, input, ctx) → SQL / S3 / tag-mapping
        yield tool_call_result
        loop
      else:
        yield done; return
  ↓
Frontend ChatPanel:
  → Render streaming text
  → Render tool call pills with results (getPageDetails → shows "read page 3")
  → Handle navigate/highlight/createMarkup/addNoteToAnnotation side-effects on canvas
  → Persist chatMessage row
```

---

## 14. Upload flow `[NAV:upload]`

### Multi-file upload (shipped in code 2026-04-19, may not be deployed)

```
User selects ≤30 files (PDF/PNG/JPEG/TIFF/HEIC), ≤500 MB each, ≤2 GB aggregate
  → UploadWidget.tsx (src/components/dashboard/UploadWidget.tsx)
  → Intl.Collator sort
  ↓
POST /api/s3/staging-credentials  (POST to avoid 8 KB CloudFront header cap on GET)
  → quota check via checkUploadQuota
  → returns N presigned POSTs keyed { projectPath }/staging/{idx3}_{safe}
  → extension allowlist enforced
  ↓
Browser: direct XHR POST to each S3 presigned URL
  → per-file progress, aggregate avg
  ↓
POST /api/projects { name, dataUrl, stagingFiles[] }
  → validate every stagingKey.startsWith(`${dataUrl}/staging/`)
  → parallel HeadObject to confirm all exist
  → enforce 2 GB aggregate
  → INSERT projects row with stagingManifest JSONB
  → SFN StartExecution
  ↓
SFN → ECS → process-worker.ts → processProject()
  Stage 0: buildProjectPdf() from stagingManifest
    → mkdtemp → download N files → spawn build_project_pdf.py via runPythonConcat (300s timeout)
    → build_project_pdf.py: fitz.insert_pdf / Pillow exif_transpose + RGB / TIFF iterator / HEIC via pillow_heif.register_heif_opener()
    → 500-page cap; pdf_encrypted error on password-protected
    → output original.pdf with {status, totalPages, fileOffsets}
    → uploadToS3
  Stages 1-19 as normal
  ↓
Frontend polls GET /api/projects/[id]
  → On status="completed", redirect to /projects/[id]/viewer
```

### Legacy single-file upload

Uses `POST /api/s3/credentials` (different endpoint). Single PDF → `{projectPath}/original.pdf`, `stagingManifest = NULL`.

**Infra implication.** Aggregate 2 GB upload → peak RAM ~2.5 GB while buffering final PDF for S3 upload. 2026-04-19 bumped Fargate tier to Performance (4 vCPU / 8 GB) for this reason.

---

## 15. Admin UI `[NAV:admin]`

Directory: `src/app/admin/` + `src/components/admin/`. Total: 29 API routes.

Top-level component: `AdminTabs.tsx`. Tabs (roughly):
1. **Overview** — project stats, user counts, storage usage
2. **Settings** — global config, feature flags
3. **Users** — user mgmt, permissions, company assignments
4. **Companies** — company CRUD, subscription tiers
5. **Projects** — project lifecycle, processing status, reprocess, merge/split
6. **AI Models** — YOLO model registry, confidence overrides
7. **CSI** — CSI code database, trade mapping, auto-detection rules, custom DB upload
8. **LLM Context** — system prompts, context config, BYOK config, provider test
9. **Pipeline** — SFN exec logs, retry, debug mode
10. **RBAC / Recent Parses / Parser Health / Running Jobs / SageMaker** — diagnostics

Key routes (grouped): see §10 "Admin (29)" list. Largest file: `src/app/api/admin/reprocess/route.ts` (~600 LOC).

---

## 16. Module inter-relationships `[NAV:module-graph]`

Simplified import graph at the macro level:

```
scripts/                                infrastructure/
  process-worker.ts ──┐                   terraform/ (config only, not imported)
  *.py (subprocess)   │
                      ▼
src/lib/processing.ts ──────► src/lib/{s3, textract, csi-detect, text-annotations,
         │                       keynotes, page-analysis, heuristic-engine,
         │                       table-classifier, csi-spatial, project-analysis}
         │                                    │
         ▼                                    ▼
src/lib/db/schema.ts                 src/lib/{detectors, tag-mapping, llm}/
         ▲                                    │
         │                                    │
src/app/api/**/route.ts ◄────────── src/lib/api-utils.ts ──► src/lib/auth.ts
         │                                                          │
         ▼                                                          │
src/components/admin/** (admin) ────────────────────────────────────┘
src/components/dashboard/UploadWidget.tsx
src/components/viewer/**  ──────► src/stores/viewerStore.ts
         │
         ▼
src/hooks/**
         │
         ▼
src/workers/bucket-fill.worker.ts (loaded by AnnotationOverlay via bucket-fill-client)
```

**Canonical import rules (enforce when editing):**

1. **Tag-mapping:** always `import { ... } from "@/lib/tag-mapping"`. Never deep-import from `matchers/` or `primitives/`.
2. **LLM tools:** `BP_TOOLS` is re-exported from `src/lib/llm/tools-defs.ts` (client-safe). `src/lib/llm/tools.ts` contains executors (server-only, pulls `db` + `fs`). Importing `tools.ts` into a client component will bundle `db`/`fs` and break the Turbopack build.
3. **CSI detect:** `src/lib/csi-detect.ts` uses `fs`. Never import from client components. OK from route files and other server libs. tsc + vitest pass either way — only Turbopack catches this.
4. **Python ↔ S3:** Python scripts in `scripts/` (except `lambda_handler.py`) **do not** talk to S3. The TS caller handles S3 download, invokes Python with local paths via stdin JSON, reads output file, uploads to S3. Follow the pattern in `src/lib/processing.ts#runPythonConcat:58-112`.
5. **Tempdir pattern:** `mkdtemp(join(tmpdir(), "bp2-xxx-"))` + `finally { rm(tempDir, { recursive: true, force: true }) }`.
6. **Viewer state:** prefer slice hooks (`useDetection`, `useTakeoffs`, `useSelection`, `usePanels`) over individual `useViewerStore(s => s.field)` subscriptions — better re-render scoping.
7. **Visibility flags:** grep `viewerStore.ts` before adding a new one. Bind your UI to canonical fields so the 3 surfaces (toolbar / panel master / ViewAllPanel eye) stay in sync automatically.
8. **Lifecycle reset:** new tools should compose into `resetAllTools()` and plug into `projectId` hook effects for hook-local state; save handlers use `isSavingRef` + reset on success.

---

## 17. Known landmarks + gotchas `[NAV:gotchas]`

The traps most likely to burn a future session.

| # | Trap | Location | Symptom | Note |
|--:|---|---|---|---|
| 1 | **Canvas render gate drift** | `AnnotationOverlay.tsx:2508-2527, :2550, :2554` | Lasso / markup invisible; canvas eats events it shouldn't; canvas dead when it should be live | Any new mode needs all 4 touched simultaneously |
| 2 | **Tag-mapping signal valves shut** | `find-occurrences.ts:141-142` | Discrepancy Engine ideas fall flat with full-score at tier=medium | Open by having matchers populate `shapeContainBoost` / `objectAdjacencyBoost` |
| 3 | **`windowMatch` hardcoded `true`** | `find-occurrences.ts:131` | Multi-word text coherence isn't evaluated | Thread from `type2-text-only.ts` |
| 4 | **In-memory stores don't scale** | `auth.ts:41-79` (brute force), `middleware.ts` (rate limit), `parse-history.ts` (debug ring buffer) | Wrong counts when ECS >1 replica | Move to Redis when scaling |
| 5 | **`as any` on `ClientAnnotation.data`** | `AnnotationOverlay.tsx` throughout | Type safety holes around 5-variant union | Don't add more; narrow-by-`data.type` when the effort is budgeted |
| 6 | **No S3 gateway endpoint** | `vpc.tf` | Fargate S3 I/O goes through NAT (cost) | Existing pipeline works; not blocking |
| 7 | **Drizzle snapshot gap** | `drizzle/meta/` (only 0000 + 0025+ exist) | `db:generate` produces bloated diffs | Rebuild snapshots when it matters |
| 8 | **3-4 GB Docker image** | `Dockerfile` | 8-12 min deploys | Base-image split planned (Dockerfile.base for PyTorch/OpenCV), cuts to ~2 min |
| 9 | **Eslint config crashes** | `eslint.config.mjs` | `JSON.stringify` of circular plugin | Known; direct-import `eslint-config-next/core-web-vitals`, drop `FlatCompat` |
| 10 | **Two bucket-fill implementations** | `workers/bucket-fill.worker.ts` (primary) + `lib/bucket-fill.ts` + `scripts/bucket_fill.py` (fallback) | Divergence between client Otsu and Python adaptive | Worker is canonical; server path is fallback. Future cleanup candidate. |
| 11 | **Host `npm run build` ships Darwin binaries** | any Mac dev | Linux container crashes at runtime | Always build in Docker or CI — not on host |
| 12 | **`focusAnnotationId` is one-shot** | `viewerStore.ts:78-79`, consumed at `AnnotationOverlay.tsx:158-163` | Effect read + clear | Setting again after no change won't fire without clearing first |
| 13 | **OAuth no domain allowlist** | `auth.ts:~215-218` | Any Google user with matching email-domain auto-joins a company | Gate via explicit invites for new domains |
| 14 | **`ROOT_ADMIN_EMAIL` auto-promotion** | `auth.ts:~166-173` | Compromised env = instant root admin | Rotate carefully |
| 15 | **`csi-detect.ts` fs import** | `src/lib/csi-detect.ts` | tsc + vitest pass; Turbopack build fails when imported into client code | Server-only |
| 16 | **Two copies of concurrent fan-out** | `api/symbol-search/route.ts:~262-290` (manual CONCURRENCY=4) + `lib/processing.ts:35-52` (`mapConcurrent`) | Duplicate logic, one could bitrot | Consolidate to `mapConcurrent` |
| 17 | **Takeoff items are project-scoped, not user** | (intentional) | Team collaboration: all users in a company see each other's items on a project. Unexpected for personal projects. |
| 18 | **Zoom centering fragile** | `PDFViewer.tsx:~277-286` | Hardcoded `window.innerWidth * 0.25` + `window.innerHeight * 0.5` | Breaks on short windows or wide pages; fit-to-viewport is the proper fix |
| 19 | **ECS Exec disabled** | (if accidentally turned off) | `root_admin.sh` can't open sessions | Ensure `enableExecuteCommand=true` in the task def |
| 20 | **Webhook anti-replay window ±5 min** | `api/processing/webhook/route.ts` | Clock skew between SFN and ECS matters | `timingSafeEqual` + timestamp window already handled |

---

## 18. Symbol index `[NAV:symbol-index]`

Grep-friendly alphabetical list of load-bearing symbols. Use `grep -rn '\bSYMBOL\b' src/` to expand.

| Symbol | File | Role |
|---|---|---|
| `addAnnotation` | `viewerStore.ts` | Add new annotation to store |
| `analyzePageImageWithFallback` | `src/lib/textract.ts:~315-343` | 3-tier OCR fallback |
| `analyzePageIntelligence` | `src/lib/page-analysis.ts` | Page-level classification |
| `analyzeProject` | `src/lib/project-analysis.ts` | Project rollup |
| `AnnotationOverlay` | `src/components/viewer/AnnotationOverlay.tsx` | Canvas renderer (2581 LOC) |
| `BP_TOOLS` | `src/lib/llm/tools-defs.ts:14` | Client-safe tool registry |
| `bindOcrToShapes` | `src/lib/ocr-shape-binding.ts` | Textract-words → shape bbox |
| `buildProjectPdf` | `src/lib/processing.ts:123-157` | Multi-file concat entry |
| `buildScope` | `src/lib/tag-mapping/primitives/...` | Page-or-project scope |
| `canvasWantsEvents` | `AnnotationOverlay.tsx:2510` | Pointer-events gate |
| `canvasShouldRender` | `AnnotationOverlay.tsx:2521` | Render null gate |
| `checkUploadQuota` | `src/lib/quotas.ts` | Per-company upload quota |
| `classifyTables` | `src/lib/table-classifier.ts` | Classify text regions as tables |
| `classifyTextRegions` | `src/lib/text-region-classifier.ts` | Label regions as table/notes/spec |
| `composeScore` | `src/lib/tag-mapping/primitives/...` | Tag-mapping composite scorer |
| `composite-classifier` | `src/lib/composite-classifier.ts` | Layer 1 Auto-QTO unifier |
| `computeCsiSpatialMap` | `src/lib/csi-spatial.ts` | 3×3 zone heatmap |
| `computeProjectSummaries` | `src/lib/project-analysis.ts` | Chunked summaries |
| `computeRealArea` | `src/lib/areaCalc.ts` | Normalized → real sqft |
| `createMarkup` | LLM tool, `tools-defs.ts:219` | Agentic annotation create |
| `detectCsiCodes` | `src/lib/csi-detect.ts:~294` | Trie keyword matcher |
| `detectTextAnnotations` | `src/lib/text-annotations.ts`, orchestrator at `src/lib/detectors/orchestrator.ts` | 9-detector orchestrator |
| `dispatchMatcher` | `src/lib/tag-mapping/find-occurrences.ts` | Tag-mapping type dispatch |
| `DrawingPreviewLayer` | `src/components/viewer/DrawingPreviewLayer.tsx` | Canvas preview renderer |
| `expandSelectionViaGroups` | `src/hooks/useMultiSelectInteraction.ts` | Click sibling → select all |
| `extractDrawingNumber` | `src/lib/title-block.ts` | Title-block OCR |
| `extractKeynotes` | `src/lib/keynotes.ts` | Shape-parse entry (spawns python) |
| `extractRawText` | `src/lib/textract.ts` | Join Textract lines |
| `fanOutShapeParse` | `src/lib/lambda-cv.ts` | Lambda shape-parse fan-out |
| `fanOutTemplateMatch` | `src/lib/lambda-cv.ts` | Lambda template-match fan-out |
| `findItemOccurrences` | `src/lib/yolo-tag-engine.ts` | Legacy shim over findOccurrences |
| `findOccurrences` | `src/lib/tag-mapping/find-occurrences.ts:171` | 5-type tag-matching orchestrator |
| `findSplittablePolygons` | (helper, AnnotationOverlay) | Split-area detector |
| `focusAnnotationId` | `viewerStore.ts` | One-shot focus signal |
| `getAnnotations` | LLM tool, `tools-defs.ts:59` | Filter YOLO + markups |
| `getEffectiveRules` | `src/lib/heuristic-engine.ts` | Merge company + built-in rules |
| `getPageOcrText` | LLM tool, `tools-defs.ts:116` | Full Textract text |
| `getPdfPageCount` | `src/lib/pdf-rasterize.ts` | Count pages without rasterizing |
| `getProjectOverview` | LLM tool, `tools-defs.ts:28` | Disciplines + csiGraph + summaries |
| `getS3Url` | `src/lib/s3.ts` | CloudFront URL builder |
| `GroupActionsBar` | `src/components/viewer/GroupActionsBar.tsx` | Floating bulk-action bar |
| `handleMouseDown` | `AnnotationOverlay.tsx:1221-1792` | Master mode dispatch |
| `handleMouseMove` | `AnnotationOverlay.tsx:1610-1700` | Drag + preview update |
| `handleMouseUp` | `AnnotationOverlay.tsx:1701-1792` | Finalize |
| `handleScopedChat` | `src/app/api/ai/chat/route.ts` | Scoped LLM chat |
| `headS3Object` | `src/lib/s3.ts` | Direct S3 HEAD (bypass CF 404-cache) |
| `hydrateGroupMemberships` | `viewerStore.ts` | Seed group memberships map |
| `inferTagPattern` | `src/lib/tag-mapping/primitives/...` | Regex + strength |
| `isLambdaCvEnabled` | `src/lib/lambda-cv.ts:~46` | Lambda CV feature flag |
| `isSavingRef` | AnnotationOverlay | Double-dispatch guard |
| `keynoteParse*` fields | `viewerStore.ts` (`useKeynoteParse`) | Keynote parse workflow state |
| `lookupPagesByIndex` | LLM tool, `tools-defs.ts:47` | O(1) index lookup |
| `mapConcurrent` | `src/lib/processing.ts:35-52` | Worker-pool concurrency limiter |
| `mapTagsToPages` | LLM tool, `tools-defs.ts:153` | Find text-tag instances |
| `mergeAutoCsi` | `src/app/api/annotations/route.ts` | Merge detected CSI on insert |
| `MarkupDialog` | `src/components/viewer/MarkupDialog.tsx` | Name/note/CSI modal |
| `PDFViewer` | `src/components/viewer/PDFViewer.tsx` | Viewer shell |
| `processProject` | `src/lib/processing.ts:165-605` | Auto pipeline entry |
| `rasterizePage` | `src/lib/pdf-rasterize.ts` | PDF page → PNG |
| `resetAllTools` | `viewerStore.ts` | Composed tool reset |
| `resolveConfig` | `src/lib/llm/resolve.ts` | Company LLM config resolver |
| `resolveProjectAccess` | `src/lib/api-utils.ts` | Scope: member/admin/root/demo |
| `runHeuristicEngine` | `src/lib/heuristic-engine.ts` | Apply 14 rules |
| `runPythonConcat` | `src/lib/processing.ts:58-112` | build_project_pdf.py subprocess |
| `saveAnnotation` | `AnnotationOverlay.tsx:1159-1175` | POST /api/annotations |
| `saveDragPosition` | `AnnotationOverlay.tsx:1176-1202` | PUT bbox after drag |
| `saveMarkup` | `AnnotationOverlay.tsx:2444-2506` | Create or edit markup from dialog |
| `saveVertexEdit` | `AnnotationOverlay.tsx:1207-1217` | PUT bbox + vertices after vertex drag |
| `scoreRawMatch` | `src/lib/tag-mapping/find-occurrences.ts` | Signal + composed scoring |
| `streamChatWithTools` | `src/lib/llm/anthropic.ts:85-169` | Full tool-use loop |
| `tagMapping` (dir) | `src/lib/tag-mapping/` | 5-type matcher subsystem |
| `TextractPageData` | `src/types/index.ts` | Textract OCR result shape |
| `toggleDetections` | `viewerStore.ts` | Master YOLO show/hide |
| `useChunkLoader` | `src/hooks/useChunkLoader.ts` | Lazy chunk loader |
| `useKeyboardShortcuts` | `src/hooks/useKeyboardShortcuts.ts` | Keyboard global |
| `useMultiSelectInteraction` | `src/hooks/useMultiSelectInteraction.ts` | Lasso + shift-click + expand |
| `useShapeParseInteraction` | `src/hooks/useShapeParseInteraction.ts` | Shape parse interaction |
| `ViewAllPanel` | `src/components/viewer/ViewAllPanel.tsx` | Unified selection tree (1504 LOC) |
| `viewerStore` | `src/stores/viewerStore.ts:609` | Main Zustand store |
| `warmCloudFrontCache` | `src/lib/s3.ts` | Post-pipeline CDN warm |
| `weightFor` | `src/lib/tag-mapping/primitives/...` | Region → weight |
| `withRetry` | `src/lib/llm/anthropic.ts:6-21` | Exp-backoff on 429 |
| `yolo-tag-engine` | `src/lib/yolo-tag-engine.ts` | Legacy shim |
| `yoloTagPickingMode` | `viewerStore.ts` (`useYoloTags`) | YOLO-class selection mode |

---

## 19. Related docs `[NAV:related-docs]`

Other files in `featureRoadMap/` worth knowing about:

| Doc | What it is |
|---|---|
| `aiQTOroadmap.md` | 4-phase product roadmap (parity → signature → agentic → community) |
| `featureRoadmap.md` | Signature features catalog (Shape Search, Discrepancy Engine, etc.) |
| `tableSteaksFeatureRoadmap.md` | Parity catch-up backlog |
| `PROCESSING_PIPELINE.md` | 972-line detailed pipeline exec order (this doc's §6 is the condensed version) |
| `tag_mapping_refactor_plan.md` | Phase plan for 5-type matcher (all shipped) |
| `note_suite_4layer_plan.md` | 4-layer note classifier (in progress; Stage 0 Keynote Manual+Auto DB-PATCH shipped 2026-04-23) |
| `bp_designflow_discussion.md` | Design / UX notes |
| `img2tablediscussion.md` | Table-parse method tradeoffs |
| `lambda_symbol_search_plan.md` | Lambda CV rollout plan (Phases A-D; D partially done) |
| `plan_csi_reactivity_and_multiselect.md` | CSI filter UX |
| `phase_b_polish.md` | Polygon label + hierarchical view plan |
| `debug_and_vector_methods_plan.md` | Vector PDF debug + method tuning |
| `vector_topology_research_sketch.md` | Sketch for vector-topology graph |
| `forward_plan_2026_04_21.md` | Near-term roadmap |
| `currentstate_april116.md` | Older lite bootstrap (~200 lines) — this doc is the deeper successor |
| `session_2026_04_{15..23}_*.md` | Session logs (changelog-style, newest first) — read latest when getting oriented |

---

## 20. How to extend `[NAV:extend]`

Recipes for the 6 most-common extension tasks. Each lists the exact files to touch. Validate end-to-end before declaring done.

### 20.1 Add a new canvas tool mode

1. **Store — `src/stores/viewerStore.ts`:**
   - Add fields: e.g., `myToolActive: boolean`, `myToolState: {...}`
   - Add setters
   - Add to appropriate slice hook (or create `useMyTool` slice near line 1680)
   - Add into `resetAllTools` composition
2. **Canvas — `src/components/viewer/AnnotationOverlay.tsx`:**
   - Add mode to `canvasWantsEvents` at `:2510-2520` (if the tool needs canvas events)
   - Add render condition to `canvasShouldRender` at `:2521-2526` (if the tool should force-render the canvas when inactive selections exist)
   - Add branch to `handleMouseDown` at `:1221+`
   - Add branch to `handleMouseMove` at `:1610+` if live preview needed
   - Add branch to `handleMouseUp` at `:1701+` for finalize
   - Add cursor expression case at `:2554`
3. **Preview — `DrawingPreviewLayer.tsx`** if live preview needed. Read `_drawStart`/`_drawEnd`/etc. from store.
4. **Panel UI** — new `MyToolPanel.tsx` or tab in existing panel; wire Activate button to `setMyToolActive(true)`.
5. **Toolbar** — add button in `ViewerToolbar.tsx` if top-level.
6. **Save handler** — new `saveMyTool()` with `isSavingRef` guard + reset on success.
7. **Test** — start dev server, enter mode, draw, save, verify DB + re-render.

### 20.2 Add a new visibility filter

1. `viewerStore.ts` — add `activeMyFilter: ...`, `setMyFilter()`. Reuse an existing slice hook if possible (§12.4).
2. `AnnotationOverlay.tsx` — add condition to the `pageAnnotations` filter memo.
3. Panel UI — checkbox/dropdown wired to `setMyFilter()`. Reuse `VisibilityEye` for eye toggles.
4. Verify: show/hide flows via toolbar + panel + ViewAllPanel eye, all three synced.

### 20.3 Add a new side panel

1. Create `src/components/viewer/MyPanel.tsx`. Subscribe via slice hooks, not individual fields.
2. `viewerStore.ts` — add `showMyPanel`, `toggleMyPanel()` to the `usePanels` slice.
3. `PDFViewer.tsx` `ViewerPanels()` at `:664-687` — add `{showMyPanel && <MyPanel />}`.
4. `ViewerToolbar.tsx` — add toggle button.
5. If the panel drives canvas drawing, also add to `canvasWantsEvents` (§12.2.1).

### 20.4 Add a new parser

1. **API route** — `src/app/api/my-parser/route.ts` with `requireAuth` + `resolveProjectAccess`.
2. **Core lib** — `src/lib/my-parser.ts` with any subprocess / AWS service call.
3. **Python script** (if native) — `scripts/my_parser.py` following tempdir + stdin JSON pattern (§16 rule 4).
4. **DB** — add column or JSONB field (new drizzle migration). If per-page, reuse `pages.pageIntelligence` blob.
5. **Pipeline hook** (if auto) — insert new stage in `processing.ts`, gated by `disabledSteps.has("my-parser")` pattern. Feature-flag via `companies.pipelineConfig`.
6. **UI consumer** — new panel or tab; fetch results from API route.
7. **Lambda fan-out variant** (if heavy) — follow `src/lib/lambda-cv.ts` + add case to `scripts/lambda_handler.py`.
8. **Admin/debug** — optional: add row to `/admin/parser-health` or `/admin/recent-parses`.

### 20.5 Add a new LLM tool

1. **Definition** — `src/lib/llm/tools-defs.ts` — add entry in `BP_TOOLS` array with `name`, `description`, `input_schema`. (Client-safe file.)
2. **Executor** — `src/lib/llm/tools.ts` — add `execMyTool(input, ctx)` + case to the switch in `executeToolCall`. OK to import `db` / `fs` here — server-only.
3. **Tool context** — if a new context field is needed, extend `ToolContext` in `src/lib/llm/types.ts`.
4. **Scoped config** — optional: gate tool availability per-company in `src/lib/llm/resolve.ts`.
5. **Frontend action handler** — if the tool is an action (like `createMarkup`), also wire a client-side handler in the `ChatPanel.tsx` tool-result handler.
6. Test via `POST /api/ai/chat` with a prompt that would trigger the tool.

### 20.6 Debug a pointer event not firing

In order, check:

1. `canvasShouldRender` at `AnnotationOverlay.tsx:2521-2527` — is it `false`? Canvas returns `null` → no events at all.
2. `canvasWantsEvents` at `:2510-2520` — is it `false`? Canvas has `pointerEvents: "none"` → events pass through.
3. `tempPanMode` — if true, canvas is force-disabled (`:2550`).
4. `mode` value — does it match the branch you think it does in `handleMouseDown`?
5. Console.log at the top of `handleMouseDown` to confirm it fires at all.
6. `getPos(e)` coordinate transform — if `cssScale !== 1`, coordinates divide by it.
7. `z-index` — DrawingPreviewLayer is above; it must have `pointerEvents: none` or it'll eat events.
8. `onMouseLeave` at `:2537-2543` — if a state like `dragging` is set, ensure it's cleared.

### 20.7 Find where a store field is used

```bash
# By slice hook
grep -rn '\buseDetection\b' src/

# By individual field (may have aliased selectors)
grep -rn '\bshowDetections\b' src/

# By setter
grep -rn '\btoggleDetections\b' src/
```

---

*End of `BPArchitecture_422.md`. Cross-references: `currentstate_april116.md` (lite bootstrap), `PROCESSING_PIPELINE.md` (detailed pipeline), session logs in `featureRoadMap/session_*.md`.*
