# BlueprintParser 2 — Current State (March 23, 2026 End of Day)

## What We Built Today

### Session Summary
Started the day with the core app deployed (Phases 1-5: viewer, OCR, search, chat, annotations). Ended with a significantly more complete product — quantity takeoff, YOLO inference pipeline, security hardening, and performance optimizations.

### Changes Made Today (in order)

**1. Terraform moved to blueprintparser_2**
- Copied `infrastructure/terraform/` from `BlueprintParser_old` into `blueprintparser_2`
- All infra now lives in one repo

**2. YOLO Inference Docker Container**
- `Dockerfile.yolo` — Python 3.10-slim + PyTorch (CUDA 11.8) + ultralytics
- `scripts/yolo_inference.py` — Standalone inference script for SageMaker Processing Jobs
  - Reads config.yaml for thresholds (confidence, IoU, image size)
  - Loads model once, processes all pages in batch
  - Outputs `{"detections": [...]}` per page (matches load route's expected format)
  - Writes `_manifest.json` summary
- `deploy-yolo.sh` — Build and push to `beaver-yolo-pipeline` ECR repo
- **Status:** Image built (after fixing GPG and libgl1 issues). Not yet tested end-to-end with SageMaker.

**3. Chat Button Animation**
- `src/app/globals.css` — Added `@keyframes chat-pulse` (20s cycle through dark blue-grey tones)
- `ViewerToolbar.tsx` — Chat button uses `chat-pulse` class when inactive

**4. Processing Pipeline Speed-Up**
- `src/lib/processing.ts`:
  - Single 300 DPI rasterization per page (was rasterizing twice: 200 DPI + 300 DPI)
  - Concurrency bumped from 10 → 20 pages in parallel
  - Thumbnail generated before parallel loop
- `infrastructure/terraform/ecs.tf` — CPU pipeline task bumped to 8 vCPU / 16 GB
- **Estimated improvement:** ~50% faster (52 pages in ~30s instead of ~60s)

**5. Dashboard Bug Fixes**
- **Delete projects:** Added `processingJobs` to cascade delete (was causing FK constraint error)
- **Upload failure:** Wrapped Step Functions start in try/catch (was leaving projects stuck at "uploading")
- **Page count showing 0:** Projects GET now counts actual pages from DB instead of stale `numPages` column
- **Poll interval:** 5s → 2s for faster progress updates
- **Progress query:** Now counts pages with textract_data OR error (not just textract_data)
- **Stale project cleanup:** `entrypoint.sh` marks projects stuck >1 hour as "error" on startup

**6. CSI Division Highlighting**
- `SearchHighlightOverlay.tsx` — When a CSI filter is active, scans Textract words for matching phrases and draws orange-yellow highlight boxes
- Search highlights changed from pale yellow to **magenta**

**7. Keynote Filter Highlighting**
- `KeynoteOverlay.tsx` — When a keynote filter is active, matching keynotes get bright magenta ring + thicker stroke. Non-matching keynotes dimmed to 25% opacity.

**8. Quantity Takeoff (Count Feature)**
- **Schema:** New `takeoff_items` table (id, projectId, name, shape, color, sortOrder)
- **Types:** `TakeoffShape`, `ClientTakeoffItem`, `CountMarkerData`; extended `ClientAnnotation` with `data` field
- **Store:** `showTakeoffPanel`, `takeoffItems[]`, `activeTakeoffItemId` with full CRUD
- **API:** `/api/takeoff-items` (GET/POST) + `/api/takeoff-items/[id]` (PUT/DELETE)
- **Annotations POST:** Now accepts `source` and `data` fields
- **Project GET:** Returns `takeoffItems` array + annotation `data` field
- **TakeoffPanel.tsx:** Right sidebar with:
  - Item list (shape icon SVG + name + count + page count)
  - Click to activate → crosshair cursor → click blueprint to place markers
  - Inline create form (name + 5 shapes + 20-color swatch grid)
  - Double-click to rename, delete button per item
  - CSV export (client-side Blob download)
- **AnnotationOverlay.tsx:**
  - Count markers render as filled shapes (circle/square/diamond/triangle/cross) at 10px radius
  - Fixed pixel size regardless of zoom
  - Click-to-place with optimistic add + API persist
  - Hit testing at 14px radius for selection
  - Escape deactivates takeoff item
- **ViewerToolbar:** "Count" toggle button (green when active)
- **AnnotationPanel:** Filters out `source === "takeoff"` from regular groups
- **Migration:** `drizzle/0003_add_takeoff_items.sql` (not yet applied to prod DB)

**9. Security Hardening**
- **Rate limiting middleware** (`src/middleware.ts`):
  - 3 registrations/15min, 5 logins/15min per IP
  - 30 chats/hr, 5 YOLO jobs/hr, 10 uploads/hr per user
  - 200 annotations/hr, 50 takeoff items/hr per user
  - General: 120 req/min per IP
  - Security headers: X-Frame-Options DENY, nosniff, HSTS, XSS protection
- **Brute force protection** (`src/lib/auth.ts`):
  - 5 failed logins → 15 min lockout
  - 10 failed logins → 1 hour lockout
  - Clears on successful login
- **JWT expiry:** 30 days → 1 day
- **Cost quotas** (`src/lib/quotas.ts`):
  - 20 uploads/day per company
  - 10 YOLO jobs/day per company
  - 100 chat messages/day per user
- **Registration hardening:**
  - Password: 10 chars minimum + uppercase + number required
  - Access key: bcrypt comparison support (backward compatible with plaintext)
  - Generic error messages (no user/key enumeration)
- **Role escalation fix:** Admin user creation hardcoded to "member" role
- **Upload limit:** S3 presigned POST 1 GB → 100 MB
- **Webhook replay protection:** Timestamp validation (reject >5 min old)
- **Audit logging** (`src/lib/audit.ts`):
  - `audit_log` table + fire-and-forget insert
  - Logs: login success/failure, registration, project delete, YOLO job start
  - Migration: `drizzle/0004_add_audit_log.sql`

**10. Cost Control TUI**
- `scripts/cost-control.sh` — Interactive terminal dashboard:
  - Toggle SageMaker on/off (IAM deny policy)
  - Toggle Step Functions on/off
  - Scale ECS (0 = offline)
  - View recent SageMaker jobs
  - Emergency shutdown (kills everything, requires "SHUTDOWN" confirmation)
  - Restore all services
- `scripts/sagemaker-killswitch.sh` — Simple on/off/status for SageMaker

**11. Graceful Degradation for Unmigrated DB**
- Project GET and DELETE wrapped `takeoffItems` queries in try/catch
- Prevents crashes when `takeoff_items` / `audit_log` tables don't exist yet

---

## Current Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Client (React 19)                   │
│  PDFViewer → AnnotationOverlay, KeynoteOverlay,     │
│              SearchHighlightOverlay                  │
│  Panels → TextPanel, ChatPanel, TakeoffPanel        │
│  State → Zustand store (viewerStore.ts)             │
│  Dashboard → ProjectGrid, UploadWidget, Admin       │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│              API Layer (Next.js 16)                   │
│  25 routes: auth, projects, search, annotations,    │
│  chat, takeoff-items, YOLO, admin, demo             │
│  Middleware: rate limiting + security headers        │
│  Quotas: upload/YOLO/chat daily limits              │
│  Audit: login, register, delete, YOLO events        │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│              AWS Infrastructure                      │
│  ECS Fargate: beaver-app (2 vCPU / 4 GB, always-on)│
│  ECS Task: cpu-pipeline (8 vCPU / 16 GB, on-demand)│
│  Step Functions: orchestrates processing             │
│  SageMaker: YOLO GPU inference (g4dn.xlarge)        │
│  RDS: PostgreSQL 15 (db.t3.medium)                  │
│  S3 + CloudFront: PDF storage + CDN                 │
│  ECR: beaver-app + beaver-yolo-pipeline images      │
└─────────────────────────────────────────────────────┘
```

## Database Tables (13)
companies, users, user_api_keys, projects, pages, annotations, chat_messages, sessions, processing_jobs, models, takeoff_items, audit_log + pages.search_vector (tsvector)

## YOLO Models (in `models/` directory)
- `yolo_precise.pt` (131 MB) — 2 classes: door_single, door_double
- `yolo_medium.pt` (131 MB) — 7 classes: doors, tables, drawings, text_box, title_block, symbol_legend
- `yolo_primitive.pt` (131 MB) — 16 classes: geometric shapes (circles, rectangles, triangles, etc.)

---

## What's Working (Deployed & Tested)
- PDF upload + processing (Textract OCR, 300 DPI, 20 concurrent pages)
- Page viewer with zoom/pan
- Full-text search with word-level highlighting (magenta)
- CSI code detection + division filtering + word highlighting (orange)
- Keynote extraction + click-to-filter + match highlighting (magenta ring)
- Annotation drawing/move/resize/delete
- LLM chat (Groq/Llama 3.3 70B) with page and project scope
- Admin panel (users, models, demo toggle)
- Dashboard with project grid, thumbnails, content search
- Demo mode at `/demo`
- Delete projects (with FK cascade fix)

## What's Built But Not Yet Deployed/Tested
- **Quantity takeoff** — code complete, needs DB migration (`0003`, `0004`) + deploy
- **Security hardening** — middleware, brute force, quotas, audit logging — needs deploy
- **YOLO inference** — Docker image built, needs end-to-end test (upload model → run → load results)
- **Cost control TUI** — scripts ready, needs testing against live AWS

## What's Planned (Not Started)
- **Area tracing** — polygon drawing, scale calibration, area calculation (plan at `plans/quantity-takeoff.md`)
- **Local Docker mode** — self-hosted with MinIO + Tesseract, no AWS required (plan at `plans/local-docker-mode.md`)
- **Open source prep** — remove credentials, setup script, README, `.env.example`
- **PDF download button**
- **BYOK API key management** (schema exists, UI not built)
- **Smooth zoom** (CSS transition on scale transform)

---

## Files Changed Today (by area)

### New Files (12)
- `src/middleware.ts` — Rate limiting + security headers
- `src/lib/quotas.ts` — Daily cost quotas
- `src/lib/audit.ts` — Audit logging helper
- `src/components/viewer/TakeoffPanel.tsx` — Takeoff sidebar
- `src/app/api/takeoff-items/route.ts` — Takeoff CRUD
- `src/app/api/takeoff-items/[id]/route.ts` — Takeoff item update/delete
- `scripts/yolo_inference.py` — SageMaker inference script
- `scripts/cost-control.sh` — Cost control TUI
- `scripts/sagemaker-killswitch.sh` — SageMaker on/off
- `Dockerfile.yolo` — GPU inference image
- `deploy-yolo.sh` — YOLO image deploy script
- `drizzle/0003_add_takeoff_items.sql` + `drizzle/0004_add_audit_log.sql`

### Modified Files (16)
- `src/lib/db/schema.ts` — Added takeoff_items + audit_log tables
- `src/types/index.ts` — Added TakeoffShape, ClientTakeoffItem, CountMarkerData; extended ClientAnnotation
- `src/stores/viewerStore.ts` — Added takeoff state (panel, items, active item)
- `src/lib/auth.ts` — Brute force protection, JWT 1 day, audit logging
- `src/lib/processing.ts` — Single 300 DPI, concurrency 20
- `src/lib/s3.ts` — Upload limit 100 MB
- `src/app/api/projects/route.ts` — Upload quota, actual page counts, SFN try/catch
- `src/app/api/projects/[id]/route.ts` — Cascade delete (processingJobs, takeoffItems), audit, data field
- `src/app/api/annotations/route.ts` — Accept source + data fields
- `src/app/api/yolo/run/route.ts` — YOLO quota + audit
- `src/app/api/ai/chat/route.ts` — Chat quota
- `src/app/api/register/route.ts` — Stronger passwords, hashed access keys, generic errors, audit
- `src/app/api/admin/users/route.ts` — Role hardcoded to member
- `src/app/api/processing/webhook/route.ts` — Timestamp replay protection
- `src/components/viewer/AnnotationOverlay.tsx` — Count marker rendering + placement
- `src/components/viewer/ViewerToolbar.tsx` — Count toggle button
- `src/components/viewer/PDFViewer.tsx` — TakeoffPanel wired in
- `src/components/viewer/AnnotationPanel.tsx` — Filter out takeoff markers
- `src/components/viewer/SearchHighlightOverlay.tsx` — CSI highlights + magenta search
- `src/components/viewer/KeynoteOverlay.tsx` — Active filter highlighting
- `src/app/globals.css` — Chat pulse animation
- `src/app/(dashboard)/home/page.tsx` — 2s poll interval
- `src/app/(dashboard)/project/[id]/page.tsx` — Hydrate takeoff items
- `entrypoint.sh` — Stale project cleanup on startup
- `infrastructure/terraform/ecs.tf` — CPU pipeline 8 vCPU

---

## Tomorrow's Priorities
1. **Deploy & test** — Run `./deploy.sh` to push all changes, verify takeoff + security work
2. **Run DB migrations** — `0003` (takeoff_items) + `0004` (audit_log) apply on startup
3. **Test YOLO end-to-end** — Upload models via admin, run on a project, verify detections appear
4. **Set up demo** — Mark 3-5 projects as demo, verify `/demo` page works
5. **Cost control testing** — Run `./scripts/cost-control.sh`, toggle SageMaker on/off
6. **Open source prep** if time — credential cleanup, `.env.example`, README

## Estimated Monthly AWS Costs
| Service | Cost |
|---------|------|
| ECS app (always-on, 2 vCPU/4 GB) | ~$99/mo |
| RDS PostgreSQL (db.t3.medium) | ~$50/mo |
| S3 + CloudFront | ~$5-10/mo |
| Textract (per page processed) | ~$0.015/page |
| SageMaker YOLO (on-demand) | ~$0.50/job |
| Step Functions | ~$0.025/execution |
| **Total baseline** | **~$155/mo** |
| **+ processing 1000 pages/mo** | **+$15** |
