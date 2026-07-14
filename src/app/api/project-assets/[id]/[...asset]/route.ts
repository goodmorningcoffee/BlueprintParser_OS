import { defineRoute } from "@/server/api/defineRoute";
import {
  serveProjectAsset,
  withProjectAssetResponsePolicy,
} from "@/server/services/project-assets";

/**
 * Canonical browser asset gateway. Private projects require a tenant session;
 * published demos use the access engine's explicit public-demo scope. Both
 * paths remain same-origin and the storage root is never returned to clients.
 *
 * Keep this route at depth four: Next 16.2.4's dev router omits depth-five app
 * routes, while this gateway must behave identically in Playwright and builds.
 */
const getProjectAsset = defineRoute({
  auth: { project: { param: "id", allowDemo: true } },
  kind: "raw",
  handler: ({ req, params, project }) =>
    serveProjectAsset(req, project!, params.asset as unknown),
});

/** Security/cache headers must cover shell-generated 401/404/500 responses too. */
export const GET: typeof getProjectAsset = async (req, segment) =>
  withProjectAssetResponsePolicy(await getProjectAsset(req, segment), {
    pdfRangeProbe: true,
  });
