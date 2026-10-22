// The config.yaml written next to a model before every YOLO run so admin changes to the model's
// config take effect (read by scripts/yolo_inference.py load_config). Shared by the single run
// (services/yolo.ts yoloRun) and the batched run (services/yolo-batch-run.ts); byte-identical to the
// template those runs used inline. TWIN template in services/models.ts registerModel.

export interface YoloRunModelConfig {
  confidence?: number;
  iou?: number;
  imageSize?: number;
  maxDetections?: number;
  classes?: string[];
}

export function yoloRunConfigYaml(config: YoloRunModelConfig | null | undefined): string {
  const conf = config?.confidence ?? 0.1;
  const iouVal = config?.iou ?? 0.6;
  const imgSize = config?.imageSize ?? 1280;
  const classList = config?.classes ?? [];
  return `model_file: model.pt
confidence_threshold: ${conf}
iou_threshold: ${iouVal}
image_size: ${imgSize}
device: auto
half_precision: true
max_detections: ${config?.maxDetections ?? 2000}
save_annotated: false
classes:
${classList.map((c: string) => `  - ${c}`).join("\n")}
`;
}
