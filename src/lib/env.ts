// [refactor jun12 P0.2] Boot-time environment contract.
//
// Why this exists: env vars were folklore — SES silently dead in prod (FROM
// unset + no IAM), LAMBDA_CV gating subtle, DB_SSL_REJECT_UNAUTHORIZED read
// nowhere effective, CLOUDWATCH_LOG_GROUP defaulting to a group that doesn't
// exist. This module is the single documented list of every variable the app
// reads, validated once at server start (src/instrumentation.ts).
//
// Behavior: in production a missing REQUIRED var fails the boot fast with a
// named list (better than a 3am stack trace from deep inside a handler).
// Outside production we only warn — local dev legitimately runs without AWS
// (build/unit-test need no live services; see env-setup memory).
//
// This is intentionally NOT yet imported by feature code. Call sites keep
// reading process.env directly; they migrate to `env.X` opportunistically as
// routes convert during P1 (same-PR rule). First zod use in the repo.

import { z } from "zod";

const req = z.string().min(1);
const opt = z.string().min(1).optional();

/** Vars the production containers cannot run without (taskdef-injected). */
const requiredInProd = z.object({
  DATABASE_URL: req,
  NEXTAUTH_URL: req,
  S3_BUCKET: req,
  AWS_REGION: req,
  STEP_FUNCTION_ARN: req, // ingest kickoff (projects POST → SFN StartExecution)
  PROCESSING_WEBHOOK_SECRET: req, // worker→webhook auth (Bearer+HMAC)
});

/** Optional / feature-gated vars. Missing ⇒ the named feature degrades. */
const optional = z.object({
  // auth — next-auth v5 reads AUTH_SECRET; NEXTAUTH_SECRET kept for compat.
  // At least ONE of the pair must be set in prod (checked below).
  NEXTAUTH_SECRET: opt,
  AUTH_SECRET: opt,
  GOOGLE_CLIENT_ID: opt, // pair required together for Google SSO
  GOOGLE_CLIENT_SECRET: opt,
  ROOT_ADMIN_EMAIL: opt, // root-admin bootstrap

  // Legacy edge-cache invalidation only. Browser assets use the same-origin
  // application gateway; self-hosted installs may omit this pair entirely.
  CLOUDFRONT_DOMAIN: opt,
  CLOUDFRONT_DISTRIBUTION_ID: opt,

  // LLM providers — chat works with any one; per-tenant keys may override.
  GROQ_API_KEY: opt,
  ANTHROPIC_API_KEY: opt,
  OPENAI_API_KEY: opt,
  LLM_PROVIDER: opt,
  LLM_BASE_URL: opt,
  LLM_MODEL: opt,
  LLM_KEY_SECRET: opt, // encrypts tenant-provided keys (llm/resolve.ts)

  // YOLO / SageMaker
  SAGEMAKER_ROLE_ARN: opt,
  YOLO_ECR_IMAGE: opt,
  AWS_ACCOUNT: opt,

  // Lambda CV fan-out (defaults exist in code)
  LAMBDA_CV_ENABLED: opt,
  LAMBDA_CV_FUNCTION_NAME: opt,
  LAMBDA_CV_BATCH_SIZE: opt,

  // Label Studio integration (group: all-or-none)
  LABEL_STUDIO_URL: opt,
  LABEL_STUDIO_API_KEY: opt,
  // Opaque identity of the provider's persistent state (Terraform uses the LS EFS ID). Cleanup
  // refuses a mismatched value so numeric project IDs cannot be replayed against a replacement.
  LABEL_STUDIO_INSTANCE_ID: opt,

  // email — DEAD in prod today (no ses:* IAM + FROM unset); P5.5 decides
  SES_FROM_EMAIL: opt,

  // ops/misc (code defaults noted)
  GEOIP_DB_PATH: opt, // default /data/GeoLite2-Country.mmdb
  CLOUDWATCH_LOG_GROUP: opt, // code default /aws/lambda/bp2 is WRONG (P5.2)
  LOG_LEVEL: opt, // default info
  DB_SSL_REJECT_UNAUTHORIZED: opt, // entrypoint hardcodes false today (P4.3)
  ALLOW_MODEL_UPLOAD: opt, // default false — weights-upload kill-switch
  DEV_PROCESSING_ENABLED: opt, // default false
  NODE_ENV: opt,
});

export type Env = z.infer<typeof requiredInProd> & z.infer<typeof optional>;

/** Validate process.env. Returns problems instead of throwing (caller decides). */
export function checkEnv(source: NodeJS.ProcessEnv = process.env): {
  missing: string[];
  warnings: string[];
} {
  const missing: string[] = [];
  const warnings: string[] = [];

  const reqParse = requiredInProd.safeParse(source);
  if (!reqParse.success) {
    for (const issue of reqParse.error.issues) missing.push(String(issue.path[0]));
  }

  // auth secret: v5 accepts AUTH_SECRET; legacy code reads NEXTAUTH_SECRET.
  if (!source.NEXTAUTH_SECRET && !source.AUTH_SECRET) {
    missing.push("NEXTAUTH_SECRET|AUTH_SECRET (one required)");
  }

  // Terraform supplies both values. Outside Terraform, both absent means no
  // legacy edge cache to invalidate; a partial pair must fail closed at boot.
  if (source.CLOUDFRONT_DOMAIN && !source.CLOUDFRONT_DISTRIBUTION_ID) {
    missing.push("CLOUDFRONT_DISTRIBUTION_ID");
  } else if (
    source.CLOUDFRONT_DISTRIBUTION_ID &&
    !source.CLOUDFRONT_DOMAIN
  ) {
    missing.push("CLOUDFRONT_DOMAIN");
  }

  // all-or-none groups → partial config is a misconfig worth naming
  const groups: Record<string, string[]> = {
    "Google SSO": ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    "Label Studio": [
      "LABEL_STUDIO_URL",
      "LABEL_STUDIO_API_KEY",
      "LABEL_STUDIO_INSTANCE_ID",
    ],
  };
  for (const [name, keys] of Object.entries(groups)) {
    const set = keys.filter((k) => !!source[k]);
    if (set.length > 0 && set.length < keys.length) {
      warnings.push(
        `${name} partially configured (${set.length}/${keys.length}: missing ${keys
          .filter((k) => !source[k])
          .join(", ")})`,
      );
    }
  }

  if (!source.GROQ_API_KEY && !source.ANTHROPIC_API_KEY && !source.OPENAI_API_KEY) {
    warnings.push("no LLM provider key set — chat falls back to tenant keys only");
  }
  if (!source.SES_FROM_EMAIL) {
    warnings.push("SES_FROM_EMAIL unset — password-reset + cap-alert emails are dead (known; P5.5)");
  }

  return { missing, warnings };
}

/**
 * Boot assertion: fail fast in production, warn elsewhere.
 * Called from src/instrumentation.ts at server start (never during build).
 */
export function assertEnv(): void {
  const { missing, warnings } = checkEnv();
  for (const w of warnings) console.warn(`[env] WARN: ${w}`);
  if (missing.length > 0) {
    const msg = `[env] missing required configuration: ${missing.join(", ")}`;
    if (process.env.NODE_ENV === "production") {
      throw new Error(msg);
    }
    console.warn(`${msg} (non-production: continuing)`);
  } else {
    console.log("[env] contract OK");
  }
}
