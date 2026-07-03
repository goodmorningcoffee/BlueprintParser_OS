// @vitest-environment node
// [refactor jul3 P1.5] CHARACTERIZATION for GET /api/projects/export-index, written as THE FREEZE
// before the P1.5 migration onto services/export.ts (exportIndex). ⚠️ Like /export this feeds
// EXTERNAL download tooling (no first-party consumer) — the 200 body stays byte-identical. Frozen:
//   • AUTH-FIRST requireAuth (401 signed-out) → auth:"session" shell at fold time.
//   • scope: root admin → ALL projects (every company); member → OWN company only. Tests are
//     POLLUTION-ROBUST (shared test DB): assertions scoped to own publicIds, never absolute
//     counts on the root path.
//   • coverage counts by annotation source (yolo/shape-parse/symbol-search/user), DISTINCT
//     yoloModels from data->>'modelName' (sorted, nulls skipped), parsedRegions JSONB aggregates
//     (SUM of jsonb_array_length + COUNT FILTER pages-with-any), qtoWorkflows count.
//   • richness = parsedRegions*5 + qtoWorkflows*5 + (symbolSearch>0 ? 3 : 0) + userAnnotations*1
//     — yolo and shapeParse contribute ZERO (info-only). Output sorted richness DESC.
//   • empty world → {projects: []} (early return).
import { describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { GET } from "@/app/api/projects/export-index/route";
import { db } from "@/lib/db";
import { annotations, qtoWorkflows } from "@/lib/db/schema";
import {
  asUser,
  createCompany,
  createPage,
  createProject,
  createUser,
  createWorld,
  makeReq,
  readJson,
  signedOut,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

const idx = () => GET(makeReq("/api/projects/export-index", { method: "GET" }));

async function seedAnn(projectId: number, source: string, data: unknown = null) {
  await db.insert(annotations).values({
    name: "a",
    minX: 0,
    minY: 0,
    maxX: 1,
    maxY: 1,
    pageNumber: 1,
    projectId,
    source,
    data: data as never,
  });
}

describe.skipIf(!dbUp)("GET /api/projects/export-index", () => {
  it("signed-out → 401 (AUTH-FIRST)", async () => {
    signedOut();
    const { status, body } = await readJson(await idx());
    expect(status).toBe(401);
    expect(body.error).toBe("Unauthorized"); // [P1.5 fold] → {code:"UNAUTHORIZED",message:"Unauthorized"}
  });

  it("member: own-company only; coverage/richness computed; sorted richness DESC", async () => {
    const { user, project, company } = await createWorld(); // rich project
    const bare = await createProject(company.id, user.id); // zero-coverage project
    await createPage(project.id, 1, {
      pageIntelligence: { parsedRegions: [{ a: 1 }, { b: 2 }] } as never,
    });
    await createPage(project.id, 2); // no parsedRegions
    await seedAnn(project.id, "yolo", { modelName: "m2" });
    await seedAnn(project.id, "yolo", { modelName: "m1" });
    await seedAnn(project.id, "yolo", {}); // null modelName → skipped from yoloModels
    await seedAnn(project.id, "shape-parse");
    await seedAnn(project.id, "symbol-search");
    await seedAnn(project.id, "user");
    await seedAnn(project.id, "user");
    await db.insert(qtoWorkflows).values({
      projectId: project.id,
      materialType: "concrete",
      step: "select-schedule",
    } as never);
    asUser(user);

    const { status, body } = await readJson(await idx());
    expect(status).toBe(200);
    const mine = body.projects.filter((p: { publicId: string }) =>
      [project.publicId, bare.publicId].includes(p.publicId),
    );
    expect(mine).toHaveLength(2); // member scope = own company (the two seeded)
    const rich = mine.find((p: { publicId: string }) => p.publicId === project.publicId);
    expect(rich.coverage).toEqual({
      yolo: 3,
      yoloModels: ["m1", "m2"], // sorted, null skipped
      shapeParse: 1,
      symbolSearch: 1,
      userAnnotations: 2,
      parsedRegions: 2, // jsonb_array_length sum
      pagesWithParsedRegions: 1, // page 2 has none
      qtoWorkflows: 1,
    });
    // richness = 2*5 + 1*5 + 3 + 2*1 = 20 (yolo/shapeParse contribute ZERO)
    expect(rich.richness).toBe(20);
    const bareRow = mine.find((p: { publicId: string }) => p.publicId === bare.publicId);
    expect(bareRow.richness).toBe(0);
    expect(bareRow.coverage.yoloModels).toEqual([]);
    // sorted richness DESC → rich before bare
    expect(body.projects.indexOf(rich)).toBeLessThan(body.projects.indexOf(bareRow));
    // shape: exact key set per row
    expect(Object.keys(rich).sort()).toEqual([
      "coverage",
      "createdAt",
      "name",
      "numPages",
      "publicId",
      "richness",
      "status",
    ]);
  });

  it("member does NOT see another company's projects; root admin DOES (frozen scopes)", async () => {
    const worldA = await createWorld();
    const worldB = await createWorld();

    asUser(worldA.user);
    const a = await readJson(await idx());
    const aIds = a.body.projects.map((p: { publicId: string }) => p.publicId);
    expect(aIds).toContain(worldA.project.publicId);
    expect(aIds).not.toContain(worldB.project.publicId); // company-scoped

    asUser(await createUser((await createCompany()).id, { isRootAdmin: true }));
    const r = await readJson(await idx());
    const rIds = r.body.projects.map((p: { publicId: string }) => p.publicId);
    expect(rIds).toContain(worldA.project.publicId); // root sees ALL companies
    expect(rIds).toContain(worldB.project.publicId);
  });

  it("member of a fresh company with no projects → {projects: []} (early return)", async () => {
    asUser(await createUser((await createCompany()).id));
    const { status, body } = await readJson(await idx());
    expect(status).toBe(200);
    expect(body).toEqual({ projects: [] });
  });
});
