#!/usr/bin/env python3
"""
bucket_fill.py — Paint-bucket room detection for surface area takeoff.

Two modes (auto-detected):
  - Vector: extract PDF line segments with pdfplumber, build planar graph
    with networkx, find minimal enclosing face around seed point.
  - Raster: OpenCV flood fill on rasterized page image.

Barrier lines (user-drawn to seal doorways) work in both modes:
  - Vector: injected as extra edges in the planar graph
  - Raster: burned onto binary image as wall pixels

Input: JSON config via stdin
Output: JSON result to stdout
"""

import sys
import json
import cv2
import numpy as np

SNAP_DIGITS = 4  # round coordinates to 4 decimals (~0.06pt precision)
MIN_EDGE_LENGTH = 0.005  # ignore edges shorter than 0.5% of page dimension
VECTOR_EDGE_THRESHOLD = 50  # minimum edges to attempt vector mode


# ─── Vector mode ──────────────────────────────────────────────

def snap_pt(x, y):
    return (round(x, SNAP_DIGITS), round(y, SNAP_DIGITS))


def segments_intersect(p1, p2, p3, p4):
    """Find intersection point of two line segments, or None."""
    x1, y1 = p1; x2, y2 = p2; x3, y3 = p3; x4, y4 = p4
    denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
    if abs(denom) < 1e-10:
        return None  # parallel or coincident
    t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom
    u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom
    eps = 1e-6
    if -eps <= t <= 1 + eps and -eps <= u <= 1 + eps:
        return snap_pt(x1 + t * (x2 - x1), y1 + t * (y2 - y1))
    return None


def split_edges_at_intersections(segments):
    """Find all intersection points between segments and split at those points."""
    n = len(segments)
    split_points = [[] for _ in range(n)]

    for i in range(n):
        for j in range(i + 1, n):
            pt = segments_intersect(
                segments[i][0], segments[i][1],
                segments[j][0], segments[j][1],
            )
            if pt is not None:
                split_points[i].append(pt)
                split_points[j].append(pt)

    new_segments = []
    for i, (p1, p2) in enumerate(segments):
        sp1, sp2 = snap_pt(*p1), snap_pt(*p2)
        pts = [sp1] + sorted(
            set(split_points[i]),
            key=lambda p: (p[0] - p1[0]) ** 2 + (p[1] - p1[1]) ** 2,
        ) + [sp2]
        # Deduplicate consecutive identical points
        deduped = [pts[0]]
        for p in pts[1:]:
            if p != deduped[-1]:
                deduped.append(p)
        for k in range(len(deduped) - 1):
            new_segments.append((deduped[k], deduped[k + 1]))

    return new_segments


