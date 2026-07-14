import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { assertProjectWritable } from "@/server/api/access";
import { zPublicId } from "@/server/api/schemas";

/**
 * Resolve the public demo bit before auth so the canonical 403 is role-independent.
 * Invalid and private IDs intentionally continue into the caller's legacy auth/gate order.
 */
export async function assertDemoYoloTargetReadOnly(
  projectId: unknown,
): Promise<void> {
  const parsed = zPublicId.safeParse(projectId);
  if (!parsed.success) return;

  const [target] = await db
    .select({
      id: projects.id,
      publicId: projects.publicId,
      companyId: projects.companyId,
      isDemo: projects.isDemo,
      lifecycleEpoch: projects.lifecycleEpoch,
      updatedAt: projects.updatedAt,
    })
    .from(projects)
    .where(eq(projects.publicId, parsed.data))
    .limit(1);

  if (target?.isDemo) assertProjectWritable(target);
}
