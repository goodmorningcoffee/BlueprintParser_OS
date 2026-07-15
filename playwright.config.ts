// [refactor jun12 P0.4] Playwright e2e + viewer-perf harness.
//
// Two servers boot for a run (webServer array):
//   :9876 e2e/cdn-stub.mjs — HTTPS S3-shaped fixture endpoint. The app asset
//         gateway reads it with the test-only task-role client and preserves
//         the real Range contract without exposing a browser CDN URL.
//   :3100 next dev — pointed at the LOCAL test database (never live RDS).
//
// Browsers live on the WORKSPACE BIND MOUNT, not the container overlay: the
// Docker Desktop VM disk runs ~100% full (host-side; root cause of every
// "fs corruption" incident S001/S004/S005 — writes fail when it hits 0), and
// the overlay is wiped on container rebuild anyway. The bind mount has room
// and persists. Reinstall after deleting:
//   PLAYWRIGHT_BROWSERS_PATH=/workspaces/BlueprintParser_OS/.pw-browsers \
//     npx playwright install chromium --no-shell
// Perf numbers are DEV-MODE (turbopack) — compare phase-over-phase only,
// never against prod; mode is stamped into the perf JSON.
import { defineConfig } from "@playwright/test";

process.env.PLAYWRIGHT_BROWSERS_PATH ||=
  "/workspaces/BlueprintParser_OS/.pw-browsers";

const TEST_DATABASE_URL = "postgres://bp_test:bp_test@localhost:5433/bp_test";

export default defineConfig({
  testDir: "e2e",
  // Source-exact A/B protocols require detached worktrees and immutable output
  // identities. They run only through their dedicated configs.
  testIgnore: ["viewer-perf-v2.spec.ts", "annotation-owner-perf-v2.spec.ts"],
  globalSetup: "./e2e/global-setup.ts",
  timeout: 180_000,
  workers: 1, // perf measurements want the machine to themselves
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3100",
    ignoreHTTPSErrors: true, // the CDN stub's self-signed cert
    trace: "off", // disk is tight in this container
    video: "off",
    // full-chrome new-headless instead of the separate headless-shell build —
    // installed with --no-shell; avoids a second 120MB download.
    channel: "chromium",
  },
  webServer: [
    {
      command: "node e2e/cdn-stub.mjs",
      port: 9876,
      // Byte-accounting is part of the transport oracle; a stale pre-oracle stub must never satisfy
      // this port check and silently make the benchmark vacuous.
      reuseExistingServer: false,
      // A fresh clone generates the ignored 100-page PDF before binding the port.
      timeout: 120_000,
    },
    {
      // Start from the current route tree. Next 16's persistent `.next/dev` cache can survive an
      // interrupted run with a partial app-path manifest and return framework 404s for valid routes.
      command: "node e2e/start-dev-server.mjs -p 3100",
      port: 3100,
      // A pre-existing process would bypass both the clean launcher and this test-only DB/S3 env.
      reuseExistingServer: false,
      timeout: 240_000, // first turbopack compile is slow
      env: {
        DATABASE_URL: TEST_DATABASE_URL,
        S3_BUCKET: "e2e-dummy-bucket",
        BP_TEST_S3_ENDPOINT: "https://localhost:9876",
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
        NEXTAUTH_URL: "http://localhost:3100",
        NEXTAUTH_SECRET: "e2e-dummy-secret",
        AUTH_SECRET: "e2e-dummy-secret",
        AWS_EC2_METADATA_DISABLED: "true",
        AWS_ACCESS_KEY_ID: "e2e-dummy",
        AWS_SECRET_ACCESS_KEY: "e2e-dummy",
        AWS_REGION: "us-east-1",
      },
    },
  ],
});
