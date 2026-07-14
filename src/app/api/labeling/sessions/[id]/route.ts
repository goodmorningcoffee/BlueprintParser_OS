// [refactor jul3 P1.5] Thin shell — behavior lives in services/labeling.ts (deleteLabelingSession).
// auth:"session" = legacy AUTH-FIRST. The id stays a raw string into the service (parseInt there,
// verbatim — trailing-garbage tolerance + the frozen NaN→500 are the service's to preserve).
import { defineRoute } from "@/server/api/defineRoute";
import { deleteLabelingSession } from "@/server/services/labeling";

export const DELETE = defineRoute({
  auth: "none",
  handler: ({ params }) => deleteLabelingSession(params.id),
});
