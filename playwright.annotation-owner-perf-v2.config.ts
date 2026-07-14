// P2.2.6 direct-parent annotation-owner A/B harness. Tests and fixtures stay in the owner
// checkout; Next and the generated derivative spec run from an exact detached app worktree.
import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";

const HARNESS_ROOT = process.cwd();
process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve(HARNESS_ROOT, "..", ".pw-browsers");

const APP_ROOT = resolve(process.env.PERF_APP_ROOT || HARNESS_ROOT);
const TEST_DATABASE_URL = "postgres://bp_test:bp_test@localhost:5433/bp_test";

export default defineConfig({
  testDir: resolve(APP_ROOT, "e2e"),
  testMatch: "annotation-owner-perf-v2.spec.ts",
  globalSetup: resolve(HARNESS_ROOT, "e2e/global-setup.ts"),
  timeout: 240_000,
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3100",
    ignoreHTTPSErrors: true,
    trace: "off",
    video: "off",
    channel: "chromium",
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
  },
  webServer: [
    {
      command: "node e2e/cdn-stub.mjs",
      cwd: HARNESS_ROOT,
      port: 9876,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "npm run dev -- -p 3100",
      cwd: APP_ROOT,
      port: 3100,
      reuseExistingServer: false,
      timeout: 240_000,
      env: {
        DATABASE_URL: TEST_DATABASE_URL,
        CLOUDFRONT_DOMAIN: "localhost:9876",
        NEXT_PUBLIC_CLOUDFRONT_DOMAIN: "localhost:9876",
        S3_BUCKET: "e2e-dummy-bucket",
        NEXT_PUBLIC_S3_BUCKET: "e2e-dummy-bucket",
        NEXTAUTH_URL: "http://localhost:3100",
        NEXTAUTH_SECRET: "e2e-dummy-secret",
        AUTH_SECRET: "e2e-dummy-secret",
        AWS_EC2_METADATA_DISABLED: "true",
        AWS_ACCESS_KEY_ID: "e2e-dummy",
        AWS_SECRET_ACCESS_KEY: "e2e-dummy",
        AWS_REGION: "us-east-1",
        NEXT_PUBLIC_BP_PERF_APP_SHA: process.env.PERF_APP_SHA || "missing-source-sha",
      },
    },
  ],
});
