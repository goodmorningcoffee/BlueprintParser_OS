/**
 * GET /api/projects/[id]/parse-engine/flags — the effective parse-engine flags (code defaults, the
 * stored `app_settings.parseEngine` document and the kill switch). Thin shell — behavior lives in
 * services/parse-engine/flags.ts. [TP-2 WP-2.E]
 * allowDemo:true: the viewer of a demo project needs the same switches; the response is global and
 * carries no project data (a fixed public projection, PUBLIC_DEMO_SURFACES "parse-engine-flags").
 */
import { defineRoute } from "@/server/api/defineRoute";
import { getParseEngineFlags } from "@/server/services/parse-engine/flags";

export const GET = defineRoute({
  auth: { project: { param: "id", allowDemo: true } },
  handler: () => getParseEngineFlags(),
});
