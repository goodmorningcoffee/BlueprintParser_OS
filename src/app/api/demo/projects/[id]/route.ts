// [refactor jun18 P1.4 demo fold] Thin shell — the public demo project-by-id bootstrap.
//
// ALL behavior now lives in services/projects.ts `getDemoProject` — a SEPARATE auth:"none" read that shares
// NOTHING with the authed getProject (its sole gate is WHERE isDemo=true; no session, no companyId scope, no
// root-bypass). Sanctioned diffs (enumerated on the service fn): the 404 envelope flips
// {error:"Not found"} → {error:{code,message}}; a non-uuid id → clean 400 "Invalid project id" (was an
// unhandled pg uuid-cast throw); an unexpected DB error → the shell's leak-free INTERNAL 500. The demoConfig
// {}-fallback try/catch is preserved verbatim. Zero live-behavior change for real callers — same auth:"none"
// path, no client switch (the demo viewer keeps hitting this URL).
import { defineRoute } from "@/server/api/defineRoute";
import { getDemoProject } from "@/server/services/projects";

export const GET = defineRoute({
  auth: "none",
  handler: ({ params }) => getDemoProject(params.id),
});
