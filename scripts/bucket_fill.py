#!/usr/bin/env python3
"""
bucket_fill.py — Paint-bucket room detection for surface area takeoff.

Raster-only: OpenCV flood fill on the rasterized page image.
The vector mode (pdfplumber + networkx) was removed — it rarely succeeded
on real blueprints and added 500-1500ms of import/processing overhead.

Barrier lines (user-drawn) are burned onto the binary image as wall pixels
before flood fill. Existing area polygons are burned as impassable regions.

Input: JSON config via stdin
Output: JSON result to stdout
"""

import sys
import json
import cv2
import numpy as np


def raster_fill(config):
    """
    Flood-fill based room detection on a rasterized page image.

    1. Load image, preprocess to binary (walls=black, rooms=white)
    2. Burn user-drawn barrier lines onto binary image
    3. Flood fill from seed point
    4. Extract contour, simplify to polygon
    """
    image_path = config["image_path"]
    seed_x = float(config["seed_x"])
    seed_y = float(config["seed_y"])
    tolerance = int(config.get("tolerance", 30))
    dilate_px = int(config.get("dilate_px", 3))
    simplify_epsilon = float(config.get("simplify_epsilon", 0.005))
    barriers = config.get("barriers", [])

    img = cv2.imread(image_path, cv2.IMREAD_GRAYSCALE)
    if img is None:
        return {"type": "error", "error": f"Could not load image: {image_path}"}

    # Downscale large images for faster flood fill (coords are normalized 0-1)
    max_dim = int(config.get("max_dimension", 2000))
    h_orig, w_orig = img.shape[:2]
    if max_dim > 0 and max(h_orig, w_orig) > max_dim:
        factor = max_dim / max(h_orig, w_orig)
        img = cv2.resize(img, None, fx=factor, fy=factor, interpolation=cv2.INTER_AREA)
        print(f"raster: downscaled {w_orig}x{h_orig} -> {img.shape[1]}x{img.shape[0]}", file=sys.stderr)

    h, w = img.shape

    sx = int(seed_x * w)
    sy = int(seed_y * h)
    if sx < 0 or sx >= w or sy < 0 or sy >= h:
        return {"type": "error", "error": "Seed point outside image bounds"}

    blurred = cv2.GaussianBlur(img, (5, 5), 0)
    binary = cv2.adaptiveThreshold(
        blurred, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY, 15, 4
    )

    if dilate_px > 0:
        kernel = np.ones((dilate_px, dilate_px), np.uint8)
        binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)

    # Burn barrier lines
    for barrier in barriers:
        bx1 = int(float(barrier["x1"]) * w)
        by1 = int(float(barrier["y1"]) * h)
        bx2 = int(float(barrier["x2"]) * w)
        by2 = int(float(barrier["y2"]) * h)
        cv2.line(binary, (bx1, by1), (bx2, by2), 0, thickness=3)

    # Burn existing area polygons as filled barriers (impassable regions)
    for poly in config.get("polygon_barriers", []):
        verts = poly.get("vertices", [])
        if len(verts) < 3:
            continue
        pts = np.array([(int(v["x"] * w), int(v["y"] * h)) for v in verts], dtype=np.int32)
        cv2.fillPoly(binary, [pts], 0)

    if binary[sy, sx] == 0:
        return {"type": "error", "error": "Seed point is on a wall or line, not inside a room"}

    # Flood fill
    flood_img = binary.copy()
    mask = np.zeros((h + 2, w + 2), np.uint8)
    cv2.floodFill(flood_img, mask, (sx, sy), 128,
                  loDiff=tolerance, upDiff=tolerance)

    filled = (flood_img == 128).astype(np.uint8) * 255

    contours, _ = cv2.findContours(filled, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return {"type": "error", "error": "No contiguous area found at seed point"}

    largest = max(contours, key=cv2.contourArea)
    area_px = cv2.contourArea(largest)
    total_px = w * h

    area_fraction = area_px / total_px
    if area_fraction > 0.40:
        return {"type": "error", "error": "Flood fill escaped room boundary (area > 40% of page). Try adding barrier lines or increasing dilate."}
    if area_fraction < 0.001:
        return {"type": "error", "error": "Area too small (< 0.1% of page). Try clicking closer to room center."}

    perimeter = cv2.arcLength(largest, True)
    epsilon = simplify_epsilon * perimeter
    simplified = cv2.approxPolyDP(largest, epsilon, True)

    vertices = [
        {"x": round(float(pt[0][0]) / w, 6), "y": round(float(pt[0][1]) / h, 6)}
        for pt in simplified
    ]

    return {
        "type": "result",
        "method": "raster",
        "vertices": vertices,
        "vertexCount": len(vertices),
        "areaFraction": round(area_fraction, 6),
    }


def main():
    config = json.load(sys.stdin)
    result = raster_fill(config)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
