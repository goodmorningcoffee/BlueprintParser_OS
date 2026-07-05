/**
 * POST /api/spec-parse/propose
 *
 * [refactor jul5 S026] Thin shell — behavior lives in services/spec-parse.ts
 * (specParsePropose). See ../route.ts for the rationale. NOTE: no UI consumer today
 * (SpecParser.tsx fetches only /api/spec-parse) — folded byte-faithful; owner disposition
 * (keep vs retire) tracked in the S026 session memory.
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { specParsePropose } from "@/server/services/spec-parse";

export const POST = defineRoute({
  auth: "none",
  body: zLooseBody,
  handler: ({ body }) => specParsePropose(body),
});
