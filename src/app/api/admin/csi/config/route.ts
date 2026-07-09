/**
 * GET/PUT /api/admin/csi/config
 *
 * [refactor jul6 S037] Thin shells — behavior lives in services/company-settings.ts
 * (getCsiConfig/putCsiConfig; GET's TSV stats block ported verbatim). auth:"admin" (A).
 *
 * [refactor jul9 P2-A C1] PUT body is now zod-validated (zCsiConfigPut) — [C1 approval
 * 2026-07-09; supersedes S037 keep-z.unknown decision]. The old accept-anything z.unknown()
 * (legacy stored WHATEVER JSON arrived — scalars/null written; empty body threw in-service
 * → 500) is superseded: malformed/scalar/null/array/non-positive-threshold bodies now 400
 * VALIDATION with no write (D-3/D-4/D-15), unknown keys stripped and the custom-DB pointer
 * triple server-preserved (D-5). GET is unchanged. Part of the ADMIN B1 six-clone batch
 * (char: __tests__/admin-config.route.test.ts CSI-*).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zCsiConfigPut } from "@/server/api/schemas";
import { getCsiConfig, putCsiConfig } from "@/server/services/company-settings";

export const GET = defineRoute({
  auth: "admin",
  handler: ({ session }) => getCsiConfig(session!),
});

export const PUT = defineRoute({
  auth: "admin",
  body: zCsiConfigPut,
  handler: ({ session, body }) => putCsiConfig(session!, body),
});
