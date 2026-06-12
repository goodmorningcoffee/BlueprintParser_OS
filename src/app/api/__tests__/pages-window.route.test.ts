// @vitest-environment node
// [refactor jun12 P0.3] CHARACTERIZATION for GET /api/projects/[id]/pages —
// the chunk-loader window contract (useChunkLoader.ts:78). This payload shape
// is what P2.2⑦ re-implements as the pagesWindow query; freeze it exactly,
// including the annotation visibility rule: a member sees THEIR OWN
// annotations plus project-scoped machine sources (yolo / shape-parse /
// symbol-search) — but NOT another user's hand-drawn ones.
import { describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { GET } from "@/app/api/projects/[id]/pages/route";
import { db } from "@/lib/db";
import { annotations } from "@/lib/db/schema";
import {
  asUser,
  createPage,
  createUser,
  createWorld,
  makeReq,
  params,
  readJson,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

function windowReq(publicId: string, from: number | string, to: number | string) {
  return makeReq(`/api/projects/${publicId}/pages?from=${from}&to=${to}`, { method: "GET" });
}

async function seedAnnotation(projectId: number, pageNumber: number, creatorId: number, source: string, name: string) {
  await db.insert(annotations).values({
    projectId, pageNumber, creatorId, source, name,
    minX: 0.1, minY: 0.1, maxX: 0.2, maxY: 0.2,
  });
}

describe.skipIf(!dbUp)("GET /api/projects/[id]/pages (chunk window)", () => {
  it("returns the window payload shape with per-page jsonb fields", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1, { keynotes: { K1: "demising wall" } as any });
    await createPage(project.id, 2);
    await createPage(project.id, 9); // outside window
    asUser(user);

    const { status, body } = await readJson(await GET(windowReq(project.publicId, 1, 8), params({ id: project.publicId })));
    expect(status).toBe(200);
    expect(body.from).toBe(1);
    expect(body.to).toBe(8);
    expect(body.pages).toHaveLength(2);
    expect(body.pages[0]).toEqual({
      pageNumber: 1,
      name: "Page 1",
      drawingNumber: null,
      keynotes: { K1: "demising wall" },
      csiCodes: null,
      textAnnotations: null,
      pageIntelligence: null,
    });
  });

  it("range validation: to<from, from<1, window>50 → 400; defaults from=1 to=9", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 3);
    asUser(user);
    for (const [f, t] of [[5, 2], [0, 5], [1, 52]] as const) {
      const { status, body } = await readJson(await GET(windowReq(project.publicId, f, t), params({ id: project.publicId })));
      expect(status).toBe(400);
      expect(body.error).toBe("Invalid range. Max 50 pages per request.");
    }
    const def = await readJson(
      await GET(makeReq(`/api/projects/${project.publicId}/pages`, { method: "GET" }), params({ id: project.publicId })),
    );
    expect(def.status).toBe(200);
    expect([def.body.from, def.body.to]).toEqual([1, 9]);
  });

  it("annotation visibility: own + machine sources, NOT another member's hand-drawn", async () => {
    const { user, project, company } = await createWorld();
    const teammate = await createUser(company.id);
    await createPage(project.id, 1);
    await seedAnnotation(project.id, 1, user.id, "user", "mine");
    await seedAnnotation(project.id, 1, teammate.id, "user", "theirs"); // hidden from `user`
    await seedAnnotation(project.id, 1, teammate.id, "yolo", "machine-yolo"); // visible (project-scoped)
    await seedAnnotation(project.id, 1, teammate.id, "symbol-search", "machine-symbol"); // visible
    asUser(user);

    const { body } = await readJson(await GET(windowReq(project.publicId, 1, 5), params({ id: project.publicId })));
    const names = body.annotations.map((a: { name: string }) => a.name).sort();
    expect(names).toEqual(["machine-symbol", "machine-yolo", "mine"]);
    expect(body.annotations[0].bbox).toHaveLength(4);
  });
});
