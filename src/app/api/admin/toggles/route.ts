/**
 * /api/admin/toggles
 *
 * Read the app-global feature toggles (sagemaker / quota) + their gating password, and mutate
 * them behind the INDEPENDENT bcrypt toggle-password subsystem. Admin only.
 *
 * [refactor jul7 S055] Thin shell — behavior lives in services/toggles.ts (getTogglesStatus /
 * updateToggle). auth:"admin" (A). GET no body → no E. PUT body:zLooseBody (E: legacy
 * `await req.json()` → shell "Invalid JSON body"). No catch-500 → no B. Solo fold (char:
 * admin-toggles.route.test.ts TG-*).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { getTogglesStatus, updateToggle } from "@/server/services/toggles";

export const GET = defineRoute({
  auth: "admin",
  handler: () => getTogglesStatus(),
});

export const PUT = defineRoute({
  auth: "admin",
  body: zLooseBody,
  handler: ({ body }) => updateToggle(body),
});
