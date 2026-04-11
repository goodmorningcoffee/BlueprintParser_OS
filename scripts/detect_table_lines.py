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


# OPENCV-FIX-1c: hard cap on detected columns. Architectural sheets routinely
# fool the line detector into reporting 25-50 columns when the actual table
# has 4-6. The downstream merger filters these out as shape_mismatch but they
# still pollute the methodResults. Cap defensively here.
MAX_REASONABLE_COLS = 20
MAX_REASONABLE_ROWS = 50  # generous — schedules can have up to this many rows


def cluster_close_lines(positions, min_separation):
    """OPENCV-FIX-1b: merge any two lines closer than `min_separation` pixels.

    The line detector + initial clustering can still produce duplicates from
    anti-aliased edges or text-glyph outlines that survived the first cluster
    pass. This second pass walks the sorted positions and merges anything
    closer than `min_separation` (typically half the median gap). Returns the
    cleaned positions sorted ascending.
    """
    if len(positions) < 2:
        return positions
    sorted_pos = sorted(positions)
    merged = [sorted_pos[0]]
    for p in sorted_pos[1:]:
        if p - merged[-1] < min_separation:
            # Merge: replace the last entry with the midpoint
            merged[-1] = (merged[-1] + p) // 2
        else:
            merged.append(p)
    return merged


def detect_grid(image_path, min_h_length=0.15, min_v_length=0.20, tolerance=15):
    """Main detection: find horizontal/vertical lines and compute grid.

    OPENCV-FIX-1a: min_v_length default bumped from 0.10 → 0.20 to reject the
    short vertical line segments that text glyphs and dimension marks create on
    architectural drawings. The wrapper still passes through user overrides via
    `--min-v-length` so the existing ParseOptionsPanel slider keeps working.
    """
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

    raw_row_count = len(row_ys)
    raw_col_count = len(col_xs)
    print(f"Detected {raw_row_count} horizontal lines, {raw_col_count} vertical lines (raw)", file=sys.stderr)

    # OPENCV-FIX-1b: second-pass clustering to merge near-duplicate lines that
    # survived the first cluster. Use half the median gap as the separation.
    if len(col_xs) >= 3:
        col_gaps = [col_xs[i + 1] - col_xs[i] for i in range(len(col_xs) - 1)]
        median_col_gap = np.median(col_gaps)
        col_xs = cluster_close_lines(col_xs, max(int(median_col_gap * 0.5), tolerance))
    if len(row_ys) >= 3:
        row_gaps = [row_ys[i + 1] - row_ys[i] for i in range(len(row_ys) - 1)]
        median_row_gap = np.median(row_gaps)
        row_ys = cluster_close_lines(row_ys, max(int(median_row_gap * 0.5), tolerance))

    if len(col_xs) != raw_col_count or len(row_ys) != raw_row_count:
        print(
            f"After secondary clustering: {len(row_ys)} rows, {len(col_xs)} cols "
            f"(merged {raw_row_count - len(row_ys)} rows, {raw_col_count - len(col_xs)} cols)",
            file=sys.stderr,
        )

    # OPENCV-FIX-1c: hard cap. If detection STILL has > MAX_REASONABLE_COLS,
    # this is almost certainly noise — log a warning and trim. Tables with
    # truly that many columns are extreme outliers; trimming gives the merger
    # SOMETHING usable instead of an unfilterable mess.
    if len(col_xs) > MAX_REASONABLE_COLS:
        print(
            f"WARNING: detected {len(col_xs)} columns exceeds MAX_REASONABLE_COLS={MAX_REASONABLE_COLS}, "
            f"trimming to first {MAX_REASONABLE_COLS}. Consider using user-tunable --min-v-length to "
            f"reject more short lines.",
            file=sys.stderr,
        )
        col_xs = col_xs[:MAX_REASONABLE_COLS]
    if len(row_ys) > MAX_REASONABLE_ROWS:
        print(
            f"WARNING: detected {len(row_ys)} rows exceeds MAX_REASONABLE_ROWS={MAX_REASONABLE_ROWS}, "
            f"trimming to first {MAX_REASONABLE_ROWS}.",
            file=sys.stderr,
        )
        row_ys = row_ys[:MAX_REASONABLE_ROWS]

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

    # Confidence — normalized scale: content(0-0.4) + structure(0-0.3) + features(0-0.2)
    # OpenCV doesn't know fill rate (no OCR), so structure weight is higher
    confidence = 0.0
    if len(row_ys) >= 2 and len(col_xs) >= 2:
        # Base: having a grid at all
        grid_cells = max(0, len(row_ys) - 1) * max(0, len(col_xs) - 1)
        confidence += min(grid_cells / 50, 0.3)  # content proxy: more cells = more content likely
        # Structure: grid regularity
        if len(row_ys) >= 3:
            row_gaps = [row_ys[i + 1] - row_ys[i] for i in range(len(row_ys) - 1)]
            median_gap = np.median(row_gaps)
            regularity = sum(1 for g in row_gaps if abs(g - median_gap) < median_gap * 0.3) / len(row_gaps)
            confidence += regularity * 0.15
        if len(col_xs) >= 3:
            col_gaps = [col_xs[i + 1] - col_xs[i] for i in range(len(col_xs) - 1)]
            median_gap = np.median(col_gaps)
            regularity = sum(1 for g in col_gaps if abs(g - median_gap) < median_gap * 0.3) / len(col_gaps)
            confidence += regularity * 0.15
        confidence = min(confidence, 0.85)

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
    parser.add_argument("--min-v-length", type=float, default=0.20, help="Min vertical line length ratio (0-1) — bumped from 0.10 in OPENCV-FIX-1a to reject text-edge false positives")
    parser.add_argument("--tolerance", type=int, default=15, help="Line clustering tolerance in pixels")
    args = parser.parse_args()

    result = detect_grid(
        args.image_path,
        min_h_length=args.min_h_length,
        min_v_length=args.min_v_length,
        tolerance=args.tolerance,
    )
    print(json.dumps(result))
