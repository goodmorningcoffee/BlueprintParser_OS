# BlueprintParser

Open-source AI-powered construction blueprint analysis platform. Self-hostable QTO (Quantity Takeoff) tool with OCR, object detection, LLM chat, and annotation — designed as a scaffold for construction companies to deploy internally.

**Live demo**: [blueprintparser.com/demo](https://blueprintparser.com/demo)

---

> **WARNING: DO NOT run `deploy.sh`, `deploy-yolo.sh`, or `terraform apply`.**
>
> These scripts deploy to a LIVE production environment on a shared AWS account. Running them will overwrite the running application, database, and infrastructure. If you want to test locally, use `docker compose up -d && npm run dev` (see Local Development below). Talk to the team before touching anything in `infrastructure/` or running any deploy commands.
>
> **This repo contains live credentials.** Keep it private. Files with secrets:
> - `infrastructure/terraform/terraform.tfvars` — DB password, API keys (Groq, Anthropic), NextAuth secret, webhook secret
> - `.env.local` — Groq API key, S3 bucket name
> - `deploy.sh` / `deploy-yolo.sh` — Hardcoded AWS account ID, ECR repo names, ECS cluster/service names
> - `src/lib/yolo.ts` — Fallback AWS account ID
>
> These will be cleaned up before open-source release. For now, do not fork publicly or share outside the team.

---

## System Architecture

```
                                 +------------------+
                                 |   CloudFront     |
                                 |  (assets CDN)    |
                                 +--------+---------+
                                          |
+-------------+    HTTPS    +-------------+-----------+    S3     +------------------+
|   Browser   +------------>+   ALB (TLS termination) +---------->+  beaver-data-*   |
|  (pdf.js +  |             +-------------+-----------+           |  (PDFs, thumbs,  |
|   Zustand)  |                           |                       |   YOLO results)  |
+-------------+                           v                       +------------------+
                            +-------------+-----------+
                            |   ECS Fargate (2vCPU)   |
                            |   Next.js 15 + API      |
                            |   Ghostscript + Tesseract|
                            +--+--------+----------+--+
                               |        |          |
                  +------------+   +----+----+   +-+-----------+
                  |                |         |   |             |
                  v                v         v   v             v
           +------+------+  +-----+---+ +---+---+--+  +-------+--------+
           |  RDS PG 16  |  | Textract| | Secrets  |  | Step Functions  |
           |  (13 tables)|  | (OCR)   | | Manager  |  | (orchestrator)  |
           +-------------+  +---------+ +----------+  +-------+--------+
                                                               |
                                                               v
                                                    +----------+---------+
                                                    | ECS Task (8vCPU)   |
                                                    | CPU Processing     |
                                                    | (Ghostscript +     |
                                                    |  Textract + OpenCV)|
                                                    +--------------------+

                                                    +--------------------+
                                                    | SageMaker GPU      |
                                                    | ml.g4dn.xlarge     |
                                                    | (YOLO inference)   |
                                                    +--------------------+
```

---

## Processing Pipeline

PDF upload triggers a Step Functions state machine that orchestrates an ECS Fargate task:

```
Upload PDF ──> S3
                │
                v
        Step Functions ──> ECS Task (8 vCPU / 16 GB)
                              │
                              ├── 1. Ghostscript: PDF ──> PNG per page (300 DPI)
                              ├── 2. Textract: PNG ──> word-level bboxes + raw text
                              ├── 3. Title block: regex + position scoring ──> drawing number
                              ├── 4. CSI detection: phrase matching against 2800-row TSV db
                              ├── 5. Keynote extraction: OpenCV + Tesseract (tiled)
                              │       ├── Images > 4000px downscaled
                              │       ├── 1200px tiles, 150px overlap
                              │       ├── Connected components ──> contour detection
                              │       ├── Shape classification + OCR per shape
                              │       └── IOU deduplication (threshold 0.5) across tiles
                              ├── 6. tsvector generation for full-text search
                              └── 7. Webhook callback ──> update project status

        Concurrency: 20 pages in parallel per project
        Typical: 52 pages in ~30 seconds
```

---

## Database Schema (13 tables)

```
companies ──┬──> users ──┬──> sessions
             │            ├──> user_api_keys
             │            ├──> annotations (source: user|yolo|takeoff|takeoff-scale)
             │            └──> chat_messages
             │
             └──> projects ──┬──> pages (rawText, textractData, keynotes, csiCodes, search_vector)
                              ├──> annotations (polymorphic via source + data jsonb)
                              ├──> takeoff_items (shape: circle|square|...|polygon)
                              ├──> processing_jobs
                              └──> chat_messages (page-scoped or project-scoped)

models ──> (YOLO model registry, s3Path + config jsonb)
audit_log ──> (action, userId, companyId, details jsonb, ip)
```

Key design: **annotations are polymorphic**. The `source` column discriminates type, and `data` jsonb holds type-specific payloads:

| source | data.type | Payload |
|--------|-----------|---------|
| `user` | — | Manual markup rectangle |
| `yolo` | — | YOLO detection with confidence |
| `takeoff` | `count-marker` | `{ shape, color, takeoffItemId }` |
| `takeoff` | `area-polygon` | `{ vertices: [{x,y}...], areaSqUnits, unit, color, takeoffItemId }` |
| `takeoff-scale` | `scale-calibration` | `{ point1, point2, realDistance, unit }` |

All coordinates normalized 0-1. No migrations needed for new annotation types.

---

## API Surface (25 routes)

| Method | Route | Auth | Purpose |
|--------|-------|------|---------|
| POST | `/api/auth/[...nextauth]` | Public | NextAuth credentials login |
| POST | `/api/register` | Public | User registration (requires company access key) |
| GET/POST | `/api/projects` | User | List / create projects |
| GET/PUT/DELETE | `/api/projects/[id]` | User | Project CRUD |
| POST | `/api/annotations` | User | Create annotation (any source) |
| PUT/DELETE | `/api/annotations/[id]` | User | Update / delete annotation |
| GET/POST | `/api/takeoff-items` | User | List / create takeoff items |
| PUT/DELETE | `/api/takeoff-items/[id]` | User | Update / delete (cascades to annotations) |
| GET | `/api/search?projectId&q` | User | Full-text search (tsvector + ts_rank + ts_headline) |
| GET | `/api/search/global?q` | User | Cross-project search |
| POST | `/api/ai/chat` | User | Streaming SSE chat (Groq, page/project scope) |
| POST | `/api/yolo/run` | Admin | Start SageMaker processing job |
| GET | `/api/yolo/status` | Admin | Poll job status |
| POST | `/api/yolo/load` | Admin | Load YOLO results from S3 into annotations |
| GET/POST/DELETE | `/api/admin/models` | Admin | YOLO model registry CRUD |
| GET/POST/DELETE | `/api/admin/users` | Admin | User management |
| POST | `/api/admin/demo` | Admin | Toggle project demo visibility |
| GET | `/api/demo/projects` | Public | List demo projects |
| GET | `/api/demo/projects/[id]` | Public | Get demo project (read-only) |
| POST | `/api/s3/credentials` | User | Presigned POST for direct browser upload |
| GET | `/api/health` | Public | Health check |

---

## Frontend Rendering Pipeline

The viewer is a layered canvas system on top of pdf.js:

```
PDFViewer (container, scroll, zoom)
  └── PDFPage (renders PDF via pdf.js canvas)
        ├── SearchHighlightOverlay (magenta word boxes from tsvector matches)
        ├── KeynoteOverlay (colored shape outlines from OpenCV detection)
        └── AnnotationOverlay (interactive canvas)
              ├── User markups (rectangles with labels)
              ├── YOLO detections (rectangles, confidence-filtered)
              ├── Count markers (filled shapes at fixed 10px radius)
              ├── Area polygons (filled + stroked, area label at centroid)
              ├── Calibration line (amber dots + dashed line)
              └── Drawing state (in-progress polygon with preview fill + snap indicator)
```

**Coordinate system**: All overlays use normalized 0-1 coordinates. The canvas matches the PDF page's CSS pixel dimensions, so `(0.5, 0.5)` always maps to the center regardless of zoom. Zoom is handled via CSS `transform: scale()` for instant feedback, with debounced canvas re-render at the target resolution.

**State management**: Single Zustand store (`viewerStore.ts`, ~50 state fields) holds all viewer state: page navigation, zoom, annotations, search, chat, takeoff items, calibration, polygon drawing state machines. No prop drilling — all components subscribe directly.

---

## QTO (Quantity Takeoff) System

### Count (Takeoff EA)
- User creates named items with shape + color (5 shapes, 20 colors)
- Click on blueprint to place markers — stored as annotations with `source: "takeoff"`, `data.type: "count-marker"`
- Markers render at fixed pixel size regardless of zoom
- TakeoffPanel shows per-item counts with page breakdown

### Area (Takeoff Area)
- **Scale calibration**: click two known-distance points, enter real measurement. Stored per-page as annotation. Math: `pixelsPerUnit = sqrt(dx_px^2 + dy_px^2) / realDistance`
- **Polygon drawing**: click to place vertices, click first point to close (15px snap radius), Enter to close, double-click to close. Preview fill + first-point glow indicator during drawing
- **Area calculation**: shoelace formula on normalized vertices, then `realArea = normalizedArea * pageWidth * pageHeight / pixelsPerUnit^2` (accounts for page aspect ratio)
- Stored as annotation: `data.type: "area-polygon"` with `vertices[]`, `areaSqUnits`, `unit`
- TakeoffPanel recomputes areas live from vertices + calibration (never trusts stored values)

### Demo mode
- `isDemo` flag in Zustand store — set by demo page, checked before every API call
- All QTO operations work locally (temp IDs, no fetch). Each browser tab is independent (Zustand is per-instance)

### Export
- CSV with both count and area items: `Item Name, Type, Shape, Color, Quantity, Unit, Pages`

---

## Security Model

| Layer | Implementation |
|-------|---------------|
| Auth | NextAuth 5 credentials provider, bcrypt passwords, JWT (24hr expiry) |
| Brute force | 5 failures = 15min lockout, 10 = 1hr lockout, per IP |
| Rate limiting | In-memory Map in middleware, per-endpoint limits (auth: 3-5/15min, chat: 30/hr, YOLO: 5/hr, general: 120/min) |
| Multi-tenancy | All queries scoped by `companyId` FK. Registration requires company access key |
| Quotas | Per-company daily limits: uploads (3 member / 10 admin), YOLO (5), chat (200), demo chat (500 global) |
| Secrets | AWS Secrets Manager, injected via ECS task definition. Rotation via `scripts/update_secret.py` |
| Webhooks | HMAC-SHA256 + timestamp validation (reject > 5min old) |
| Audit | Fire-and-forget logging to `audit_log` table (login, registration, create/delete, YOLO, password changes) |
| Headers | `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin` |

---

## Infrastructure (Terraform)

11 Terraform files managing:

| Resource | Config |
|----------|--------|
| VPC | 10.0.0.0/16, 2 public + 2 private subnets, NAT gateway |
| ECS Fargate | 2 vCPU / 4 GB app service, 8 vCPU / 16 GB processing tasks, auto-scaling 1-4 |
| ALB | HTTPS with ACM cert, HTTP redirect, 300s idle timeout, circuit breaker rollback |
| RDS | PostgreSQL 16 db.t4g.medium, 50GB gp3, encrypted, 7-day backups, Multi-AZ in prod |
| S3 + CloudFront | Versioned bucket, OAC, CORS response headers policy, CachingOptimized |
| ECR | 3 repos (app, cpu-pipeline, yolo-pipeline), lifecycle policies |
| Step Functions | Blueprint processing orchestrator with retry/catch |
| SageMaker | Processing jobs for YOLO (ml.g4dn.xlarge GPU, on-demand) |
| IAM | 4 roles with least-privilege policies, no wildcards |
| Secrets Manager | 5 secrets with 7-day recovery window |

Estimated: ~$155/month baseline. SageMaker GPU ~$0.75/hr on-demand.

---

## Local Development

Prerequisites: Node.js 20+, Docker

```bash
docker compose up -d          # PostgreSQL on port 5433
npm install
cp .env.example .env.local    # Edit: DATABASE_URL, NEXTAUTH_SECRET
npx drizzle-kit migrate
npm run dev                   # http://localhost:3000
```

Works without AWS credentials — PDF viewing, annotations, QTO, search all functional. For full pipeline: add `GROQ_API_KEY` (chat), AWS credentials (Textract, S3, SageMaker).

---

## Tech Stack

| | |
|-|-|
| **Runtime** | Next.js 15 (App Router), React 19, TypeScript 5 |
| **State** | Zustand (single store, ~50 fields) |
| **Rendering** | pdf.js (PDF), HTML5 Canvas (overlays), CSS transform zoom |
| **Database** | PostgreSQL 16, Drizzle ORM, 5 migrations |
| **Auth** | NextAuth 5 (credentials), bcrypt, JWT |
| **AI** | Groq SDK (llama-3.3-70b), streaming SSE |
| **CV** | OpenCV (keynotes), Tesseract (OCR), YOLOv8/ultralytics |
| **Infra** | Terraform, ECS Fargate, S3/CloudFront, RDS, SageMaker, Step Functions |
| **Containers** | Node 20 Alpine + Ghostscript + Tesseract (app), Python 3.10 + PyTorch CUDA 11.8 (YOLO) |

---

## Key Design Decisions

**QTO is data labeling.** Count markers are bounding boxes. Area polygons are segmentation masks. The annotation table is polymorphic (same as CVAT/Label Studio's approach). This means the same infrastructure that powers manual QTO can later accept model predictions — upload a trained segmentation model, run inference, get area polygons automatically.

**Normalized coordinates everywhere.** All annotations stored as 0-1 ratios. Rendering multiplies by current canvas dimensions. Zoom-independent, DPI-independent, resolution-independent.

**No migrations for new features.** The `data` jsonb column on annotations absorbs new annotation types without schema changes. Count markers, area polygons, scale calibrations, and YOLO detections all share one table.

**Tiled processing for reliability.** Large blueprints (7200x5400px at 300 DPI) would OOM Tesseract. Tiling with overlap + IOU deduplication handles arbitrary sizes.

**Optimistic UI everywhere.** All mutations add to Zustand immediately with temp negative IDs, then persist async. Demo mode skips persistence entirely — same UX, zero API calls.

---

## License

MIT
