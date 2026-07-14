// @vitest-environment node
// B2 freeze: a capability minted while a project is private is not perpetual authority. Publishing
// must revoke it before any internal numeric-id sink can write through an async boundary.
import { afterEach, describe, expect, inject, it, vi } from "vitest";
vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});
import { and, eq, sql } from "drizzle-orm";
import { Pool, type PoolClient } from "pg";
import { db } from "@/lib/db";
import {
  annotationGroupMembers,
  annotationGroups,
  annotations,
  pages,
  projects,
} from "@/lib/db/schema";
import { patchProjectSummaries } from "@/lib/project-analysis";
import { deleteParsedRegion } from "@/server/services/regions";
import { manageDemo } from "@/server/services/demo";
import {
  acquireProjectMutationLease,
  assertProjectWritable,
  isDemoWriteProtectionError,
  releaseProjectMutationLease,
} from "@/server/api/project-write-capability";
import {
  ageProjectForPublication,
  asUser,
  createPage,
  createProject,
  createUser,
  createWorld,
  sessionState,
  signedOut,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

afterEach(() => {
  vi.useRealTimers();
  signedOut();
});

async function waitForTransactionWaiter(
  client: PoolClient,
  blockingTransactionId: string,
): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await client.query<{ pid: number }>(
      `SELECT pid
         FROM pg_locks
        WHERE locktype = 'transactionid'
          AND transactionid::text = $1
          AND granted = false
        LIMIT 1`,
      [blockingTransactionId],
    );
    if (result.rows[0]) return result.rows[0].pid;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the child mutation to block on the page row");
}

