/**
 * GET/PUT /api/admin/text-annotations/config
 *
 * [refactor jul6 S037] Thin shells — behavior lives in services/company-settings.ts
 * (getTextAnnotationConfig/putTextAnnotationConfig; registry validation + the subkey
 * REBUILD + updatedAt touch preserved). auth:"admin" (A). PUT body:zLooseBody (E);
 * both field-validation literals (incl. the dynamic "Unknown detector IDs:" join) stay
 * in-service, byte-verbatim. Part of the ADMIN B1 six-clone batch
 * (char: __tests__/admin-config.route.test.ts TA-*).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { getTextAnnotationConfig, putTextAnnotationConfig } from "@/server/services/company-settings";

export const GET = defineRoute({
  auth: "admin",
  handler: ({ session }) => getTextAnnotationConfig(session!),
});

export const PUT = defineRoute({
  auth: "admin",
  body: zLooseBody,
  handler: ({ session, body }) => putTextAnnotationConfig(session!, body),
});
