// @vitest-environment node
// [refactor jul3 P1.5] CHARACTERIZATION for DELETE /api/labeling/sessions/[id], written as THE
// FREEZE before the P1.5 migration onto services/labeling.ts (no P0.3 file existed). Frozen:
//   • AUTH-FIRST requireAuth (401 before any lookup).
//   • lookup = and(eq(labelingSessions.id, parseInt(id)), eq(companyId, session.companyId)) —
//     DIRECT on the DENORMALIZED companyId column, NO project join, NO isRootAdmin bypass.
//     Root admin cross-company → 404 AND the row survives (R1 guard vs a future
//     resolveProjectOrThrow "simplification").
//   • parseInt(id) — NOT Number(): trailing garbage is TOLERATED ("999999abc" → 999999 → real
//     lookup → 404, never 500). Only a leading non-digit ("abc") yields NaN → pg int-cast throw.
//     Do NOT "upgrade" to Number() (would flip "5abc" from 404 to 500 — unsanctioned).
//   • Label Studio deleteProject failure is SWALLOWED (logger only) — DB row is still deleted and
//     the response is still 200 {success:true}. No affected-rows check (TOCTOU no-op).
//   • NaN id: legacy has no catch → pg int-cast REJECTS. Flips to the shell's leak-free
//     INTERNAL 500 at fold time (qto/annotations/takeoff-items precedent — NOT a clean 400).
// Assertions tagged [P1.5 fold] flip envelopes in the fold commit (sanctioned diff A).
import { describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

// Mock the Label Studio client — tests never talk to a live LS. deleteProject is per-test
// controllable; the other exports exist so the fold-time service module (which also imports
// createProject/importTasks) loads under the same mock.
const lsMocks = vi.hoisted(() => ({
  deleteProject: vi.fn(),
  createProject: vi.fn(),
  importTasks: vi.fn(),
  getProject: vi.fn(),
  healthCheck: vi.fn(),
}));
vi.mock("@/lib/label-studio", () => lsMocks);

import { DELETE } from "@/app/api/labeling/sessions/[id]/route";
import { db } from "@/lib/db";
import { labelingSessions } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
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

const del = (id: number | string) =>
  DELETE(makeReq(`/api/labeling/sessions/${id}`, { method: "DELETE" }), params({ id: String(id) }));

async function seedSession(projectId: number, companyId: number) {
  const [row] = await db
    .insert(labelingSessions)
    .values({
      projectId,
      companyId,
      labelStudioProjectId: 80000 + Math.floor(Math.random() * 9999),
      labelStudioUrl: "http://ls.test/projects/80001",
      taskType: "generic",
      pageRange: "1-3",
      status: "active",
    })
    .returning();
  return row;
}

const rowById = (id: number) =>
  db.select().from(labelingSessions).where(eq(labelingSessions.id, id));

describe.skipIf(!dbUp)("DELETE /api/labeling/sessions/[id]", () => {
  it("happy: 200 {success:true}, row gone, LS deleteProject called with the LS project id", async () => {
    const { user, project, company } = await createWorld();
    const session = await seedSession(project.id, company.id);
    asUser(user);
    lsMocks.deleteProject.mockResolvedValueOnce(undefined);

    const { status, body } = await readJson(await del(session.id));
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(await rowById(session.id)).toHaveLength(0); // really deleted
    expect(lsMocks.deleteProject).toHaveBeenCalledWith(session.labelStudioProjectId);
  });

  it("LS deleteProject failure is SWALLOWED: still 200 {success:true} and the row is still deleted (frozen quirk)", async () => {
    const { user, project, company } = await createWorld();
    const session = await seedSession(project.id, company.id);
    asUser(user);
    lsMocks.deleteProject.mockRejectedValueOnce(new Error("LS down"));

    const { status, body } = await readJson(await del(session.id));
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(await rowById(session.id)).toHaveLength(0); // DB cleanup proceeds despite LS failure
  });

  it("missing id → 404 'Not found'", async () => {
    const { user } = await createWorld();
    asUser(user);
    const { status, body } = await readJson(await del(999999));
    expect(status).toBe(404);
    expect(body.error).toBe("Not found"); // [P1.5 fold] → {code:"NOT_FOUND",message:"Not found"}
  });

  it("signed-out → 401 (AUTH-FIRST)", async () => {
    const { project, company } = await createWorld();
    const session = await seedSession(project.id, company.id);
    signedOut();
    const { status, body } = await readJson(await del(session.id));
    expect(status).toBe(401);
    expect(body.error).toBe("Unauthorized"); // [P1.5 fold] → {code:"UNAUTHORIZED",message:"Unauthorized"}
    expect(await rowById(session.id)).toHaveLength(1); // untouched
  });

  it("R1: ROOT ADMIN cross-company → 404 AND the row survives (NO bypass on the companyId-scoped lookup)", async () => {
    const { project, company } = await createWorld();
    const session = await seedSession(project.id, company.id);
    asUser(await createUser((await createCompany()).id, { isRootAdmin: true }));

    const { status, body } = await readJson(await del(session.id));
    expect(status).toBe(404);
    expect(body.error).toBe("Not found"); // [P1.5 fold] → {code:"NOT_FOUND",message:"Not found"}
    expect(await rowById(session.id)).toHaveLength(1); // NOT deleted — no cross-company reach
  });

  it("trailing-garbage id '<n>abc' → parseInt tolerance → 404 (frozen: parseInt NOT Number — never a 500)", async () => {
    const { user } = await createWorld();
    asUser(user);
    const { status, body } = await readJson(await del("999999abc")); // parseInt → 999999 → no row
    expect(status).toBe(404);
    expect(body.error).toBe("Not found"); // [P1.5 fold] → {code:"NOT_FOUND",message:"Not found"}
  });

  // [P1.5 fold] WHOLE assertion flips: parseInt("abc") = NaN → legacy has no catch → the pg
  // int-cast REJECTS (raw framework 500 in prod). Fold = the shell's deterministic leak-free
  // INTERNAL 500 (frozen at 500 — NOT diff-D'd to a 400; qto-workflows/[id] precedent).
  it("non-numeric id → legacy pg int-cast throw on NaN (frozen defensive form)", async () => {
    const { user } = await createWorld();
    asUser(user);
    await expect(del("abc")).rejects.toThrow();
  });
});
