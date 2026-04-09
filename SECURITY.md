# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.x     | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability in BlueprintParser, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please use one of these methods:

1. **GitHub Security Advisories** (preferred): Go to the [Security tab](../../security/advisories/new) of this repository and create a new advisory.
2. **Email**: Send details to the repository maintainers (see GitHub profile).

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

- NextAuth 5 with bcrypt password hashing
- JWT-based sessions with 24-hour expiry
- Brute force protection with escalating lockouts
- Per-endpoint rate limiting
- Multi-tenant query scoping (all queries filtered by companyId)
- AES-256-GCM encryption for stored API keys
- HMAC-SHA256 webhook validation
- Comprehensive audit logging

## Self-Hosting Security Checklist

If you're deploying BlueprintParser:

- [ ] Set a strong `NEXTAUTH_SECRET` (generate with `openssl rand -base64 32`)
- [ ] Set a strong `PROCESSING_WEBHOOK_SECRET`
- [ ] Use HTTPS in production (the Terraform config includes ALB + ACM)
- [ ] Don't expose PostgreSQL to the public internet
- [ ] Rotate API keys stored in the database periodically
- [ ] Review the AWS WAF rules in `hardening.sh`
