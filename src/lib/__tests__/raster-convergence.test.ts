// @vitest-environment node
/**
 * raster-convergence — a standing reminder that prints in every test run until phase 5 does the
 * work and deletes this file.
 *
 * ── WHY A TEST AND NOT A TODO COMMENT ───────────────────────────────────────────────────
 * After phase 3 the app has TWO flood-fill engines: the legacy raster worker
 * (`src/workers/bucket-fill.worker.ts`) and worker #2 (`src/workers/oneclick.worker.ts`). Phase 5
 * converges them — one engine, two mask builders — by feeding `buildRasterMask` into worker #2 and
 * retiring the legacy path.
 *
 * Two engines is a stable-looking state. Everything passes, the product works, and the duplication
 * quietly becomes permanent: every future fix has to be made twice, and the two drift. A comment in
 * a file nobody opens does not resist that. **An `it.todo` prints in the output of every single
 * test run**, so the cost of not converging is visible to whoever is looking at the suite today
 * rather than to whoever eventually goes looking.
 *
 * PLAN §5 phase 3 asks for exactly this, and phase 5 deletes it **by doing the work** — not by
 * deleting the reminder.
 *
 * ── WHAT PHASE 5 ACTUALLY HAS TO DO ─────────────────────────────────────────────────────
 * Recorded here so the reminder carries its own instructions rather than pointing at a plan
 * someone has to go find:
 *
 *   1. `buildRasterMask` (already vendored, `src/lib/oneclick/rastermask.ts`) becomes worker #2's
 *      second mask builder, keyed `sourceKind: "raster"` — the cache key already reserves that
 *      value precisely so this arrives without a migration.
 *   2. The legacy worker's own binarize/dilate/flood/trace is deleted, NOT wrapped.
 *   3. `bucket-fill-client.ts`'s raster branch routes to worker #2.
 *   4. ⚠ The historical `bucket4000Ms` perf series stays valid until this lands, because this is
 *      the change that alters the pixel source. Phase 5 owns re-authoring that painted fixture.
 *
 * ⚠ AND THE ONE THING THIS DOES NOT BUY. Convergence unifies the CLIENT. RC5 — the client-vs-Python
 * -server divergence — is a different pair of engines and survives phase 5 untouched. That was
 * refuted once already during planning; do not re-derive it.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const LEGACY_WORKER = "src/workers/bucket-fill.worker.ts";
const VECTOR_WORKER = "src/workers/oneclick.worker.ts";

describe("raster convergence (phase 5)", () => {
  it.todo("legacy raster worker replaced by buildRasterMask into worker #2");

  it("still has TWO flood engines — delete this file when that stops being true", () => {
    // The reminder is only honest if it can go stale. This asserts the condition that makes it
    // necessary, so when phase 5 lands the legacy worker's removal, this test fails and whoever
    // is doing the work is told to delete the file rather than left to remember.
    const root = process.cwd();
    const legacy = existsSync(join(root, LEGACY_WORKER));
    const vector = existsSync(join(root, VECTOR_WORKER));
    expect(vector).toBe(true);
    expect(
      legacy,
      `${LEGACY_WORKER} is gone — phase 5 has converged the engines. Delete ` +
        `src/lib/__tests__/raster-convergence.test.ts; its job is done.`,
    ).toBe(true);
  });

  it("records that the legacy worker still owns its own binarize/flood/trace", () => {
    // Names the duplication concretely. If someone starts hollowing the legacy worker out, these
    // counts move and the reminder is the first thing to say so.
    const src = readFileSync(join(process.cwd(), LEGACY_WORKER), "utf8");
    for (const own of ["bucketRgbaBinarize", "floodFill", "traceBorder", "morphClose"]) {
      expect(src, `${LEGACY_WORKER} should still export ${own} until phase 5`).toContain(
        `export function ${own}`,
      );
    }
  });
});
