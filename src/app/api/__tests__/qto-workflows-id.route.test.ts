// @vitest-environment node
// [refactor jun17 P1.3] CHARACTERIZATION for /api/qto-workflows/[id] (GET, PUT, DELETE), written
// WITH the P1.3 family-3 migration onto services/qto-workflows.ts. Frozen behavior:
//   • indirect-lookup authz: fetch the workflow by Number(id) → 404 if missing (BEFORE auth) →
//     resolve access on the PARENT project, NO demo bypass; cross-tenant → 404 (no existence leak).
//   • the Number(id)→NaN quirk: a non-numeric id is NOT a clean 400 (unlike annotation-groups) — the
//     pg int-cast on `id = NaN` THROWS → the shell's leak-free INTERNAL 500 (deterministic; mirrors
//     annotations/[id] + takeoff-items/[id]). It is never 200, never 404, never 400.
//   • PUT short-circuit field validation in source order with the verbatim legacy messages/limits,
//     and PUT's ABSENCE of a demo write-gate (an owning-company member CAN PUT a demo workflow).
//   • Envelope = {error:{code,message}}.
import { describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { POST as createWorkflow } from "@/app/api/qto-workflows/route";
import { DELETE, GET, PUT } from "@/app/api/qto-workflows/[id]/route";
import { db } from "@/lib/db";
import { qtoWorkflows } from "@/lib/db/schema";
import { inArray } from "drizzle-orm";
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

/** Create a workflow via the real collection POST and return its id (caller sets the session). */
async function makeWorkflow(publicId: string): Promise<number> {
  const { body } = await readJson(
    await createWorkflow(makeReq("/api/qto-workflows", { body: { projectId: publicId, materialType: "concrete" } })),
  );
  return body.id;
}

const get = (id: number | string) =>
  GET(makeReq(`/api/qto-workflows/${id}`, { method: "GET" }), params({ id: String(id) }));
const put = (id: number | string, body: unknown) =>
  PUT(makeReq(`/api/qto-workflows/${id}`, { method: "PUT", body }), params({ id: String(id) }));
const del = (id: number | string) =>
  DELETE(makeReq(`/api/qto-workflows/${id}`, { method: "DELETE" }), params({ id: String(id) }));

const INTERNAL_500 = { code: "INTERNAL", message: "Internal server error" };

describe.skipIf(!dbUp)("/api/qto-workflows/[id]", () => {
  it("GET: happy; missing → 404; signed-out on existing → 401; cross-tenant → 404; NaN id → 500", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const id = await makeWorkflow(project.publicId);

    const ok = await readJson(await get(id));
    expect(ok.status).toBe(200);
    expect(ok.body.id).toBe(id);
    expect(ok.body.step).toBe("select-schedule");

    expect((await readJson(await get(999999))).status).toBe(404); // missing → 404 (before auth)

    signedOut();
    expect((await readJson(await get(id))).status).toBe(401); // existing + signed out → 401

    asUser(await createUser((await createCompany()).id)); // different company
    expect((await readJson(await get(id))).status).toBe(404); // cross-tenant → 404, no existence leak

    // NaN quirk: Number("abc") = NaN → pg int-cast THROWS → leak-free 500 (frozen, deterministic)
    asUser(user);
    const nan = await readJson(await get("abc"));
    expect(nan.status).toBe(500);
    expect(nan.body.error).toEqual(INTERNAL_500);
  });

  it("PUT: valid step; empty body touches only updatedAt; field 400s + short-circuit precedence", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const id = await makeWorkflow(project.publicId);

    const ok = await readJson(await put(id, { step: "review" }));
    expect(ok.status).toBe(200);
    expect(ok.body.step).toBe("review");
    expect(typeof ok.body.updatedAt).toBe("string"); // Date → ISO on the wire

    const empty = await readJson(await put(id, {}));
    expect(empty.status).toBe(200);
    expect(empty.body.step).toBe("review"); // unchanged — empty body only bumps updatedAt

    // exportedAt is passed through UNVALIDATED (frozen quirk — the service header calls it out).
    // Freeze the passthrough: a null is accepted + written (proves the field is not rejected and is
    // persisted), so adding validation or dropping the write would fail here.
    const exported = await readJson(await put(id, { exportedAt: null }));
    expect(exported.status).toBe(200);
    expect(exported.body.exportedAt).toBe(null);

    const badStep = await readJson(await put(id, { step: "bogus" }));
    expect(badStep.status).toBe(400);
    expect(badStep.body.error).toEqual({ code: "VALIDATION", message: "invalid step" });

    const badPage = await readJson(await put(id, { schedulePageNumber: 0 }));
    expect(badPage.status).toBe(400);
    expect(badPage.body.error.message).toBe("invalid schedulePageNumber");

    const big = "x".repeat(1_100_000);
    const oversized = await readJson(await put(id, { lineItems: [big] }));
    expect(oversized.status).toBe(400);
    expect(oversized.body.error.message).toBe("lineItems exceeds 1MB limit");

    const longStr = "y".repeat(1025);
    const badLabel = await readJson(await put(id, { materialLabel: longStr }));
    expect(badLabel.status).toBe(400);
    expect(badLabel.body.error.message).toBe("invalid materialLabel");

    // short-circuit: step is validated BEFORE schedulePageNumber → step's message wins
    const both = await readJson(await put(id, { step: "bogus", schedulePageNumber: 0 }));
    expect(both.status).toBe(400);
    expect(both.body.error.message).toBe("invalid step");
  });

  it("PUT: signed-out → 401; cross-tenant → 404; missing → 404; NaN id → 500", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const id = await makeWorkflow(project.publicId);

    signedOut();
    expect((await readJson(await put(id, { step: "review" }))).status).toBe(401);

    asUser(await createUser((await createCompany()).id));
    expect((await readJson(await put(id, { step: "review" }))).status).toBe(404);

    asUser(user);
    expect((await readJson(await put(999999, { step: "review" }))).status).toBe(404);

    const nan = await readJson(await put("abc", { step: "review" }));
    expect(nan.status).toBe(500);
    expect(nan.body.error).toEqual(INTERNAL_500);
  });

  it("L5 freeze: demo PUT/DELETE deny signed-out, member, admin, and root with zero changes", async () => {
    const { company, project } = await createWorld();
    const member = await createUser(company.id);
    const admin = await createUser(company.id, { role: "admin" });
    const root = await createUser((await createCompany()).id, { role: "admin", isRootAdmin: true });
    const actors = [null, member, admin, root];
    const ids: number[] = [];
    const statuses: number[] = [];
    const seededPairs = [];
    for (const [index] of actors.entries()) {
      const seeded = await db
        .insert(qtoWorkflows)
        .values([
          { projectId: project.id, materialType: `put-${index}`, materialLabel: "original", step: "pick" },
          { projectId: project.id, materialType: `delete-${index}`, materialLabel: "original", step: "pick" },
        ])
        .returning();
      ids.push(...seeded.map((row) => row.id));
      seededPairs.push(seeded);
    }
    await publishDemoFixture(project.id);

    for (const [index, actor] of actors.entries()) {
      const seeded = seededPairs[index];
      actor ? asUser(actor) : signedOut();
      statuses.push((await readJson(await put(seeded[0].id, { step: "review" }))).status);
      statuses.push((await readJson(await del(seeded[1].id))).status);
    }
    expect(statuses).toEqual(Array(8).fill(403));
    const rows = await db.select().from(qtoWorkflows).where(inArray(qtoWorkflows.id, ids));
    expect(rows).toHaveLength(8);
    expect(rows.every((row) => row.step === "pick")).toBe(true);
  });

  it("DELETE: happy (then 404 on re-get); signed-out → 401; missing → 404; cross-tenant → 404; NaN id → 500", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const id = await makeWorkflow(project.publicId);

    const gone = await readJson(await del(id));
    expect(gone.status).toBe(200);
    expect(gone.body).toEqual({ success: true });
    expect((await readJson(await get(id))).status).toBe(404); // really gone

    const id2 = await makeWorkflow(project.publicId);
    signedOut();
    expect((await readJson(await del(id2))).status).toBe(401);

    asUser(user);
    expect((await readJson(await del(999999))).status).toBe(404);

    asUser(await createUser((await createCompany()).id));
    expect((await readJson(await del(id2))).status).toBe(404); // cross-tenant

    asUser(user);
    const nan = await readJson(await del("abc"));
    expect(nan.status).toBe(500);
    expect(nan.body.error).toEqual(INTERNAL_500);
  });

  // Inherited zLooseBody/shell diff (the de-facto 4th sanctioned diff, same as families 1/2):
  // legacy PUT did property access (body.step, body[key]) on the parsed body with NO destructure,
  // so a non-object body (array/number/string/bool) yielded all-undefined → no field validation →
  // a 200 no-op that bumped updatedAt. The shell's body:zLooseBody now REJECTS every non-object →
  // 400, and that 400 fires in the shell's validate phase BEFORE loadWorkflowAndAuthz, so it also
  // precedes the 404 (missing) and 401 (signed-out). STATUS is frozen here (the narrowing is
  // accepted; non-object PUT bodies are not a real client path).
  it("PUT non-object body → shell 400, fired BEFORE load/authz (inherited zLooseBody diff)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const id = await makeWorkflow(project.publicId);

    // existing workflow + non-object body → 400 (legacy returned a 200 no-op)
    const num = await readJson(await put(id, 42));
    expect(num.status).toBe(400);
    expect(num.body.error.code).toBe("VALIDATION");
    expect((await readJson(await put(id, [1, 2]))).status).toBe(400);

    // the body-shape 400 PRECEDES the 404 (missing id) and the 401 (signed out) — shell ordering
    expect((await readJson(await put(999999, 42))).status).toBe(400); // not 404
    signedOut();
    expect((await readJson(await put(id, 42))).status).toBe(400); // not 401
  });
});
