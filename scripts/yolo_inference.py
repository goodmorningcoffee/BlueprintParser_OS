#!/usr/bin/env python3
"""YOLO inference script for SageMaker Processing Jobs.

Reads page images and a model from SageMaker input mounts,
runs YOLOv8 detection, and writes per-page JSON results.
"""

import glob
import json
import os
import sys
import time
import traceback

import yaml
import torch
from ultralytics import YOLO

# SageMaker Processing Job well-known paths
INPUT_IMAGES = "/opt/ml/processing/input/images"
INPUT_MODELS = "/opt/ml/processing/input/models"
OUTPUT_DIR = "/opt/ml/processing/output"

# Defaults if config.yaml is missing or incomplete
DEFAULTS = {
    "model_file": "model.pt",
    "confidence_threshold": 0.10,
    "iou_threshold": 0.60,
    "image_size": 1280,
    "device": "auto",
    "half_precision": True,
    "max_detections": 2000,
    "classes": [],
}


def load_config():
    """Load config.yaml from model input dir, falling back to defaults."""
    config_path = os.path.join(INPUT_MODELS, "config.yaml")
    config = dict(DEFAULTS)

    if os.path.exists(config_path):
        with open(config_path) as f:
            user_config = yaml.safe_load(f) or {}
        config.update({k: v for k, v in user_config.items() if v is not None})
        print(f"Loaded config from {config_path}")
    else:
        print(f"No config.yaml found at {config_path}, using defaults")

    # Resolve device
    if config["device"] == "auto":
        config["device"] = "cuda" if torch.cuda.is_available() else "cpu"

    print(f"Config: device={config['device']}, conf={config['confidence_threshold']}, "
          f"iou={config['iou_threshold']}, imgsz={config['image_size']}, "
          f"half={config['half_precision']}, max_det={config['max_detections']}")
    return config


def run_inference(model, image_path, config):
    """Run YOLO inference on a single image and return detections list."""
    results = model.predict(
        source=image_path,
        conf=config["confidence_threshold"],
        iou=config["iou_threshold"],
        imgsz=config["image_size"],
        device=config["device"],
        half=config["half_precision"] and config["device"] == "cuda",
        max_det=config["max_detections"],
        verbose=False,
    )

    result = results[0]
    h, w = result.orig_shape
    detections = []

    if result.boxes is not None and len(result.boxes) > 0:
        boxes_xyxy = result.boxes.xyxy.cpu().numpy()
        confidences = result.boxes.conf.cpu().numpy()
        class_ids = result.boxes.cls.cpu().int().numpy()

        class_names = config["classes"]

        for i in range(len(boxes_xyxy)):
            x1, y1, x2, y2 = boxes_xyxy[i]
            cls_id = int(class_ids[i])
            conf = float(confidences[i])

            # Resolve class name: config classes first, then model metadata
            if cls_id < len(class_names):
                cls_name = class_names[cls_id]
            elif cls_id in model.names:
                cls_name = model.names[cls_id]
            else:
                cls_name = f"class_{cls_id}"

            detections.append({
                "class_id": cls_id,
                "class_name": cls_name,
                "confidence": round(conf, 4),
                "bbox": [int(x1), int(y1), int(x2), int(y2)],
                "bbox_normalized": [
                    round(float(x1) / w, 6),
                    round(float(y1) / h, 6),
                    round(float(x2) / w, 6),
                    round(float(y2) / h, 6),
                ],
            })

    return detections


def main():
    start_time = time.time()
    print("=" * 60)
    print("YOLO Inference — Beaver Blueprint Parser")
    print("=" * 60)

    # Load config and model
    config = load_config()

    model_path = os.path.join(INPUT_MODELS, config["model_file"])
    if not os.path.exists(model_path):
        print(f"ERROR: Model not found at {model_path}")
        sys.exit(1)

    print(f"Loading model from {model_path}...")
    model = YOLO(model_path)
    print(f"Model loaded: {len(model.names)} classes")

    # Find all page images
    image_files = sorted(glob.glob(os.path.join(INPUT_IMAGES, "page_*.png")))
    if not image_files:
        print(f"ERROR: No page_*.png images found in {INPUT_IMAGES}")
        sys.exit(1)

    print(f"Found {len(image_files)} pages to process")
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # Process each page
    total_detections = 0
    errors = []

    for image_path in image_files:
        filename = os.path.basename(image_path)
        page_stem = os.path.splitext(filename)[0]  # e.g. "page_0001"

        try:
            detections = run_inference(model, image_path, config)
            total_detections += len(detections)

            output_path = os.path.join(OUTPUT_DIR, f"{page_stem}.json")
            with open(output_path, "w") as f:
                json.dump({"detections": detections}, f)

            print(f"  {filename}: {len(detections)} detections")

        except Exception as e:
            error_msg = f"{filename}: {str(e)}"
            errors.append(error_msg)
            print(f"  WARNING: {error_msg}")
            traceback.print_exc()

            # Write empty detections for failed pages so load route doesn't skip
            output_path = os.path.join(OUTPUT_DIR, f"{page_stem}.json")
            with open(output_path, "w") as f:
                json.dump({"detections": []}, f)

    # Write manifest (skipped by load route)
    elapsed = round(time.time() - start_time, 2)
    manifest = {
        "pages_processed": len(image_files),
        "pages_failed": len(errors),
        "total_detections": total_detections,
        "errors": errors,
        "runtime_seconds": elapsed,
        "config": {
            "model_file": config["model_file"],
            "confidence_threshold": config["confidence_threshold"],
            "iou_threshold": config["iou_threshold"],
            "image_size": config["image_size"],
            "device": config["device"],
            "half_precision": config["half_precision"],
        },
    }
    with open(os.path.join(OUTPUT_DIR, "_manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)

    print("=" * 60)
    print(f"Done: {len(image_files)} pages, {total_detections} detections, "
          f"{len(errors)} errors, {elapsed}s")
    print("=" * 60)

    if len(errors) == len(image_files):
        print("ERROR: All pages failed")
        sys.exit(1)


if __name__ == "__main__":
    main()
