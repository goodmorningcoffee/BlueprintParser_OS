/**
 * reprocess-per-project-guard.test.ts — structural guard on the NDJSON stream.
 *
 * [csi-rebuild S8 / TILE_015 C1] `reprocessProjects` streams NDJSON and ends with
 * a `done` event the client waits for. Four of its five scopes had no per-project
 * try/catch, so a single failing project threw out of the loop and the stream
 * simply stopped — no `done`, no error event, a client hanging on a response that
 * had already ended. Only `thumbnails` guarded itself.
 *
 * ── WHY THIS TEST IS SOURCE-LEVEL, WHICH IS OTHERWISE A SMELL ──
 *
 * The behavioural tests for this file (`admin-reprocess.route.test.ts` and
 * `admin-reprocess-g3.route.test.ts`, 29 tests) are DB-backed and SKIP wherever
 * postgres is absent — including the container this change was written in. So the
 * fix could not be exercised behaviourally here at all.
 *
 * Given that, a source-level invariant is the honest option: it cannot prove the
 * catch behaves correctly, but it does prove no scope is left unguarded, which is
 * the exact defect. It is a floor, not a substitute.
 *
 * **This change still needs one run on a postgres-equipped machine before it is
 * trusted.** That is recorded in STATE.md, not hidden here.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src/server/services/reprocess.ts");

describe("reprocessProjects — every scope survives one bad project", () => {
  const lines = () => readFileSync(SRC, "utf-8").split("\n");

  it("every per-project loop opens with a try", () => {
    const src = lines();
    const unguarded: number[] = [];
    src.forEach((line, i) => {
      if (!line.includes("for (const project of allProjects) {")) return;
      // The guard must be the FIRST statement of the loop body, or a throw from
      // anything before it still escapes.
      if (!(src[i + 1] ?? "").trim().startsWith("try {")) unguarded.push(i + 1);
    });
    expect(
      unguarded,
      `per-project loops with no try/catch at lines ${unguarded.join(", ")} — ` +
        "one failing project would truncate the NDJSON stream with no `done` event",
    ).toEqual([]);
  });

  it("finds the loops it claims to check — the test cannot pass vacuously", () => {
    // If the loop shape is ever refactored, the check above would silently find
    // nothing and go green. Pin the count so that fails loudly instead.
    const count = lines().filter(l => l.includes("for (const project of allProjects) {")).length;
    expect(count, "per-project loop shape changed — re-verify the guards by hand").toBe(5);
  });

  it("each scope reports failure as a stream error event, not silence", () => {
    // A catch that swallows is barely better than no catch: the client still
    // cannot tell a skipped project from a successful one.
    const src = readFileSync(SRC, "utf-8");
    for (const scope of ["page-names", "thumbnails", "shape-parse", "intelligence", "full"]) {
      expect(src, `no per-project error log for scope ${scope}`).toContain(`[reprocess-${scope}] Project`);
    }
    const errorSends = src.match(/send\(\{ type: "error", project: project\.name/g) ?? [];
    expect(errorSends.length).toBeGreaterThanOrEqual(5);
  });
});
