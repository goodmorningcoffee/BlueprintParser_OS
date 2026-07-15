// Versioned populated P2.3 A/B harness. Playwright/test/fixture live in this checkout; only the
// Next dev server cwd changes between exact detached production-source worktrees.
import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";

// The protocol invokes Playwright from the owner harness root. Keep this CJS-loader-compatible:
// Playwright transpiles TS config through CJS in this repository, so import.meta.url is unavailable.
const HARNESS_ROOT = process.cwd();
process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve(
  HARNESS_ROOT,
  "..",
  ".pw-browsers",
);

const APP_ROOT = resolve(process.env.PERF_APP_ROOT || HARNESS_ROOT);
const TEST_DATABASE_URL = "postgres://bp_test:bp_test@localhost:5433/bp_test";

export default defineConfig({
  testDir: "e2e",
  testMatch: "viewer-perf-v2.spec.ts",
  globalSetup: "./e2e/global-setup.ts",
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
      // A fresh clone generates the ignored 100-page PDF before binding the port.
      timeout: 120_000,
    },
    {
      command: "node e2e/start-dev-server.mjs -p 3100",
      cwd: HARNESS_ROOT,
      port: 3100,
      reuseExistingServer: false,
      timeout: 240_000,
      env: {
        DATABASE_URL: TEST_DATABASE_URL,
        BP_E2E_APP_ROOT: APP_ROOT,
        BP_TEST_S3_ENDPOINT: "https://localhost:9876",
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
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
        NEXT_PUBLIC_BP_PERF_APP_SHA:
          process.env.PERF_APP_SHA || "missing-source-sha",
      },
    },
  ],
});
