// [fix 2026-10-24 T1a] max_detections default: 6000 for text-only models (yolo_text saturated at
// 2000), 2000 otherwise; an explicit model config value always wins. The YAML is regenerated before
// every run, so this needs no YOLO image rebuild.
import { describe, expect, it } from "vitest";
import { isTextOnlyModel, yoloRunConfigYaml } from "@/lib/yolo-config-yaml";

const maxDet = (yaml: string) => Number(/max_detections: (\d+)/u.exec(yaml)?.[1]);

describe("yoloRunConfigYaml max_detections", () => {
  it("layout / shape models keep 2000", () => {
    expect(maxDet(yoloRunConfigYaml({ classes: ["tables", "text_box", "title_block"] }, "yolo_medium"))).toBe(2000);
    expect(maxDet(yoloRunConfigYaml({ classes: ["circle", "text", "grid"] }, "yolo_primitive"))).toBe(2000);
    expect(maxDet(yoloRunConfigYaml(null))).toBe(2000);
  });

  it("a text-only model defaults to 6000 — by classes, or by name when it declares none", () => {
    expect(maxDet(yoloRunConfigYaml({ classes: ["text_box"] }, "anything"))).toBe(6000);
    expect(maxDet(yoloRunConfigYaml({}, "yolo_text"))).toBe(6000);
    expect(maxDet(yoloRunConfigYaml(undefined, "yolo_text"))).toBe(6000);
  });

  it("the DEPLOYED yolo_text config (text_box + text_box_2, all 216 bundles) gets 6000", () => {
    const deployed = { classes: ["text_box", "text_box_2"], confidence: 0.25, imageSize: 1280 };
    expect(maxDet(yoloRunConfigYaml(deployed, "yolo_text"))).toBe(6000);
    // numbered text classes count as text even when the name does not say so
    expect(maxDet(yoloRunConfigYaml(deployed, "words_v3"))).toBe(6000);
    expect(isTextOnlyModel(["text_box", "text_box_2"], "yolo_text")).toBe(true);
    // the name is checked first: a text model keeps 6000 whatever class it adds next
    expect(isTextOnlyModel(["text_box", "stamp"], "yolo_text")).toBe(true);
    // a mixed non-text model is unaffected
    expect(isTextOnlyModel(["text_box", "text_box_2", "title_block"], "yolo_medium")).toBe(false);
    expect(isTextOnlyModel(["text_boxes"], "m")).toBe(false);
  });

  it("an explicit maxDetections wins", () => {
    expect(maxDet(yoloRunConfigYaml({ classes: ["text_box"], maxDetections: 1500 }, "yolo_text"))).toBe(1500);
    expect(maxDet(yoloRunConfigYaml({ classes: ["door"], maxDetections: 9000 }, "m"))).toBe(9000);
  });

  it("isTextOnlyModel does not match lookalike names", () => {
    expect(isTextOnlyModel([], "yolo_textures")).toBe(false);
    expect(isTextOnlyModel([], "context_v2")).toBe(false);
    expect(isTextOnlyModel([], "text-v2")).toBe(true);
  });
});
