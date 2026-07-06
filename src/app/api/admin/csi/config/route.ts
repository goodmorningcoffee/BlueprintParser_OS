/**
 * GET/PUT /api/admin/csi/config
 *
 * [refactor jul6 S037] Thin shells — behavior lives in services/company-settings.ts
 * (getCsiConfig/putCsiConfig; GET's TSV stats block ported verbatim). auth:"admin" (A).
 * PUT body is z.unknown(), NOT zLooseBody: legacy stored WHATEVER JSON arrived
 * (scalars/null accepted and written — frozen CSI-4); an empty body throws in-service
 * (legacy 500-class, no write). Part of the ADMIN B1 six-clone batch
 * (char: __tests__/admin-config.route.test.ts CSI-*).
 */

import { z } from "zod";
import { defineRoute } from "@/server/api/defineRoute";
import { getCsiConfig, putCsiConfig } from "@/server/services/company-settings";

export const GET = defineRoute({
  auth: "admin",
  handler: ({ session }) => getCsiConfig(session!),
});

export const PUT = defineRoute({
  auth: "admin",
  body: z.unknown(),
  handler: ({ session, body }) => putCsiConfig(session!, body),
});
