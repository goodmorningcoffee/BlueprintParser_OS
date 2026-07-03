// [refactor jul3 P1.5] Thin shell — behavior lives in services/labeling.ts (listLabelingSessions).
// auth:"session" = the legacy AUTH-FIRST shape (requireAuth 401 fired BEFORE the projectId-required
// 400). NO declarative `query` schema: zodToApiError prepends the field path ("projectId: Required")
// which would corrupt the verbatim "projectId required" message — the service validates imperatively.
import { defineRoute } from "@/server/api/defineRoute";
import { listLabelingSessions } from "@/server/services/labeling";

export const GET = defineRoute({
  auth: "session",
  handler: ({ req, session }) =>
    listLabelingSessions(new URL(req.url).searchParams.get("projectId"), session!),
});
