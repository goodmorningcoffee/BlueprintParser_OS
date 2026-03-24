# Security Hardening & Cost Explosion Mitigation

## Context
The app has solid auth foundations (bcrypt, NextAuth, company isolation) but no rate limiting, no brute force protection, and no cost guardrails. An attacker who gets an account (or brute-forces one) could run up SageMaker, Textract, and LLM costs.

## Priority 1: Rate Limiting Middleware (blocks 80% of abuse)

### New file: `src/middleware.ts`
Next.js middleware that runs on every request. Uses in-memory rate limiting (no Redis needed for now).

**Rate limits by endpoint:**
| Endpoint | Limit | Window | Key |
|----------|-------|--------|-----|
| `POST /api/register` | 3 requests | 15 min | IP |
| `POST /api/auth/callback/credentials` (login) | 5 requests | 15 min | IP + email |
| `POST /api/ai/chat` | 30 requests | 1 hour | userId |
| `POST /api/yolo/run` | 5 requests | 1 hour | userId |
| `POST /api/projects` (upload) | 10 requests | 1 hour | userId |
| `POST /api/s3/credentials` | 10 requests | 1 hour | userId |
| `POST /api/takeoff-items` | 50 requests | 1 hour | userId |
| `POST /api/annotations` | 200 requests | 1 hour | userId |
| All other API routes | 120 requests | 1 min | userId or IP |

**Implementation:** Simple in-memory Map with IP/userId → { count, resetTime }. Clean up expired entries every 5 min. Return 429 Too Many Requests when exceeded.

**Security headers** added to all responses:
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Strict-Transport-Security: max-age=31536000; includeSubDomains`
- `X-XSS-Protection: 1; mode=block`
- `Referrer-Policy: strict-origin-when-cross-origin`

## Priority 2: Brute Force Protection on Login

### Modify: `src/lib/auth.ts`
- Track failed login attempts per email in memory (or DB)
- After 5 failed attempts: lock account for 15 minutes
- After 10 failed attempts: lock for 1 hour
- Return generic "Invalid credentials" (already does this)
- Log failed attempts with IP + timestamp

## Priority 3: JWT Expiration & Session Security

### Modify: `src/lib/auth.ts`
- JWT `maxAge`: 30 days → 1 day (24 hours)
- Add `session.update()` on each request to extend active sessions (sliding window)
- On password change: invalidate all existing sessions (rotate JWT secret per-user or use a `tokenVersion` field)

## Priority 4: Cost Guardrails

### New file: `src/lib/quotas.ts`
Track usage per user/company and enforce limits.

**Quotas:**
| Resource | Limit | Period | Scope |
|----------|-------|--------|-------|
| PDF uploads | 20 | per day | per company |
| Total pages processed | 500 | per day | per company |
| SageMaker YOLO jobs | 10 | per day | per company |
| LLM chat messages | 100 | per day | per user |
| S3 storage | 5 GB | total | per company |

**Implementation:** Query DB counts (e.g., `SELECT COUNT(*) FROM projects WHERE company_id = ? AND created_at > NOW() - INTERVAL '1 day'`). Check before allowing the action. Return 429 with a clear message: "Daily upload limit reached (20/day)."

### Modify endpoints to check quotas:
- `src/app/api/projects/route.ts` — check upload quota before creating
- `src/app/api/yolo/run/route.ts` — check YOLO job quota before starting
- `src/app/api/ai/chat/route.ts` — check chat quota before calling Groq
- `src/app/api/s3/credentials/route.ts` — check storage quota before issuing presigned URL

## Priority 5: Input Validation & Upload Limits

### Modify: `src/app/api/s3/credentials/route.ts`
- Enforce max file size in presigned POST conditions: 100 MB
- Restrict content type to `application/pdf` only (already partially done)

### Modify: `src/app/api/admin/models/route.ts`
- Max model file size: 500 MB
- Validate file extension is `.pt`

### Modify: `src/app/api/admin/users/route.ts`
- Hardcode `role: "member"` on creation — admin role only via separate elevation endpoint
- Prevents privilege escalation via POST body

## Priority 6: Registration Security

### Modify: `src/app/api/register/route.ts`
- Hash access keys in DB (bcrypt, like passwords) — compare with `bcrypt.compare()`
- Generic error message: change "Email already registered" → "Invalid access key or email already in use"
- Password requirements: minimum 10 chars, at least 1 number and 1 uppercase

### Modify: `src/lib/db/schema.ts`
- No schema change needed — accessKey column stays, but values stored as bcrypt hashes

## Priority 7: Webhook Security

### Modify: `src/app/api/processing/webhook/route.ts`
- Add timestamp to webhook payload, reject if > 5 min old
- Add HMAC-SHA256 signature validation (sign payload with secret, verify on receipt)
- Log all webhook calls with IP + projectId

## Priority 8: Audit Logging

### New file: `src/lib/audit.ts`
Simple function that inserts into an `audit_log` table:
```
auditLog(action, userId, details)
```

### New table: `audit_log`
- id, action (varchar), userId, companyId, details (jsonb), ip (varchar), createdAt

### Log these events:
- Login success/failure
- Registration
- Project create/delete
- YOLO job triggered
- User created/deleted
- Password changed
- Demo flag toggled

## Implementation Order

| Step | Files | Effort | Impact |
|------|-------|--------|--------|
| 1. Rate limiting middleware | `src/middleware.ts` (new) | Medium | Blocks most abuse |
| 2. Login brute force protection | `src/lib/auth.ts` | Small | Prevents account takeover |
| 3. JWT expiration reduction | `src/lib/auth.ts` | Tiny | Limits compromised token window |
| 4. Cost quotas | `src/lib/quotas.ts` (new), 4 route files | Medium | Prevents cost explosion |
| 5. Upload size limits | `src/app/api/s3/credentials/route.ts` | Tiny | Prevents S3 abuse |
| 6. Registration hardening | `src/app/api/register/route.ts` | Small | Prevents spam accounts |
| 7. Webhook HMAC | `src/app/api/processing/webhook/route.ts` | Small | Prevents webhook spoofing |
| 8. Audit logging | `src/lib/audit.ts` (new), schema, multiple routes | Medium | Accountability |

## Verification
- Try logging in 6 times with wrong password → should get locked out
- Try creating 11 projects in 1 hour → should get 429
- Try triggering 6 YOLO jobs in 1 hour → should get 429
- Check response headers include security headers
- JWT expires after 24 hours (test by waiting or manipulating token)
- Register with weak password → rejected
- Audit log captures login/upload/delete events
