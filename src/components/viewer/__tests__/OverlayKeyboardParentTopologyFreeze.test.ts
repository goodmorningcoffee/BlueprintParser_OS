// @vitest-environment node
//
// [refactor jul20 P3.4 K1] Post-move topology freeze for the shared AnnotationOverlay keyboard
// axis. K0 described the two listeners, incomplete editable gates, and Enter fan-out; the same
// evidence now pins one dispatcher, deterministic priority, and the rejected page/zoom migration.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const OVERLAY_PATH = "src/components/viewer/AnnotationOverlay.tsx";
const DISPATCHER_PATH = "src/components/viewer/useOverlayKeyboardDispatcher.ts";
const EDITABLE_TARGET_PATH = "src/lib/keyboard-target.ts";
const DEAD_HOOK_PATH = "src/hooks/useKeyboardShortcuts.ts";
const OVERLAY = readFileSync(join(ROOT, OVERLAY_PATH), "utf8");
const DISPATCHER = readFileSync(join(ROOT, DISPATCHER_PATH), "utf8");
const EDITABLE_TARGET = readFileSync(join(ROOT, EDITABLE_TARGET_PATH), "utf8");
const AUTH_PAGE = readFileSync(
  join(ROOT, "src/app/(dashboard)/project/[id]/page.tsx"),
  "utf8",
);
const DEMO_PAGE = readFileSync(join(ROOT, "src/app/demo/project/[id]/page.tsx"), "utf8");

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
  it("keeps one unconditional AO dispatcher call before the render-null gate", () => {
    expect(count(OVERLAY, "useOverlayKeyboardDispatcher({")).toBe(1);
    expect(count(OVERLAY, 'window.addEventListener("keydown",')).toBe(0);
    expect(count(DISPATCHER, 'window.addEventListener("keydown", handleKeyDown)')).toBe(1);
    expect(count(DISPATCHER, 'window.removeEventListener("keydown", handleKeyDown)')).toBe(1);
    expect(DISPATCHER).not.toContain('addEventListener("keydown", handleKeyDown,');
    expect(DISPATCHER).not.toContain("if (selectedId === null) return;");
    expect(OVERLAY.indexOf("useOverlayKeyboardDispatcher({")).toBeLessThan(
      OVERLAY.indexOf("if (!canvasShouldRender) return null;"),
    );
  });

  it("puts the complete safe editable predicate before lifecycle and owner reads", () => {
    const handler = slice(DISPATCHER, "    function handleKeyDown", "    window.addEventListener");
    const editable = handler.indexOf("if (isEditableKeyboardTarget(event.target)) return;");
    const lifecycle = handler.indexOf("if (!canAdoptProjectLifecycle()) return;");
    expect(editable).toBeGreaterThan(-1);
    expect(editable).toBeLessThan(lifecycle);
    for (const ownerRead of [
      "useUiStore.getState()",
      "useSessionStore.getState()",
      "useToolStore.getState()",
      "readActiveAnnotationDrag()",
    ]) {
      expect(editable, ownerRead).toBeLessThan(handler.indexOf(ownerRead));
    }
    expect(EDITABLE_TARGET).toContain("target instanceof HTMLInputElement");
    expect(EDITABLE_TARGET).toContain("target instanceof HTMLTextAreaElement");
    expect(EDITABLE_TARGET).toContain("target instanceof HTMLElement");
    expect(EDITABLE_TARGET).toContain("target.isContentEditable");
    expect(EDITABLE_TARGET).toContain('getAttribute("contenteditable")');
  });

  it("pins drag-first Enter before every tool Enter publication", () => {
    const drag = DISPATCHER.indexOf("const annotationDrag = readActiveAnnotationDrag();");
    const finish = DISPATCHER.indexOf("finishAnnotationDrag(annotationDrag, true);");
    expect(drag).toBeGreaterThan(-1);
    expect(finish).toBeGreaterThan(drag);
    for (const toolAction of [
      "acceptSplit();",
      "prepareBucketFillPolygon();",
      "saveLinearPolyline();",
      "savePolygon();",
    ]) {
      expect(finish, toolAction).toBeLessThan(DISPATCHER.indexOf(toolAction));
    }
    expect(count(DISPATCHER, "finishAnnotationDrag(annotationDrag, true);")).toBe(1);
  });

  it("moves only live browse/Z-W promises and rejects dead page/zoom ownership", () => {
    expect(existsSync(join(ROOT, DEAD_HOOK_PATH))).toBe(false);
    const callers = productionSources()
      .filter((path) => readFileSync(join(ROOT, path), "utf8").includes("useKeyboardShortcuts"));
    expect(callers).toEqual([]);
    expect(DISPATCHER).toContain("navigateYoloTag(");
    expect(DISPATCHER).toContain("takeoffUndo(qc);");
    expect(DISPATCHER).toContain("takeoffRedo(qc);");
    expect(DISPATCHER).not.toContain("navigateViewerPage");
    expect(DISPATCHER).not.toContain("useViewerCoreStore");
    expect(DISPATCHER).not.toMatch(/\.zoom(?:In|Out|Fit)\(/u);
    expect(DISPATCHER).not.toContain("stopPropagation");
    expect(DISPATCHER).not.toContain("stopImmediatePropagation");
  });

  it("keeps the rejected controller key/page scaffold axes deleted", () => {
    // [refactor jul22 P3.4 K2] onKey/onPageChange were unimplemented scaffold on ToolController.
    // Keyboard is dispatcher-owned; page transitions stay with viewerCommands and the drag machine.
    // [refactor jul22 P3.4 K3] Regex pins so a property-style re-add (onKey?: (…) =>) cannot
    // evade the freeze; prose mentions like "onKey/onPageChange" stay legal.
    const TYPES = readFileSync(join(ROOT, "src/components/viewer/tools/types.ts"), "utf8");
    expect(TYPES).not.toMatch(/onKey\??\s*[:(]/u);
    expect(TYPES).not.toMatch(/onPageChange\??\s*[:(]/u);
    for (const path of productionSources("src/components/viewer/tools")) {
      const source = readFileSync(join(ROOT, path), "utf8");
      expect(source, `${path} onKey`).not.toMatch(/onKey\??\s*[:(]/u);
      expect(source, `${path} onPageChange`).not.toMatch(/onPageChange\??\s*[:(]/u);
    }
  });

  it("keeps both project-page Arrow guards before viewer-core reads", () => {
    for (const [label, page] of [["auth", AUTH_PAGE], ["demo", DEMO_PAGE]] as const) {
      const handler = slice(page, "    function handleKeyDown", "    window.addEventListener");
      const editable = handler.indexOf("if (isEditableKeyboardTarget(e.target)) return;");
      const browse = handler.indexOf("useUiStore.getState().tagBrowseId");
      const core = handler.indexOf("const store = useViewerCoreStore.getState();");
      expect(editable, `${label} editable`).toBeGreaterThan(-1);
      expect(browse, `${label} browse`).toBeGreaterThan(editable);
      expect(core, `${label} core`).toBeGreaterThan(browse);
      expect(handler).toContain('e.key === "ArrowLeft" || e.key === "ArrowRight"');
      expect(handler).not.toContain("stopPropagation");
      expect(handler).not.toContain("stopImmediatePropagation");
    }
  });
});
