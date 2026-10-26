/**
 * POST /api/admin/reprocess  (company-wide detector re-run, NDJSON progress stream)
 *
 * [refactor P1 reprocess-fold jul8 S062] Thin shell — the 5 scope branches + the stream
 * live VERBATIM in services/reprocess.ts (the DEAD-LAST P1.5 solo). auth:"admin" (A:
 * byte-identical "Unauthorized"/"Admin only" messages, envelope shape only).
 * kind:"stream": the service's `new Response(stream, {x-ndjson, chunked})` passes through
 * untouched (viewer-perf pins: stream headers + the thumbnails IMMUTABLE cache-control).
 * rawBody:true per the §E-a OWNER DECISION (2026-07-08): the body swallow stays in-service
 * — no body/malformed/non-object → process ALL company projects (load-bearing for 4 of 5
 * consumers), and auth stays BEFORE parse (signed-out + malformed = 401; deliberately NOT
 * the PH-5b 400 flip). NO B — all post-auth failures are in-stream domain lines at 200.
 * Solo fold (char: admin-reprocess.route.test.ts + admin-reprocess-g3.route.test.ts).
 */

// [2026-10-25 root hardening] admitReprocess (services/reprocess-admission.ts) runs first: the
// shape-parse scope with Lambda CV on is ROOT ONLY (owner-billed fan-out), and every scope is audited.
import { defineRoute } from "@/server/api/defineRoute";
import { reprocessProjects } from "@/server/services/reprocess";
import { admitReprocess } from "@/server/services/reprocess-admission";

export const POST = defineRoute({
  auth: "admin",
  kind: "stream",
  rawBody: true,
  handler: ({ req, session }) => reprocessProjects(req, admitReprocess(session!, req)),
});
