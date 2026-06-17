// @vitest-environment node
// [refactor jun17 P1.3] CHARACTERIZATION for /api/annotation-groups/[id] (PUT, DELETE) and
// /api/annotation-groups/[id]/members (POST, DELETE), added WITH the P1.3 migration to lock the
// [id]/members paths the P0.3 harness never froze (it only covered the collection GET/POST).
// Frozen behavior:
//   • PUT: partial update returns {group}; auto-CSI fills csiCode from (name, notes) when the
//     caller omits csiCode but changes text; a MANUAL csiCode always wins; non-numeric id → a
//     clean 400 "invalid id" (this family guards with parseInt(,10)+Number.isInteger — STRICTER
//     than annotations/[id], which 500s; do NOT regress to that); missing group → 404; signed-out
//     on an existing group → 401; cross-tenant → 404 (indirect lookup, no existence leak).
//   • DELETE: cascade=false (default, "dissolve") removes the group, member annotations SURVIVE;
//     cascade=true deletes the member annotations too (non-members untouched); invalid id → 400.
//   • members POST: adds → {success, addedCount}; cross-project annotationId → 400 with the frozen
//     message, nothing added. members DELETE: removes → {success, removedCount}.
// Errors use the P1 envelope {error:{code,message}}.
import { describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { GET, POST } from "@/app/api/annotation-groups/route";
import { DELETE, PUT } from "@/app/api/annotation-groups/[id]/route";
import { POST as addMembers, DELETE as removeMembers } from "@/app/api/annotation-groups/[id]/members/route";
import { POST as createAnnotation } from "@/app/api/annotations/route";
import {
  annotationsFor,
  asUser,
  createCompany,
  createUser,
  createWorld,
  makeReq,
  params,
  readJson,
  signedOut,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;
const bbox = [0.1, 0.1, 0.2, 0.2];

// ── seeding helpers (go through the real routes so tenancy/quirks stay honest) ──
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

async function createGroup(publicId: string, annotationIds: number[], over: Record<string, unknown> = {}): Promise<any> {
  const { body } = await readJson(
    await POST(makeReq("/api/annotation-groups", { body: { projectId: publicId, name: "G", annotationIds, ...over } })),
  );
  return body.group; // { id, projectId, name, csiCode, ... }
}

/** Member annotationIds of one group, read back through the GET hydrate path. */
async function membersOf(publicId: string, groupId: number): Promise<number[]> {
  const { body } = await readJson(await GET(makeReq(`/api/annotation-groups?projectId=${publicId}`, { method: "GET" })));
  return body.memberships
    .filter((m: { groupId: number }) => m.groupId === groupId)
    .map((m: { annotationId: number }) => m.annotationId)
    .sort((a: number, b: number) => a - b);
}
async function groupCount(publicId: string): Promise<number> {
  const { body } = await readJson(await GET(makeReq(`/api/annotation-groups?projectId=${publicId}`, { method: "GET" })));
  return body.groups.length;
}

// ── [id] handler call convention (params arrive as a Promise — mirror annotations-id) ──
const put = (id: string | number, body: unknown) =>
  PUT(makeReq(`/api/annotation-groups/${id}`, { method: "PUT", body }), params({ id: String(id) }));
const del = (id: string | number, cascade = false) =>
  DELETE(
    makeReq(`/api/annotation-groups/${id}${cascade ? "?cascade=true" : ""}`, { method: "DELETE" }),
    params({ id: String(id) }),
  );
const addMem = (id: string | number, body: unknown) =>
  addMembers(makeReq(`/api/annotation-groups/${id}/members`, { method: "POST", body }), params({ id: String(id) }));
const delMem = (id: string | number, body: unknown) =>
  removeMembers(makeReq(`/api/annotation-groups/${id}/members`, { method: "DELETE", body }), params({ id: String(id) }));

describe.skipIf(!dbUp)("PUT/DELETE /api/annotation-groups/[id]", () => {
  it("PUT updates name/notes and returns {group}", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const ids = await seedAnnotations(project.publicId, 1);
    const group = await createGroup(project.publicId, ids);

    const res = await readJson(await put(group.id, { name: "Renamed", notes: "hello" }));
    expect(res.status).toBe(200);
    expect(res.body.group.id).toBe(group.id);
    expect(res.body.group.name).toBe("Renamed");
    expect(res.body.group.notes).toBe("hello");
  });

  it("PUT auto-fills csiCode from notes when csiCode omitted; a manual csiCode wins", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const a = await createGroup(project.publicId, await seedAnnotations(project.publicId, 1));

    // notes carry a multi-word CSI description verbatim ("list of drawing sheets" = a 3-significant-
    // word entry that clears detection's Tier-1 threshold; a short 1-2 word phrase is down-weighted
    // out by design — see csi-detect-defs.ts). csiCode omitted → auto-CSI fills a real code.
    const auto = await readJson(
      await put(a.id, { notes: "refer to the list of drawing sheets for the full index" }),
    );
    expect(auto.status).toBe(200);
    expect(typeof auto.body.group.csiCode).toBe("string");
    expect(/\d/.test(auto.body.group.csiCode)).toBe(true); // a numeric CSI code was filled in

    // a manual csiCode is never overridden by detection, even with detectable CSI text in notes.
    const b = await createGroup(project.publicId, await seedAnnotations(project.publicId, 1));
    const manual = await readJson(
      await put(b.id, { csiCode: "26 05 00", notes: "refer to the list of drawing sheets" }),
    );
    expect(manual.status).toBe(200);
    expect(manual.body.group.csiCode).toBe("26 05 00");
  });

  it("PUT: invalid id → 400; missing group → 404; signed-out on existing → 401; cross-tenant → 404", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const group = await createGroup(project.publicId, await seedAnnotations(project.publicId, 1));

    // non-numeric id is a CLEAN 400 here (parseInt(,10)+Number.isInteger guard), not a 500.
    const bad = await readJson(await put("abc", { name: "x" }));
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("VALIDATION");

    expect((await readJson(await put(999999, { name: "x" }))).status).toBe(404); // missing → 404

    signedOut();
    expect((await readJson(await put(group.id, { name: "x" }))).status).toBe(401); // existing + no session

    asUser(await createUser((await createCompany()).id)); // another company
    expect((await readJson(await put(group.id, { name: "x" }))).status).toBe(404); // cross-tenant = 404
  });

  it("DELETE dissolve (no cascade): group removed, member annotations SURVIVE", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const ids = await seedAnnotations(project.publicId, 2);
    const group = await createGroup(project.publicId, ids);

    const res = await readJson(await del(group.id));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, cascade: false });
    expect(await groupCount(project.publicId)).toBe(0); // group gone
    expect((await annotationsFor(project.id)).length).toBe(2); // annotations survive
  });

  it("DELETE cascade=true: member annotations deleted; non-members survive", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const ids = await seedAnnotations(project.publicId, 3); // group 2, leave 1
    const group = await createGroup(project.publicId, [ids[0], ids[1]]);

    const res = await readJson(await del(group.id, true));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, cascade: true });
    const surviving = (await annotationsFor(project.id)).map((a) => a.id);
    expect(surviving).toEqual([ids[2]]); // only the ungrouped annotation remains
    expect(await groupCount(project.publicId)).toBe(0);
  });

  it("DELETE cascade=true deletes a member SHARED across groups; the other group survives without it", async () => {
    // The documented data-loss footgun (service: cascade deletes the annotation, whose FK cascade
    // also drops its membership in OTHER groups). Freeze the cross-group blast radius explicitly.
    const { user, project } = await createWorld();
    asUser(user);
    const ids = await seedAnnotations(project.publicId, 3); // [a, b, c]
    const groupA = await createGroup(project.publicId, [ids[0], ids[1]]); // a, b
    const groupB = await createGroup(project.publicId, [ids[1], ids[2]]); // b (shared), c

    const res = await readJson(await del(groupA.id, true)); // cascade
    expect(res.status).toBe(200);
    // a + b deleted (b was shared with B); c survives.
    expect((await annotationsFor(project.id)).map((x) => x.id)).toEqual([ids[2]]);
    // group B survives but lost the shared member b — only c remains in it.
    expect(await groupCount(project.publicId)).toBe(1);
    expect(await membersOf(project.publicId, groupB.id)).toEqual([ids[2]]);
  });

  it("DELETE: invalid id → 400", async () => {
    const { user } = await createWorld();
    asUser(user);
    const res = await readJson(await del("abc"));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION");
  });
});

