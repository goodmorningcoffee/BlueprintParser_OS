/**
 * GET /api/demo/domain-knowledge  (public static domain-knowledge markdown, text/plain)
 *
 * [refactor jul8 S060] Thin auth:"none" shell (Option B) — behavior lives in
 * services/demo-landing.ts (getDemoDomainKnowledge). The service returns a RAW NextResponse
 * on BOTH branches (text/plain + Cache-Control "public, max-age=3600" happy path; "" 404 on
 * read failure) — the shell's result-instanceof-Response passthrough keeps the headers
 * (getPageTextract precedent). ZERO sanctioned diffs. Shell-fold (char:
 * demo-landing.route.test.ts DK-*).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { getDemoDomainKnowledge } from "@/server/services/demo-landing";

export const GET = defineRoute({
  auth: "none",
  handler: () => getDemoDomainKnowledge(),
});