async function publicationDisposition(
  client: PoolClient,
  childPid: number,
  publicationSettled: () => boolean,
): Promise<"committed" | "serialized-behind-child"> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (publicationSettled()) return "committed";
    const result = await client.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid()
            AND pid <> $1
            AND state = 'active'
            AND wait_event_type = 'Lock'
       ) AS waiting`,
      [childPid],
    );
    if (result.rows[0]?.waiting) return "serialized-behind-child";
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Publication neither committed nor serialized behind the child mutation");
}

describe.skipIf(!dbUp)("project write capability lifecycle", () => {
  it("B2: a pre-publication capability cannot mutate the project after it becomes demo", async () => {
    const before = { summaries: { allTrades: ["BEFORE"] } };
    const { project } = await createWorld({ projectIntelligence: before as never });
    const staleCapability = assertProjectWritable(project);

    // Simulate manageDemo publishing while an internal caller is suspended after minting authority.
    await db
      .update(projects)
      .set({
        isDemo: true,
        lifecycleEpoch: sql`${projects.lifecycleEpoch} + 1`,
      })
      .where(eq(projects.id, project.id));

    let thrown: unknown;
    try {
      await patchProjectSummaries(project.id, { allTrades: ["MUTATED"] }, staleCapability);
    } catch (error) {
      thrown = error;
    }

    expect.soft(thrown).toMatchObject({
      code: "FORBIDDEN",
      message: "Demo projects are read-only",
    });
    const [after] = await db
      .select({ projectIntelligence: projects.projectIntelligence })
      .from(projects)
      .where(eq(projects.id, project.id));
    expect.soft(after.projectIntelligence).toEqual(before);
  });

  it("B3: manageDemo cannot publish between capability validation and a child-table write", async () => {
    const { company, project } = await createWorld();
    await ageProjectForPublication(project.id);
    const admin = await createUser(company.id, { role: "admin" });
    const pageIntelligence = {
      parsedRegions: [
        {
          id: "must-survive",
          type: "notes",
          bbox: [0.1, 0.1, 0.2, 0.2],
          data: { marker: "pre-publication" },
          category: "notes-region",
          source: "user",
          confidence: 1,
        },
      ],
    };
    const page = await createPage(project.id, 1, { pageIntelligence: pageIntelligence as never });
    const writeCapability = assertProjectWritable(project);
    asUser(admin);
    const adminSession = sessionState.current!;

    // Hold only the child row so deleteParsedRegion blocks after its parent-first authority lock.
    // Publication must wait behind that already-admitted mutation. The pre-fix plain-SELECT
    // capability check held no parent lock, allowing publication to commit in this exact window.
    const blockerPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const blocker = await blockerPool.connect();
    let released = false;
    let mutation: Promise<unknown> | undefined;
    let publication: Promise<unknown> | undefined;
    let disposition: "committed" | "serialized-behind-child" | undefined;
    let duringPublication = false;
    let operationError: unknown;
    try {
      await blocker.query("BEGIN");
      const xidResult = await blocker.query<{ xid: string }>(
        "SELECT txid_current()::text AS xid",
      );
      await blocker.query("SELECT 1 FROM pages WHERE id = $1 FOR UPDATE", [page.id]);

      mutation = deleteParsedRegion(project.id, 1, "must-survive", writeCapability);
      const childPid = await waitForTransactionWaiter(blocker, xidResult.rows[0].xid);

      let publicationSettled = false;
      publication = manageDemo(
        { projectId: project.publicId, isDemo: true },
        adminSession,
      ).finally(() => {
        publicationSettled = true;
      });
      // Let pg establish the publication transaction's second pooled backend before inspecting
      // lock state. Without this yield a fast same-client polling loop can observe only the two
      // already-established blocker/mutation backends during connection startup.
      await new Promise((resolve) => setTimeout(resolve, 50));
      disposition = await publicationDisposition(
        blocker,
        childPid,
        () => publicationSettled,
      );

      const [during] = await db
        .select({ isDemo: projects.isDemo })
        .from(projects)
        .where(eq(projects.id, project.id));
      duringPublication = during.isDemo;
    } catch (error) {
      operationError = error;
    } finally {
      try {
        await blocker.query("COMMIT");
        released = true;
      } finally {
        if (!released) await blocker.query("ROLLBACK").catch(() => undefined);
        blocker.release();
        await blockerPool.end();
      }
      await Promise.allSettled([mutation, publication].filter(Boolean) as Promise<unknown>[]);
    }

    if (operationError) throw operationError;
    expect.soft(disposition).toBe("serialized-behind-child");
    expect.soft(duringPublication).toBe(false);

    const [afterPage] = await db
      .select({ pageIntelligence: pages.pageIntelligence })
      .from(pages)
      .where(eq(pages.id, page.id));
    expect.soft(afterPage.pageIntelligence).toEqual({ parsedRegions: [] });
  }, 15_000);

  it("B3: a same-millisecond publish-withdraw cycle never revives an old capability", async () => {
    const before = { summaries: { allTrades: ["BEFORE"] } };
    const { company, project } = await createWorld({ projectIntelligence: before as never });
    await ageProjectForPublication(project.id);
    const admin = await createUser(company.id, { role: "admin" });
    const lifecycleInstant = new Date("2035-04-05T06:07:08.123Z");
    await db
      .update(projects)
      .set({ updatedAt: lifecycleInstant })
      .where(eq(projects.id, project.id));
    const [versionedProject] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, project.id));
    const staleCapability = assertProjectWritable(versionedProject);
    asUser(admin);
    const adminSession = sessionState.current!;

    // The pre-fix Date-based token let both sanctioned transitions write the same millisecond and
    // recreate the exact pre-publish authority. The monotonic epoch must advance on both changes.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(lifecycleInstant);
    await manageDemo({ projectId: project.publicId, isDemo: true }, adminSession);
    await manageDemo({ projectId: project.publicId, isDemo: false }, adminSession);

    let thrown: unknown;
    try {
      await patchProjectSummaries(
        project.id,
        { allTrades: ["MUTATED"] },
        staleCapability,
      );
    } catch (error) {
      thrown = error;
    }

    expect.soft(thrown).toMatchObject({
      code: "FORBIDDEN",
      message: "Project write capability expired",
    });
    const [after] = await db
      .select({ projectIntelligence: projects.projectIntelligence })
      .from(projects)
      .where(eq(projects.id, project.id));
    expect.soft(after.projectIntelligence).toEqual(before);
  });

  it("a live mutation lease blocks publication and duplicate idempotency keys", async () => {
    const { company, project } = await createWorld();
    await ageProjectForPublication(project.id);
    const admin = await createUser(company.id, { role: "admin" });
    const capability = assertProjectWritable(project);
    const lease = await acquireProjectMutationLease(capability, {
      kind: "security-freeze",
      idempotencyKey: `security-freeze-${project.id}`,
    });
    asUser(admin);
    const adminSession = sessionState.current!;

    await expect(acquireProjectMutationLease(capability, {
      kind: "security-freeze",
      idempotencyKey: `security-freeze-${project.id}`,
    })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Project mutation already in progress",
    });
    await expect(manageDemo(
      { projectId: project.publicId, isDemo: true },
      adminSession,
    )).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Project has an active mutation lease",
    });

    await releaseProjectMutationLease(capability, lease);
    await manageDemo({ projectId: project.publicId, isDemo: true }, adminSession);

    const [published] = await db
      .select({ isDemo: projects.isDemo, lifecycleEpoch: projects.lifecycleEpoch })
      .from(projects)
      .where(eq(projects.id, project.id));
    expect(published).toEqual({ isDemo: true, lifecycleEpoch: project.lifecycleEpoch + 1 });
  });

  it("the indirect membership trigger protects the old demo project on cross-project UPDATE", async () => {
    const { company, user, project: oldProject } = await createWorld();
    const newProject = await createProject(company.id, user.id);
    const [oldAnnotation, newAnnotation] = await db
      .insert(annotations)
      .values([
        {
          projectId: oldProject.id,
          pageNumber: 1,
          name: "old-demo-annotation",
          minX: 0,
          minY: 0,
          maxX: 1,
          maxY: 1,
        },
        {
          projectId: newProject.id,
          pageNumber: 1,
          name: "new-private-annotation",
          minX: 0,
          minY: 0,
          maxX: 1,
          maxY: 1,
        },
      ])
      .returning({ id: annotations.id });
    const [oldGroup, newGroup] = await db
      .insert(annotationGroups)
      .values([
        { projectId: oldProject.id, name: "old-demo-group" },
        { projectId: newProject.id, name: "new-private-group" },
      ])
      .returning({ id: annotationGroups.id });
    await db.insert(annotationGroupMembers).values({
      annotationId: oldAnnotation.id,
      groupId: oldGroup.id,
    });
    await db
      .update(projects)
      .set({
        isDemo: true,
        lifecycleEpoch: sql`${projects.lifecycleEpoch} + 1`,
      })
      .where(eq(projects.id, oldProject.id));

    let thrown: unknown;
    try {
      await db
        .update(annotationGroupMembers)
        .set({ annotationId: newAnnotation.id, groupId: newGroup.id })
        .where(and(
          eq(annotationGroupMembers.annotationId, oldAnnotation.id),
          eq(annotationGroupMembers.groupId, oldGroup.id),
        ));
    } catch (error) {
      thrown = error;
    }

    expect(isDemoWriteProtectionError(thrown)).toBe(true);
    const memberships = await db
      .select()
      .from(annotationGroupMembers)
      .where(and(
        eq(annotationGroupMembers.annotationId, oldAnnotation.id),
        eq(annotationGroupMembers.groupId, oldGroup.id),
      ));
    expect(memberships).toHaveLength(1);
  });
});
