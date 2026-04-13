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
    4. Extract contours with RETR_CCOMP so holes (courtyards inside rooms,
       enclosed areas inside hallways) are preserved as child contours.
    5. Compute net area = outer area - sum(hole areas) and use THAT for the
       leak-threshold check. Previously RETR_EXTERNAL discarded holes, so the
       outer contour of a U-shaped hallway wrapped around its courtyard as
       if the hole didn't exist — overstating area and including the
       enclosed region in the returned polygon.
    6. Return holes as separate metadata so the preview can render them.
    """
    image_path = config["image_path"]
    seed_x = float(config["seed_x"])
    seed_y = float(config["seed_y"])
    tolerance = int(config.get("tolerance", 30))
    dilate_px = int(config.get("dilate_px", 3))
    simplify_epsilon = float(config.get("simplify_epsilon", 0.005))
    # leak_threshold: max accepted net area as a fraction of the page.
    # Default matches the client worker's retry threshold so the two paths
    # agree. Previously this was hardcoded at 0.40 (server) while the worker
    # used 0.25 — two different behaviors for the same user action. The
    # user-facing slider now controls both.
    leak_threshold = float(config.get("leak_threshold", 0.25))
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

    # RETR_CCOMP returns a 2-level hierarchy: outer contours at level 0,
    # their holes at level 1. hierarchy[0][i] = [next, prev, first_child, parent].
    # parent == -1 means top-level (outer); parent != -1 means hole.
    contours, hierarchy = cv2.findContours(filled, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    if not contours or hierarchy is None:
        return {"type": "error", "error": "No contiguous area found at seed point"}

    hier = hierarchy[0]

    # Pick the largest top-level contour. With flood fill there's usually only
    # one connected component, but guard against stray specks with area > 0.
    outer_idx = -1
    outer_area_px = 0.0
    for i, h_entry in enumerate(hier):
        if h_entry[3] == -1:  # top-level
            a = cv2.contourArea(contours[i])
            if a > outer_area_px:
                outer_area_px = a
                outer_idx = i

    if outer_idx < 0:
        return {"type": "error", "error": "No outer contour found"}

    outer = contours[outer_idx]
    total_px = w * h

    # Walk the hole chain for the chosen outer contour.
    holes_data = []
    hole_area_px = 0.0
    child_idx = hier[outer_idx][2]  # first_child, or -1 if no holes
    while child_idx >= 0:
        hc = contours[child_idx]
        ha = cv2.contourArea(hc)
        # Skip degenerate holes (zero area from quantization).
        if ha > 0:
            hole_area_px += ha
            h_perim = cv2.arcLength(hc, True)
            h_eps = simplify_epsilon * h_perim
            h_simp = cv2.approxPolyDP(hc, h_eps, True)
            holes_data.append({
                "vertices": [
                    {"x": round(float(pt[0][0]) / w, 6), "y": round(float(pt[0][1]) / h, 6)}
                    for pt in h_simp
                ],
                "areaFraction": round(ha / total_px, 6),
            })
        child_idx = hier[child_idx][0]  # next sibling

    # Net area subtracts holes so a hallway wrapping a courtyard reports the
    # actual hallway area, not the bounding-region area. This is also what the
    # leak-threshold check uses so the user doesn't get false-positive "leak"
    # errors on rooms with legitimate interior enclosed regions.
    net_area_px = max(0.0, outer_area_px - hole_area_px)
    area_fraction = net_area_px / total_px

    if area_fraction > leak_threshold:
        pct = int(round(leak_threshold * 100))
        return {
            "type": "error",
            "error": f"Flood fill escaped room boundary (area > {pct}% of page). Try adding barrier lines, increasing dilation, or raising the Leak Threshold slider.",
        }
    if area_fraction < 0.001:
        return {"type": "error", "error": "Area too small (< 0.1% of page). Try clicking closer to room center."}

    perimeter = cv2.arcLength(outer, True)
    epsilon = simplify_epsilon * perimeter
    simplified = cv2.approxPolyDP(outer, epsilon, True)

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
        "holes": holes_data,
        "holeCount": len(holes_data),
    }


def main():
    config = json.load(sys.stdin)
    result = raster_fill(config)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
