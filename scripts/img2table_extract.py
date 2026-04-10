#!/usr/bin/env python3
"""
img2table_extract.py — Table extraction using img2table library.

Uses Hough line detection + morphological operations + merged cell detection.
Provides skew correction and better line detection than our basic OpenCV method.

Input: JSON on stdin with image_path, region_bbox
Output: JSON on stdout with MethodResult format
"""

import sys
import json

try:
    import numpy as np
    from img2table.document import Image as Img2TableImage
    from img2table.ocr import TesseractOCR
except ImportError:
    print(json.dumps({"method": "img2table", "headers": [], "rows": [], "confidence": 0,
                       "error": "img2table not installed"}))
    sys.exit(0)


def extract_table(image_path: str, region_bbox: list, dpi: int = 150,
                  detect_rotation: bool = False, implicit_rows: bool = True,
                  min_confidence: int = 50):
    """
    Extract tables from an image using img2table.

    Args:
        image_path: Path to the page image (PNG)
        region_bbox: [minX, minY, maxX, maxY] normalized 0-1
        dpi: Image DPI for processing
        detect_rotation: Whether to correct skew/rotation
        implicit_rows: Whether to split implicit rows
        min_confidence: Minimum OCR confidence (0-99)

    Returns:
        MethodResult dict
    """
    try:
        import cv2

        # Load image to get dimensions
        img_array = cv2.imread(image_path)
        if img_array is None:
            return {"method": "img2table", "headers": [], "rows": [], "confidence": 0,
                    "error": "Failed to load image"}

        img_h, img_w = img_array.shape[:2]

        # Crop to region
        rx0, ry0, rx1, ry1 = region_bbox
        crop_x0 = int(rx0 * img_w)
        crop_y0 = int(ry0 * img_h)
        crop_x1 = int(rx1 * img_w)
        crop_y1 = int(ry1 * img_h)
        cropped = img_array[crop_y0:crop_y1, crop_x0:crop_x1]

        # Write cropped image to temp file for img2table (unique name to avoid collisions)
        import tempfile
        import os
        import uuid
        tmp_path = os.path.join(tempfile.gettempdir(), f"bp2_img2table_{uuid.uuid4().hex[:8]}.png")
        cv2.imwrite(tmp_path, cropped)

        crop_h, crop_w = cropped.shape[:2]
        print(f"Cropped region: {crop_w}x{crop_h}", file=sys.stderr)

        # Create img2table Image from cropped region
        doc = Img2TableImage(src=tmp_path, dpi=dpi, detect_rotation=detect_rotation)

        # Use Tesseract for OCR (already installed in our Docker image)
        ocr = TesseractOCR(lang="eng")

        # Extract tables
        tables = doc.extract_tables(ocr=ocr, implicit_rows=implicit_rows,
                                     min_confidence=min_confidence)

        # Clean up temp file after extraction completes
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

        if not tables:
            print("No tables detected by img2table", file=sys.stderr)
            return {"method": "img2table", "headers": [], "rows": [], "confidence": 0,
                    "error": "No tables detected in region"}

        # Take the largest table (most cells)
        def table_size(t):
            d = t.df
            if d is None: return 0
            return d.shape[0] * d.shape[1] if hasattr(d, 'shape') else 0
        best_table = max(tables, key=table_size)
        d = best_table.df
        nr = d.shape[0] if d is not None and hasattr(d, 'shape') else 0
        nc = d.shape[1] if d is not None and hasattr(d, 'shape') else 0
        print(f"Best table: {nr}r x {nc}c", file=sys.stderr)

        # Convert to MethodResult format
        # Get the DataFrame representation
        df = best_table.df
        if df is None or df.empty:
            return {"method": "img2table", "headers": [], "rows": [], "confidence": 0}

        # Use first row as potential headers, or generate column names
        headers = [str(c) for c in df.columns]
        # img2table uses integer column indices by default
        if all(str(h).isdigit() for h in headers):
            headers = [f"Column {int(h) + 1}" for h in headers]

        rows = []
        for _, row in df.iterrows():
            row_dict = {}
            for h_idx, h in enumerate(headers):
                val = str(row.iloc[h_idx]) if h_idx < len(row) else ""
                row_dict[h] = val if val != "None" and val != "nan" else ""
            rows.append(row_dict)

        if not rows:
            return {"method": "img2table", "headers": [], "rows": [], "confidence": 0}

        # Compute column and row boundaries (normalized to region, then to page)
        # img2table content is OrderedDict of row_idx → [TableCell] with .bbox (BBox x1,y1,x2,y2) in pixel coords
        col_xs = set()
        row_ys = set()
        for row_cells in best_table.content.values():
            for cell in row_cells:
                col_xs.add(cell.bbox.x1)
                col_xs.add(cell.bbox.x2)
                row_ys.add(cell.bbox.y1)
                row_ys.add(cell.bbox.y2)

        sorted_cols = sorted(col_xs)
        sorted_rows = sorted(row_ys)

        # Normalize to page coordinates: pixel_in_crop / crop_size * region_size + region_offset
        col_boundaries = [rx0 + (x / crop_w) * (rx1 - rx0) for x in sorted_cols]
        row_boundaries = [ry0 + (y / crop_h) * (ry1 - ry0) for y in sorted_rows]

        # Confidence — normalized scale: content(0-0.4) + structure(0-0.3) + features(0-0.2)
        filled = sum(1 for r in rows for v in r.values() if v.strip())
        total = len(rows) * len(headers)
        fill_rate = filled / total if total > 0 else 0
        confidence = fill_rate * 0.4
        # Structure: grid size bonus
        if nr >= 3 and nc >= 2:
            confidence += 0.2
        # Feature: having detected larger tables
        if nr >= 5:
            confidence += 0.1
        confidence = min(confidence, 0.85)

        return {
            "method": "img2table",
            "headers": headers,
            "rows": rows,
            "confidence": round(confidence, 3),
            "colBoundaries": [round(x, 6) for x in col_boundaries],
            "rowBoundaries": [round(y, 6) for y in row_boundaries],
        }

    except Exception as e:
        print(f"img2table error: {e}", file=sys.stderr)
        return {"method": "img2table", "headers": [], "rows": [], "confidence": 0,
                "error": str(e)}


if __name__ == "__main__":
    config = json.loads(sys.stdin.read())
    result = extract_table(
        image_path=config["image_path"],
        region_bbox=config["region_bbox"],
        dpi=config.get("dpi", 200),
        detect_rotation=config.get("detect_rotation", True),
        implicit_rows=config.get("implicit_rows", True),
        min_confidence=config.get("min_confidence", 50),
    )
    print(json.dumps(result))
