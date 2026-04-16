# Session 2026-04-16 — Lambda CV Pipeline

## What Was Built This Session

### Phase A — Lambda Infrastructure (COMPLETE)

All deployed and working on AWS.

| File | Status | Description |
|------|--------|-------------|
| `Dockerfile.lambda` | CREATED | Python 3.11-slim + awslambdaric + OpenCV + Tesseract. ~400MB image. |
| `scripts/lambda_handler.py` | CREATED | Dual-mode handler: `template_match` + `shape_parse`. Downloads pages from S3, calls existing Python functions, uploads results JSON. |
| `deploy-lambda.sh` | CREATED | ECR login → build → push → create/update Lambda. Follows deploy-yolo.sh pattern. |
| `setup-lambda-iam.sh` | CREATED | One-time: creates Lambda execution role + adds lambda:InvokeFunction to ECS task role. |
| `.deploy.env` | MODIFIED | Added ECR_CV_REPO, LAMBDA_FUNCTION_NAME, LAMBDA_ROLE_ARN |
| `.deploy.env.example` | MODIFIED | Same, plus ECS_TASK_ROLE |
| `infrastructure/terraform/lambda.tf` | CREATED | OS template: Lambda function + ECR repo + IAM role + CloudWatch logs |
| `infrastructure/terraform/iam.tf` | MODIFIED | Added lambda:InvokeFunction to ECS task role |
| `infrastructure/terraform/ecr.tf` | MODIFIED | Added 4th ECR repo (cv-lambda) + lifecycle policy |
| `infrastructure/terraform/outputs.tf` | MODIFIED | Added Lambda ARN + ECR URL outputs |
| `infrastructure/terraform/s3.tf` | MODIFIED | Added lifecycle rule expiring tmp/cv-jobs/ after 1 day |
| `infrastructure/terraform/ecs.tf` | MODIFIED | Added LAMBDA_CV_ENABLED + LAMBDA_CV_FUNCTION_NAME env vars |
| `.env.local` | MODIFIED | Added LAMBDA_CV_ENABLED=false, LAMBDA_CV_FUNCTION_NAME |
| `.env.example` | MODIFIED | Added Lambda CV env vars |

### Phase B — OCR-Shape Binding (COMPLETE)

| File | Status | Description |
|------|--------|-------------|
| `src/lib/ocr-shape-binding.ts` | CREATED | Binds Textract words to detected shapes (inside → nearest → none). Reuses bbox-utils.ts helpers. |

### Phase C — Symbol Search Lambda Integration (COMPLETE)

| File | Status | Description |
|------|--------|-------------|
| `package.json` | MODIFIED | Added @aws-sdk/client-lambda |
| `src/lib/lambda-cv.ts` | CREATED | Fan-out orchestrator: partition pages → invoke Lambdas in parallel (Promise.allSettled) → retry failures → collect results from S3 → cleanup. Exports `isLambdaCvEnabled()`, `fanOutTemplateMatch()`, `fanOutShapeParse()`. |
| `src/app/api/symbol-search/route.ts` | MODIFIED | Added Lambda path before local path. When LAMBDA_CV_ENABLED=true: upload template to S3, build page key list, fan out, stream batch progress. Falls back to local Python on failure. |

### Phase D — Shape Parse All-Pages Route (COMPLETE, UI NOT DONE)

| File | Status | Description |
|------|--------|-------------|
| `src/app/api/shape-parse/route.ts` | MODIFIED | Added `scanAll: true` mode. When set: queries all pages from DB, fans out via Lambda (or sequential fallback). Returns `{ keynotes, byPage: Record<number, KeynoteShapeData[]> }`. |

### Bug Fix

| File | Status | Description |
|------|--------|-------------|
| `src/components/viewer/DetectionPanel.tsx` | MODIFIED | Shape parse save button: added "Cannot save in demo mode" error, loading spinner, success feedback, console.error logging. Was silently failing in demo mode. |

### Key Technical Decisions

1. **Dockerfile.lambda uses `python:3.11-slim` + `awslambdaric`** (not official Lambda base image). Reason: tesseract installs at `/usr/bin/tesseract` via apt-get, matching the hardcoded path in extract_keynotes.py.

2. **Lambda handler imports Python scripts directly** (`from template_match import process_target`), no subprocess. `process_target()` first arg is a numpy array (not file path) — handler does `cv2.imread(path, IMREAD_GRAYSCALE)` first.

3. **Bbox formats**: template_match returns LTWH `[x,y,w,h]`, shape parse returns MinMax `[left,top,right,bottom]`. Lambda preserves native formats. Orchestrator converts as needed.

4. **Terraform is OS template only** — live infra deployed via CLI scripts (deploy-lambda.sh, setup-lambda-iam.sh). Terraform files updated for open-source completeness.

5. **Feature flag**: `LAMBDA_CV_ENABLED` checked in orchestrator (`lambda-cv.ts`), not in routes. Fallback to local Python on flag=false or Lambda failure.

---

## Shape Parse UI (3 Modes) — IMPLEMENTED

All 3 modes are fully implemented:
1. **BB mode** — draw a region → scan shapes in that region only ✅
2. **Page mode** — scan full current page (no region) ✅
3. **All Pages mode** — `scanAll: true` → Lambda fan-out → results for every page ✅

Button layout: `[ Scan Page 3 ] [ BB ] [ All ]`
- "All" button triggers `runShapeParseAll()` → `POST /api/shape-parse { scanAll: true }`
- Uses `setBatchKeynotes(data.byPage)` for single atomic store update
- Save page + Save all pages buttons both implemented
- Admin Pipeline tab toggle + reprocess scope both implemented
- Shape parse during upload wired into processing.ts (gated by disabledSteps)

## OCR-Tag Binding — IMPLEMENTED

- Shared helpers extracted to `ocr-utils.ts`: `findWordsInBbox`, `sortWordsReadingOrder`, `findNearestWord`
- `ocr-shape-binding.ts` rewritten to use shared helpers
- `yolo-tag-engine.ts` updated to use same helpers
- Binding wired into shape-parse route (returns `boundText` per shape)
- Binding wired into symbol-search route (both Lambda and local paths)

## Code Dedup — IMPLEMENTED

- `lambda-cv.ts`: generic `fanOut<T>()` with `resultMapper` callback (307→240 lines)
- `lambda_handler.py`: generic `process_pages(event, worker_fn)` (227→160 lines)

## Still Deferred

- Symbol Search as 4th tab in DetectionPanel (keeping floating panel for now)
- Unified Shape Schema (Phase E from original plan)
- Dockerfile.lambda USER directive (minor security hardening)
