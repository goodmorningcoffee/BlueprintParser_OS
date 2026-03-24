# Local Docker Mode: Self-Hosted Deployment Without AWS

## Context
Make BlueprintParser runnable locally via Docker Compose with zero AWS dependencies. This enables open-source users to try the tool without an AWS account. The app should support both modes: native AWS (current) and local Docker.

## AWS → Local Swap Map

| AWS Service | Local Replacement | Swap Type |
|---|---|---|
| S3 | MinIO (S3-compatible, same SDK) | Config: `S3_ENDPOINT` env var |
| Textract | Tesseract (already in Docker image) | Code: adapter function |
| RDS PostgreSQL | PostgreSQL container | Config: `DATABASE_URL` |
| ECS Fargate | Docker Compose | Already Dockerized |
| Step Functions | Direct `processProject()` call | Already done (no `STEP_FUNCTION_ARN` → direct) |
| SageMaker | Run ultralytics directly in container | Code: local inference function |
| CloudFront | Not needed | Skip |
| ECR | Local build | Skip |

## Implementation

### Step 1: docker-compose.yml (new, project root)
```yaml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_DB: beaver
      POSTGRES_USER: beaver
      POSTGRES_PASSWORD: beaver
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "5432:5432"

  storage:
    image: minio/minio
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    volumes:
      - minio_data:/data
    ports:
      - "9000:9000"
      - "9001:9001"

  app:
    build: .
    depends_on: [db, storage]
    ports:
      - "3000:3000"
    environment:
      DATABASE_URL: postgresql://beaver:beaver@db:5432/beaver
      S3_BUCKET: beaver-data
      S3_ENDPOINT: http://storage:9000
      S3_ACCESS_KEY: minioadmin
      S3_SECRET_KEY: minioadmin
      S3_FORCE_PATH_STYLE: "true"
      USE_LOCAL_OCR: "true"
      NODE_ENV: production
      NEXTAUTH_URL: http://localhost:3000
      NEXTAUTH_SECRET: local-dev-secret-change-me

volumes:
  pgdata:
  minio_data:
```

### Step 2: S3 client — MinIO compatibility
**File:** `src/lib/s3.ts`

Add `S3_ENDPOINT` support to the S3Client config:
```ts
const s3Client = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  ...(process.env.S3_ENDPOINT && {
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: true, // Required for MinIO
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY || "minioadmin",
      secretAccessKey: process.env.S3_SECRET_KEY || "minioadmin",
    },
  }),
});
```

Also update `getS3Url()` — when `S3_ENDPOINT` is set, return MinIO URLs instead of CloudFront/S3 URLs. Or serve files through the app (proxy route) so the browser doesn't need direct MinIO access.

### Step 3: Textract → Tesseract adapter
**File:** `src/lib/textract.ts` (modify existing)

Add a local OCR path:
```ts
export async function analyzePageImage(pngBuffer: Buffer) {
  if (process.env.USE_LOCAL_OCR === "true") {
    return analyzeWithTesseract(pngBuffer);
  }
  return analyzeWithTextract(pngBuffer);
}
```

**New function `analyzeWithTesseract()`:**
- Write PNG to temp file
- Call `tesseract <img> - tsv` to get word-level bounding boxes with confidence
- Parse TSV output into same `TextractPageData` format (words with bbox, confidence, lines)
- Tesseract TSV gives: level, page_num, block_num, par_num, line_num, word_num, left, top, width, height, conf, text
- Convert pixel coords to normalized 0-1 using image dimensions
- This is the hardest adapter — Textract returns richer data (lines, tables) but for QTO we mainly need word bboxes

### Step 4: Local YOLO inference
**File:** `src/lib/yolo.ts` (modify existing)

When no `SAGEMAKER_ROLE_ARN` or when `USE_LOCAL_YOLO=true`:
- Instead of creating a SageMaker job, run inference directly
- Option A: Shell out to `python3 scripts/yolo_inference.py` with local paths
- Option B: Add a local YOLO API route that accepts images and returns detections
- Option A is simpler — reuse the same inference script, just point it at local dirs

The `startYoloJob()` function would:
1. Copy images + model to temp dirs
2. Set env vars for input/output paths
3. Spawn `python3 scripts/yolo_inference.py` as a child process
4. Return a job ID (just a timestamp)
5. `getYoloJobStatus()` checks if the process is done

### Step 5: Setup script
**File:** `setup.sh` (new, project root)

```bash
#!/bin/bash
# First-time setup for local Docker mode
# 1. Copy .env.example to .env
# 2. Generate NEXTAUTH_SECRET
# 3. docker compose up -d db storage
# 4. Wait for services
# 5. Create MinIO bucket (mc mb local/beaver-data)
# 6. Run DB migrations (npx drizzle-kit push)
# 7. Seed admin user
# 8. docker compose up -d app
```

### Step 6: File proxy route (for MinIO)
**File:** `src/app/api/files/[...path]/route.ts` (new)

Browsers can't access MinIO directly (CORS, internal Docker network). Add a proxy route:
- GET `/api/files/companyKey/projectHash/thumbnail.png`
- Fetches from MinIO via S3 SDK, streams back to browser
- Only needed when `S3_ENDPOINT` is set (local mode)

Update `getS3Url()` to return `/api/files/...` paths in local mode.

### Step 7: Presigned URL handling for MinIO
**File:** `src/app/api/s3/credentials/route.ts`

MinIO supports presigned URLs but the endpoint needs to be accessible from the browser. Two options:
- Expose MinIO on localhost:9000 and use that as the presigned endpoint
- Or proxy uploads through the app (simpler, slightly slower)

For simplicity: add a `/api/upload` route that accepts multipart form data and writes to MinIO. Only used in local mode.

### Step 8: Credential cleanup for open source
- Create `.env.example` with all env vars documented (no real values)
- Add `.env` to `.gitignore` (should already be there)
- Audit codebase for hardcoded AWS account IDs (deploy.sh, deploy-yolo.sh, yolo.ts) — make them env vars
- Remove `terraform.tfvars` from git (has secrets)
- Add `infrastructure/terraform/terraform.tfvars` to `.gitignore`

## What Users Get

**Local mode (`docker compose up`):**
- Upload PDFs, view pages
- OCR via Tesseract (slightly lower quality than Textract but free)
- Full-text search, CSI detection, keynote extraction
- Manual annotations + quantity takeoff
- YOLO inference if they have a GPU (optional)
- LLM chat if they provide their own API key
- Everything runs on their machine, no cloud costs

**AWS mode (current):**
- Same features but with Textract (better OCR), SageMaker (managed GPU), S3/CloudFront (CDN)
- Terraform for infrastructure provisioning
- Step Functions for background processing

## Verification
- `docker compose up` starts all services
- Upload a PDF, verify OCR works with Tesseract
- Annotations save and reload
- CSV export works
- YOLO inference works (if GPU available)
- Everything works without any AWS credentials set
