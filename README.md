# BlueprintParser

Open-source AI-powered construction blueprint analysis. Upload PDFs, extract text, detect symbols, chat with AI, and run quantity takeoff — all self-hostable.

**Live demo**: [blueprintparser.com/demo](https://blueprintparser.com/demo)

---

> **WARNING: DO NOT run `deploy.sh`, `deploy-yolo.sh`, or `terraform apply`.**
>
> These scripts deploy to a LIVE production environment on a shared AWS account. Running them will overwrite the running application, database, and infrastructure. If you want to test locally, use `docker compose up -d && npm run dev` (see Quick Start below). Talk to the team before touching anything in `infrastructure/` or running any deploy commands.

---

## Features

### Document Intelligence
- **PDF Processing** — Upload multi-page construction blueprints, automatic page extraction via Ghostscript
- **OCR** — AWS Textract word-level text extraction with bounding boxes
- **Full-Text Search** — PostgreSQL tsvector across all pages with word-level magenta highlighting
- **Keynote Detection** — OpenCV + Tesseract tiled extraction of architectural symbols (circles, triangles, etc.)
- **CSI Code Detection** — Automatic Construction Specifications Institute code matching with trade filtering

### AI
- **Chat** — Groq (llama-3.3-70b) streaming with page or project scope, includes OCR + detection context
- **YOLO Object Detection** — Upload custom YOLOv8 models, run inference on SageMaker GPU, confidence filtering

### Quantity Takeoff (QTO)
- **Takeoff EA (Count)** — Shape markers (circle, square, diamond, triangle, cross), 20 colors, click-to-place
- **Takeoff Area (Surface Area)** — Scale calibration, polygon drawing (click vertices, click first point to close), shoelace area calculation with real-unit display (SF/SM)
- **CSV Export** — Both count and area items with per-page breakdowns

### Platform
- **Multi-tenant** — Company-based isolation with role-based access (member/admin)
- **Demo Mode** — Public viewer with full QTO playground (local-only, no auth required)
- **Admin Panel** — User management, YOLO model upload, inference runner, demo publishing
- **Security** — Rate limiting, brute force protection, JWT sessions, per-company quotas, audit logging

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 15, React 19, Zustand, pdf.js, Tailwind CSS 4 |
| Backend | Next.js API routes, Drizzle ORM, PostgreSQL 16 |
| AI/ML | Groq (LLM), YOLOv8 via SageMaker, Tesseract + OpenCV |
| Infrastructure | AWS ECS Fargate, S3 + CloudFront, RDS, SageMaker, Terraform |
| Auth | NextAuth 5 (credentials provider) |

---

## Quick Start (Local Development)

Prerequisites: Node.js 20+, Docker

```bash
# Clone
git clone https://github.com/YOUR_ORG/blueprintparser.git
cd blueprintparser

# Start PostgreSQL
docker compose up -d

# Install dependencies
npm install

# Configure environment
cp .env.example .env.local
# Edit .env.local — at minimum set DATABASE_URL and NEXTAUTH_SECRET

# Run database migrations
npx drizzle-kit migrate

# Start dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Local mode works without AWS credentials — you get PDF viewing, annotations, QTO tools, and search. OCR requires Textract (or Tesseract fallback), YOLO requires SageMaker, chat requires a Groq API key.

---

## AWS Deployment

Prerequisites: AWS CLI, Terraform, Docker

```bash
cd infrastructure/terraform

# Configure
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your AWS account, domain, secrets

# Deploy infrastructure
terraform init
terraform apply

# Deploy application
cd ../..
./deploy.sh

# Deploy YOLO container (optional, for object detection)
./deploy-yolo.sh
```

Estimated cost: ~$155/month (ECS Fargate + RDS + S3/CloudFront). SageMaker GPU is on-demand (~$0.75/hr when running YOLO jobs).

---

## Project Structure

```
blueprintparser/
├── src/
│   ├── app/                        # Next.js app router
│   │   ├── (auth)/                 #   Login, register
│   │   ├── (dashboard)/            #   Project list, PDF viewer
│   │   ├── admin/                  #   Admin panel
│   │   ├── demo/                   #   Public demo
│   │   └── api/                    #   20+ API routes
│   ├── components/viewer/          # Viewer components
│   │   ├── PDFViewer.tsx           #   Main viewer container
│   │   ├── PDFPage.tsx             #   Page renderer (pdf.js)
│   │   ├── AnnotationOverlay.tsx   #   Canvas overlay (markups, polygons, markers)
│   │   ├── TakeoffPanel.tsx        #   QTO panel (count + area tabs)
│   │   ├── ChatPanel.tsx           #   AI chat sidebar
│   │   ├── ViewerToolbar.tsx       #   Top toolbar
│   │   └── ...                     #   Search, keynote, text overlays
│   ├── stores/viewerStore.ts       # Zustand state
│   ├── lib/                        # Server utilities
│   │   ├── areaCalc.ts             #   Shoelace formula, calibration math
│   │   ├── processing.ts           #   PDF processing pipeline
│   │   ├── s3.ts                   #   S3 + CloudFront URL generation
│   │   ├── yolo.ts                 #   SageMaker job management
│   │   ├── textract.ts             #   AWS Textract integration
│   │   ├── keynotes.ts             #   Keynote extraction (OpenCV)
│   │   └── csi-detect.ts           #   CSI code matching
│   └── types/index.ts              # TypeScript types
├── scripts/
│   ├── extract_keynotes.py         # OpenCV + Tesseract keynote extraction
│   ├── yolo_inference.py           # YOLOv8 SageMaker inference
│   ├── update_secret.py            # Secret rotation utility
│   └── cost-control.sh             # Infrastructure cost TUI
├── infrastructure/terraform/       # Full AWS IaC (11 files)
├── drizzle/                        # Database migrations
├── deploy.sh                       # ECS deployment
├── deploy-yolo.sh                  # YOLO container deployment
├── Dockerfile                      # App container (Node + Ghostscript + Tesseract)
└── Dockerfile.yolo                 # GPU inference container (PyTorch + CUDA)
```

---

## Key Scripts

| Script | Purpose |
|--------|---------|
| `scripts/extract_keynotes.py` | Tiled keynote extraction (1200px tiles, 150px overlap, IOU deduplication) |
| `scripts/yolo_inference.py` | YOLOv8 inference for SageMaker Processing Jobs |
| `scripts/update_secret.py` | Rotate secrets across .env.local, terraform.tfvars, AWS Secrets Manager, and ECS |
| `scripts/cost-control.sh` | Interactive dashboard: toggle SageMaker/Step Functions, scale ECS, emergency shutdown |

---

## QTO Terminology

| Term | Meaning |
|------|---------|
| **QTO** | Quantity Takeoff — measuring quantities from blueprints for cost estimation |
| **Takeoff EA** | Each/Count — counting discrete items (doors, fixtures, outlets) |
| **Takeoff Area** | Surface area — measuring polygon areas (floors, walls, ceilings) in SF/SM |
| **Scale Calibration** | Setting real-world scale by clicking two points of known distance on the blueprint |

---

## Architecture Notes

- **QTO as data labeling**: Count markers = bounding boxes, area polygons = segmentation masks. Same paradigm as CVAT/Label Studio, applied to construction.
- **Normalized coordinates**: All annotations stored as 0-1 ratios relative to page dimensions. Zoom-independent.
- **Polymorphic annotations**: Count markers, area polygons, YOLO detections, and manual markups all stored in one `annotations` table via `source` + `data` jsonb columns. No migrations needed for new annotation types.
- **Tiled processing**: Large blueprints (>4000px) are downscaled and split into 1200px tiles with 150px overlap, processed independently, then deduplicated via IOU threshold.
- **13 database tables**: companies, users, projects, pages, annotations, takeoff_items, chat_messages, processing_jobs, models, audit_log, sessions, user_api_keys.

---

## Environment Variables

See [`.env.example`](.env.example) for the full list. Minimum for local dev:

```
DATABASE_URL=postgresql://beaver:beaver@localhost:5433/beaverdb
NEXTAUTH_SECRET=generate-with-openssl-rand-base64-32
NEXTAUTH_URL=http://localhost:3000
```

For full features, also set: `GROQ_API_KEY`, `AWS_*` credentials, `S3_BUCKET`, `CLOUDFRONT_DOMAIN`, `SAGEMAKER_ROLE_ARN`.

---

## License

MIT

---

## Contributing

This is an early-stage project building toward a full open-source release with local Docker deployment (no AWS required). Issues and PRs welcome.
