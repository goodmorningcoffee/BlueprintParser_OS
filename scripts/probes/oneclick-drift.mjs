#!/usr/bin/env node

/**
 * VENDOR DRIFT CHECK — has upstream changed the files we vendored?
 *
 * ⚠ INFORMATIONAL ONLY. This script NEVER merges and never edits a vendored file. The vendor
 * posture is FORK / FREEZE at commit 70d10ce (decision 8 of the rebuild plan), settled against
 * the commit record: all core algorithm work landed 2026-07-05 → 07-11, and none of the last 20
 * upstream commits touch the flood engine. A drift report is a prompt to make a decision, not an
 * instruction to sync.
 *
 * It compares the vendored file BODY — everything after our Apache header block — against the
 * upstream working copy. Comparing bodies rather than whole files is what lets the header carry
 * the MODIFICATIONS list without registering as drift.
 *
 *   node scripts/probes/oneclick-drift.mjs
 *
 * Exit codes:  0 = identical    1 = drift found    2 = could not check
 *
 * Needs the out-of-tree OpenTakeoff clone; set $BP_OT_CLONE if it is not in the default place.
 * It FAILS LOUD when the clone is missing rather than reporting "no drift", because a check that
 * silently passes when it cannot see the other side is worse than no check at all.
 */

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { REPO, OT_CLONE } from "./_paths.mjs";

const PINNED_COMMIT = "70d10ce";
const FILES = [
  { vendored: "src/lib/oneclick/oneclick.ts", upstream: "web/src/lib/oneclick.ts" },
  { vendored: "src/lib/oneclick/rastermask.ts", upstream: "web/src/lib/rastermask.ts" },
];

/** Strip our vendored header: everything up to and including the first blank line after it. */
function body(text) {
  const marker = "// ─────────────────────────────────────────────────────────────────────────────\n\n";
  const i = text.lastIndexOf(marker);
  return i === -1 ? text : text.slice(i + marker.length);
}

if (!existsSync(OT_CLONE)) {
  console.error(
    `FATAL: OpenTakeoff clone not found at ${OT_CLONE}\n` +
      `  Set $BP_OT_CLONE. Refusing to report "no drift" without seeing upstream.\n`,
  );
  process.exit(2);
}

let drift = 0;
console.log(`vendor drift check — pinned at ${PINNED_COMMIT}\n`);

for (const f of FILES) {
  const vPath = join(REPO, f.vendored);
  const uPath = join(OT_CLONE, f.upstream);
  if (!existsSync(vPath) || !existsSync(uPath)) {
    console.error(`  MISSING  ${!existsSync(vPath) ? vPath : uPath}`);
    drift = 2;
    continue;
  }
  const v = body(readFileSync(vPath, "utf8"));
  const u = readFileSync(uPath, "utf8");
  const h = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);
  if (v === u) {
    console.log(`  IDENTICAL  ${f.vendored}  (${h(v)})`);
  } else {
    console.log(
      `  DRIFT      ${f.vendored}\n` +
        `             vendored body ${h(v)} (${v.split("\n").length} ln)\n` +
        `             upstream      ${h(u)} (${u.split("\n").length} ln)`,
    );
    drift = 1;
  }
}

// Upstream's own history on exactly these two files — the quarterly surveillance, automated.
//
// ⚠ SHALLOWNESS IS CHECKED FIRST, AND LOUDLY. The working clone at gitignore/opentakeoff is
// `--depth 1` (recorded in notes/UPSTREAM_CHURN.md). On a shallow clone, `git log -- <paths>`
// can only ever return HEAD, which PRINTS LIKE "nothing has changed" while actually meaning
// "I cannot see". A pass-3 auditor already caught that exact trap once; re-introducing it in a
// surveillance tool would be worse than having no tool. So: report UNAVAILABLE, never "(none)".
let shallow = false;
try {
  shallow =
    execFileSync("git", ["-C", OT_CLONE, "rev-parse", "--is-shallow-repository"], {
      encoding: "utf8",
    }).trim() === "true";
} catch {
  /* not a git clone at all — handled below */
}

console.log("\nupstream history for the vendored files:");
if (shallow) {
  console.log(
    "  ⚠ UNAVAILABLE — this clone is SHALLOW (--depth 1), so `git log` sees only HEAD.\n" +
      "    This is NOT evidence that upstream is unchanged. To actually check:\n" +
      "      git clone --filter=blob:none https://github.com/Kentucky-ai/opentakeoff.git\n" +
      "      git -C <that clone> log --oneline -- web/src/lib/oneclick.ts web/src/lib/rastermask.ts\n" +
      "    Prior full-history finding (notes/UPSTREAM_CHURN.md, 2026-07-25): all core oneclick.ts\n" +
      "    work landed 2026-07-05 -> 07-11; rastermask.ts untouched since 07-11.",
  );
} else {
  try {
    const log = execFileSync(
      "git",
      ["-C", OT_CLONE, "log", "--oneline", "-10", "--", ...FILES.map((f) => f.upstream)],
      { encoding: "utf8" },
    ).trim();
    console.log(log ? log.split("\n").map((l) => "  " + l).join("\n") : "  (none in the last 10)");
  } catch (e) {
    console.log(`  ⚠ could not read git log: ${e.message}`);
  }
}

console.log(
  drift === 1
    ? "\n⚠ DRIFT. This is INFORMATIONAL. Decide deliberately; do not auto-sync.\n" +
      "  If a vendored body was edited on our side, that edit belongs in the file's\n" +
      "  MODIFICATIONS list (Apache-2.0 §4(b)) — check there before assuming upstream moved.\n"
    : "\nNo drift.\n",
);
process.exit(drift);
