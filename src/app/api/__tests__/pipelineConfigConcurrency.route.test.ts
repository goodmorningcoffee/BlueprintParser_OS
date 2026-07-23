// @vitest-environment node
// [refactor jul23 P4.1 U11] Real-DB concurrency freeze for companies.pipelineConfig.
//
// TWO tests, one per stage of the U11 sequence (root commits them separately):
//
//  • STAGE-A CHARACTERIZATION (this file's first `it`, lands at HEAD before the
//    wrapper): documents TODAY'S lost-update. Every pipelineConfig writer is a
//    NON-ATOMIC read-modify-write (company-settings.ts:65-76 writePipelineConfig +
//    its 6 callers; llm-config.ts updateLlmSettings; csi-upload.ts upload/revert):
//    two concurrent PUTs to DIFFERENT subtrees both read the same base, then the
//    second UPDATE clobbers the first subtree — one write is silently LOST.
//
//  • STAGE-B PROOF (second `it`, lands WITH the wrapper): the same two concurrent
//    different-subtree writes routed through the REAL updatePipelineConfig wrapper
//    now BOTH survive — SELECT ... FOR UPDATE serializes them (the second blocks,
//    then re-reads the first's committed base). This is the point of the unit.
//
// WHY the Stage-A interleave is driven at the DB level, not through the real routes
// (task fallback, REPORTED): a DETERMINISTIC lost-update requires forcing BOTH reads
// to complete before EITHER write, and the unlocked writePipelineConfig has NO pause
// seam between its read (readPipelineConfig) and its write — nor is it exported.
// Racing two real route PUTs via Promise.all is timing-dependent (flaky, and this
// suite must never be run under a scheduler we don't control). So Stage-A reproduces
// writePipelineConfig's EXACT non-atomic RMW (unlocked SELECT → top-level spread →
// UPDATE) with an in-test barrier that releases both writers only after both have
// read — the faithful, deterministic mirror the task prescribes ("call
// writePipelineConfig twice with awaits arranged to interleave reads"). Stage-B needs
// no barrier: the FOR UPDATE lock serializes the two real transactions on its own.
import { describe, expect, inject, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";
import { createCompany } from "@/test/harness";
// [refactor jul23 P4.1 U11] Stage-B target — the companies-row FOR-UPDATE wrapper.

const dbUp = inject("dbUp") as boolean;

/** 2-party barrier: each caller blocks at arrive() until the SECOND caller arrives. */
function makeBarrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  return async function arrive(): Promise<void> {
    arrived += 1;
    if (arrived >= parties) release();
    await gate;
  };
}

/** Raw pipelineConfig read-back — the merge-semantics oracle. */
async function pcOf(companyId: number): Promise<Record<string, unknown> | null> {
  const [row] = await db
    .select({ pc: companies.pipelineConfig })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  return (row?.pc ?? null) as Record<string, unknown> | null;
}

// Two DIFFERENT subtrees so a correct serialized write keeps BOTH; a lost update
// drops one back to its BASE value.
const BASE = { demo: { a: true }, csi: { matchingConfidenceThreshold: 0.42 } };
const NEW_DEMO = { a: false, b: true };
const NEW_CSI = { matchingConfidenceThreshold: 0.99 };

describe.skipIf(!dbUp)("[P4.1 U11] pipelineConfig concurrent different-subtree writers", () => {
  // ── STAGE A — freeze TODAY'S lost-update (green at HEAD, no wrapper needed) ──
  it("STAGE-A characterization: concurrent unlocked demo-write vs csi-write lose exactly ONE update (non-atomic RMW)", async () => {
    const company = await createCompany({ pipelineConfig: BASE as never });
    const barrier = makeBarrier(2);

    // Faithful mirror of writePipelineConfig (company-settings.ts:65-76): UNLOCKED
    // read → top-level spread → write. The barrier forces both reads before either
    // write, making the clobber deterministic (the real racing routes are not).
    async function unlockedRmw(patch: Record<string, unknown>): Promise<void> {
      const [row] = await db
        .select({ pc: companies.pipelineConfig })
        .from(companies)
        .where(eq(companies.id, company.id))
        .limit(1);
      const existing = (row?.pc ?? {}) as Record<string, unknown>;
      await barrier(); // ← both writers have now read the SAME base
      const updated = { ...existing, ...patch };
      await db
        .update(companies)
        .set({ pipelineConfig: updated as never })
        .where(eq(companies.id, company.id));
    }

    await Promise.all([unlockedRmw({ demo: NEW_DEMO }), unlockedRmw({ csi: NEW_CSI })]);

    const pc = await pcOf(company.id);
    const demoWon = JSON.stringify(pc?.demo) === JSON.stringify(NEW_DEMO);
    const csiWon = JSON.stringify(pc?.csi) === JSON.stringify(NEW_CSI);
    // TODAY: whichever transaction commits LAST fully overwrites the column, so exactly
    // ONE subtree carries its new value and the OTHER reverts to BASE (the lost update).
    expect(demoWon !== csiWon).toBe(true); // XOR — precisely one survived
    if (demoWon) expect(pc?.csi).toEqual(BASE.csi); // csi was lost
    else expect(pc?.demo).toEqual(BASE.demo); // demo was lost
  });

  // ── STAGE B — the wrapper closes it (lands WITH company-config.ts) ──
});
