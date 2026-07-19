import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const AO = readFileSync(
  join(process.cwd(), "src/components/viewer/AnnotationOverlay.tsx"),
  "utf8",
);
const MARKUP = readFileSync(
  join(process.cwd(), "src/components/viewer/tools/markup.ts"),
  "utf8",
);

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function compact(source: string): string {
  return source.replace(/\s+/g, "");
}

function sha256(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

describe("P3 standalone markup topology and finding dispositions", () => {
  it("requires one shared reset terminal to clear all five controlled fields", () => {
    const state = AO.slice(
      AO.indexOf("// Markup modal: the first CSI entry is editable"),
      AO.indexOf("const {\n    showDetections"),
    );
    expect(compact(state)).toContain(compact(`
      const clearMarkupDialog = useCallback(() => {
        setPendingMarkup(null);
        setMarkupName("");
        setMarkupNote("");
        setMarkupCsi("");
        setEditingAnnotationId(null);
      }, []);
    `));
    const jsx = AO.slice(AO.indexOf("{/* Markup name + notes + CSI dialog */"));
    expect(compact(jsx)).toContain("onCancel={clearMarkupDialog}");
    expect(count(jsx, "onCancel=")).toBe(1);
  });

  it("pins #13 already retired instead of manufacturing replacement provenance", () => {
    expect(AO).not.toContain("saveVertexEdit");
    expect(AO).not.toContain("split-area persistence code at L941");
    expect(AO).not.toContain("Pattern cloned from the split-area persistence");
  });

  it("pins the only two non-null dialog openers and the shared save tail", () => {
    expect(count(AO, "setPendingMarkup(selAnn.bbox as [number, number, number, number]);")).toBe(1);
    expect(count(AO, "setPendingMarkup(bbox);")).toBe(1);
    expect(count(AO, "const saveMarkup = useCallback(() => {")).toBe(1);
    expect(count(AO, "<MarkupDialog")).toBe(1);
    expect(count(AO, "void persistCreate({")).toBe(4);
  });

  it("discharges K12 by freezing both copied mousedown paths byte-exact", () => {
    const start = AO.indexOf("      // Pointer mode (and Group mode");
    const end = AO.indexOf("      // [refactor jul16 P3.2] The markup mousedown blocks");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const pointerGroup = AO.slice(start, end);
    expect(Buffer.byteLength(pointerGroup, "utf8")).toBe(15617);
    expect(sha256(pointerGroup)).toBe(
      "fd0b1e5c54a1c808e365ec34b7e15903d5c013f78ac727c69867ea7aac6c2dee",
    );
    expect(Buffer.byteLength(MARKUP, "utf8")).toBe(4543);
    expect(sha256(MARKUP)).toBe(
      "b73291e6f81070d4d412eed13b329a6b2657d5986af8a3bb301aa92f4c5044d6",
    );
  });

  it("pins the sacred handleMouseDown dependency contract", () => {
    const callbackStart = AO.indexOf("  const handleMouseDown = useCallback(");
    const callbackEnd = AO.indexOf("\n  );", callbackStart);
    const callback = AO.slice(callbackStart, callbackEnd + "\n  );".length);
    const dependencyStart = callback.lastIndexOf("\n    [") + 1;
    const dependencyEnd = callback.indexOf("]\n  );", dependencyStart) + 2;
    const raw = callback.slice(dependencyStart, dependencyEnd);
    const members = raw.trim().slice(1, -1).split(",").map((member) => member.trim()).filter(Boolean);

    expect(members).toHaveLength(37);
    expect(createHash("md5").update(raw).digest("hex")).toBe(
      "dada8bf65ea7834550cc1e5fc221d5ee",
    );
  });

  it("retains the current AO ceiling before and after the repair", () => {
    expect(AO.split("\n").length - 1).toBeLessThanOrEqual(2734);
  });
});
