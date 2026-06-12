import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
    // [refactor jun12 P0.3] route characterization harness wiring:
    // setup-env force-points DATABASE_URL at the local test db (safety rail —
    // tests can never touch a real database); global-setup migrates it fresh
    // once per run and provides `dbUp` (route tests skip when no local pg;
    // CI sets BP_REQUIRE_TEST_DB=1 so they can never silently skip there).
    setupFiles: ["src/test/setup-env.ts"],
    globalSetup: ["src/test/global-setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
