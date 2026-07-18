// @vitest-environment node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const HOOK = readFileSync(
  join(process.cwd(), "src/components/viewer/useAnnotationDragMachine.ts"),
  "utf8",
);
const OVERLAY = readFileSync(
  join(process.cwd(), "src/components/viewer/AnnotationOverlay.tsx"),
  "utf8",
);

describe("annotation drag machine topology", () => {
  it("revalidates the captured session before exposing hot-path physics", () => {
    expect(HOOK).toContain("return active && isLive(active) ? active : null;");
  });

  it("invalidates ownership and React drag state before frame cancellation", () => {
    const detach = HOOK.slice(
      HOOK.indexOf("const detach = useCallback"),
      HOOK.indexOf("const begin = useCallback"),
    );
    expect(detach.indexOf("activeRef.current = null;")).toBeLessThan(
      detach.indexOf("cancelAnimationFrame(frame)"),
    );
    expect(detach.indexOf("setDragging(false);")).toBeLessThan(
      detach.indexOf("cancelAnimationFrame(frame)"),
    );
  });

  it("refuses begin when cancellation admitted a newer owner", () => {
    const begin = HOOK.slice(
      HOOK.indexOf("const begin = useCallback"),
      HOOK.indexOf("const schedule = useCallback"),
    );
    const postCancel = begin.slice(
      begin.indexOf("// Cancellation is an external boundary"),
      begin.indexOf("const generation = ++generationRef.current;"),
    );
    expect(postCancel).toContain("activeRef.current !== null ||");
    expect(postCancel).toContain(
      "generationRef.current !== expectedEmptyGeneration ||",
    );
    expect(postCancel).toContain("pageEpochRef.current !== pageEpochAtStart ||");
  });

  it("keeps page ABA epochs on both rAF and terminal publication paths", () => {
    expect(HOOK.match(/pageEpochRef\.current !== session\.pageEpoch/g)).toHaveLength(2);
    expect(HOOK).toContain("pageEpochRef.current += 1;");
  });

  it("passes the exact journal payload object to persistence", () => {
    expect(HOOK).toContain(
      "await persistFetch(`/api/annotations/${session.annotationId}`, update.payload, \"PUT\");",
    );
  });

  it("makes the synchronous page subscriber the sole selection-clear owner", () => {
    const pageBoundary = HOOK.slice(
      HOOK.indexOf("useLayoutEffect(() => useViewerCoreStore.subscribe"),
      HOOK.indexOf("const lifecycleRef"),
    );
    expect(pageBoundary).toContain("useLayoutEffect(() => useViewerCoreStore.subscribe");
    expect(pageBoundary).toContain("if (!mountedRef.current ||");
    expect(pageBoundary.indexOf("setSelectedId(null);")).toBeLessThan(
      pageBoundary.indexOf("detach(active)"),
    );
    expect(OVERLAY).not.toContain("selectedPageRef");
  });

  it("clears retired lifecycle selection before successor passive focus", () => {
    const lifecycleBoundary = HOOK.slice(
      HOOK.indexOf("const lifecycleRef"),
      HOOK.indexOf("// Ref-only layout cleanup"),
    );
    expect(lifecycleBoundary).toContain("useLayoutEffect(() => {");
    expect(lifecycleBoundary.indexOf("setSelectedId(null);")).toBeLessThan(
      lifecycleBoundary.indexOf("detach(active)"),
    );
  });

  it("retires only the session owned by the replaced lifecycle guard", () => {
    const lifecycleBoundary = HOOK.slice(
      HOOK.indexOf("const lifecycleRef"),
      HOOK.indexOf("// Ref-only layout cleanup"),
    );
    expect(lifecycleBoundary).toContain(
      "if (active?.canAdopt === canAdoptProjectLifecycle) return;",
    );
    expect(lifecycleBoundary.indexOf("active?.canAdopt === canAdoptProjectLifecycle")).toBeLessThan(
      lifecycleBoundary.indexOf("setSelectedId(null);"),
    );
    expect(lifecycleBoundary.indexOf("active?.canAdopt === canAdoptProjectLifecycle")).toBeLessThan(
      lifecycleBoundary.indexOf("detach(active)"),
    );
  });

  it("closes drag admission before synchronous unmount cancellation", () => {
    const begin = HOOK.slice(
      HOOK.indexOf("const begin = useCallback"),
      HOOK.indexOf("const schedule = useCallback"),
    );
    const postCancel = begin.slice(begin.indexOf("// Cancellation is an external boundary"));
    const unmount = HOOK.slice(
      HOOK.indexOf("// Ref-only layout cleanup"),
      HOOK.indexOf("const readActive"),
    );
    expect(begin.slice(0, begin.indexOf("const liveOrigin"))).toContain(
      "!mountedRef.current ||",
    );
    expect(postCancel).toContain("!mountedRef.current ||");
    expect(unmount).toContain("useLayoutEffect(() => {");
    expect(unmount.indexOf("mountedRef.current = false;")).toBeLessThan(
      unmount.indexOf("cancelAnimationFrame(frame)"),
    );
  });

  it("keeps pointermove physics on the current-page projection", () => {
    const move = OVERLAY.slice(
      OVERLAY.indexOf("const handleMouseMove = useCallback"),
      OVERLAY.indexOf("const handleMouseUp = useCallback"),
    );
    expect(move.match(/pageAnnotations\.find/g)).toHaveLength(2);
    expect(move).not.toContain("readAnnotations(");
  });

  it("routes Enter through the exact terminal with vertex-first precedence", () => {
    const keyboard = OVERLAY.slice(
      OVERLAY.indexOf("// Keyboard: Delete/Backspace"),
      OVERLAY.indexOf("// Exit polygon drawing"),
    );
    const inputGuard = keyboard.indexOf("e.target instanceof HTMLInputElement");
    const lifecycleGuard = keyboard.indexOf("if (!canAdoptProjectLifecycle()) return;");
    const enterStart = keyboard.indexOf('if (e.key === "Enter")');
    const enter = keyboard.slice(enterStart);
    const read = enter.indexOf("const annotationDrag = readActiveAnnotationDrag();");
    const vertex = enter.indexOf('annotationDrag?.operation.kind === "vertex"');
    const bbox = enter.indexOf('annotationDrag?.operation.kind === "bbox"');
    const invalidate = enter.indexOf("invalidateToolTailAuthority();");
    const finish = enter.indexOf("finishAnnotationDrag(annotationDrag, true);");

    expect(inputGuard).toBeGreaterThan(-1);
    expect(lifecycleGuard).toBeGreaterThan(-1);
    expect(enterStart).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(-1);
    expect(vertex).toBeGreaterThan(-1);
    expect(bbox).toBeGreaterThan(-1);
    expect(read).toBeLessThan(vertex);
    expect(inputGuard).toBeLessThan(lifecycleGuard);
    expect(lifecycleGuard).toBeLessThan(enterStart);
    expect(vertex).toBeLessThan(bbox);
    expect(bbox).toBeLessThan(invalidate);
    expect(invalidate).toBeLessThan(finish);
    expect(enter.match(/finishAnnotationDrag\(annotationDrag, true\);/g)).toHaveLength(1);
    expect(enter).not.toContain('e.key === "Enter" && dragging');
    expect(enter).not.toContain("saveDragPosition();");
  });
});
