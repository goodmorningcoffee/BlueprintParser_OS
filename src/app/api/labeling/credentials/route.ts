// P2 close-review tombstone. Label Studio is backed by one operator identity spanning every
// application tenant, so no application role — including root — may receive its bootstrap secret
// over HTTP. Keep a deterministic 410 while old clients drain; middleware rate-limits the route
// and samples its deprecated-route signal. Provider credentials remain server-only.
import { defineRoute } from "@/server/api/defineRoute";
import { ApiError } from "@/server/api/envelope";

export const GET = defineRoute({
  auth: "none",
  handler: () => {
    throw new ApiError(
      "NOT_FOUND",
      "Label Studio browser credentials are disabled",
      410,
    );
  },
});
