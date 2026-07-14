// @vitest-environment node
// B2 freeze: exported LLM mutation executors enforce demo immutability themselves. Tool-list
// filtering and a caller-supplied boolean are not authority.
import { describe, expect, inject, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { annotations } from "@/lib/db/schema";
import { executeToolCall, type ToolContext } from "@/lib/llm/tools";
import { assertProjectWritable } from "@/server/api/project-write-capability";
import { createWorld } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

describe.skipIf(!dbUp)("LLM tool executor security", () => {
  it("keeps private mutation results unchanged behind the atomic project boundary", async () => {
    const { company, user, project } = await createWorld();
    const ctx: ToolContext = {
      projectId: project.id,
      publicId: project.publicId,
      companyId: company.id,
      userId: user.id,
      writeCapability: assertProjectWritable(project),
    };

    const created = await executeToolCall("createMarkup", {
      pageNumber: 1,
      name: "ATOMIC-MARKUP",
      minX: 0.1,
      minY: 0.1,
      maxX: 0.2,
      maxY: 0.2,
      note: "first",
    }, ctx) as { annotationId: number };

    expect.soft(created).toMatchObject({
      action: "createMarkup",
      annotationId: expect.any(Number),
      pageNumber: 1,
      name: "ATOMIC-MARKUP",
    });

    const appended = await executeToolCall("addNoteToAnnotation", {
      annotationId: created.annotationId,
      note: "second",
    }, ctx);
    expect.soft(appended).toEqual({
      annotationId: created.annotationId,
      note: "first\nsecond",
      appended: true,
    });

    const batched = await executeToolCall("batchAddNotes", {
      pageNumber: 1,
      className: "ATOMIC-MARKUP",
      note: "third",
    }, ctx);
    expect.soft(batched).toEqual({ updated: 1, totalMatched: 1, noteAppended: "third" });

    const [stored] = await db
      .select({ note: annotations.note })
      .from(annotations)
      .where(eq(annotations.id, created.annotationId));
    expect.soft(stored?.note).toBe("first\nsecond\nthird");
  });

  it("B2 RED: a forged allowMutatingTools flag/fake capability cannot write a demo project", async () => {
    const { company, user, project } = await createWorld({ isDemo: true });
    const forgedContext = {
      projectId: project.id,
      publicId: project.publicId,
      companyId: company.id,
      userId: user.id,
      allowMutatingTools: true,
      // Deliberately resembles authority but lacks the module-private capability brand.
      writeCapability: { projectId: project.id, publicId: project.publicId, companyId: company.id },
    } as unknown as ToolContext;

    const result = await executeToolCall("createMarkup", {
      pageNumber: 1,
      name: "FORGED-DEMO-WRITE",
      minX: 0.1,
      minY: 0.1,
      maxX: 0.2,
      maxY: 0.2,
    }, forgedContext);

    expect.soft(result).toMatchObject({ error: expect.any(String) });
    expect.soft(await db.select().from(annotations).where(eq(annotations.projectId, project.id))).toEqual([]);
  });
});
