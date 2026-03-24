# BlueprintParser 2 — Current State (March 24, 2026)

## Session Summary
Focused on bug fixes, keynote extraction reliability, YOLO admin panel, and QTO improvements. Multiple deploys throughout the session. Ended with YOLO inference running on SageMaker for the first time.

## Changes Made This Session

### Bug Fixes
1. **Chat — Groq lazy init** (`src/app/api/ai/chat/route.ts`)
   - Moved Groq client from module-level to per-request `getGroqClient()` — fixes 401 errors when env vars aren't available at module load time (Secrets Manager timing)
   - Better error messages (returns actual Groq error, not generic "Chat failed")

2. **Chat — SSE streaming buffer** (`src/components/viewer/ChatPanel.tsx`)
   - Fixed data loss across chunk boundaries by buffering incomplete SSE messages

3. **QTO Takeoff — Migration journal** (`drizzle/meta/_journal.json`)
   - Added missing entries for `0003_add_takeoff_items` and `0004_add_audit_log`
   - Tables now created on container start

4. **QTO Takeoff — Error feedback** (`src/components/viewer/TakeoffPanel.tsx`)
   - Added inline error display, loading state on Create button
   - Users now see actual API errors instead of "nothing happens"

5. **QTO Takeoff — Marker placement** (`src/components/viewer/AnnotationOverlay.tsx`)
   - Fixed canvas rendering gate: was returning null when no annotations existed on page
   - Added `activeTakeoffItemId === null` check so canvas renders in takeoff mode

6. **QTO — Button visibility** (`src/components/viewer/TakeoffPanel.tsx`)
   - "+ Add Count Item" button uses chat-pulse animation when no items exist

### Zoom & UI
7. **Smooth zoom** (`PDFViewer.tsx`, `PDFPage.tsx`, `viewerStore.ts`)
   - Zoom factor: 0.85 → 0.95 (~5% per tick instead of ~18%)
   - Wheel throttle: 30ms between events
   - Debounce: 150ms → 80ms for faster re-render

8. **Renamed "Move" → "Pan"** (`ViewerToolbar.tsx`)

### Keynote Extraction (Major)
9. **Tiling architecture** (`scripts/extract_keynotes.py`)
   - Images > 4000px downscaled to 50% before tiling
   - 1200px tiles with 150px overlap
   - Per-tile extraction with coordinate remapping
   - IOU-based deduplication for overlapping tile boundaries
   - Skip OCR in tiled mode (avoids Tesseract crashes)
   - Per-keynote OCR try/catch for non-tiled mode

10. **Diagnostic logging** (`src/lib/keynotes.ts`, `src/lib/processing.ts`)
    - Full stderr passthrough from Python
    - Per-page keynote count logging
    - Error logging with exit code and stderr

11. **Explicit Tesseract path** (`scripts/extract_keynotes.py`)
    - `pytesseract.tesseract_cmd = '/usr/bin/tesseract'` for Alpine containers

12. **Buffer increase** (`src/lib/keynotes.ts`)
    - maxBuffer: 10MB → 50MB for large keynote JSON output

### YOLO Admin Panel
13. **Presigned S3 upload** (`src/lib/s3.ts`, `src/app/api/admin/models/route.ts`, `src/app/admin/page.tsx`)
    - Model .pt files upload directly to S3 via presigned POST (no more timeout)
    - Progress bar during upload
    - Split into: presign → S3 upload → register in DB

14. **Polling cleanup** (`src/app/admin/page.tsx`)
    - Intervals stored in ref, cleared on unmount
    - No more memory leaks from orphaned polling

15. **Error handling** (`src/app/admin/page.tsx`)
    - Load results response checked (detection count shown)
    - S3 retry with 3s + 5s delays for eventual consistency
    - Failure reason from SageMaker displayed
    - Color-coded status (red/green/blue)

16. **Run route specificity** (`src/app/api/yolo/run/route.ts`)
    - Distinct errors: "Failed to download PDF" / "Failed to rasterize" / "Failed to start SageMaker"

### Infrastructure
17. **Groq secret in Terraform** (`secrets.tf`, `ecs.tf`, `iam.tf`, `variables.tf`, `outputs.tf`)
    - `beaver/GROQ_API_KEY` in Secrets Manager, wired to ECS task definition

18. **ECS task role — SageMaker permissions** (`iam.tf`)
    - Added CreateProcessingJob, DescribeProcessingJob, StopProcessingJob + PassRole

