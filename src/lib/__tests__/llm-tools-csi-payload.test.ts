// @vitest-environment node
// [csi-v2 S6] Call-site pins for the slim LLM CSI payload. The helper (`csiCodesForLlm`) is unit
// tested in csi-utils.test.ts; these assert the two tool executors actually route through it, so
// reverting either call site to the raw stored codes (triggers, bboxes, division) fails here.
import { describe, expect, inject, it } from "vitest";
import { executeToolCall, type ToolContext } from "@/lib/llm/tools";
import { assertProjectWritable } from "@/server/api/project-write-capability";
import { createPage, createWorld } from "@/test/harness";
import { existsSync as __hasKbExists } from "node:fs";
import { join as __hasKbJoin } from "node:path";
// KB-backed tests skip without src/data/csi-kb.json (gitignored, owner ruling D1; see src/test/global-setup.ts).
const HAS_KB = __hasKbExists(__hasKbJoin(process.cwd(), "src/data/csi-kb.json"));

const dbUp = inject("dbUp") as boolean;
const SLIM_KEYS = new Set(["code", "description", "trade", "confidence"]);

function expectSlim(codes: unknown) {
  expect(Array.isArray(codes)).toBe(true);
  for (const c of codes as Record<string, unknown>[]) {
    expect(Object.keys(c).filter((k) => !SLIM_KEYS.has(k))).toEqual([]);
  }
}

describe.skipIf(!dbUp)("getPageDetails CSI payload", () => {
  it("returns {code, description, trade, confidence?} — never the stored triggers/bboxes/division", async () => {
    const { company, user, project } = await createWorld();
    const stored = [
      {
        code: "08 11 13", description: "Hollow Metal Doors and Frames", trade: "Openings",
        division: "08 00 00", confidence: 0.91,
        triggers: [{ text: "hollow metal", bbox: [0.1, 0.1, 0.2, 0.02], bboxes: [[0.1, 0.1, 0.09, 0.02], [0.2, 0.1, 0.1, 0.02]], tier: 1 }],
      },
      {
        code: "081416", description: "Flush Wood Doors", trade: "Openings", division: "08",
        triggers: [{ text: "wood doors", bbox: [0.3, 0.3, 0.1, 0.02], tier: 2 }],
      },
    ];
    await createPage(project.id, 1, { csiCodes: stored as never });
    const ctx: ToolContext = {
      projectId: project.id,
      publicId: project.publicId,
      companyId: company.id,
      userId: user.id,
      writeCapability: assertProjectWritable(project),
    };

    const res = (await executeToolCall("getPageDetails", { pageNumber: 1 }, ctx)) as { csiCodes: unknown };
    expectSlim(res.csiCodes);
    expect(res.csiCodes).toEqual([
      { code: "08 11 13", description: "Hollow Metal Doors and Frames", trade: "Openings", confidence: 0.91 },
      { code: "081416", description: "Flush Wood Doors", trade: "Openings" },
    ]);
  });
});

describe("detectCsiFromText payload", () => {
  it.skipIf(!HAS_KB)("returns slim codes (no division/triggers) through the public demo path", async () => {
    const res = await executeToolCall(
      "detectCsiFromText",
      { text: "HOLLOW METAL DOORS AND FRAMES" },
      { projectId: 0, publicId: "x", companyId: 0 },
    );
    expect((res as unknown[]).length).toBeGreaterThan(0);
    expectSlim(res);
  });
});
