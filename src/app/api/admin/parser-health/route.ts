/**
 * /api/admin/parser-health
 *
 * Phase I.2.b: Run a whitelisted diagnostic command inside the container and
 * return its output to the admin debug UI. Replaces routine ECS exec for the
 * common "is the parser stack healthy?" checks.
 *
 * GET  → list available checks (for the UI dropdown)
 * POST → run one of the whitelisted checks and return {stdout, stderr, exitCode, durationMs}
 *
 * [refactor jul8 S061] Thin shells — behavior (incl. the CHECKS whitelist = the security
 * core) lives in services/parser-health.ts. auth:"admin" both methods; POST body:zLooseBody
 * (A on auth + the one 400 literal; E on malformed JSON; NO B — spawn failures are DOMAIN
 * data at 200). Solo fold (char: admin-parser-health.route.test.ts PH-*).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { listParserChecks, runParserCheck } from "@/server/services/parser-health";

export const GET = defineRoute({
  auth: "admin",
  handler: () => listParserChecks(),
});

export const POST = defineRoute({
  auth: "admin",
  body: zLooseBody,
  handler: ({ body }) => runParserCheck(body),
});