19. **ALB timeout** (`ecs.tf`)
    - idle_timeout: 60s default → 300s

20. **Confidence input fix** (`src/app/admin/page.tsx`)
    - `step="0.05"` → `step="any"` (browser validation issue)

### Scripts & Tooling
21. **update_secret.py** (`scripts/update_secret.py`)
    - Universal secret rotation: .env.local + terraform.tfvars + Secrets Manager + ECS restart
    - Supports any secret, validates known keys (Groq, Anthropic)
    - Flags: `--local-only`, `--no-restart`

22. **YOLO load fix** (`src/app/api/yolo/load/route.ts`)
    - Root cause: `creator_id` NOT NULL in production DB
    - Bypassed Drizzle with raw `pg` for bulk insert reliability
    - Added "Load" button to admin panel for manual result loading
    - 1,143 detections loaded successfully on first real test

23. **Open source plan** (`plans/opensource_plan.md`)
    - Comprehensive audit of open-source readiness
    - Two deployment paths: local Docker / AWS
    - Checklist for git history cleanup, parameterization, documentation

## Current Architecture
```
Client: React 19 + Zustand + pdfjs-dist + Tailwind CSS 4
API:    Next.js 16 App Router (25+ routes)
DB:     PostgreSQL 16 + Drizzle ORM (13 tables)
Auth:   NextAuth 5 (credentials)
AWS:    ECS Fargate (8 vCPU / 16GB), Step Functions, S3 + CloudFront, Textract, SageMaker
ML:     YOLO models via SageMaker Processing Jobs (ml.g4dn.xlarge GPU)
LLM:    Groq (llama-3.3-70b-versatile) via Secrets Manager
IaC:    Terraform (11 files, S3 backend)
```

## What's Deployed & Working
- PDF upload/processing with tiled keynote extraction
- Full-text search with word-level highlighting
- CSI code detection with orange-yellow highlights
- Keynote detection with colored shape overlays (tiled, downscaled)
- Manual annotations (draw, resize, move, delete)
- AI chat (Groq streaming, page/project scope)
- QTO count takeoff (create items, place markers, CSV export)
- Admin panel (user management, model upload with progress, YOLO job runner)
- Demo mode (public read-only viewer)
- Smooth zoom with cursor-anchored scrolling

## YOLO Status
- First real inference job running: `beaver-yolo-yolo-shapes-1774317889575` (InProgress)
- Model: yolo_shapes (16 classes)
- Project: harvard_medium (15 pages)
- Results will auto-load as annotations when job completes

## Additional Changes (Late Session)

23. **YOLO load fix** — `creator_id` NOT NULL in production, bypassed Drizzle with raw pg for bulk insert
24. **"Load" button** on admin panel for manual YOLO result loading
25. **YOLO detection context in chat** — LLM now sees detection counts/classes per page
26. **Project rename** — double-click name on dashboard to edit inline
27. **Demo chat enabled** — unauthenticated users can chat on demo projects (500/day global pool)
28. **Per-company quotas** — chat changed from per-user to per-company; uploads role-based (admin 10, member 3)
29. **Demo back button** → `/demo` instead of `/home`
30. **Demo page count** — counts actual page rows instead of projects.numPages
31. **.dockerignore** — exclude .terraform (~300MB), models (~390MB), tfvars (secrets)
32. **Security audit** — completed, findings documented, cost attack vectors addressed with per-company quotas
33. **Landing page** — "Try Demo (Coming Soon)" → active "Try Demo" link

## Pending Deploy
All above changes are coded but need `./deploy.sh` to go live.

## Known Issues / Next Session
- **QTO rename** — "Count" → "QTO" with submenu: "Takeoff EA" (count) + "Takeoff Area" (polygon)
- **Area/polygon QTO tool** — Phase 2 of QTO (scale calibration, shoelace formula)
- **QTO performance** — marker placement/movement feels slow and janky
- **Demo polish** — test full demo experience end-to-end
- **Keynote text** — tiled mode skips OCR (returns empty text). Could match with Textract data later.
- **Processing progress** — "0/X pages" gets stuck during processing, needs intermediate status updates
- **Open source prep** — secrets in git history, hardcoded account IDs, missing docs

## Monthly AWS Costs
~$155/mo baseline + $15 per 1000 pages + SageMaker GPU costs (~$0.75/hr when running)