describe.skipIf(!dbUp)("POST/DELETE /api/annotation-groups/[id]/members", () => {
  it("members POST adds annotations to the group → {success, addedCount}", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const ids = await seedAnnotations(project.publicId, 3);
    const group = await createGroup(project.publicId, [ids[0]]); // start with one member

    const res = await readJson(await addMem(group.id, { annotationIds: [ids[1], ids[2]] }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, addedCount: 2 });
    expect(await membersOf(project.publicId, group.id)).toEqual([...ids].sort((a, b) => a - b));
  });

  it("members POST: cross-project annotationId → 400, nothing added", async () => {
    const { user, project } = await createWorld();
    const other = await createWorld(); // different company + project
    asUser(other.user);
    const foreignIds = await seedAnnotations(other.project.publicId, 1);

    asUser(user);
    const myIds = await seedAnnotations(project.publicId, 1);
    const group = await createGroup(project.publicId, myIds);

    const res = await readJson(await addMem(group.id, { annotationIds: foreignIds }));
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("one or more annotationIds not found in this project");
    expect(await membersOf(project.publicId, group.id)).toEqual([...myIds].sort((a, b) => a - b)); // unchanged
  });

  it("members DELETE removes membership rows → {success, removedCount}; annotations survive", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const ids = await seedAnnotations(project.publicId, 2);
    const group = await createGroup(project.publicId, ids); // both members

    const res = await readJson(await delMem(group.id, { annotationIds: [ids[1]] }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, removedCount: 1 });
    expect(await membersOf(project.publicId, group.id)).toEqual([ids[0]]); // only the un-removed one
    expect((await annotationsFor(project.id)).length).toBe(2); // annotations themselves untouched
  });

  it("members POST/DELETE: present-but-invalid annotationIds → 400 with the exact frozen message", async () => {
    // S5 preserved-half: a malformed/empty BODY hits the shell first (sanctioned), but a body whose
    // annotationIds IS present-but-invalid still reaches parseAnnotationIds and must yield the exact
    // legacy message verbatim. zLooseBody passes the object through, so this service path is live.
    const { user, project } = await createWorld();
    asUser(user);
    const ids = await seedAnnotations(project.publicId, 1);
    const group = await createGroup(project.publicId, ids);
    const msg = "annotationIds required (non-empty integer array)";
    for (const bad of [{ annotationIds: [] }, { annotationIds: [1.5] }, { annotationIds: "x" }]) {
      const add = await readJson(await addMem(group.id, bad));
      expect(add.status).toBe(400);
      expect(add.body.error.message).toBe(msg);
      const rem = await readJson(await delMem(group.id, bad));
      expect(rem.status).toBe(400);
      expect(rem.body.error.message).toBe(msg);
    }
    expect(await membersOf(project.publicId, group.id)).toEqual([...ids].sort((a, b) => a - b)); // unchanged
  });

  it("members count = REQUESTED ids, not affected rows (onConflict re-add / remove non-member are no-ops)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const ids = await seedAnnotations(project.publicId, 2);
    const group = await createGroup(project.publicId, [ids[0]]); // member: ids[0]

    // re-add an EXISTING member → onConflictDoNothing inserts 0 rows, addedCount still counts the request.
    const re = await readJson(await addMem(group.id, { annotationIds: [ids[0]] }));
    expect(re.status).toBe(200);
    expect(re.body).toEqual({ success: true, addedCount: 1 });
    expect(await membersOf(project.publicId, group.id)).toEqual([ids[0]]); // no duplicate row

    // remove a NON-member → deletes 0 rows, removedCount still counts the request.
    const rm = await readJson(await delMem(group.id, { annotationIds: [ids[1]] }));
    expect(rm.status).toBe(200);
    expect(rm.body).toEqual({ success: true, removedCount: 1 });
    expect(await membersOf(project.publicId, group.id)).toEqual([ids[0]]); // unchanged
  });

  it("members POST/DELETE enforce group authz: missing → 404, signed-out → 401, cross-tenant → 404", async () => {
    // members WRITE data, so freeze their group-level authz directly (not just transitively via PUT).
    const { user, project } = await createWorld();
    asUser(user);
    const ids = await seedAnnotations(project.publicId, 1);
    const group = await createGroup(project.publicId, ids);
    const body = { annotationIds: ids };

    expect((await readJson(await addMem(999999, body))).status).toBe(404); // missing group
    expect((await readJson(await delMem(999999, body))).status).toBe(404);

    signedOut();
    expect((await readJson(await addMem(group.id, body))).status).toBe(401); // existing group + no session
    expect((await readJson(await delMem(group.id, body))).status).toBe(401);

    asUser(await createUser((await createCompany()).id)); // another company
    expect((await readJson(await addMem(group.id, body))).status).toBe(404); // cross-tenant = 404
    expect((await readJson(await delMem(group.id, body))).status).toBe(404);
  });
});
