// @vitest-environment node
// [table pipeline WP-2.D1, K19/K40] POST /api/projects/[id]/tags/ops — two concurrent writers both
// survive (the whole-array PUT is last-writer-wins), other projectIntelligence keys survive, a remap
// clears only its own region's 0-hit tags, demo refused for every role, signed-out 401 / cross-tenant
// 404, validation 400 with nothing written.
import { describe, expect, inject, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { POST } from "@/app/api/projects/[id]/tags/ops/route";
import { PUT as projectPUT } from "@/app/api/projects/[id]/route";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { assertProjectWritable, withProjectWrite } from "@/server/api/project-write-capability";
import { applyTagOps, type StoredYoloTag } from "@/server/services/tag-ops";
import {
  asUser,
  createCompany,
  createUser,
  createWorld,
  makeReq,
  params,
  publishDemoFixture,
  readJson,
  signedOut,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

const url = (publicId: string) => `/api/projects/${publicId}/tags/ops`;
const post = (publicId: string, body: unknown) =>
  POST(makeReq(url(publicId), { method: "POST", body }), params({ id: publicId }));

function tag(id: string, over: Partial<StoredYoloTag> = {}): StoredYoloTag {
  return {
    id,
    name: id,
    tagText: id.toUpperCase(),
    yoloClass: "",
    yoloModel: "",
    source: "schedule",
    scope: "project",
    instances: [{ pageNumber: 1, annotationId: -1, bbox: [0.1, 0.1, 0.12, 0.12], confidence: 1 }],
    ...over,
  };
}

async function seeded(yoloTags: StoredYoloTag[] = []) {
  const world = await createWorld();
  await db.update(projects)
    .set({ projectIntelligence: { yoloTags, other: { kept: true } } as never })
    .where(eq(projects.id, world.project.id));
  return world;
}

async function storedTags(projectId: number): Promise<StoredYoloTag[]> {
  const [row] = await db.select({ pi: projects.projectIntelligence }).from(projects).where(eq(projects.id, projectId));
  return ((row.pi as Record<string, unknown>).yoloTags ?? []) as StoredYoloTag[];
}

async function projectIntel(projectId: number) {
  const [row] = await db.select({ pi: projects.projectIntelligence }).from(projects).where(eq(projects.id, projectId));
  return row.pi as Record<string, any>;
}

/** Wait until some backend is blocked on a lock held by backend `holderPid` (5 s bound). */
async function waitForWaiterOn(holderPid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await db.execute(sql`
      SELECT 1 FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'
         AND ${holderPid}::int = ANY(pg_blocking_pids(pid))
       LIMIT 1`);
    if ((result as unknown as { rows: unknown[] }).rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the second writer to block on the first");
}

describe.skipIf(!dbUp)("POST /api/projects/[id]/tags/ops", () => {
  it("[K19] a writer that arrives while another holds the project waits, then both edits survive (deterministic)", async () => {
    const { user, project } = await seeded([tag("a"), tag("b")]);
    asUser(user);
    const capability = assertProjectWritable(project);
    let second: Promise<Response> | undefined;
    await withProjectWrite(capability, project.id, async (tx) => {
      await applyTagOps(tx, capability, [{ op: "upsert", tag: tag("a", { description: "first" }) }]);
      const [{ pid }] = (await tx.execute(sql`SELECT pg_backend_pid() AS pid`) as unknown as { rows: { pid: number }[] }).rows;
      second = post(project.publicId, { ops: [{ op: "upsert", tag: tag("b", { description: "second" }) }] });
      // The second writer has to reach the database while the first still holds it; with the row
      // lock it waits before reading, without it it reads the stale array and overwrites "first".
      await waitForWaiterOn(pid);
    });
    expect((await second!).status).toBe(200);
    const rows = await storedTags(project.id);
    expect(rows.find((r) => r.id === "a")?.description).toBe("first");
    expect(rows.find((r) => r.id === "b")?.description).toBe("second");
  });

  it("[K19] two concurrent writers editing different tags both survive", async () => {
    const { user, project } = await seeded([tag("a"), tag("b")]);
    asUser(user);
    const results = await Promise.all([
      post(project.publicId, { ops: [{ op: "upsert", tag: tag("a", { description: "from tab 1" }) }, { op: "upsert", tag: tag("c") }] }),
      post(project.publicId, { ops: [{ op: "upsert", tag: tag("b", { description: "from tab 2" }) }, { op: "upsert", tag: tag("d") }] }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const rows = await storedTags(project.id);
    expect(rows.map((r) => r.id).sort()).toEqual(["a", "b", "c", "d"]);
    expect(rows.find((r) => r.id === "a")?.description).toBe("from tab 1");
    expect(rows.find((r) => r.id === "b")?.description).toBe("from tab 2");
  });

  it("[K19] eight concurrent single-tag writers all survive", async () => {
    const { user, project } = await seeded();
    asUser(user);
    const ids = Array.from({ length: 8 }, (_, i) => `w${i}`);
    const statuses = (await Promise.all(ids.map((id) => post(project.publicId, { ops: [{ op: "upsert", tag: tag(id) }] }))))
      .map((r) => r.status);
    expect(statuses).toEqual(ids.map(() => 200));
    expect((await storedTags(project.id)).map((r) => r.id).sort()).toEqual(ids);
  });

  it("[K05] sheet 3 keys 1..9 then sheet 7 keys 1..9 → 18 tags (key-matched upserts)", async () => {
    const { user, project } = await seeded();
    asUser(user);
    const sheet = (page: number, run: string) =>
      Array.from({ length: 9 }, (_, i) => ({
        op: "upsert",
        match: "key",
        tag: tag(`k-${page}-${i + 1}-${run}`, {
          tagText: String(i + 1),
          source: "keynote",
          scope: "page",
          pageNumber: page,
          instances: [{ pageNumber: page, annotationId: -1, bbox: [0.1, 0.05 * i, 0.12, 0.05 * i + 0.02], confidence: 1 }],
        }),
      }));
    expect((await post(project.publicId, { ops: sheet(3, "a") })).status).toBe(200);
    expect((await post(project.publicId, { ops: sheet(7, "a") })).status).toBe(200);
    expect(await storedTags(project.id)).toHaveLength(18);
    expect((await post(project.publicId, { ops: sheet(3, "b") })).status).toBe(200);
    const rows = await storedTags(project.id);
    expect(rows).toHaveLength(18);
    expect(rows.filter((r) => r.pageNumber === 3).every((r) => r.id.endsWith("-a"))).toBe(true);
  });

  it("[K40] a remap clears the 0-hit tags of that region only; the response lists the changes", async () => {
    const r1 = { links: { regionId: "pr-1" } };
    const r2 = { links: { regionId: "pr-2" } };
    const { user, project } = await seeded([
      tag("keep", { tagText: "QX-1", ...r1 }),
      tag("stale", { tagText: "QX-2", ...r1 }),
      tag("other", { tagText: "QX-2", ...r2, instances: [] }),
    ]);
    asUser(user);
    const { status, body } = await readJson(await post(project.publicId, {
      ops: [{
        op: "replace-for-region",
        regionId: "pr-1",
        tags: [tag("new-id", { tagText: "QX-1", description: "remapped" }), tag("zero", { tagText: "QX-2", instances: [] })],
      }],
    }));
    expect(status).toBe(200);
    expect(body.removed).toEqual(["stale"]);
    expect(body.replacedRegionIds).toEqual(["pr-1"]);
    expect(body.tags).toHaveLength(1);
    expect(body.tags[0]).toMatchObject({ id: "keep", description: "remapped", links: { regionId: "pr-1" } });
    expect((await storedTags(project.id)).map((r) => r.id)).toEqual(["keep", "other"]);
  });

  it("keeps every other projectIntelligence key", async () => {
    const { user, project } = await seeded([tag("a")]);
    asUser(user);
    expect((await post(project.publicId, { ops: [{ op: "remove", id: "a" }] })).status).toBe(200);
    const pi = await projectIntel(project.id);
    expect(pi.yoloTags).toEqual([]);
    expect(pi.other).toEqual({ kept: true });
  });

  it("the legacy whole-array PUT still works next to it (import path)", async () => {
    const { user, project } = await seeded([tag("a")]);
    asUser(user);
    const put = await projectPUT(
      makeReq(`/api/projects/${project.publicId}`, { method: "PUT", body: { yoloTags: [tag("x")] } }),
      params({ id: project.publicId }),
    );
    expect(put.status).toBe(200);
    expect((await post(project.publicId, { ops: [{ op: "upsert", tag: tag("y") }] })).status).toBe(200);
    expect((await storedTags(project.id)).map((r) => r.id)).toEqual(["x", "y"]);
  });

  it("a malformed op → 400 and nothing is written", async () => {
    const { user, project } = await seeded([tag("a")]);
    asUser(user);
    const res = await readJson(await post(project.publicId, {
      ops: [{ op: "remove", id: "a" }, { op: "upsert", tag: { ...tag("b"), source: "legend" } }],
    }));
    expect(res.status).toBe(400);
    expect((await storedTags(project.id)).map((r) => r.id)).toEqual(["a"]);
  });

  it("signed-out → 401; cross-tenant → 404", async () => {
    const { project } = await seeded([tag("a")]);
    signedOut();
    expect((await post(project.publicId, { ops: [{ op: "remove", id: "a" }] })).status).toBe(401);
    asUser(await createUser((await createWorld()).company.id));
    expect((await post(project.publicId, { ops: [{ op: "remove", id: "a" }] })).status).toBe(404);
    expect((await storedTags(project.id)).map((r) => r.id)).toEqual(["a"]);
  });

  it("demo projects refuse every role before any write", async () => {
    const { company, project } = await seeded([tag("a")]);
    await publishDemoFixture(project.id);
    const member = await createUser(company.id);
    const root = await createUser((await createCompany()).id, { role: "admin", isRootAdmin: true });
    const statuses: number[] = [];
    for (const actor of [null, member, root]) {
      actor ? asUser(actor) : signedOut();
      statuses.push((await post(project.publicId, { ops: [{ op: "remove", id: "a" }] })).status);
    }
    expect(statuses).toEqual([403, 403, 403]);
    expect((await storedTags(project.id)).map((r) => r.id)).toEqual(["a"]);
  });
});
