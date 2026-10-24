/**
 * GET/PUT /api/admin/tiles  (ROOT ONLY — upload-time tile pyramid on/off + tile level sizes)
 *
 * [tiles T9 2026-10-24] Thin shells — behavior lives in services/tiles-setting.ts. auth:"root" on
 * BOTH methods: a company admin gets 403 and can neither read nor change the setting. PUT body is
 * strictly validated by zTilesPut (boolean + optional unique px sizes within plan.ts bounds; unknown
 * keys → 400). Modelled on /api/admin/upload-compute.
 */

import { defineRoute } from "@/server/api/defineRoute";
import { getTilesSetting, putTilesSetting, zTilesPut } from "@/server/services/tiles-setting";

export const GET = defineRoute({
  auth: "root",
  handler: () => getTilesSetting(),
});

export const PUT = defineRoute({
  auth: "root",
  body: zTilesPut,
  handler: ({ body, session }) => putTilesSetting(body, session!),
});
