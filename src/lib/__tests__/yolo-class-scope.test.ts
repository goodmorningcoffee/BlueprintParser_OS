// [fix 2026-10-24 T1a] layout classes are read from the model that defines them; a drop is logged
// once per (class, model) pair so a renamed layout model does not lose its signals silently.
import { describe, expect, it, vi } from "vitest";
import { logger } from "@/lib/logger";
import { inLayoutScope, scopeLayoutDetections } from "@/lib/yolo-class-scope";

describe("yolo-class-scope", () => {
  it("keeps text_box from yolo_medium, drops it from yolo_text, keeps unscoped and legacy rows", () => {
    const dets = [
      { name: "text_box", modelName: "yolo_medium" },
      { name: "text_box", modelName: "yolo_text" },
      { name: "text_box", modelName: null },
      { name: "vertical_area", modelName: "yolo_primitive" },
      { name: "vertical_area", modelName: "yolo_medium" },
      { name: "tables", modelName: "yolo_text" },
    ];
    expect(scopeLayoutDetections(dets)).toEqual([dets[0], dets[2], dets[3], dets[5]]);
  });

  it("logs a drop once per (class, model) pair, naming the fix", () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    try {
      expect(inLayoutScope({ name: "text_box", modelName: "yolo_medium_v2" })).toBe(false);
      expect(inLayoutScope({ name: "text_box", modelName: "yolo_medium_v2" })).toBe(false);
      expect(inLayoutScope({ name: "horizontal_area", modelName: "yolo_medium_v2" })).toBe(false);
      expect(info).toHaveBeenCalledTimes(2);
      expect(String(info.mock.calls[0][0])).toContain('"text_box" from model "yolo_medium_v2"');
      expect(String(info.mock.calls[0][0])).toContain("LAYOUT_CLASS_MODELS");
      inLayoutScope({ name: "text_box", modelName: "yolo_medium" });
      expect(info).toHaveBeenCalledTimes(2);
    } finally {
      info.mockRestore();
    }
  });
});
