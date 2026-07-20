// @vitest-environment node
//
// [refactor jul20 P3.4 K0] Parent topology freeze for the shared AnnotationOverlay keyboard axis.
// These assertions intentionally describe the pre-dispatcher defects: two independently ordered
// listeners, incomplete editable gates, and Enter fan-out. K1 translates the same file to the
// accepted one-listener topology instead of deleting the evidence.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const OVERLAY_PATH = "src/components/viewer/AnnotationOverlay.tsx";
const DEAD_HOOK_PATH = "src/hooks/useKeyboardShortcuts.ts";
const OVERLAY = readFileSync(join(ROOT, OVERLAY_PATH), "utf8");
const DEAD_HOOK = readFileSync(join(ROOT, DEAD_HOOK_PATH), "utf8");

function count(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

function slice(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing start anchor: ${start}`).toBeGreaterThan(-1);
  expect(endIndex, `missing end anchor: ${end}`).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

function productionSources(directory = "src"): string[] {
  const files: string[] = [];
  const visit = (relative: string) => {
    for (const entry of readdirSync(join(ROOT, relative), { withFileTypes: true })) {
      const child = join(relative, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") visit(child);
      } else if (
        /\.(ts|tsx)$/u.test(entry.name) &&
        !entry.name.includes(".test.") &&
        !entry.name.includes(".spec.") &&
        !entry.name.endsWith(".d.ts")
      ) {
        files.push(child);
      }
    }
  };
  visit(directory);
  return files.sort();
}

describe("P3.4 overlay keyboard parent topology", () => {
  it("characterizes the two independently installed window listeners", () => {
    expect(count(OVERLAY, 'window.addEventListener("keydown",')).toBe(2);
    expect(count(OVERLAY, 'window.removeEventListener("keydown",')).toBe(2);
    expect(OVERLAY.indexOf('window.addEventListener("keydown", handleEscape)')).toBeLessThan(
      OVERLAY.indexOf('window.addEventListener("keydown", handleKey)'),
    );
    expect(OVERLAY).toContain("if (selectedId === null) return;");
  });

  it("characterizes the incomplete and differently placed editable gates", () => {
    const toolListener = slice(
      OVERLAY,
      "  // Escape and tool-local keyboard commands",
      "  // Keyboard: Delete/Backspace",
    );
    const selectionListener = slice(
      OVERLAY,
      "  // Keyboard: Delete/Backspace",
      "  // Exit polygon drawing",
    );

    expect(toolListener.indexOf('if (e.key === "Escape")')).toBeLessThan(
      toolListener.indexOf("e.target instanceof HTMLInputElement"),
    );
    expect(toolListener.indexOf('if (e.key === "Enter")')).toBeLessThan(
      toolListener.indexOf("e.target instanceof HTMLInputElement"),
    );
    expect(toolListener).not.toContain("isContentEditable");
    expect(selectionListener).toContain("e.target instanceof HTMLInputElement");
    expect(selectionListener).toContain("e.target instanceof HTMLTextAreaElement");
    expect(selectionListener).not.toContain("isContentEditable");
  });

  it("characterizes simultaneous tool-Enter and drag-Enter fan-out", () => {
    const toolListener = slice(
      OVERLAY,
      "  // Escape and tool-local keyboard commands",
      "  // Keyboard: Delete/Backspace",
    );
    const selectionListener = slice(
      OVERLAY,
      "  // Keyboard: Delete/Backspace",
      "  // Exit polygon drawing",
    );

    expect(toolListener).toContain('if (e.key === "Enter")');
    expect(toolListener).toContain("acceptSplit();");
    expect(toolListener).toContain("prepareBucketFillPolygon();");
    expect(toolListener).toContain("saveLinearPolyline();");
    expect(toolListener).toContain("savePolygon();");
    expect(selectionListener).toContain('if (e.key === "Enter")');
    expect(selectionListener).toContain("finishAnnotationDrag(annotationDrag, true);");
  });

  it("pins the dead hook as promises without a production caller", () => {
    const callers = productionSources()
      .filter((path) => path !== DEAD_HOOK_PATH)
      .filter((path) => readFileSync(join(ROOT, path), "utf8").includes("useKeyboardShortcuts"));
    expect(callers).toEqual([]);
    expect(DEAD_HOOK).toContain("navigateYoloTag(");
    expect(DEAD_HOOK).toContain("takeoffUndo(qc);");
    expect(DEAD_HOOK).toContain("takeoffRedo(qc);");
    expect(DEAD_HOOK).toContain("navigateViewerPage(");
    expect(DEAD_HOOK).toContain("core.zoomIn();");
    expect(DEAD_HOOK).toContain("core.zoomOut();");
    expect(DEAD_HOOK).toContain("core.zoomFit();");
  });
});
