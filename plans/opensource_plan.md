# Open Source Release Plan

## Vision
BlueprintParser 2 becomes the only open-source QTO/AI tool for blueprints. Contractors can self-deploy via Docker (local) or AWS (cloud). The system works without any cloud accounts for local mode.

---

## Critical Blockers (Must Fix Before Release)

### 1. Secrets in Version Control
- `.env.local` contains real Groq API key — committed despite being in `.gitignore`
- `terraform.tfvars` contains real DB password, NextAuth secret, webhook secret, Groq key
- **Fix**: Remove from git history with `bfg repo-cleaner`, rotate ALL secrets
- **Add to `.gitignore`**: `terraform.tfvars`, `*.tfvars` (keep `terraform.tfvars.example`)

### 2. Hardcoded AWS Account ID (`100328509916`)
Found in:
- `deploy.sh` (line 10)
- `deploy-yolo.sh` (line 9)
- `src/lib/yolo.ts` (lines 20, 24) — fallback defaults
- `infrastructure/terraform/main.tf` (line 16) — S3 backend bucket name

**Fix**: Accept `AWS_ACCOUNT` as env var or CLI arg in deploy scripts. Remove hardcoded defaults from yolo.ts. Terraform backend bucket should be configurable.

### 3. Hardcoded Domain Names (`blueprintparser.com`)
Found in:
- `infrastructure/terraform/ecs.tf` (lines 70-71) — CloudFront domain, NextAuth URL
- `infrastructure/terraform/s3.tf` (lines 70, 98) — CORS, CloudFront alias
- `.env.example` (line 8)

**Fix**: Already have `var.domain_name` — use it everywhere instead of hardcoding.

---

## Two Deployment Paths

### Path A: Local Docker Mode (No AWS)
Target: Contractors who want to run it on their own machine or server.

**Docker Compose stack:**
| Service | Purpose | Replaces |
|---------|---------|----------|
| PostgreSQL 16 | Database | RDS |
| MinIO | Object storage | S3 + CloudFront |
| App (Next.js) | Main application | ECS Fargate |
| Tesseract | OCR | Textract |
| YOLO (optional) | Object detection | SageMaker |

**What users run:**
```bash
git clone <repo>
cp .env.example .env
# Edit .env with their Groq key (optional)
docker compose up
# App available at http://localhost:3000
```

**What needs to be built:**
- `docker-compose.full.yml` with all services
- S3 client adapter for MinIO (partially exists — `S3_ENDPOINT` support)
- Textract → Tesseract adapter (swap OCR backend based on env var)
- Local processing pipeline (skip Step Functions, call `processProject()` directly)
- `setup.sh` script for first-time setup (create buckets, run migrations, seed demo data)

### Path B: AWS Deployment
Target: Companies that want scalability and managed services.

**What users run:**
```bash
git clone <repo>
cd infrastructure/terraform
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with their AWS account, domain, secrets
terraform init && terraform apply
cd ../..
./deploy.sh
```

**What needs to be built:**
- `terraform.tfvars.example` (template with placeholder values)
- Parameterize deploy scripts (`AWS_ACCOUNT` from env or arg)
- Remove hardcoded account IDs from yolo.ts
- Documentation for ACM certificate creation, domain setup

---

## Documentation Needed

### README.md
- Project description and screenshots
- Quick start (local Docker in 3 commands)
- Feature list
- Architecture diagram (simple ASCII)
- Links to detailed docs

### docs/LOCAL_DEPLOYMENT.md
- Prerequisites (Docker, Docker Compose)
- Step-by-step local setup
- Optional: Groq API key for chat, YOLO models for detection
- Troubleshooting

### docs/AWS_DEPLOYMENT.md
- Prerequisites (AWS account, domain, ACM cert)
- Terraform setup
- deploy.sh usage
- Cost estimate (~$155/mo baseline)
- Scaling guidance

### docs/DEVELOPMENT.md
- Local dev setup (npm run dev + docker compose for DB)
- Project structure overview
- How to add features
- Testing approach

### LICENSE
- Recommend: MIT (most permissive, contractor-friendly)
- Alternative: Apache 2.0 (patent protection)

---

## Setup Script (`setup.sh`)

For local Docker mode, a one-command setup:
```bash
#!/bin/bash
# 1. Check prerequisites (docker, docker-compose)
# 2. Copy .env.example to .env if not exists
# 3. Prompt for optional Groq API key
# 4. docker compose up -d postgres minio
# 5. Wait for services to be healthy
# 6. Run database migrations
# 7. Create MinIO bucket
# 8. Seed demo project (optional)
# 9. docker compose up -d app
# 10. Print access URL
```

---

## Git History Cleanup

Before making the repo public:
```bash
# Install bfg repo cleaner
# Remove all .env.local files from history
bfg --delete-files .env.local
# Remove terraform.tfvars from history
bfg --delete-files terraform.tfvars
# Remove any remaining secrets
bfg --replace-text secrets.txt  # file with patterns to redact
git reflog expire --expire=now --all && git gc --prune=now --aggressive
```

---

## Checklist

- [ ] Remove secrets from git history (bfg)
- [ ] Rotate ALL secrets (Groq, Anthropic, DB password, NextAuth, webhook)
- [ ] Add `terraform.tfvars` to `.gitignore`
- [ ] Create `terraform.tfvars.example`
- [ ] Parameterize deploy scripts (no hardcoded account IDs)
- [ ] Remove hardcoded defaults from `src/lib/yolo.ts`
- [ ] Parameterize Terraform backend bucket name
- [ ] Use `var.domain_name` everywhere in Terraform
- [ ] Build local Docker Compose stack (MinIO + Tesseract adapters)
- [ ] Create `setup.sh` for local mode
- [ ] Create README.md
- [ ] Create LICENSE (MIT)
- [ ] Create docs/ directory with deployment guides
- [ ] Test clean-room deployment (fresh clone → working app)
- [ ] Seed demo blueprint for first-run experience
