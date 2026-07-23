// @vitest-environment node
// [refactor jul23 P4.1 U11-D] Log-mode subtree observation at the updatePipelineConfig sink.
//
// Verdict 2 contract: ZERO behavior change. The wrapper validates the persisted
// pipelineConfig against the `.loose()` subtree registry (types/shapes/pipeline-config.ts)
// and emits at most ONE aggregated `[shape-registry]` warn per write — it NEVER 400s and
// NEVER alters what is stored. This net proves all three legs: valid config → zero warns;
// a drifted subtree → exactly one warn (paths+codes only, no values); and the write
// persists byte-identical EITHER way.
//
// PROBES (both go RED): unwire the observePipelineConfig call in company-config.ts →
// the "one warn" assertion fails; loosen zCsiConfigStored's threshold to z.any() →
// the drift stops warning (over-tolerant); tighten a sibling (e.g. make zDemoConfig
// reject the seed) → the valid-config test warns (over-strict).
import { afterEach, describe, expect, inject, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { updatePipelineConfig } from "@/server/services/company-config";
import { createCompany } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

/** Only the observation module's entries — logger.warn is shared by many subsystems. */
const shapeRegistryWarns = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter(
    (c) => typeof c[0] === "string" && (c[0] as string).startsWith("[shape-registry]"),
  );

async function pcOf(companyId: number): Promise<Record<string, unknown> | null> {
  const [row] = await db
    .select({ pc: companies.pipelineConfig })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  return (row?.pc ?? null) as Record<string, unknown> | null;
}

describe.skipIf(!dbUp)("[P4.1 U11] observePipelineConfig at updatePipelineConfig", () => {
  afterEach(() => vi.restoreAllMocks());

  it("valid config persists verbatim with ZERO shape-registry warns", async () => {
    const company = await createCompany();
    const warn = vi.spyOn(logger, "warn");
    const VALID = {
      demo: { flagA: true, flagB: false }, // all-boolean → valid zDemoConfig
      csi: { matchingConfidenceThreshold: 0.7, tier2MinWords: 3 },
      llm: { systemPrompt: "hi", toolUse: true },
      heuristics: [{ id: "h1", name: "Rule 1" }], // bare {id,name} is valid (RD-I)
    };
    await updatePipelineConfig(company.id, (c) => ({ ...c, ...VALID }) as never);
    expect(shapeRegistryWarns(warn)).toHaveLength(0);
    expect(await pcOf(company.id)).toEqual(VALID); // persisted exactly
  });

  it("a DRIFTED subtree STILL persists byte-identical (log-only) and emits exactly ONE aggregated warn", async () => {
    const company = await createCompany({
      pipelineConfig: { demo: { flagA: true } } as never,
    });
    const warn = vi.spyOn(logger, "warn");
    // textAnnotation.enabledDetectors typed as a STRING → fails z.array(z.string()); the
    // valid demo sibling must NOT warn, and the drift must NOT block the write.
    await updatePipelineConfig(
      company.id,
      (c) => ({ ...c, textAnnotation: { enabledDetectors: "not-an-array" } }) as never,
    );

    const calls = shapeRegistryWarns(warn);
    expect(calls).toHaveLength(1); // ONE aggregated warn per call
    const ctx = calls[0][1] as Record<string, unknown>;
    expect(ctx.sink).toBe("pipelineConfig.write");
    expect(ctx.subtrees).toEqual(["textAnnotation"]); // demo (valid) is not listed
    expect(ctx.issueCount).toBe(1);
    expect(ctx.issues).toEqual(
      expect.arrayContaining([expect.stringContaining("textAnnotation.enabledDetectors:")]),
    );
    // Log hygiene: paths+codes only — never the drifted value.
    expect(JSON.stringify(ctx)).not.toContain("not-an-array");

    // The write persisted UNCHANGED (Verdict 2 — log-mode never rejects a v0 write).
    const pc = await pcOf(company.id);
    expect((pc?.textAnnotation as Record<string, unknown>).enabledDetectors).toBe("not-an-array");
    expect(pc?.demo).toEqual({ flagA: true }); // sibling survived the spread
  });
});
