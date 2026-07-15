// @vitest-environment node
import { beforeEach, describe, expect, inject, it, vi } from "vitest";

const boundaries = vi.hoisted(() => ({
  failStorageRoot: null as string | null,
  monitoredProjectIds: [] as number[],
  monitoredStorageRoots: [] as string[],
  monitoredUserId: null as number | null,
  finalCalls: [] as string[],
  stagingCalls: [] as string[],
  snapshots: [] as Array<{
    storageRoot: string;
    projectCount: number;
    tombstoneCount: number;
    userCount: number;
  }>,
}));

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

vi.mock("@/lib/cloudfront", () => ({
  ensureProjectCloudFrontInvalidation: vi.fn(async () => ({
    id: "atomic-cascade-invalidation",
    complete: true,
  })),
}));

vi.mock("@/lib/s3", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/s3")>();
  return {
    ...original,
    deleteProjectFiles: vi.fn(async (storageRoot: string) => {
      const { db } = await import("@/lib/db");
      const { projectAssetDeletions, projects, users } =
        await import("@/lib/db/schema");
      const { eq, inArray } = await import("drizzle-orm");
      const [projectRows, tombstones, userRows] = await Promise.all([
        db
          .select({ id: projects.id })
          .from(projects)
          .where(inArray(projects.id, boundaries.monitoredProjectIds)),
        db
          .select({ id: projectAssetDeletions.id })
          .from(projectAssetDeletions)
          .where(
            inArray(
              projectAssetDeletions.storageRoot,
              boundaries.monitoredStorageRoots,
            ),
          ),
        db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, boundaries.monitoredUserId!)),
      ]);
      boundaries.finalCalls.push(storageRoot);
      boundaries.snapshots.push({
        storageRoot,
        projectCount: projectRows.length,
        tombstoneCount: tombstones.length,
        userCount: userRows.length,
      });
      if (boundaries.failStorageRoot === storageRoot) {
        throw new Error("simulated first-project S3 outage");
      }
      return { deletedObjects: 0, emptySweepObserved: true };
    }),
    deleteProjectStagingFiles: vi.fn(async (storageRoot: string) => {
      boundaries.stagingCalls.push(storageRoot);
      if (boundaries.failStorageRoot === storageRoot) {
        throw new Error("simulated first-project staging outage");
      }
      return { deletedObjects: 0, emptySweepObserved: true };
    }),
  };
});

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  annotationGroups,
  annotations,
  chatMessages,
  processingJobs,
  projectAssetDeletions,
  projects,
  users,
} from "@/lib/db/schema";
import { deleteUser } from "@/server/services/admin-users";
import {
  ageProjectForPublication,
  asUser,
  createCompany,
  createProject,
  createUser,
  sessionState,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

beforeEach(() => {
  boundaries.failStorageRoot = null;
  boundaries.monitoredProjectIds.length = 0;
  boundaries.monitoredStorageRoots.length = 0;
  boundaries.monitoredUserId = null;
  boundaries.finalCalls.length = 0;
  boundaries.stagingCalls.length = 0;
  boundaries.snapshots.length = 0;
});

describe.skipIf(!dbUp)("admin user cascade atomicity", () => {
  it("rolls back every project, outbox, attribution change, and the user when project two is not quiescent", async () => {
    const company = await createCompany();
    const admin = await createUser(company.id, { role: "admin" });
    const victim = await createUser(company.id);
    const [victimIdentity] = await db
      .select({ publicId: users.publicId })
      .from(users)
      .where(eq(users.id, victim.id));
    const first = await createProject(company.id, victim.id);
    const blocked = await createProject(company.id, victim.id);
    const referenced = await createProject(company.id, admin.id);
    await Promise.all([
      ageProjectForPublication(first.id),
      ageProjectForPublication(blocked.id),
    ]);
    const [attribution] = await db
      .insert(annotations)
      .values({
        projectId: referenced.id,
        creatorId: victim.id,
        name: "must-survive-rollback",
        minX: 0,
        minY: 0,
        maxX: 1,
        maxY: 1,
        pageNumber: 1,
      })
      .returning({ id: annotations.id });
    await db.insert(processingJobs).values({
      projectId: blocked.id,
      status: "running",
      executionId: `atomic-cascade-blocker-${blocked.id}`,
    });

    asUser(admin);
    await expect(
      deleteUser(sessionState.current!, {
        id: victimIdentity.publicId,
        mode: "cascade",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Project has an active processing job",
    });

    const [survivingProjects, tombstones, survivingUser, survivingAttribution] =
      await Promise.all([
        db
          .select({ id: projects.id })
          .from(projects)
          .where(inArray(projects.id, [first.id, blocked.id])),
        db
          .select({ id: projectAssetDeletions.id })
          .from(projectAssetDeletions)
          .where(
            inArray(projectAssetDeletions.storageRoot, [
              first.dataUrl,
              blocked.dataUrl,
            ]),
          ),
        db.select({ id: users.id }).from(users).where(eq(users.id, victim.id)),
        db
          .select({ creatorId: annotations.creatorId })
          .from(annotations)
          .where(eq(annotations.id, attribution.id)),
      ]);
    expect(survivingProjects.map((row) => row.id).sort()).toEqual(
      [first.id, blocked.id].sort(),
    );
    expect(tombstones).toHaveLength(0);
    expect(survivingUser).toHaveLength(1);
    expect(survivingAttribution).toEqual([{ creatorId: victim.id }]);
    expect(boundaries.finalCalls).toHaveLength(0);
    expect(boundaries.stagingCalls).toHaveLength(0);
  });

  it("commits the full DB unit before S3 and continues to the next outbox after one reconcile failure", async () => {
    const company = await createCompany();
    const admin = await createUser(company.id, { role: "admin" });
    const victim = await createUser(company.id);
    const [victimIdentity] = await db
      .select({ publicId: users.publicId })
      .from(users)
      .where(eq(users.id, victim.id));
    const first = await createProject(company.id, victim.id);
    const second = await createProject(company.id, victim.id);
    await Promise.all([
      ageProjectForPublication(first.id),
      ageProjectForPublication(second.id),
    ]);
    boundaries.failStorageRoot = first.dataUrl;
    boundaries.monitoredProjectIds.push(first.id, second.id);
    boundaries.monitoredStorageRoots.push(first.dataUrl, second.dataUrl);
    boundaries.monitoredUserId = victim.id;

    asUser(admin);
    await expect(
      deleteUser(sessionState.current!, {
        id: victimIdentity.publicId,
        mode: "cascade",
      }),
    ).resolves.toEqual({ success: true, mode: "cascade", projectCount: 2 });

    expect(boundaries.finalCalls).toEqual(
      expect.arrayContaining([first.dataUrl, second.dataUrl]),
    );
    expect(boundaries.stagingCalls).toEqual(
      expect.arrayContaining([first.dataUrl, second.dataUrl]),
    );
    expect(boundaries.snapshots.length).toBeGreaterThan(0);
    for (const snapshot of boundaries.snapshots) {
      expect.soft(snapshot.projectCount).toBe(0);
      expect.soft(snapshot.tombstoneCount).toBe(2);
      expect.soft(snapshot.userCount).toBe(0);
    }
    expect(
      await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, victim.id)),
    ).toHaveLength(0);
    expect(
      await db
        .select({ id: projects.id })
        .from(projects)
        .where(inArray(projects.id, [first.id, second.id])),
    ).toHaveLength(0);
    const outboxes = await db
      .select({
        storageRoot: projectAssetDeletions.storageRoot,
        status: projectAssetDeletions.status,
        phase: projectAssetDeletions.phase,
      })
      .from(projectAssetDeletions)
      .where(
        inArray(projectAssetDeletions.storageRoot, [
          first.dataUrl,
          second.dataUrl,
        ]),
      );
    expect(outboxes).toHaveLength(2);
    expect(outboxes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          storageRoot: first.dataUrl,
          status: "pending",
          phase: "purge",
        }),
        expect.objectContaining({
          storageRoot: second.dataUrl,
          status: "watching",
          phase: "watch",
        }),
      ]),
    );
  });

  it("deletes owned projects while preserving a locked private project and nulling every victim attribution", async () => {
    const company = await createCompany();
    const admin = await createUser(company.id, { role: "admin" });
    const victim = await createUser(company.id);
    const [victimIdentity] = await db
      .select({ publicId: users.publicId })
      .from(users)
      .where(eq(users.id, victim.id));
    const owned = await createProject(company.id, victim.id);
    const referenced = await createProject(company.id, admin.id);
    await ageProjectForPublication(owned.id);
    const [annotation] = await db
      .insert(annotations)
      .values({
        projectId: referenced.id,
        creatorId: victim.id,
        name: "private-attribution",
        minX: 0,
        minY: 0,
        maxX: 1,
        maxY: 1,
        pageNumber: 1,
      })
      .returning({ id: annotations.id });
    const [chat] = await db
      .insert(chatMessages)
      .values({
        projectId: referenced.id,
        userId: victim.id,
        role: "user",
        content: "private attribution",
      })
      .returning({ id: chatMessages.id });
    const [group] = await db
      .insert(annotationGroups)
      .values({
        projectId: referenced.id,
        createdBy: victim.id,
        name: "private attribution",
      })
      .returning({ id: annotationGroups.id });
    boundaries.monitoredProjectIds.push(owned.id);
    boundaries.monitoredStorageRoots.push(owned.dataUrl);
    boundaries.monitoredUserId = victim.id;

    asUser(admin);
    await expect(
      deleteUser(sessionState.current!, {
        id: victimIdentity.publicId,
        mode: "cascade",
      }),
    ).resolves.toEqual({ success: true, mode: "cascade", projectCount: 1 });

    const [
      ownedRows,
      referencedRows,
      userRows,
      annotationRows,
      chatRows,
      groupRows,
    ] = await Promise.all([
      db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, owned.id)),
      db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, referenced.id)),
      db.select({ id: users.id }).from(users).where(eq(users.id, victim.id)),
      db
        .select({ creatorId: annotations.creatorId })
        .from(annotations)
        .where(eq(annotations.id, annotation.id)),
      db
        .select({ userId: chatMessages.userId })
        .from(chatMessages)
        .where(eq(chatMessages.id, chat.id)),
      db
        .select({ createdBy: annotationGroups.createdBy })
        .from(annotationGroups)
        .where(eq(annotationGroups.id, group.id)),
    ]);
    expect(ownedRows).toHaveLength(0);
    expect(referencedRows).toEqual([{ id: referenced.id }]);
    expect(userRows).toHaveLength(0);
    expect(annotationRows).toEqual([{ creatorId: null }]);
    expect(chatRows).toEqual([{ userId: null }]);
    expect(groupRows).toEqual([{ createdBy: null }]);
    expect(
      await db
        .select({ storageRoot: projectAssetDeletions.storageRoot })
        .from(projectAssetDeletions)
        .where(eq(projectAssetDeletions.storageRoot, owned.dataUrl)),
    ).toEqual([{ storageRoot: owned.dataUrl }]);
  });
});
