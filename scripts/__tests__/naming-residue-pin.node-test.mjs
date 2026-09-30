// [refactor jul23 P5.3 U5] Pin the app-side `blueprintparser-*` naming residue.
//
// Scripts were canonicalized to `beaver-*` in the P2/P5 closure, but three app-side sites
// still carry the LEGACY `blueprintparser-*` names. They are NOT fixed here on purpose: the
// canonical name is an OWNER ratification (P5.3), and flipping any one in isolation would
// break against whichever name is live. This test pins the CURRENT strings so the owner's
// eventual cutover is a CONSCIOUS, lockstep edit — when the owner renames, this test fails and
// names the exact set of files that must move together. Each pinned site carries an
// [OWNER-CUTOVER] comment. See gitignore/refactor_html_memories/P5_DESIGN/P5_RECON_MW_2026-07-23.md §(4).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const read = (rel) => readFile(path.join(repoRoot, rel), "utf8");

const CUTOVER_NOTE =
  "when the owner ratifies the beaver-* cutover, update these files IN LOCKSTEP: " +
  "src/lib/admin-logs/cw-logs.ts, src/server/services/admin-monitor.ts, src/lib/env.ts " +
  "(+ infrastructure/terraform). This pin is expected to fail at that moment — that is the signal.";

test("admin-monitor.ts still pins legacy blueprintparser-* names (Monitor tab, OWNER cutover)", async () => {
  const src = await read("src/server/services/admin-monitor.ts");
  // Monitor-tab ECS metrics currently query the NONEXISTENT legacy service (live = beaver-*),
  // so the CPU/mem series come back empty. Pinned, not fixed — owner-coupled. (lambdaFn is
  // `beaver-cv-pipeline`, the real function_name in lambda.tf; not part of this cutover.)
  assert.match(src, /const cluster = "blueprintparser-cluster";/, CUTOVER_NOTE);
  assert.match(src, /const appService = "blueprintparser-app";/, CUTOVER_NOTE);
  assert.match(src, /AlarmNamePrefix: "blueprintparser-",/, CUTOVER_NOTE);
  // The [OWNER-CUTOVER] marker and the pin must travel together.
  assert.match(src, /\[OWNER-CUTOVER/);
});

test("cw-logs.ts still pins legacy /ecs/blueprintparser-app log group (correct today, OWNER cutover)", async () => {
  const src = await read("src/lib/admin-logs/cw-logs.ts");
  // This default MATCHES infrastructure/terraform/ecs.tf today (so it is correct now), but it is
  // the legacy name and must move with the rename.
  assert.match(
    src,
    /process\.env\.CLOUDWATCH_LOG_GROUP \|\| "\/ecs\/blueprintparser-app"/,
    CUTOVER_NOTE,
  );
  assert.match(src, /\[OWNER-CUTOVER/);
});

test("env.ts CLOUDWATCH_LOG_GROUP comment is de-staled (no phantom /aws/lambda/bp2 default)", async () => {
  const src = await read("src/lib/env.ts");
  // The old comment claimed a WRONG code default `/aws/lambda/bp2` that never existed in code
  // (the only consumer, cw-logs.ts, defaults to /ecs/blueprintparser-app). Guard against its
  // reintroduction and confirm the corrected note points at the real default.
  assert.equal(
    /aws\/lambda\/bp2/u.test(src),
    false,
    "env.ts must not reference the phantom /aws/lambda/bp2 default (stale doc, corrected in U5)",
  );
  assert.match(src, /\/ecs\/blueprintparser-app/);
});
