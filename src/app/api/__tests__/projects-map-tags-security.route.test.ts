// @vitest-environment node
// L5 freeze-first oracle: anonymous demo compute may use explicitly public inputs, but generic
// annotation rows and private page-intelligence fields must not cross the matching-engine seam.
import { beforeEach, describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

const h = vi.hoisted(() => ({ findOccurrences: vi.fn() }));
vi.mock("@/lib/tag-mapping", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tag-mapping")>()),
  findOccurrences: h.findOccurrences,
}));

import { POST } from "@/app/api/projects/[id]/map-tags-batch/route";
import { db } from "@/lib/db";
import { annotations } from "@/lib/db/schema";
import {
  createPage,
  createWorld,
  makeReq,
  params,
  publishDemoFixture,
  readJson,
  signedOut,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

beforeEach(() => {
  vi.clearAllMocks();
  h.findOccurrences.mockReturnValue([]);
  signedOut();
});

describe.skipIf(!dbUp)("POST /api/projects/[id]/map-tags-batch public input policy", () => {
  it("L5 freeze: private annotation and page-intelligence canaries never reach findOccurrences", async () => {
    const { project } = await createWorld();
    await createPage(project.id, 1, {
      drawingNumber: "A-101",
      textractData: { words: [{ text: "PUBLIC", bbox: [0, 0, 0.1, 0.1] }] } as any,
      pageIntelligence: {
        classifiedRegions: { privateCanary: "PRIVATE-MAP-PI-CANARY" },
      } as any,
    });
    await db.insert(annotations).values({
      projectId: project.id,
      pageNumber: 1,
      name: "PRIVATE-MAP-ANNOTATION-CANARY",
      note: "PRIVATE-MAP-NOTE-CANARY",
      minX: 0.1,
      minY: 0.1,
      maxX: 0.2,
      maxY: 0.2,
      source: "user",
      data: { privateCanary: "PRIVATE-MAP-DATA-CANARY" } as never,
    });
    await publishDemoFixture(project.id);

    const response = await readJson(
      await POST(
        makeReq(`/api/projects/${project.publicId}/map-tags-batch`, {
          method: "POST",
          body: { tags: ["PUBLIC"] },
        }),
        params({ id: project.publicId }),
      ),
    );
    expect(response.status).toBe(200);
    expect(h.findOccurrences).toHaveBeenCalled();
    const serializedContext = JSON.stringify(h.findOccurrences.mock.calls[0][1]);
    for (const canary of [
      "PRIVATE-MAP-PI-CANARY",
      "PRIVATE-MAP-ANNOTATION-CANARY",
      "PRIVATE-MAP-NOTE-CANARY",
      "PRIVATE-MAP-DATA-CANARY",
    ]) {
      expect.soft(serializedContext).not.toContain(canary);
    }
  });
});
