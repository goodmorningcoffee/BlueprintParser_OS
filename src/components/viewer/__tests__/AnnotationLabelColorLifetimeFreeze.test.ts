// @vitest-environment node
//
// [refactor jul20 P3.3] Post-fix regression for the annotation-label color seam. The overlay,
// annotation panel, detection panel, and docs witness all share one stateless name policy, so
// project history and encounter order cannot change a label's color.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { annotationLabelColor } from "@/lib/annotation-label-color";

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const overlaySource = source("src/components/viewer/AnnotationOverlay.tsx");
const panelSource = source("src/components/viewer/AnnotationPanel.tsx");
const detectionSource = source("src/components/viewer/DetectionPanel.tsx");
const demoSource = source("src/app/docs/_components/demos/YoloClassChipDemo.tsx");
const policySource = source("src/lib/annotation-label-color.ts");

describe("annotation label-color lifetime regression", () => {
  it("is invariant to prior project labels, encounter order, and repeat calls", () => {
    const target = "Cross-project target";
    const peer = "Same-project peer";
    const coldProjectB = annotationLabelColor(target);

    // Simulate unrelated project-A and same-project encounters in the retained module.
    annotationLabelColor("Project A - first");
    annotationLabelColor("Project A - second");
    annotationLabelColor("Project A - third");
    expect(annotationLabelColor(target)).toBe(coldProjectB);

    annotationLabelColor(peer);
    expect(annotationLabelColor(target)).toBe(coldProjectB);
    expect(annotationLabelColor(target)).toBe("#ffd8b1");

    const forward = [target, peer].map(annotationLabelColor);
    const reverse = [peer, target].map(annotationLabelColor).reverse();
    expect(reverse).toEqual(forward);
  });

  it("keeps every visible consumer on the one stateless policy", () => {
    const overlayImport =
      'import { annotationLabelColor as labelColor } from "@/lib/annotation-label-color";';
    const panelImport = overlayImport;
    const detectionImport =
      'import { annotationLabelColor as classColor } from "@/lib/annotation-label-color";';

    expect(count(overlaySource, overlayImport)).toBe(1);
    expect(count(overlaySource, "getLabelColor: labelColor,")).toBe(1);
    expect(overlaySource).not.toMatch(/labelColorMap|function labelColor\(|TWENTY_COLORS/);

    expect(count(panelSource, panelImport)).toBe(1);
    expect(count(panelSource, "borderLeftColor: labelColor(name)")).toBe(1);
    expect(panelSource).not.toMatch(/function labelColor\(|TWENTY_COLORS/);

    expect(count(detectionSource, detectionImport)).toBe(1);
    expect(count(detectionSource, "classColor(cls)")).toBe(2);
    expect(detectionSource).not.toMatch(/function classColor\(|TWENTY_COLORS/);

    expect(count(demoSource, detectionImport)).toBe(1);
    expect(count(demoSource, "classColor(c.name)")).toBe(1);
    expect(demoSource).not.toMatch(/function classColor\(|TWENTY_COLORS/);

    expect(policySource).toContain("export function annotationLabelColor(name: string): string");
    expect(policySource).toContain("TWENTY_COLORS[Math.abs(hash) % TWENTY_COLORS.length]");
    expect(policySource).not.toMatch(/\b(?:Map|Set|WeakMap|WeakSet)\b/);
  });
});
