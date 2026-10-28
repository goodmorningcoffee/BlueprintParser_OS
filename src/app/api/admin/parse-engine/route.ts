/**
 * GET/PUT /api/admin/parse-engine  (ROOT ONLY — the parse-engine kill switch, per-tool legacy/engine
 * modes and the standard crop-cache switch; `app_settings.parseEngine`)
 *
 * [TP-3 WP-3.E] Thin shells — behavior lives in services/parse-engine/flags-admin.ts. auth:"root" on
 * BOTH methods. PUT body strictly validated by zParseEngineFlagsPut (unknown keys, tools or modes →
 * 400); the write and its audit_log row commit in one transaction. The generic app-settings route
 * refuses this key. Modelled on /api/admin/tiles.
 */

import { defineRoute } from "@/server/api/defineRoute";
import {
  getParseEngineFlagsAdmin,
  putParseEngineFlags,
  zParseEngineFlagsPut,
} from "@/server/services/parse-engine/flags-admin";

export const GET = defineRoute({
  auth: "root",
  handler: () => getParseEngineFlagsAdmin(),
});

export const PUT = defineRoute({
  auth: "root",
  body: zParseEngineFlagsPut,
  handler: ({ body, session }) => putParseEngineFlags(body, session!),
});
