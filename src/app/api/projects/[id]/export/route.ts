// [refactor jul3 P1.5] Thin shell — behavior lives in services/export.ts (exportProject).
// auth:"none" + service-resolved access (resolveProjectOrThrow allowDemo:true — demo projects
// export WITHOUT auth, unknown → 404 before auth, root bypass; the legacy resolveProjectAccess
// engine, unchanged). ⚠️ The bp-export/1 bundle is an EXTERNAL-tooling ingest contract — the 200
// body is byte-identical to legacy (the shell json-envelopes the returned object with no extra
// headers, exactly like legacy NextResponse.json).
import { defineRoute } from "@/server/api/defineRoute";
import { exportProject } from "@/server/services/export";

export const GET = defineRoute({
  auth: "none",
  handler: ({ req, params }) => exportProject(req, params.id),
});
