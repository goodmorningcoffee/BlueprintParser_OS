// [refactor jul3 P1.5] Thin shell — behavior lives in services/export.ts (exportProject).
// auth:"session" makes the bp-export/1 external-tooling bundle authenticated project data. The
// service still resolves tenancy/root access after the shell's auth-first boundary. The 200
// body is byte-identical to legacy (the shell json-envelopes the returned object with no extra
// headers, exactly like legacy NextResponse.json).
import { defineRoute } from "@/server/api/defineRoute";
import { exportProject } from "@/server/services/export";

export const GET = defineRoute({
  auth: "session",
  handler: ({ req, params }) => exportProject(req, params.id),
});
