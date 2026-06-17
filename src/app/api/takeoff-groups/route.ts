// [refactor jun16 P1.2] Thin shell — all behavior lives in services/takeoff.ts.
// GET: shell session-auth + zod query (projectId). POST: validate-before-auth, so the
// shell does NO auth (auth:"none") and the service validates fields → resolves access →
// inserts (per-(project,kind) ladder + auto-CSI). See services/takeoff.ts.
import { z } from "zod";
import { defineRoute } from "@/server/api/defineRoute";
import { zPublicId, zLooseBody } from "@/server/api/schemas";
import { createTakeoffGroup, listTakeoffGroups } from "@/server/services/takeoff";

export const GET = defineRoute({
  auth: "session",
  query: z.object({ projectId: zPublicId }),
  handler: ({ session, query }) => listTakeoffGroups(session!, query.projectId),
});

export const POST = defineRoute({
  auth: "none",
  body: zLooseBody,
  handler: ({ body }) => createTakeoffGroup(body),
});
