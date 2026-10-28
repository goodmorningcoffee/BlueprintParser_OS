// @vitest-environment node
// [table pipeline WP-3.J fix round, VERIFY MED-1] POST /api/admin/reprocess?scope=intelligence reads
// `tools.notesAuto` once, before the loop, and passes it to A12 (`analyzePageIntelligence`) and A03
// (`classifyTextRegions`). Before this file, dropping it from either call left every test green (verifier mutant
// V2). The flag reader is mocked to a chosen mode; both stages run REAL behind spies.
import { beforeEach, describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});
const h = vi.hoisted(() => ({ notesAuto: "engine" as "legacy" | "engine" }));
vi.mock("@/server/services/parse-engine/flags", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/server/services/parse-engine/flags")>();
  return { ...orig, readParseEngineFlags: vi.fn(async () => orig.resolveParseEngineFlags({ tools: { notesAuto: h.notesAuto } }).flags) };
});
vi.mock("@/lib/page-analysis", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/page-analysis")>();
  return { ...orig, analyzePageIntelligence: vi.fn(orig.analyzePageIntelligence) };
});
vi.mock("@/lib/text-region-classifier", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/text-region-classifier")>();
  return { ...orig, classifyTextRegions: vi.fn(orig.classifyTextRegions) };
});

import { POST } from "@/app/api/admin/reprocess/route";
import { analyzePageIntelligence } from "@/lib/page-analysis";
import { classifyTextRegions } from "@/lib/text-region-classifier";
import { readParseEngineFlags } from "@/server/services/parse-engine/flags";
import { asUser, createPage, createUser, createWorld, makeReq } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;
const a12 = vi.mocked(analyzePageIntelligence);
const a03 = vi.mocked(classifyTextRegions);

async function reprocessIntelligence(mode: "legacy" | "engine") {
  h.notesAuto = mode;
  const { company, project } = await createWorld();
  await createPage(project.id, 1, { textractData: { lines: [], words: [] } as never, rawText: "" });
  await createPage(project.id, 2, { textractData: { lines: [], words: [] } as never, rawText: "" });
  asUser(await createUser(company.id, { role: "admin" }));
  const res = await POST(makeReq("/api/admin/reprocess?scope=intelligence", { method: "POST" }));
  const lines = (await res.text()).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  expect(lines.at(-1)).toMatchObject({ type: "done", updated: 2, total: 2 });
}

beforeEach(() => {
  a12.mockClear();
  a03.mockClear();
  vi.mocked(readParseEngineFlags).mockClear();
});

describe.skipIf(!dbUp)("POST /api/admin/reprocess?scope=intelligence — tools.notesAuto", () => {
  it("engine: read once, passed to A12 and A03 on every page", async () => {
    await reprocessIntelligence("engine");
    expect(readParseEngineFlags).toHaveBeenCalledTimes(1);
    expect(a12).toHaveBeenCalledTimes(2);
    expect(a03).toHaveBeenCalledTimes(2);
    for (const call of a12.mock.calls) expect(call[3]).toEqual({ notesAuto: "engine" });
    for (const call of a03.mock.calls) expect(call[2]).toMatchObject({ notesAuto: "engine" });
  }, 30000);

  it("legacy: passed through as legacy", async () => {
    await reprocessIntelligence("legacy");
    expect(a12.mock.calls.map((c) => c[3])).toEqual([{ notesAuto: "legacy" }, { notesAuto: "legacy" }]);
    expect(a03.mock.calls.map((c) => (c[2] as { notesAuto?: string }).notesAuto)).toEqual(["legacy", "legacy"]);
  }, 30000);
});
