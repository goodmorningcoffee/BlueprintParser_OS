# Security Deep Dive — BlueprintParser 2
**Date: March 31, 2026**

## Overall Posture: MODERATE
Strong foundations (Drizzle ORM, bcrypt, AES-256-GCM, brute force protection) with gaps in multi-tenant isolation, secret management, and monitoring.

---

## CRITICAL — Fix Immediately

### 1. Committed API Key in `.env.local`
`GROQ_API_KEY=gsk_OD1SNI...` committed to git. Active key leaked.
**Action:** Rotate key immediately. Scrub from git history with BFG. Add pre-commit hook (`detect-secrets` or `git-secrets`).

### 2. Missing company auth on `/api/pages/intelligence` (PATCH)
**File:** `src/app/api/pages/intelligence/route.ts` line 39
Queries pages by integer `projectId` without verifying project belongs to user's company. Any authenticated user can modify any company's page intelligence.
**Action:** Join to projects table, check `companyId`.

### 3. No auth on `/api/table-parse/propose`
**File:** `src/app/api/table-parse/propose/route.ts`
Zero authentication. Queries pages by integer `projectId`. Unauthenticated attacker can extract OCR data from any project by guessing IDs.
**Action:** Add `requireAuth()` + company ownership check.

---

## HIGH — Fix This Week

### 4. SSL validation disabled in production DB connection
**File:** `src/lib/db/index.ts` line 9
`ssl: { rejectUnauthorized: false }` in production. Allows MITM on DB connection.
**Action:** Set `rejectUnauthorized: true`, use RDS CA certificate.

### 5. SageMaker IAM role over-permissioned
**File:** `infrastructure/terraform/iam.tf` line 216
Uses `AmazonSageMakerFullAccess` managed policy. Grants far more than needed.
**Action:** Custom policy with only `CreateProcessingJob`, `DescribeProcessingJob`, `StopProcessingJob`.

### 6. Rate limit bypass via unauthenticated fallback
**File:** `src/middleware.ts` lines 102-107
User-keyed rate limits fall back to IP when no auth cookie present. Unauthenticated users get the higher IP-based limit (120/min) instead of the tighter per-user limit.
**Action:** Apply stricter IP limits on user-scoped routes when unauthenticated.

### 7. Admin invites returns all companies' data
**File:** `src/app/api/admin/invites/route.ts` line 13
No `companyId` filter. Cross-tenant data leak.
**Action:** Filter by company.

### 8. No timeout on LLM stream + page processing
**Files:** `src/lib/llm/stream.ts`, `src/lib/processing.ts`
Both can hang indefinitely on external service failures.
**Action:** AbortController timeout (30s LLM, 60s per page).

---

## MEDIUM — Fix This Month

### 9. Missing security headers
**File:** `src/middleware.ts` lines 73-79
Missing: `Strict-Transport-Security` (HSTS), `Content-Security-Policy` (CSP).
Present and correct: `X-Content-Type-Options`, `X-Frame-Options`, `X-XSS-Protection`, `Referrer-Policy`, `Permissions-Policy`.

### 10. Shared encryption key + weak derivation
**File:** `src/lib/crypto.ts` lines 12-15
All API keys encrypted with same key derived from `LLM_KEY_SECRET || NEXTAUTH_SECRET` via raw SHA256. Key reuse + no PBKDF2/HKDF.
**Action:** Require separate `LLM_KEY_SECRET`, use PBKDF2 for key derivation.

### 11. JWT lifetime 24 hours, no refresh tokens
**File:** `src/lib/auth.ts` line 154
Compromised token valid for 24h with no revocation mechanism.
**Action:** Consider 1-2h access token + refresh token rotation.

### 12. No quotas on expensive endpoints
`/api/symbol-search`, `/api/table-parse`, `/api/search` — all require significant compute (CV, rasterization, DB queries) but have no per-user rate limiting.

### 13. Error responses leak internals
5 routes return `err.message` to client: `/api/yolo/run`, `/api/table-parse`, `/api/symbol-search`, `/api/pages/intelligence`, `/api/projects/[id]` DELETE.
**Action:** Log full error server-side, return generic message.

### 14. Integer projectId enables enumeration
Several routes accept internal DB integer IDs instead of UUIDs. Sequential integers are trivially guessable.
**Action:** Migrate API contracts to use `publicId` (UUID) only.

### 15. In-memory rate limiting + brute force
Both systems use `Map()` — reset on server restart, not shared across ECS tasks.
**Action:** For multi-instance deployment, migrate to Redis or DynamoDB.

### 16. Incomplete audit logging
Only login events logged. Missing: project delete, YOLO runs, admin actions, failed access attempts, data exports. IP not captured despite field existing.

---

## LOW — Backlog

### 17. Docker image not pinned to digest
Uses `node:20-alpine` tag, not SHA256 digest. Supply chain risk.

### 18. Python/Tesseract in runtime image
Increases attack surface. Consider separating processing into sidecar container.

### 19. Password policy inconsistency
Registration requires 10+ chars, admin user creation only 8+.

### 20. No password reset flow
Users who forget passwords have no self-service recovery.

### 21. No CSRF token validation
Relying on NextAuth defaults (SameSite=Lax). Explicit CSRF tokens would be stronger.

---

## What's Secure (Verified)

| Area | Status | Details |
|------|--------|---------|
| SQL Injection | SAFE | Drizzle ORM parameterized queries throughout |
| Command Injection | SAFE | All subprocess calls use `execFile` (no shell), user input never reaches args |
| S3 Path Traversal | SAFE | Paths built from fixed structure, company prefix validated |
| XSS | LOW RISK | `dangerouslySetInnerHTML` used once (OCR data, not user input) |
| SSRF | SAFE | No user-supplied URLs in server-side fetch calls |
| Password Hashing | GOOD | bcrypt cost 12, timing-safe comparison |
| API Key Encryption | GOOD | AES-256-GCM with random IV + auth tag |
| Brute Force | GOOD | 5 attempts→15min lockout, 10→1hr |
| S3 Bucket | GOOD | Public access blocked, versioning, encryption, OAC |
| RDS | GOOD | Private subnet, SG restricted to ECS only, encrypted, multi-AZ |
| CloudFront | GOOD | TLS 1.2+, GET/HEAD only, SNI |
| VPC | GOOD | Public/private subnet separation, NAT gateway |
| Webhook Auth | GOOD | HMAC-SHA256 + timing-safe comparison + timestamp validation |

---

## Priority Fix Order

| # | Item | Effort | Risk |
|---|------|--------|------|
| 1 | Rotate GROQ API key, scrub git | 30 min | Active key exposure |
| 2 | Auth on `/api/table-parse/propose` | 15 min | Unauthenticated data access |
| 3 | Company check on `/api/pages/intelligence` | 15 min | Cross-tenant write |
| 4 | Company filter on `/api/admin/invites` | 10 min | Cross-tenant read |
| 5 | Fix SSL `rejectUnauthorized: false` | 15 min | MITM on DB |
| 6 | Restrict SageMaker IAM | 30 min | Over-privileged role |
| 7 | Add HSTS + CSP headers | 30 min | Transport + XSS protection |
| 8 | LLM stream + processing timeouts | 30 min | Hung connections |
| 9 | Error response sanitization | 1 hr | Info leak |
| 10 | Quotas on expensive endpoints | 1-2 hrs | DoS protection |
