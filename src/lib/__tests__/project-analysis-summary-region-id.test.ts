// @vitest-environment node
// [TP-1 WP-1.A K11, fix round] `summaries.parsedTables[]` names the region each entry came from.
// Auto-QTO resolves a summary-only schedule by this id; without it two tables with the same name
// on one page can only be told apart by guessing. DB-backed (real computeProjectSummaries).
// Synthetic text only.
import { describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { computeProjectSummaries } from "@/lib/project-analysis";
import { assertProjectWritable } from "@/server/api/access";
import { createCompany, createPage, createProject, createUser } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

function schedule(id: string, tableName: string, tag: string) {
  return {
    id,
    type: "schedule",
    category: "door-schedule",
    bbox: [0.1, 0.1, 0.4, 0.4],
    data: { tableName, headers: ["TAG", "SIZE"], rows: [{ TAG: tag, SIZE: "S" }], tagColumn: "TAG" },
  };
}

describe.skipIf(!dbUp)("computeProjectSummaries parsedTables identity (K11)", () => {
  it("every parsed table entry carries its region id, also when two share a name", async () => {
    const company = await createCompany();
    const admin = await createUser(company.id, { role: "admin" });
    const project = await createProject(company.id, admin.id, { numPages: 2 });
    await createPage(project.id, 1);
    await createPage(project.id, 2, {
      pageIntelligence: {
        parsedRegions: [
          schedule("pr-first", "Door Schedule", "D-1"),
          schedule("pr-second", "Door Schedule", "D-2"),
          { id: "kn-1", type: "keynote", category: "keynote-table", bbox: [0.5, 0.5, 0.9, 0.9], data: { headers: ["Key", "Description"], rows: [] } },
        ],
      } as never,
    });
    const [row] = await db.select().from(projects).where(eq(projects.id, project.id));
    const summaries = await computeProjectSummaries(project.id, assertProjectWritable(row));

    expect(summaries.parsedTables.map((entry) => [entry.pageNum, entry.name, entry.regionId])).toEqual([
      [2, "Door Schedule", "pr-first"],
      [2, "Door Schedule", "pr-second"],
      [2, "keynote-table", "kn-1"],
    ]);
  });
});
