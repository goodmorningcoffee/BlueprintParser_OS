// [refactor jul3 P1.5] Thin shell — behavior lives in services/labeling.ts (getLabelingCredentials).
// auth:"none" is MANDATORY (not auth:"admin"): the legacy gate returns 403 "Admin only" for a
// SIGNED-OUT caller — defineRoute's requireSession("admin") would 401 a null session before the
// role check. The service resolves auth() itself to keep the ONE combined 403 gate byte-faithful.
import { defineRoute } from "@/server/api/defineRoute";
import { getLabelingCredentials } from "@/server/services/labeling";

export const GET = defineRoute({
  auth: "none",
  handler: () => getLabelingCredentials(),
});
