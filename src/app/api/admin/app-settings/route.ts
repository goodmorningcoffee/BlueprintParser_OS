/**
 * GET/PUT /api/admin/app-settings
 *
 * GET → read all app settings (admin). PUT → upsert one setting (ROOT admin only, via the
 * in-service secondary gate).
 *
 * [refactor jul6 S047] Thin shells — behavior lives in services/app-settings.ts
 * (getAppSettings / putAppSetting). auth:"admin" (A) for BOTH methods — ⚠️ PUT's root
 * restriction is a SECONDARY in-service isRootAdmin check ("Root admin required"/403), NOT the
 * shell auth level (bumping to auth:"root" would break the admin-readable GET). PUT
 * body:zLooseBody (E: legacy `await req.json()` → shell "Invalid JSON body"). Solo fold
 * (char: admin-app-settings.route.test.ts AS-*).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { getAppSettings, putAppSetting } from "@/server/services/app-settings";

export const GET = defineRoute({
  auth: "admin",
  handler: () => getAppSettings(),
});

export const PUT = defineRoute({
  auth: "admin",
  body: zLooseBody,
  handler: ({ body, session }) => putAppSetting(body, session!),
});
