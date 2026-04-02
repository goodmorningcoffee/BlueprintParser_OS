# BlueprintParser Open Source Release Plan

## Stage 1: Secrets Removal (DONE)

All hardcoded secrets, AWS account IDs, bucket names, and company-specific domain references have been scrubbed from source code, deploy scripts, terraform, and config templates.

### What was done
- **Source code (7 files):** Removed `beaver-public`, `beaver-app-uploads`, `beaver-yolo-pipeline`, `beaver-sagemaker-role` fallbacks from `s3.ts`, `toggles.ts`, `yolo.ts`, `email.ts`, `PDFPage.tsx`, `PDFViewer.tsx`, `PageSidebar.tsx`
- **Deploy scripts (10 files):** Parameterized all scripts to read from `.deploy.env` instead of hardcoded values. Scripts: `deploy.sh`, `deploy-yolo.sh`, `deploy-label-studio.sh`, `ecs-health.sh`, `hardening.sh`, `root_admin.sh`, `scripts/setup-label-studio.sh`, `scripts/update_secret.py`, `scripts/cost-control.sh`, `scripts/sagemaker-killswitch.sh`
- **Config templates:** `.env.example` cleaned of all company-specific values, `.deploy.env.example` created
- **Terraform (4 files):** All `blueprintparser.com` domains replaced with `var.domain_name` in `ecs.tf`, `s3.tf`, `variables.tf`, `main.tf`
- **Deleted:** `fix-task.py` (hardcoded ARN), `estimation logic map.pdf` (all ARNs with account ID)
- **Created:** `.deploy.env` (gitignored, holds your actual deployment values), `.deploy.env.example` (template for OS users)

### Auth bug fixes (during this session)
- Fixed `auth.ts:242` — credentials JWT callback condition `!account?.provider` was always false in NextAuth v5 (credentials sets `provider: "credentials"`). Changed to `account?.provider === "credentials"`.
- Fixed `password/route.ts:32` and `auth.ts:125` — `user.passwordHash` nullable after OAuth migration, added null guards before `bcrypt.compare`

---

## Stage 2: Code Quality & Docs (TODO)

### Must-Fix (Blocking release)

#### 1. Remove internal/stale files
| File | Why |
|------|-----|
| `plans/old/` (entire directory) | Internal planning docs, roadmap TODOs, references security audit findings |
| `REFACTORED_MARCH29.md` | Internal refactoring session log |
| `tesseracctSetup.md` | Personal setup/debug notes |
| `.DS_Store` (root + plans/) | macOS system files |

#### 2. Update README.md for OS audience
- Remove lines 9-18 (live credentials warning, "do not fork publicly")
- Add "Quick Start" section at top: clone → docker compose up → cp .env.example → npm run dev
- Add "Configuration" section pointing to `.env.example` and `.deploy.env.example`
- Keep the excellent architecture/algorithm documentation as-is (511 lines of gold)

#### 3. Add `.DS_Store` to `.gitignore`

#### 4. Fresh git history for public repo
Create OS repo with fresh `git init` — don't push private repo history. Ensures no secrets ever appear in git log. No need for git filter-repo.

### Should-Fix (Polish)

#### 5. CONTRIBUTING.md
- Prerequisites (Node 20+, Docker)
- Local dev setup steps
- Code style (ESLint, TypeScript strict)
- Testing (`npm test`)
- PR process

#### 6. SECURITY.md
- Responsible disclosure policy
- Contact email for vulnerability reports
- Expected response time

#### 7. GitHub Actions CI
`.github/workflows/ci.yml` — lint + build + test on push/PR. Keeps the project looking maintained.

#### 8. Prettier config
Add `.prettierrc` for consistent contributor formatting.

#### 9. Clean unused dependencies from package.json
Remove: `@hookform/resolvers`, `react-hook-form`, `@types/d3-selection`, `d3-selection`, `@testing-library/jest-dom`, `@testing-library/react`, `esbuild`
Add missing: `sharp` (used in labeling route)

### Nice-to-Have (Post-launch)

#### 10. Expand test coverage
Currently 3 test files (<2% coverage). Priority targets:
- `csi-detect.ts` — CSI code detection algorithm
- `context-builder.ts` — LLM context assembly
- `processing.ts` — PDF processing pipeline
- Key API routes (chat, projects, yolo)
- Estimated effort: 8-12 hours

#### 11. API endpoint documentation
69 routes, no OpenAPI spec or endpoint listing. Options:
- `API.md` with table of endpoints, methods, params, responses
- JSDoc on each route handler
- Auto-generate OpenAPI spec

#### 12. install_setup.sh TUI Wizard
Interactive setup script for non-technical users (estimators, PMs). Uses `whiptail` for terminal UI.

Flow:
1. Prerequisites check (Docker, Node 20+, AWS CLI)
2. Deployment mode: Local Dev / AWS Production / Custom
3. Database setup (auto-configure docker-compose or prompt for connection string)
4. AWS features (checkboxes: S3, Textract, SageMaker YOLO, SES, Step Functions)
5. LLM provider (Anthropic / OpenAI / Groq / Local Ollama / Skip)
6. Auth config (admin email/password, optional Google OAuth)
7. Generate `.env.local` + `.deploy.env`
8. Launch (docker compose up + db:migrate + npm run dev)

Key UX: validates each step before proceeding, can re-run without losing config, never requires manual .env editing.

---

## What's Already Good (No work needed)

- **README.md** — 511 lines, comprehensive architecture, CSI algorithm, security model
- **LICENSE** — MIT
- **Demo mode** — Well-separated `/api/demo/*`, works without AWS, rate-limited
- **TypeScript strict mode** — Enabled
- **Logger** — Proper `logger.ts`, no stray console.log in prod
- **Error handling** — API routes have proper try/catch with HTTP codes
- **Code comments** — Core algorithm files (csi-detect, context-builder, yolo, s3) have excellent JSDoc
- **Zero TODO/FIXME/HACK** comments in production code

---

## Things to Consider

### Deployment options for OS users
Most OS users won't have AWS. Consider documenting:
- **Local-only mode:** Docker Compose + local file storage (no S3, no Textract, no SageMaker)
- **Minimal AWS:** Just S3 for storage, everything else local
- **Full AWS:** S3 + Textract + SageMaker + Step Functions + ECS

### LLM provider flexibility
Already well-handled — admin dashboard supports Anthropic, OpenAI, Groq, and local Ollama. Document that Groq has a free tier for getting started.

### Model weights distribution
YOLO `.pt` model files are large binaries. Don't commit them. Options:
- GitHub Releases (attach as assets)
- S3 public bucket with download script
- Hugging Face model hub

### Database migrations
New users need to run `npx drizzle-kit migrate` after cloning. The setup wizard should handle this, but document it clearly in Quick Start.

### Cost awareness
Document estimated AWS costs for different configurations so OS users aren't surprised:
- Local dev: $0 (Docker only)
- Minimal AWS (S3 only): ~$5/month
- Full AWS (ECS + RDS + SageMaker): ~$150-300/month
- SageMaker GPU jobs: ~$0.50-1.00 per YOLO run (ml.g4dn.xlarge)
