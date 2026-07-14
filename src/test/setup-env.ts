// [refactor jun12 P0.3] vitest setupFile — runs in EVERY test worker before
// any test module is imported.
//
// SAFETY RAIL: DATABASE_URL is force-overridden to the local test database for
// the entire test process. The devcontainer is sometimes wired to the LIVE RDS
// for end-to-end debugging (env-setup memory) — without this line a stray
// `import { db }` in a test could open a pool against production. Tests can
// NEVER see a non-localhost database, by construction.
export const TEST_DATABASE_URL =
  process.env.BP_TEST_DATABASE_URL ??
  "postgres://bp_test:bp_test@localhost:5433/bp_test";

const testDatabase = new URL(TEST_DATABASE_URL);
if (!["localhost", "127.0.0.1", "::1"].includes(testDatabase.hostname)) {
  throw new Error("BP_TEST_DATABASE_URL must target localhost");
}

process.env.DATABASE_URL = TEST_DATABASE_URL;
// (NODE_ENV is already "test" under vitest — relied on by db/index.ts to skip SSL)

// Dummy AWS config so SDK clients constructed at import time fail FAST on use
// instead of hanging on IMDS credential discovery (no metadata service here).
process.env.AWS_EC2_METADATA_DISABLED = "true";
process.env.AWS_ACCESS_KEY_ID ||= "test-dummy";
process.env.AWS_SECRET_ACCESS_KEY ||= "test-dummy";
process.env.AWS_REGION ||= "us-east-1";
process.env.S3_BUCKET ||= "test-dummy-bucket";
process.env.NEXTAUTH_SECRET ||= "test-dummy-secret";
process.env.AUTH_SECRET ||= "test-dummy-secret";
process.env.NEXTAUTH_URL ||= "http://localhost:3000";
process.env.PROCESSING_WEBHOOK_SECRET ||= "test-webhook-secret";
process.env.STEP_FUNCTION_ARN ||=
  "arn:aws:states:us-east-1:000000000000:stateMachine:test-dummy";
