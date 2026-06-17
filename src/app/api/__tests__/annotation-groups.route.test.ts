// @vitest-environment node
// [refactor jun12 P0.3] CHARACTERIZATION for /api/annotation-groups — the ONE
// route family that already uses a transaction (group + junction rows atomic);
// it's the P1 reference for what every multi-row write becomes. Also frozen:
// the annotationIds tenancy check (can't group another project's annotations)
// and GET's unauthenticated-demo read (allowDemo:true).
//
// [refactor jun17 P1.3] Envelope flipped to {error:{code,message}} as the family migrated
// onto services/annotation-groups.ts (the ONE sanctioned diff). Only the tenancy-error read
// below changes (.error → .error.message); every other assertion checks .status only. The
// [id]/members paths get their own frozen file (annotation-groups-id.route.test.ts).
import { describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { GET, POST } from "@/app/api/annotation-groups/route";
import { POST as createAnnotation } from "@/app/api/annotations/route";
import {
  asUser,
  createWorld,
  makeReq,
  readJson,
  signedOut,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;
const bbox = [0.1, 0.1, 0.2, 0.2];

async function seedAnnotations(publicId: string, n: number): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const { body } = await readJson(
      await createAnnotation(makeReq("/api/annotations", { body: { projectId: publicId, pageNumber: 1, name: `a${i}`, bbox } })),
    );
    ids.push(body.id);
  }
  return ids;
}

describe.skipIf(!dbUp)("/api/annotation-groups", () => {
  it("POST creates group + memberships atomically; GET hydrates {groups, memberships}", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const ids = await seedAnnotations(project.publicId, 3);

    const created = await readJson(
      await POST(makeReq("/api/annotation-groups", { body: { projectId: project.publicId, name: "North Wall Fixtures", annotationIds: ids } })),
    );
    expect(created.status).toBe(200);
    expect(created.body.memberCount).toBe(3);
    expect(created.body.group.createdBy).toBe(user.id);
    expect(typeof created.body.group.color).toBe("string"); // random TWENTY_COLORS fill when omitted

    const hydrate = await readJson(
      await GET(makeReq(`/api/annotation-groups?projectId=${project.publicId}`, { method: "GET" })),
    );
    expect(hydrate.status).toBe(200);
    expect(hydrate.body.groups).toHaveLength(1);
    expect(hydrate.body.memberships).toHaveLength(3);
    expect(hydrate.body.memberships.map((m: { annotationId: number }) => m.annotationId).sort()).toEqual([...ids].sort());
  });

  it("tenancy: grouping another project's annotationIds → 400, nothing created", async () => {
    const { user, project } = await createWorld();
    const other = await createWorld(); // different company+project
    asUser(other.user);
    const foreignIds = await seedAnnotations(other.project.publicId, 2);

    asUser(user);
    const myIds = await seedAnnotations(project.publicId, 1);
    const res = await readJson(
      await POST(makeReq("/api/annotation-groups", {
        body: { projectId: project.publicId, name: "smuggle", annotationIds: [...myIds, ...foreignIds] },
      })),
    );
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("one or more annotationIds not found in this project");
    const hydrate = await readJson(await GET(makeReq(`/api/annotation-groups?projectId=${project.publicId}`, { method: "GET" })));
    expect(hydrate.body.groups).toHaveLength(0); // tx never ran
  });

  it("validation 400s; empty annotationIds rejected; signed-out write 401", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const ids = await seedAnnotations(project.publicId, 1);
    const p = project.publicId;
    expect((await readJson(await POST(makeReq("x", { body: { projectId: p, name: "", annotationIds: ids } })))).status).toBe(400);
    expect((await readJson(await POST(makeReq("x", { body: { projectId: p, name: "ok", annotationIds: [] } })))).status).toBe(400);
    expect((await readJson(await POST(makeReq("x", { body: { projectId: p, name: "ok", annotationIds: [1.5] } })))).status).toBe(400);
    signedOut();
    expect((await readJson(await POST(makeReq("x", { body: { projectId: p, name: "ok", annotationIds: ids } })))).status).toBe(401);
  });

  it("GET on a demo project works UNAUTHENTICATED (allowDemo read path — frozen)", async () => {
    const { user, project } = await createWorld({ isDemo: true });
    asUser(user);
    await seedAnnotations(project.publicId, 1); // member of owning company can still write to own demo? — no: demo write gate… seed via direct user on non-demo path
    signedOut();
    const res = await readJson(await GET(makeReq(`/api/annotation-groups?projectId=${project.publicId}`, { method: "GET" })));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("groups");
    expect(res.body).toHaveProperty("memberships");
  });
});
