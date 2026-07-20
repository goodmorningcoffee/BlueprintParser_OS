// @vitest-environment node
//
// [refactor jul19 P3.3] Pre-fix executable proof for the annotation-label color seam.
// AnnotationOverlay allocates colors from a module-lifetime encounter-order map, while
// AnnotationPanel hashes each name independently. Execute the exact private source slices in
// isolated sandboxes so this characterization cannot seed AnnotationOverlay's real module map or
// leak label history into another test. The follow-up fix is expected to replace this contract.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ModuleKind,
  ScriptTarget,
  transpileModule,
} from "typescript";
import { describe, expect, it } from "vitest";
import { TWENTY_COLORS } from "@/types";

type LabelColor = (name: string) => string;

function exactSlice(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const next = source.indexOf(start, from + start.length);
  const to = source.indexOf(end, from + start.length);

  expect(from).toBeGreaterThanOrEqual(0);
  expect(next).toBe(-1);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

function compileLabelColor(source: string): LabelColor {
  const javascript = transpileModule(source, {
    compilerOptions: {
      module: ModuleKind.None,
      target: ScriptTarget.ES2022,
    },
  }).outputText;
  const factory = new Function(
    "TWENTY_COLORS",
    `${javascript}\nreturn labelColor;`,
  ) as (palette: readonly string[]) => LabelColor;

  return factory(TWENTY_COLORS);
}

const overlaySource = readFileSync(
  join(process.cwd(), "src/components/viewer/AnnotationOverlay.tsx"),
  "utf8",
);
const panelSource = readFileSync(
  join(process.cwd(), "src/components/viewer/AnnotationPanel.tsx"),
  "utf8",
);

const overlayMap = exactSlice(
  overlaySource,
  "const labelColorMap = new Map<string, string>();\n",
  "const EMPTY_KEYNOTE_COLUMN_BBS",
);
const overlayFunction = exactSlice(
  overlaySource,
  "function labelColor(name: string): string {\n",
  "\n\nfunction readCanvasGestureSnapshot",
);
const panelFunction = exactSlice(
  panelSource,
  "function labelColor(name: string): string {\n",
  "\n\nexport default function AnnotationPanel",
);

function newOverlayModule(): LabelColor {
  return compileLabelColor(`${overlayMap}${overlayFunction}`);
}

describe("annotation label-color lifetime pre-fix characterization", () => {
  it("makes overlay color depend on prior project/order while the panel stays name-deterministic", () => {
    const target = "Cross-project target";
    const peer = "Same-project peer";

    // The private const map has no lifecycle reset path elsewhere in the component module.
    expect(overlaySource.match(/\blabelColorMap\b/g)).toHaveLength(5);
    expect(overlaySource).not.toMatch(/labelColorMap\.(?:clear|delete)\s*\(/);
    expect(overlaySource.split("getLabelColor: labelColor,")).toHaveLength(2);
    expect(panelSource.split("borderLeftColor: labelColor(name)")).toHaveLength(2);

    // A fresh module that opens project B first allocates B's target at palette slot zero.
    const coldProjectB = newOverlayModule();
    expect(coldProjectB(target)).toBe(TWENTY_COLORS[0]);

    // The production map has no project key or reset. These project-A encounters therefore shift
    // the first unseen label in project B, and the allocation survives later encounters.
    const projectAThenB = newOverlayModule();
    expect([
      projectAThenB("Project A - first"),
      projectAThenB("Project A - second"),
      projectAThenB("Project A - third"),
    ]).toEqual(TWENTY_COLORS.slice(0, 3));
    expect(projectAThenB(target)).toBe(TWENTY_COLORS[3]);
    projectAThenB("Project B - later");
    expect(projectAThenB(target)).toBe(TWENTY_COLORS[3]);

    // Even without a project transition, reversing first encounter changes the target's color.
    const targetFirst = newOverlayModule();
    const peerFirst = newOverlayModule();
    expect(targetFirst(target)).toBe(TWENTY_COLORS[0]);
    targetFirst(peer);
    peerFirst(peer);
    expect(peerFirst(target)).toBe(TWENTY_COLORS[1]);

    // AnnotationPanel's current hash has no lifetime state: unrelated names do not change this
    // target, but its color also disagrees with either overlay history above.
    const panelLabelColor = compileLabelColor(panelFunction);
    const panelTarget = panelLabelColor(target);
    panelLabelColor(peer);
    expect(panelLabelColor(target)).toBe(panelTarget);
    expect(panelTarget).toBe("#ffd8b1");
    expect(panelTarget).not.toBe(coldProjectB(target));
    expect(panelTarget).not.toBe(projectAThenB(target));
  });
});
