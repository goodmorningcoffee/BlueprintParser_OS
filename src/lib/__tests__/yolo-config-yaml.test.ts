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
