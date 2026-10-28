// @vitest-environment node
// [table pipeline WP-3.J fix round, VERIFY MED-1] The Step Functions worker (scripts/process-worker.ts) is the
// production upload path. It reads `tools.notesAuto` (lib never reads app_settings) and hands it to
// processProject. Before this file, passing `{}` instead left every test green (verifier mutant V1). The script
// runs main() on import and exits, so this test imports it with process.exit stubbed and processProject mocked;
// the project lookup runs against the real test DB.
import { afterEach, describe, expect, inject, it, vi } from "vitest";

const h = vi.hoisted(() => ({ notesAuto: "engine" as "legacy" | "engine" }));
vi.mock("@/lib/processing", () => ({
  processProject: vi.fn(async () => ({ pagesProcessed: 1, pageErrors: 0, processingTime: 0 })),
}));
vi.mock("@/lib/processing-webhook-notify", () => ({ notifyProcessingWebhook: vi.fn(async () => {}) }));
vi.mock("@/server/services/parse-engine/flags", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/server/services/parse-engine/flags")>();
  return { ...orig, readParseEngineFlags: vi.fn(async () => orig.resolveParseEngineFlags({ tools: { notesAuto: h.notesAuto } }).flags) };
});

import { processProject } from "@/lib/processing";
import { createWorld } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

async function runWorker(projectId: number) {
  const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  vi.stubEnv("PROJECT_ID", String(projectId));
  vi.stubEnv("WEBHOOK_URL", "");
  vi.resetModules();
  await import("../../../scripts/process-worker");
  await vi.waitFor(() => expect(exit).toHaveBeenCalled(), { timeout: 20000 });
  expect(exit).toHaveBeenCalledWith(0);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.mocked(processProject).mockClear();
});

describe.skipIf(!dbUp)("scripts/process-worker — tools.notesAuto reaches processProject", () => {
  it.each(["engine", "legacy"] as const)("notesAuto %s is passed as the third argument", async (mode) => {
    h.notesAuto = mode;
    const { project } = await createWorld();
    await runWorker(project.id);
    expect(processProject).toHaveBeenCalledTimes(1);
    const [id, , options] = vi.mocked(processProject).mock.calls[0] as unknown as [number, unknown, unknown];
    expect(id).toBe(project.id);
    expect(options).toEqual({ notesAuto: mode });
  }, 30000);
});
