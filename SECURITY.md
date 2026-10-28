# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| `main` branch (v2) | Yes |
| older snapshots, v1 | No |

## Reporting a Vulnerability

If you discover a security vulnerability in BlueprintParser, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Report it privately through GitHub: open the repository's
[Security tab](https://github.com/goodmorningcoffee/BlueprintParser_OS/security) and choose
**"Report a vulnerability"** (GitHub private vulnerability reporting). The report is visible only to
the maintainers.

### What to Include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if you have one)

### What to Expect

- **Acknowledgment** within 48 hours
- **Assessment** within 1 week
- **Fix or mitigation** timeline communicated after assessment
- **Credit** in the release notes (unless you prefer anonymity)

## Security Architecture

BlueprintParser includes several security layers documented in the [README](README.md#security-model):

- NextAuth 5 with bcrypt password hashing, JWT sessions with 24-hour expiry, optional Google sign-in
- Mandatory authenticator-app (TOTP) two-factor login for root admins
- Brute-force protection with escalating, database-backed lockouts
- Per-endpoint rate limiting and per-company daily quotas
- Multi-tenant query scoping (all queries filtered by companyId)
- AES-256-GCM encryption for stored API keys
- HMAC-SHA256 webhook validation
- Comprehensive audit logging

## Self-Hosting Security Checklist

If you're deploying BlueprintParser:

- [ ] Set a strong `NEXTAUTH_SECRET` (generate with `openssl rand -base64 32`)
- [ ] Set a strong `PROCESSING_WEBHOOK_SECRET`
- [ ] Set `ROOT_2FA_KEY` before the first root admin enrols, and never rotate it casually
- [ ] Keep `ALLOW_MODEL_UPLOAD` off except while uploading model weights
- [ ] Use HTTPS in production (the Terraform config includes ALB + ACM)
- [ ] Don't expose PostgreSQL to the public internet; the `docker-compose.yml` and seed credentials are for local development only
- [ ] Replace the Label Studio default credentials (`LABEL_STUDIO_ADMIN_PASSWORD`, API key) before exposing it
- [ ] Rotate API keys stored in the database periodically
- [ ] Review/import owner-managed WAF, GuardDuty, and CloudTrail controls; the retired `hardening.sh` is deliberately side-effect-free
- [ ] Keep ALB logs in the dedicated private SSE-S3 bucket with one-day expiry; query strings can contain revocable Label Studio asset bearers
- [ ] Restrict ALB-log `s3:GetObject` and `s3:ListBucket` access to incident responders, and never paste request targets into tickets or chat
