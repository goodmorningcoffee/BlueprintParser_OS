// @vitest-environment node
// [refactor jul3 P1.5] CHARACTERIZATION for GET /api/demo/labeling/sessions, written as THE
// FREEZE before the P1.4-deferred fold onto services/labeling.ts (listDemoLabelingSessions —
// the PUBLIC twin of S020's listLabelingSessions; DELIBERATELY ISOLATED, do NOT parameterize
// the authed fn to serve both). Frozen:
//   • FULLY PUBLIC: no auth at all.
//   • projectId query param required → 400 "projectId required" (the FIRST check).
//   • project gate = and(publicId, isDemo=true) → unknown uuid AND non-demo project BOTH return
//     **[] at 200 — NOT 404** (THE quirk; unlike the demo pages twin which 404s — do not
//     harmonize either way).
//   • 200 = BARE ARRAY mapped to EXACTLY 5 fields {id, labelStudioUrl, taskType, pageRange,
//     taskCount} with taskCount HARDCODED 0 ("Not stored in DB, cosmetic only") — must NEVER
//     grow the authed 8-field shape (labelStudioProjectId/labels/status/createdAt stay absent:
//     data-minimization on an UNAUTHENTICATED endpoint).
//   • non-uuid projectId: legacy had no catch → pg uuid-cast THREW (S003 class). Now a clean 400
//     "Invalid project id" AFTER the required-400 (sanctioned diff C).
// Assertions tagged [P1.5 fold] were flipped in the fold commit from the legacy {error:string}
// envelope to {error:{code,message}} (sanctioned diff A); the freeze form is at commit 87199c4.
import { randomUUID } from "node:crypto";
import { describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { GET } from "@/app/api/demo/labeling/sessions/route";
import { db } from "@/lib/db";
import { labelingSessions } from "@/lib/db/schema";
import {
  asUser,
  createCompany,
  createUser,
  createWorld,
  makeReq,
  readJson,
  signedOut,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

const list = (projectId?: string) =>
  GET(
    makeReq(
      `/api/demo/labeling/sessions${projectId !== undefined ? `?projectId=${projectId}` : ""}`,
      { method: "GET" },
    ),
  );

async function seedSession(projectId: number, companyId: number, over: Record<string, unknown> = {}) {
  const [row] = await db
    .insert(labelingSessions)
    .values({
      projectId,
      companyId,
      labelStudioProjectId: 70000 + Math.floor(Math.random() * 9999),
      labelStudioUrl: "http://ls.test/projects/70001",
      taskType: "generic",
      pageRange: "1-3",
      status: "active",
      ...over,
    })
    .returning();
  return row;
}

// The exact 5 public wire fields (alphabetical for the sorted key-set assertion).
const WIRE_FIELDS = ["id", "labelStudioUrl", "pageRange", "taskCount", "taskType"];

describe.skipIf(!dbUp)("GET /api/demo/labeling/sessions", () => {
  it("happy (signed-out): bare array of EXACTLY the 5 public fields, values pinned, taskCount hardcoded 0", async () => {
    const { project, company } = await createWorld({ isDemo: true });
    const s1 = await seedSession(project.id, company.id, {
      labelStudioUrl: "http://ls.test/projects/71001",
      pageRange: "1-3",
    });
    const s2 = await seedSession(project.id, company.id, {
      labelStudioUrl: "http://ls.test/projects/71002",
      taskType: "tiled",
      pageRange: "4-9",
    });
    signedOut();

    const { status, body } = await readJson(await list(project.publicId));
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true); // BARE array
    expect(body).toHaveLength(2);
    for (const row of body) {
      expect(Object.keys(row).sort()).toEqual(WIRE_FIELDS); // 5-field subset — authed-only fields NEVER leak
      expect(row.taskCount).toBe(0); // hardcoded cosmetic 0
    }
    const byId = Object.fromEntries(body.map((r: { id: number }) => [r.id, r]));
    expect(byId[s1.id]).toEqual({
      id: s1.id,
      labelStudioUrl: "http://ls.test/projects/71001",
      taskType: "generic",
      pageRange: "1-3",
      taskCount: 0,
    });
    expect(byId[s2.id]).toEqual({
      id: s2.id,
      labelStudioUrl: "http://ls.test/projects/71002",
      taskType: "tiled",
      pageRange: "4-9",
      taskCount: 0,
    });
  });

  it("missing projectId → 400 'projectId required'", async () => {
    signedOut();
    const { status, body } = await readJson(await list());
    expect(status).toBe(400);
    expect(body.error).toEqual({ code: "VALIDATION", message: "projectId required" }); // [P1.5 fold] flipped (legacy: bare string)
  });

  it("unknown (valid) uuid → 200 [] — NOT 404 (THE frozen quirk)", async () => {
    signedOut();
    const { status, body } = await readJson(await list(randomUUID()));
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it("NON-demo project with sessions → 200 [] (isDemo gate; no existence signal, no data)", async () => {
    const { project, company } = await createWorld(); // isDemo: false
    await seedSession(project.id, company.id);
    // even an authed cross-company (or any) caller: same public [] — route never reads a session
    asUser(await createUser((await createCompany()).id, { isRootAdmin: true }));
    const { status, body } = await readJson(await list(project.publicId));
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  // [P1.5 fold] WHOLE assertion flipped: legacy had no catch → the pg uuid-cast REJECTED (frozen
  // at 87199c4 as .rejects.toThrow()). Now sanctioned diff C: clean 400 via zPublicId, gated
  // AFTER the projectId-required 400 (the missing-field message still wins).
  it("non-uuid projectId → 400 'Invalid project id' (sanctioned diff C; legacy threw)", async () => {
    signedOut();
    const { status, body } = await readJson(await list("not-a-uuid"));
    expect(status).toBe(400);
    expect(body.error).toEqual({ code: "VALIDATION", message: "Invalid project id" });
  });
});
