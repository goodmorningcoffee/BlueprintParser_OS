#!/usr/bin/env python3
"""
tatr_structure.py — Table structure recognition using Microsoft's Table Transformer (TATR).

Detects table rows, columns, cells, headers, and spanning cells as bounding boxes.
Does NOT extract text — the caller fills text from OCR data.

Input: JSON on stdin with image_path and model_path
Output: JSON on stdout with detected structural elements
"""

import sys
import json
import os

def detect_structure(image_path: str, model_path: str, confidence_threshold: float = 0.5):
    """
    Run TATR inference on a cropped table image.

    Args:
        image_path: Path to cropped table region PNG
        model_path: Path to TATR model directory (HuggingFace format)
        confidence_threshold: Min detection confidence (0-1)

    Returns:
        Dict with cells, rows, columns, confidence
    """
    try:
        import torch
        from transformers import TableTransformerForObjectDetection, AutoImageProcessor
        from PIL import Image
    except ImportError as e:
        return {"error": f"Missing dependency: {e}", "cells": [], "rows": [], "columns": [], "confidence": 0}

    if not os.path.isdir(model_path):
        return {"error": f"Model not found at {model_path}", "cells": [], "rows": [], "columns": [], "confidence": 0}

    try:
        # Load model and image processor
        print(f"Loading TATR model from {model_path}...", file=sys.stderr)
        image_processor = AutoImageProcessor.from_pretrained(model_path)
        model = TableTransformerForObjectDetection.from_pretrained(model_path)
        model.eval()

        # Load and preprocess image
        image = Image.open(image_path).convert("RGB")
        img_w, img_h = image.size
        print(f"Image size: {img_w}x{img_h}", file=sys.stderr)

        inputs = image_processor(images=image, return_tensors="pt")

        # Run inference
        with torch.no_grad():
            outputs = model(**inputs)

        # Post-process: convert to bboxes with labels and scores
        target_sizes = torch.tensor([image.size[::-1]])  # (height, width)
        results = image_processor.post_process_object_detection(
            outputs, threshold=confidence_threshold, target_sizes=target_sizes
        )[0]

        # Map label IDs to names
        id2label = model.config.id2label

        # Categorize detections
        rows = []
        columns = []
        headers = []
        spanning_cells = []

        for score, label_id, box in zip(
            results["scores"].tolist(),
            results["labels"].tolist(),
            results["boxes"].tolist(),
        ):
            label = id2label.get(label_id, f"unknown_{label_id}")
            # Normalize bbox to 0-1 (relative to crop image)
            x1, y1, x2, y2 = box
            norm_bbox = [
                round(x1 / img_w, 6),
                round(y1 / img_h, 6),
                round(x2 / img_w, 6),
                round(y2 / img_h, 6),
            ]

            entry = {"bbox": norm_bbox, "confidence": round(score, 4), "label": label}

            if "row" in label and "header" not in label:
                entry["index"] = len(rows)
                rows.append(entry)
            elif "column" in label and "header" not in label:
                entry["index"] = len(columns)
                columns.append(entry)
            elif "column header" in label:
                headers.append(entry)
            elif "projected row header" in label:
                headers.append(entry)
            elif "spanning" in label:
                spanning_cells.append(entry)
            # Skip "table" detections (we already know it's a table)

        # Sort rows by Y position, columns by X position
        rows.sort(key=lambda r: r["bbox"][1])
        columns.sort(key=lambda c: c["bbox"][0])
        for i, r in enumerate(rows):
            r["index"] = i
        for i, c in enumerate(columns):
            c["index"] = i

        print(f"Detected: {len(rows)} rows, {len(columns)} columns, "
              f"{len(headers)} headers, {len(spanning_cells)} spanning cells",
              file=sys.stderr)

        # Build cell grid from row × column intersections
        cells = []
        for ri, row in enumerate(rows):
            for ci, col in enumerate(columns):
                # Cell bbox = intersection of row and column bboxes
                cell_x1 = max(row["bbox"][0], col["bbox"][0])
                cell_y1 = max(row["bbox"][1], col["bbox"][1])
                cell_x2 = min(row["bbox"][2], col["bbox"][2])
                cell_y2 = min(row["bbox"][3], col["bbox"][3])

                # Skip if no valid intersection
                if cell_x1 >= cell_x2 or cell_y1 >= cell_y2:
                    continue

                cell_bbox = [
                    round(cell_x1, 6), round(cell_y1, 6),
                    round(cell_x2, 6), round(cell_y2, 6),
                ]

                # Determine cell type
                cell_type = "cell"
                for h in headers:
                    # Check if this cell overlaps significantly with a header
                    overlap_x = max(0, min(cell_x2, h["bbox"][2]) - max(cell_x1, h["bbox"][0]))
                    overlap_y = max(0, min(cell_y2, h["bbox"][3]) - max(cell_y1, h["bbox"][1]))
                    cell_area = (cell_x2 - cell_x1) * (cell_y2 - cell_y1)
                    if cell_area > 0 and (overlap_x * overlap_y) / cell_area > 0.5:
                        cell_type = "column-header" if "column" in h["label"] else "row-header"
                        break

                # Check if this cell is part of a spanning cell
                row_span = 1
                col_span = 1
                for sc in spanning_cells:
                    overlap_x = max(0, min(cell_x2, sc["bbox"][2]) - max(cell_x1, sc["bbox"][0]))
                    overlap_y = max(0, min(cell_y2, sc["bbox"][3]) - max(cell_y1, sc["bbox"][1]))
                    cell_area = (cell_x2 - cell_x1) * (cell_y2 - cell_y1)
                    if cell_area > 0 and (overlap_x * overlap_y) / cell_area > 0.5:
                        cell_type = "spanning"
                        # Estimate span from spanning cell bbox vs row/col sizes
                        sc_height = sc["bbox"][3] - sc["bbox"][1]
                        sc_width = sc["bbox"][2] - sc["bbox"][0]
                        avg_row_h = sum(r["bbox"][3] - r["bbox"][1] for r in rows) / max(len(rows), 1)
                        avg_col_w = sum(c["bbox"][2] - c["bbox"][0] for c in columns) / max(len(columns), 1)
                        if avg_row_h > 0:
                            row_span = max(1, round(sc_height / avg_row_h))
                        if avg_col_w > 0:
                            col_span = max(1, round(sc_width / avg_col_w))
                        break

                cells.append({
                    "bbox": cell_bbox,
                    "row": ri,
                    "col": ci,
                    "rowSpan": row_span,
                    "colSpan": col_span,
                    "type": cell_type,
                    "confidence": round(min(row["confidence"], col["confidence"]), 4),
                })

        # Overall confidence = average of row + column detections
        all_confs = [r["confidence"] for r in rows] + [c["confidence"] for c in columns]
        avg_confidence = sum(all_confs) / len(all_confs) if all_confs else 0

        return {
            "cells": cells,
            "rows": [{"bbox": r["bbox"], "index": r["index"]} for r in rows],
            "columns": [{"bbox": c["bbox"], "index": c["index"]} for c in columns],
            "headers": [{"bbox": h["bbox"], "label": h["label"]} for h in headers],
            "spanningCells": [{"bbox": s["bbox"]} for s in spanning_cells],
            "confidence": round(avg_confidence, 4),
        }

    except Exception as e:
        print(f"TATR error: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        return {"error": str(e), "cells": [], "rows": [], "columns": [], "confidence": 0}


if __name__ == "__main__":
    config = json.loads(sys.stdin.read())
    image_path = config["image_path"]
    model_path = config.get("model_path", os.path.join(os.path.dirname(os.path.dirname(__file__)), "models", "tatr"))

    result = detect_structure(
        image_path=image_path,
        model_path=model_path,
        confidence_threshold=config.get("confidence_threshold", 0.5),
    )
    print(json.dumps(result))
