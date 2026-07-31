// [refactor jun12 P0.2] Boot-time environment contract.
//
// Why this exists: env vars were folklore — SES silently dead in prod (FROM
// unset + no IAM), LAMBDA_CV gating subtle, and CLOUDWATCH_LOG_GROUP defaulting
// to a group that doesn't exist. This module is the documented list of the
// variables that are VALIDATED once at server start (src/instrumentation.ts).
//
// ⚠ It is NOT the list of every variable the app reads — that is what this header
// claimed until 2026-07-31, and it was 78% true. Measured that day (every
// `process.env.X` under src/, comments stripped): 36 declared here, 43 read by
// production code. The TEN that are read and not declared:
//
//   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY   8 files each — s3/textract/yolo/
//                                              lambda-cv/toggles + 3 services.
//                                              Supplied by the task role in prod.
//   PROJECT_ASSET_EVENT_QUEUE_URL              project-asset-deletion + -object-events;
//                                              its presence SWITCHES the sweep cadence.
//   NEXT_PUBLIC_BUCKET_FILL_MODE               bucket-fill-mode.ts (build-time inlined)
//   NEXT_PUBLIC_TABLE_PARSE_DEBUG              AutoParseTab.tsx      (build-time inlined)
//   NEXT_RUNTIME                               instrumentation.ts — Next.js injects it,
//                                              and it gates the call to assertEnv() itself
//   BP_TEST_S3_ENDPOINT                        s3.ts — test-only, production ignores it
//   BP_REQUIRE_TEST_DB, BP_TEST_DATABASE_URL,  read only by the test harness under
//   AWS_EC2_METADATA_DISABLED                  src/test/, never by shipped code
//
// The two NEXT_PUBLIC_* vars CANNOT move here even in principle: Next.js inlines
// `process.env.NEXT_PUBLIC_*` at build time only when referenced statically, so routing
// them through a validated object would silently yield undefined (bucket-fill-mode.ts
// says so at its own read site). Declaring the rest is a real change to what boot
// validation covers, not a comment fix — so it is left as an owner decision, and this
// header now states the gap instead of denying it.
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
  GEOIP_DB_PATH: opt, // code default is ./geo/GeoLite2-Country.mmdb, i.e. path.join(process.cwd(), "geo", …) in geo.ts — NOT /data/…, which was never a path this code used
  CLOUDWATCH_LOG_GROUP: opt, // [jul23 P5.3 U5] code default is /ecs/blueprintparser-app (cw-logs.ts) — legacy name, moves with the beaver-* owner cutover. (Prior note here named a phantom code default that never existed.)
  LOG_LEVEL: opt, // default info
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