def point_in_polygon(px, py, polygon):
    """Ray casting point-in-polygon test."""
    n = len(polygon)
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        if ((yi > py) != (yj > py)) and (px < (xj - xi) * (py - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def polygon_area(verts):
    """Shoelace formula for polygon area."""
    n = len(verts)
    area = 0
    for i in range(n):
        x1, y1 = verts[i]
        x2, y2 = verts[(i + 1) % n]
        area += x1 * y2 - x2 * y1
    return abs(area) / 2


def vector_fill(config):
    """
    Vector-based room detection using PDF line segments.

    1. Extract edges from PDF with pdfplumber
    2. Add barrier lines as extra edges
    3. Split all edges at intersection points (handles T-junctions)
    4. Build networkx planar graph
    5. Traverse faces of the planar embedding
    6. Find smallest face containing the seed point
    """
    import pdfplumber
    import networkx as nx

    pdf_path = config.get("pdf_path")
    page_number = int(config.get("page_number", 1))
    seed_x = float(config["seed_x"])
    seed_y = float(config["seed_y"])
    barriers = config.get("barriers", [])

    if not pdf_path:
        return None  # no PDF path, fall back to raster

    try:
        pdf = pdfplumber.open(pdf_path)
    except Exception:
        return None

    try:
        if page_number > len(pdf.pages):
            return None
        page = pdf.pages[page_number - 1]
        pw, ph = float(page.width), float(page.height)

        # Extract edges, normalized to 0-1 (pdfplumber uses top-left origin)
        raw_segments = []
        for e in page.edges:
            p1 = (e["x0"] / pw, e["top"] / ph)
            p2 = (e["x1"] / pw, e["bottom"] / ph)
            # Filter very short edges (noise)
            dx, dy = abs(p2[0] - p1[0]), abs(p2[1] - p1[1])
            if dx < MIN_EDGE_LENGTH and dy < MIN_EDGE_LENGTH:
                continue
            raw_segments.append((p1, p2))

        edge_count = len(raw_segments)
        threshold = int(config.get("vector_edge_threshold", VECTOR_EDGE_THRESHOLD))
        if edge_count < threshold:
            return None  # not enough vector content, fall back to raster

        print(f"vector: {edge_count} edges on page {page_number}", file=sys.stderr)

        # Add barrier lines as extra segments
        for b in barriers:
            p1 = (float(b["x1"]), float(b["y1"]))
            p2 = (float(b["x2"]), float(b["y2"]))
            raw_segments.append((p1, p2))

        # Split at intersections (critical for T-junctions)
        segments = split_edges_at_intersections(raw_segments)

        # Build graph
        G = nx.Graph()
        for p1, p2 in segments:
            sp1, sp2 = snap_pt(*p1), snap_pt(*p2)
            if sp1 != sp2:
                G.add_edge(sp1, sp2)

        if G.number_of_edges() < 3:
            return None

        # Check planarity
        is_planar, embedding = nx.check_planarity(G)
        if not is_planar:
            print("vector: graph not planar, falling back to raster", file=sys.stderr)
            return None

        # Traverse all faces of the planar embedding
        faces = []
        visited_half_edges = set()
        for v in embedding:
            for w in embedding.neighbors_cw_order(v):
                if (v, w) in visited_half_edges:
                    continue
                face = []
                curr_v, curr_w = v, w
                while (curr_v, curr_w) not in visited_half_edges:
                    visited_half_edges.add((curr_v, curr_w))
                    face.append(curr_v)
                    curr_v, curr_w = embedding.next_face_half_edge(curr_v, curr_w)
                if len(face) >= 3:
                    faces.append(face)

        if not faces:
            return None

        # Find faces containing the seed point, pick smallest
        seed = snap_pt(seed_x, seed_y)
        matching = []
        for face in faces:
            area = polygon_area(face)
            if point_in_polygon(seed[0], seed[1], face):
                matching.append((area, face))

        if not matching:
            print("vector: seed point not inside any face", file=sys.stderr)
            return None

        # Pick smallest face (excludes the infinite outer face)
        best_area, best_face = min(matching, key=lambda x: x[0])

        # Reject if face is > 50% of page (likely the outer/infinite face)
        if best_area > 0.50:
            print(f"vector: best face too large ({best_area:.3f}), likely outer face", file=sys.stderr)
            return None

        vertices = [{"x": round(v[0], 6), "y": round(v[1], 6)} for v in best_face]

        return {
            "type": "result",
            "method": "vector",
            "vertices": vertices,
            "vertexCount": len(vertices),
            "areaFraction": round(best_area, 6),
            "edgesOnPage": edge_count,
        }

    except Exception as e:
        print(f"vector: error: {e}", file=sys.stderr)
        return None
    finally:
        pdf.close()


# ─── Raster mode ──────────────────────────────────────────────

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

    h, w = img.shape

    sx = int(seed_x * w)
    sy = int(seed_y * h)
    if sx < 0 or sx >= w or sy < 0 or sy >= h:
        return {"type": "error", "error": "Seed point outside image bounds"}

    # Pre-process
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


# ─── Main: auto-detect vector vs raster ──────────────────────

def main():
    config = json.load(sys.stdin)

    # Try vector mode first (if PDF path provided)
    result = vector_fill(config)

    # Fall back to raster
    if result is None:
        result = raster_fill(config)

    print(json.dumps(result))


if __name__ == "__main__":
    main()
