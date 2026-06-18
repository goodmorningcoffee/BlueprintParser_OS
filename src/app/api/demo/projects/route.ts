// [refactor jun18 P1.4 demo fold] Thin shell — the public demo gallery LIST.
//
// ALL behavior now lives in services/projects.ts `listDemoProjects` — a SEPARATE auth:"none" read that shares
// NOTHING with the authed listProjects (its sole gate is WHERE isDemo=true; no session, no companyId scope,
// no root-bypass). Option B (owner-locked): the demo endpoint STAYS as a dedicated auth:"none" route; only
// its behavior moves into the service layer. Zero live-behavior change for real callers — no client switch,
// no path change (demo/page.tsx:49 keeps hitting this URL and consumes the same bare array).
//
// Sanctioned diff (enumerated on the service fn): an unexpected DB error → the shell's leak-free INTERNAL 500
// (legacy GET() had no try/catch → a raw 500 that could leak a stack). The 200 response is byte-identical — a
// BARE ARRAY of exactly {id,name,numPages,status,thumbnailUrl}, oldest-first — so there is NO success-envelope
// flip (a bare array has no {error} shape), and this route has no path param / no body (the [id] fold's
// non-uuid→400 and body-shape diffs do not apply).
import { defineRoute } from "@/server/api/defineRoute";
import { listDemoProjects } from "@/server/services/projects";

export const GET = defineRoute({
  auth: "none",
  handler: () => listDemoProjects(),
});
