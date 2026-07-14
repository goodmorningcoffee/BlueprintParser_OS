// [refactor jul6 S045] admin/demo SOLO — POST refresh-demo-projects OR toggle a project's
// isDemo flag, folded from the legacy route (git show 7976990:src/app/api/admin/demo/route.ts).
// Char: __tests__/admin-demo.route.test.ts (DEMO-*). requireAdmin (the shell provides
// auth:"admin"). Sanctioned diffs:
//   • A — flat auth errors → envelope; the "projectId and isDemo required" 400 literal stays
//     byte-verbatim as ApiError("VALIDATION", ...).
//   • E — legacy `await req.json()` (no try/catch) subsumed by the shell raw-parse (malformed
//     → 400 BAD_REQUEST "Invalid JSON body").
//   • NO B — no catch-500 literal; unexpected db errors → shell generic INTERNAL 500.
// PRESERVED byte-exact: BOTH writes carry the companyId tenancy guard (eq(projects.companyId,
// session.user.companyId) — NO root bypass); the isDemo=true refresh filter + .returning(id);
// the set-branch publicId+companyId WHERE; new Date() updatedAt bumps.

import { db } from "@/lib/db";
import {
  labelStudioProjectIntents,
  labelingSessions,
  processingJobs,
  projectMutationLeases,
  projects,
} from "@/lib/db/schema";
import { eq, and, sql } from "drizzle-orm";
import type { AuthSession } from "@/lib/api-utils";
import { PROJECT_UPLOAD_PUBLICATION_FENCE_SECONDS } from "@/lib/project-upload-authority";
import { ApiError } from "@/server/api/envelope";

export async function manageDemo(
  rawBody: Record<string, unknown>,
  session: AuthSession,
): Promise<unknown> {
  const body = rawBody as {
    action?: unknown;
    projectId?: unknown;
    isDemo?: unknown;
  };

  // Refresh all demo projects (bust caches, confirm sync)
  if (body.action === "refresh") {
    const result = await db
      .update(projects)
      .set({
        lifecycleEpoch: sql`${projects.lifecycleEpoch} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(projects.isDemo, true),
          eq(projects.companyId, session.user.companyId),
        ),
      )
      .returning({ id: projects.id });

    return { success: true, refreshed: result.length };
  }

  const { projectId, isDemo } = body as {
    projectId?: string;
    isDemo?: unknown;
  };

  if (!projectId || typeof isDemo !== "boolean") {
    throw new ApiError("VALIDATION", "projectId and isDemo required");
  }

  if (isDemo) {
    await db.transaction(async (tx) => {
      const [project] = await tx
        .select({
          id: projects.id,
          status: projects.status,
          isDemo: projects.isDemo,
          uploadAuthorityActive: sql<boolean>`
            ${projects.createdAt} IS NULL
            OR ${projects.createdAt}
              + (${PROJECT_UPLOAD_PUBLICATION_FENCE_SECONDS} * INTERVAL '1 second')
              > CURRENT_TIMESTAMP
          `,
        })
        .from(projects)
        .where(
          and(
            eq(projects.publicId, projectId),
            eq(projects.companyId, session.user.companyId),
          ),
        )
        .for("update")
        .limit(1);

      // Preserve the legacy cross-company/missing-target silent no-op.
      if (!project) return;
      if (project.status !== "completed") {
        throw new ApiError(
          "CONFLICT",
          "Project must be completed before publishing",
        );
      }
      const [activeJob] = await tx
        .select({ id: processingJobs.id })
        .from(processingJobs)
        .where(
          and(
            eq(processingJobs.projectId, project.id),
            eq(processingJobs.status, "running"),
          ),
        )
        .limit(1);
      if (activeJob) {
        throw new ApiError("CONFLICT", "Project has an active processing job");
      }

      // Heartbeat expiry is diagnostic, not proof that an external system stopped. Only explicit
      // release retires an active lease; crashed workers therefore fail publication closed until
      // provider/operator reconciliation. This also makes publisher host clock skew irrelevant.
      const [activeLease] = await tx
        .select({ token: projectMutationLeases.token })
        .from(projectMutationLeases)
        .where(
          and(
            eq(projectMutationLeases.projectId, project.id),
            eq(projectMutationLeases.status, "active"),
          ),
        )
        .limit(1);
      if (activeLease) {
        throw new ApiError("CONFLICT", "Project has an active mutation lease");
      }

      // Label Studio is a separately mutable system with long-lived admin authority. Until a
      // session is explicitly deleted there is no immutable snapshot to expose as a public demo.
      const [linkedLabelingSession] = await tx
        .select({ id: labelingSessions.id })
        .from(labelingSessions)
        .where(eq(labelingSessions.projectId, project.id))
        .limit(1);
      if (linkedLabelingSession) {
        throw new ApiError("CONFLICT", "Project has linked labeling sessions");
      }
      const [pendingLabelStudioProject] = await tx
        .select({ id: labelStudioProjectIntents.id })
        .from(labelStudioProjectIntents)
        .where(eq(labelStudioProjectIntents.projectId, project.id))
        .limit(1);
      if (pendingLabelStudioProject) {
        throw new ApiError(
          "CONFLICT",
          "Project has pending Label Studio provisioning",
        );
      }
      if (project.uploadAuthorityActive) {
        throw new ApiError(
          "CONFLICT",
          "Project upload credentials are still active",
        );
      }

      await tx
        .update(projects)
        .set({
          isDemo: true,
          lifecycleEpoch: sql`${projects.lifecycleEpoch} + 1`,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(eq(projects.id, project.id));
    });
  } else {
    // Withdrawal is always permitted. It is the recovery step required before generic writes.
    await db.transaction(async (tx) => {
      const [project] = await tx
        .select({ id: projects.id, isDemo: projects.isDemo })
        .from(projects)
        .where(
          and(
            eq(projects.publicId, projectId),
            eq(projects.companyId, session.user.companyId),
          ),
        )
        .for("update")
        .limit(1);
      if (!project) return;
      await tx
        .update(projects)
        .set(
          project.isDemo
            ? {
                isDemo: false,
                lifecycleEpoch: sql`${projects.lifecycleEpoch} + 1`,
                updatedAt: new Date(),
              }
            : { updatedAt: new Date() },
        )
        .where(eq(projects.id, project.id));
    });
  }

  return { success: true };
}
