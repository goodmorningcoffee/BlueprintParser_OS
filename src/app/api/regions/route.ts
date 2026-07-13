// [refactor jul13 P2.4 W1] Durable generic ParsedRegion deletion. Project access is resolved by
// the route shell from the strict publicId body contract. allowDemo permits normal demo-project
// resolution, but every demo write is rejected here, including owning admins and root admins.
import { z } from "zod";
import { defineRoute } from "@/server/api/defineRoute";
import { ApiError } from "@/server/api/envelope";
import { zPageNumber, zPublicId } from "@/server/api/schemas";
import { deleteParsedRegion } from "@/server/services/regions";

const deleteRegionBody = z
  .object({
    publicId: zPublicId,
    pageNumber: zPageNumber,
    regionId: z.string().min(1),
  })
  .strict();

export const DELETE = defineRoute({
  auth: { project: { bodyKey: "publicId", allowDemo: true } },
  body: deleteRegionBody,
  handler: ({ body, project }) => {
    if (project!.isDemo) {
      throw new ApiError("FORBIDDEN", "Demo projects are read-only");
    }
    return deleteParsedRegion(project!.id, body.pageNumber, body.regionId);
  },
});
