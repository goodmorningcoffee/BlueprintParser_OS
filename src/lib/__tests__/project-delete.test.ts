// @vitest-environment node
// [refactor jun13 P0.5-G4] Freezes deleteProjectFully's NEW ordering contract:
// all DB rows go in one transaction FIRST, the S3 purge runs only after
// commit, and an S3 failure never bubbles (worst case = orphaned objects,
// logged).
// [refactor jun16 P0-review G4] Added the annotation_groups cascade assertion.
// That child used to vanish only via a silent DB ON DELETE CASCADE and was
// untested ANYWHERE (the projects/[id] route test seeds a lone annotation, no
// groups). project-delete.ts now deletes it explicitly; this test pins it so a
// future schema/FK change that breaks the teardown fails loudly here.
import { describe, expect, inject, it, vi } from "vitest";

const s3CallLog: { projectRowsAtCallTime: number; dataUrl: string }[] = [];
let s3ShouldThrow = false;

vi.mock("@/lib/s3", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/s3")>();
  return {
    ...orig,
    deleteProjectFiles: async (dataUrl: string) => {
      const { db } = await import("@/lib/db");
      const { projects } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      const rows = await db.select({ id: projects.id }).from(projects).where(eq(projects.dataUrl, dataUrl));
      s3CallLog.push({ projectRowsAtCallTime: rows.length, dataUrl });
      if (s3ShouldThrow) throw new Error("simulated S3 outage");
    },
  };
});

import { deleteProjectFully } from "@/lib/project-delete";
import { db } from "@/lib/db";
import {
  annotations,
  annotationGroups,
  annotationGroupMembers,
  chatMessages,
  pages,
  projects,
} from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { createWorld } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

describe.skipIf(!dbUp)("deleteProjectFully — G4 ordering contract", () => {
  it("commits the DB transaction BEFORE the S3 purge runs", async () => {
    const { project } = await createWorld();
    await db.insert(pages).values({ projectId: project.id, pageNumber: 1, name: "P1" });
    await db.insert(chatMessages).values({ projectId: project.id, role: "user", content: "hi" });

    await deleteProjectFully({ id: project.id, dataUrl: project.dataUrl, jobId: null });

    const call = s3CallLog.find((c) => c.dataUrl === project.dataUrl);
    expect(call).toBeTruthy();
    // the ordering freeze: when S3 cleanup fires, the row is already gone
    expect(call!.projectRowsAtCallTime).toBe(0);
    expect(await db.select().from(pages).where(eq(pages.projectId, project.id))).toHaveLength(0);
  });

  it("S3 failure does not bubble and the DB delete still stands", async () => {
    const { project } = await createWorld();
    s3ShouldThrow = true;
    try {
      await expect(
        deleteProjectFully({ id: project.id, dataUrl: project.dataUrl, jobId: null }),
      ).resolves.toBeUndefined();
    } finally {
      s3ShouldThrow = false;
    }
    expect(await db.select().from(projects).where(eq(projects.id, project.id))).toHaveLength(0);
  });

  it("removes annotation_groups + their member links (the previously cascade-only path)", async () => {
    const { user, project } = await createWorld();
    // an annotation + a group + the M:N link between them
    const [anno] = await db
      .insert(annotations)
      .values({ projectId: project.id, name: "A1", minX: 0, maxX: 1, minY: 0, maxY: 1, pageNumber: 1, creatorId: user.id })
      .returning();
    const [group] = await db
      .insert(annotationGroups)
      .values({ projectId: project.id, name: "Doors" })
      .returning();
    await db.insert(annotationGroupMembers).values({ annotationId: anno.id, groupId: group.id });

    await deleteProjectFully({ id: project.id, dataUrl: project.dataUrl, jobId: null });

    // annotation_groups: the one child that used to rely on a silent DB cascade
    // — now deleted explicitly, asserted gone here.
    expect(
      await db.select().from(annotationGroups).where(eq(annotationGroups.projectId, project.id)),
    ).toHaveLength(0);
    // the junction has no direct project FK; it clears via its parents' cascade
    expect(
      await db.select().from(annotationGroupMembers).where(eq(annotationGroupMembers.groupId, group.id)),
    ).toHaveLength(0);
  });
});
