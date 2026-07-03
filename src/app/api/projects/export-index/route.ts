// [refactor jul3 P1.5] Thin shell — behavior lives in services/export.ts (exportIndex).
// auth:"session" = the legacy AUTH-FIRST requireAuth shape. Scope stays the service's concern
// (root admin → ALL companies' projects — frozen; member → own company). ⚠️ External-tooling
// consumer — the 200 body is byte-identical to legacy.
import { defineRoute } from "@/server/api/defineRoute";
import { exportIndex } from "@/server/services/export";

export const GET = defineRoute({
  auth: "session",
  handler: ({ session }) => exportIndex(session!),
});
