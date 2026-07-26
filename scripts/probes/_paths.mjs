// Shared path + module resolution for the adopted bucket-fill probes.
//
// WHY THIS FILE EXISTS. Every one of the 14 original probes hardcoded
//     const BP2 = "/workspaces/projects/BlueprintParser_OS_july10_part6_refactor/blueprintparser_2";
// which is the workspace's single most expensive recurring bug: a hardcoded path that fails
// SILENTLY after a move. The last `gitignore/` move broke five tools exactly this way, and one
// of them merely exited with no output. Adopting the probes into the repo is the moment to fix
// it, so nothing here resolves by absolute path except the out-of-tree OpenTakeoff clone, which
// is overridable and is checked before use.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/** The repo root, resolved from THIS file's location — moves with the tree. */
export const REPO = resolve(new URL("../..", import.meta.url).pathname);

/** The OpenTakeoff clone is deliberately OUT of tree (third-party). Overridable. */
export const OT_CLONE =
  process.env.BP_OT_CLONE ||
  "/workspaces/projects/gitignore/projects/bucketfill_rebuild/gitignore/opentakeoff";

/** Engine resolution: vendored copy first (phase 1+), then the clone. */
export function enginePath() {
  const candidates = [
    process.env.BP_ONECLICK_ENGINE,
    join(REPO, "src/lib/oneclick/oneclick.ts"),
    join(OT_CLONE, "web/src/lib/oneclick.ts"),
  ].filter(Boolean);
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) {
    throw new Error(
      "could not resolve the One-Click engine. Tried:\n" + candidates.map((p) => "  - " + p).join("\n"),
    );
  }
  return hit;
}

/** The density fixture (VA finish plan). Fails loud rather than measuring nothing. */
export function densityFixture() {
  const p = join(OT_CLONE, "demo/sample-finish-plan.pdf");
  if (!existsSync(p)) {
    throw new Error(`density fixture missing: ${p}\nSet $BP_OT_CLONE to the OpenTakeoff clone.`);
  }
  return p;
}

/**
 * `detectRooms.ts` is NOT vendored — §2.1's take list is oneclick.ts + rastermask.ts only, and
 * BP2 has its own room-seeding path. It therefore always resolves from the OpenTakeoff clone.
 *
 * ⚠ DO NOT derive it from enginePath(). Both probes used to do
 *     enginePath().replace("oneclick.ts", "detectRooms.ts")
 * which worked only while the engine resolved to the clone. The moment phase 1 vendored the
 * engine, enginePath() correctly switched to src/lib/oneclick/ — and the derived sibling pointed
 * at a file that does not exist there. Product gates could not see it: this is probe-only code.
 */
export function detectRoomsPath() {
  const p = join(OT_CLONE, "web/src/lib/detectRooms.ts");
  if (!existsSync(p)) {
    throw new Error(
      `detectRooms.ts not found at ${p}\n` +
        `  It is NOT vendored (see src/lib/oneclick/README.md). Set $BP_OT_CLONE.`,
    );
  }
  return p;
}
export const loadDetectRooms = () => import(detectRoomsPath());

export const pdfjsPath = () => join(REPO, "node_modules/pdfjs-dist/legacy/build/pdf.mjs");
export const canvasPath = () => join(REPO, "node_modules/@napi-rs/canvas/index.js");
export const loadPdfjs = () => import(pdfjsPath());
export const loadEngine = () => import(enginePath());
export const loadCanvas = () => import(canvasPath());

/** A path you WRITE must be a path that EXISTS. One postcondition, no judgment required. */
export function assertPaths() {
  const checks = { REPO, engine: enginePath(), fixture: densityFixture(), pdfjs: pdfjsPath(), canvas: canvasPath() };
  for (const [k, v] of Object.entries(checks)) {
    if (!existsSync(v)) throw new Error(`${k} does not exist: ${v}`);
  }
  return checks;
}
