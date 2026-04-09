#!/usr/bin/env python3
"""
detect_table_lines.py — OpenCV line detection for table grid structure.

Input: path to a cropped table region PNG image
Output: JSON to stdout with detected rows, columns, and grid structure

Uses morphological operations to find horizontal/vertical lines,
then computes intersections to define the table grid.
"""

import sys
import json
import cv2
import numpy as np
from collections import defaultdict


def find_line_masks(image):
    """Detect horizontal and vertical line masks using morphological operations."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    thresh = cv2.adaptiveThreshold(
        blurred, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV, 11, 2
    )

    h, w = image.shape[:2]
    # Horizontal lines: kernel width = 5% of image width (min 40px)
    h_kernel_w = max(40, int(w * 0.05))
    h_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (h_kernel_w, 1))
    h_mask = cv2.morphologyEx(thresh, cv2.MORPH_OPEN, h_kernel, iterations=1)

    # Vertical lines: kernel height = 5% of image height (min 40px)
    v_kernel_h = max(40, int(h * 0.05))
    v_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, v_kernel_h))
    v_mask = cv2.morphologyEx(thresh, cv2.MORPH_OPEN, v_kernel, iterations=1)

    return h_mask, v_mask


def filter_lines(mask, is_horizontal, min_length_ratio=0.15):
    """Filter detected lines by minimum length."""
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    h, w = mask.shape[:2]
    min_length = (w if is_horizontal else h) * min_length_ratio

    filtered = np.zeros_like(mask)
    for cnt in contours:
        x, y, cw, ch = cv2.boundingRect(cnt)
        length = cw if is_horizontal else ch
        if length >= min_length:
            cv2.drawContours(filtered, [cnt], -1, 255, thickness=cv2.FILLED)

    return filtered


def find_line_positions(mask, is_horizontal, tolerance=15):
    """Extract line Y-positions (horizontal) or X-positions (vertical) by clustering."""
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    positions = []

    for cnt in contours:
        x, y, w, h = cv2.boundingRect(cnt)
        if is_horizontal:
            positions.append(y + h // 2)  # center Y
        else:
            positions.append(x + w // 2)  # center X

    if not positions:
        return []

    # Cluster nearby positions
    positions.sort()
    clusters = [[positions[0]]]
    for pos in positions[1:]:
        if pos - clusters[-1][-1] <= tolerance:
            clusters[-1].append(pos)
        else:
            clusters.append([pos])

    # Return cluster medians
    return [int(np.median(c)) for c in clusters]


def detect_grid(image_path, min_h_length=0.15, min_v_length=0.10, tolerance=15):
    """Main detection: find horizontal/vertical lines and compute grid."""
    image = cv2.imread(image_path)
    if image is None:
        return {"error": "Failed to load image", "rows": [], "cols": []}

    h, w = image.shape[:2]
    print(f"Image size: {w}x{h}", file=sys.stderr)

    # Detect line masks
    h_mask, v_mask = find_line_masks(image)

    # Filter short lines
    h_filtered = filter_lines(h_mask, is_horizontal=True, min_length_ratio=min_h_length)
    v_filtered = filter_lines(v_mask, is_horizontal=False, min_length_ratio=min_v_length)

    # Get line positions
    row_ys = find_line_positions(h_filtered, is_horizontal=True, tolerance=tolerance)
    col_xs = find_line_positions(v_filtered, is_horizontal=False, tolerance=tolerance)

    print(f"Detected {len(row_ys)} horizontal lines, {len(col_xs)} vertical lines", file=sys.stderr)

    # Convert to normalized 0-1 coordinates
    rows_normalized = [{"y": round(y / h, 6), "height": 0} for y in row_ys]
    cols_normalized = [{"x": round(x / w, 6), "width": 0} for x in col_xs]

    # Compute row heights (gap between consecutive horizontal lines)
    for i in range(len(rows_normalized)):
        if i < len(rows_normalized) - 1:
            rows_normalized[i]["height"] = round(rows_normalized[i + 1]["y"] - rows_normalized[i]["y"], 6)
        else:
            rows_normalized[i]["height"] = round(1.0 - rows_normalized[i]["y"], 6)

    # Compute column widths
    for i in range(len(cols_normalized)):
        if i < len(cols_normalized) - 1:
            cols_normalized[i]["width"] = round(cols_normalized[i + 1]["x"] - cols_normalized[i]["x"], 6)
        else:
            cols_normalized[i]["width"] = round(1.0 - cols_normalized[i]["x"], 6)

    # Compute confidence based on grid regularity
    confidence = 0.0
    if len(row_ys) >= 2 and len(col_xs) >= 2:
        confidence = 0.5
        # Bonus for regular spacing
        if len(row_ys) >= 3:
            row_gaps = [row_ys[i + 1] - row_ys[i] for i in range(len(row_ys) - 1)]
            median_gap = np.median(row_gaps)
            regularity = sum(1 for g in row_gaps if abs(g - median_gap) < median_gap * 0.3) / len(row_gaps)
            confidence += regularity * 0.2
        if len(col_xs) >= 3:
            col_gaps = [col_xs[i + 1] - col_xs[i] for i in range(len(col_xs) - 1)]
            median_gap = np.median(col_gaps)
            regularity = sum(1 for g in col_gaps if abs(g - median_gap) < median_gap * 0.3) / len(col_gaps)
            confidence += regularity * 0.2
        confidence = min(confidence, 0.95)

    return {
        "rows": rows_normalized,
        "cols": cols_normalized,
        "rowCount": max(0, len(row_ys) - 1),  # rows between lines
        "colCount": max(0, len(col_xs) - 1),  # cols between lines
        "confidence": round(confidence, 3),
    }


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Detect table grid lines in an image")
    parser.add_argument("image_path", help="Path to the input image")
    parser.add_argument("--min-h-length", type=float, default=0.15, help="Min horizontal line length ratio (0-1)")
    parser.add_argument("--min-v-length", type=float, default=0.10, help="Min vertical line length ratio (0-1)")
    parser.add_argument("--tolerance", type=int, default=15, help="Line clustering tolerance in pixels")
    args = parser.parse_args()

    result = detect_grid(
        args.image_path,
        min_h_length=args.min_h_length,
        min_v_length=args.min_v_length,
        tolerance=args.tolerance,
    )
    print(json.dumps(result))
