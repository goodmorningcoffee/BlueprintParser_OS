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

/** Ultralytics `max_det` when the model config sets none. */
export const DEFAULT_MAX_DETECTIONS = 2000;
/**
 * [fix 2026-10-24 T1a] Text-only models (every class a text class — the deployed yolo_text declares
 * `text_box` + `text_box_2`) find one box per word cluster; at 2000 the yolo_text run saturated on 71
 * corpus pages, silently dropping the rest of the page. The cap travels in this file, so raising it
 * needs no YOLO image rebuild. An explicit `maxDetections` in the model config always wins.
 */
export const TEXT_MODEL_MAX_DETECTIONS = 6000;
/** `text`, `text_box`, and numbered variants (`text_box_2`, `text_3`). */
export const TEXT_CLASS = /^text(?:_box)?(?:_\d+)?$/u;
/** A whole `text` token in the model name: `yolo_text`, `text-v2`; not `yolo_textures`. */
export const TEXT_MODEL_NAME = /(^|[_-])text($|[_-])/iu;

/**
 * A model is text-only when its NAME says so (`yolo_text`, checked first, so a new numbered class
 * cannot silently drop it back to 2000), or when it declares classes and all of them are text classes.
 */
export function isTextOnlyModel(classes: readonly string[], modelName?: string): boolean {
  if (TEXT_MODEL_NAME.test(modelName ?? "")) return true;
  return classes.length > 0 && classes.every((c) => TEXT_CLASS.test(c));
}

export function defaultMaxDetections(classes: readonly string[], modelName?: string): number {
  return isTextOnlyModel(classes, modelName) ? TEXT_MODEL_MAX_DETECTIONS : DEFAULT_MAX_DETECTIONS;
}

export function yoloRunConfigYaml(
  config: YoloRunModelConfig | null | undefined,
  modelName?: string,
): string {
  const conf = config?.confidence ?? 0.1;
  const iouVal = config?.iou ?? 0.6;
  const imgSize = config?.imageSize ?? 1280;
  const classList = config?.classes ?? [];
  const maxDet = config?.maxDetections ?? defaultMaxDetections(classList, modelName);
  return `model_file: model.pt
confidence_threshold: ${conf}
iou_threshold: ${iouVal}
image_size: ${imgSize}
device: auto
half_precision: true
max_detections: ${maxDet}
save_annotated: false
classes:
${classList.map((c: string) => `  - ${c}`).join("\n")}
`;
}
