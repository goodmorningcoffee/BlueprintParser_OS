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

## What's Left — Shape Parse UI (3 Modes)

The shape-parse API route now supports 3 modes but the **DetectionPanel UI** only has the first two wired up. Need to add "Scan All Pages" button.

### Current Shape Tab UI (DetectionPanel.tsx)
- Located in the YOLO/Detection panel under the "Shape" tab
- Has: "Run Shape Parse" button that calls `runShapeParse()` with current page
- Has: BB region draw mode (click "Draw Region" → draw bbox → "Scan Region")
- Has: Results list grouped by shape type, clickable filter, save button
- Missing: "Scan All Pages" button + project-wide results display

### Planned 3 Modes
1. **BB mode** (existing) — draw a region → scan shapes in that region only
2. **Page mode** (existing) — scan full current page (no region)
3. **All Pages mode** (NEW) — `scanAll: true` → Lambda fan-out → results for every page

### UI Plan for All Pages Mode

**Button**: Add a third button next to the existing "Scan Page N" button:
```
[ Scan Page 3 ] [ Draw Region ] [ Scan All Pages ▶ ]
```
"Scan All Pages" only enabled when `LAMBDA_CV_ENABLED` or always available (sequential fallback exists).

**Progress**: Show "Scanning page X of N..." during all-pages scan.

**Results**: When `scanAll` returns `byPage`, store keynotes for ALL pages in the zustand `keynotes` store (currently `Record<number, KeynoteShapeData[]>`). The KeynoteOverlay already renders per-page — it will automatically show shapes on every page as the user navigates.

**Response handling**: The API returns `{ keynotes, byPage }`. The `byPage` object maps page numbers to their keynotes. Store each page's keynotes:
```typescript
const data = await res.json();
for (const [pn, shapes] of Object.entries(data.byPage)) {
  setKeynotes(Number(pn), shapes);
}
```

**Save**: The existing save button saves current page keynotes. For all-pages, we'd need a "Save All" that batches across pages. Could be a follow-up — users can navigate page-by-page and save each.

### Files to Modify
- `src/components/viewer/DetectionPanel.tsx` — add "Scan All Pages" button + handler + progress
- `src/stores/viewerStore.ts` — possibly add a `shapeParseAllLoading` state (or reuse `shapeParseLoading`)

### No New Files Needed
The API route and Lambda orchestrator are already complete.
