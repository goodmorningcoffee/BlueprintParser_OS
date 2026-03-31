#!/usr/bin/env python3
"""
template_match.py — Generic two-tier template matching engine.

Reusable engine: knows HOW to match, not WHAT is being matched.
Consumers (symbol search, schedule tag map, auto-QTO) provide the what.

Tier 1: cv2.matchTemplate (multi-scale) — fast, no rotation support
Tier 2: SIFT + FLANN + RANSAC (fallback) — slower, rotation/scale invariant

Input: JSON config via stdin
Output: NDJSON to stdout (one progress line per target, final results)
"""

import sys
import json
import cv2
import numpy as np
import gc


def nms_boxes(boxes, iou_threshold=0.3):
    """Non-max suppression on list of (x, y, w, h, confidence, method, scale) tuples."""
    if not boxes:
        return []

    arr = np.array([[b[0], b[1], b[0] + b[2], b[1] + b[3], b[4]] for b in boxes])
    x1, y1, x2, y2, scores = arr[:, 0], arr[:, 1], arr[:, 2], arr[:, 3], arr[:, 4]
    areas = (x2 - x1) * (y2 - y1)
    order = scores.argsort()[::-1]

    keep = []
    while order.size > 0:
        i = order[0]
        keep.append(i)
        if order.size == 1:
            break

        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])

        inter = np.maximum(0, xx2 - xx1) * np.maximum(0, yy2 - yy1)
        iou = inter / (areas[i] + areas[order[1:]] - inter + 1e-8)

        inds = np.where(iou <= iou_threshold)[0]
        order = order[inds + 1]

    return [boxes[i] for i in keep]


def tier1_match_template(template_gray, target_gray, scales, threshold):
    """Tier 1: Multi-scale cv2.matchTemplate with TM_CCOEFF_NORMED."""
    th, tw = template_gray.shape[:2]
    tgt_h, tgt_w = target_gray.shape[:2]
    hits = []

    for scale in scales:
        stw = max(1, int(tw * scale))
        sth = max(1, int(th * scale))

        # Skip if scaled template is larger than target
        if stw >= tgt_w or sth >= tgt_h:
            continue

        scaled = cv2.resize(template_gray, (stw, sth), interpolation=cv2.INTER_AREA)
        result = cv2.matchTemplate(target_gray, scaled, cv2.TM_CCOEFF_NORMED)

        locs = np.where(result >= threshold)
        for pt_y, pt_x in zip(*locs):
            conf = float(result[pt_y, pt_x])
            # Normalize to 0-1 coordinates
            nx = pt_x / tgt_w
            ny = pt_y / tgt_h
            nw = stw / tgt_w
            nh = sth / tgt_h
            hits.append((nx, ny, nw, nh, conf, "template", scale))

    return hits


def tier2_sift_match(template_gray, target_gray):
    """Tier 2: SIFT + FLANN + RANSAC for rotation/scale invariant matching."""
    sift = cv2.SIFT_create()

    kp1, des1 = sift.detectAndCompute(template_gray, None)
    kp2, des2 = sift.detectAndCompute(target_gray, None)

    if des1 is None or des2 is None or len(kp1) < 4 or len(kp2) < 4:
        return []

    # FLANN matcher
    index_params = dict(algorithm=1, trees=5)  # FLANN_INDEX_KDTREE
    search_params = dict(checks=50)
    flann = cv2.FlannBasedMatcher(index_params, search_params)

    try:
        matches = flann.knnMatch(des1, des2, k=2)
    except cv2.error:
        return []

    # Lowe's ratio test
    good = []
    for m_pair in matches:
        if len(m_pair) == 2:
            m, n = m_pair
            if m.distance < 0.7 * n.distance:
                good.append(m)

    if len(good) < 4:
        return []

    src_pts = np.float32([kp1[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
    dst_pts = np.float32([kp2[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)

    # RANSAC homography
    M, mask = cv2.findHomography(src_pts, dst_pts, cv2.RANSAC, 5.0)
    if M is None:
        return []

    inliers = int(mask.sum())
    if inliers < 4:
        return []

    # Transform template corners to find matched region
    th, tw = template_gray.shape[:2]
    tgt_h, tgt_w = target_gray.shape[:2]

    corners = np.float32([[0, 0], [tw, 0], [tw, th], [0, th]]).reshape(-1, 1, 2)
    transformed = cv2.perspectiveTransform(corners, M)
    pts = transformed.reshape(4, 2)

    # Get bounding box from transformed corners
    x_min, y_min = pts.min(axis=0)
    x_max, y_max = pts.max(axis=0)

    # Validate: bounding box should be reasonable
    w = x_max - x_min
    h = y_max - y_min
    if w <= 0 or h <= 0 or w > tgt_w * 0.5 or h > tgt_h * 0.5:
        return []

    # Confidence from inlier ratio
    conf = min(0.95, inliers / len(good))

    # Normalize to 0-1
    nx = float(x_min / tgt_w)
    ny = float(y_min / tgt_h)
    nw = float(w / tgt_w)
    nh = float(h / tgt_h)

    # Clamp to valid range
    nx = max(0.0, min(1.0, nx))
    ny = max(0.0, min(1.0, ny))
    nw = max(0.0, min(1.0 - nx, nw))
    nh = max(0.0, min(1.0 - ny, nh))

    return [(nx, ny, nw, nh, conf, "sift", 1.0)]


def process_target(template_gray, target_path, config):
    """Process a single target image against the template."""
    target = cv2.imread(target_path, cv2.IMREAD_GRAYSCALE)
    if target is None:
        print(f"[template_match] Failed to load: {target_path}", file=sys.stderr)
        return []

    threshold = config.get("confidence_threshold", 0.75)
    multi_scale = config.get("multi_scale", True)
    scales = config.get("scales", [0.9, 0.95, 1.0, 1.05, 1.1])
    use_sift = config.get("use_sift_fallback", True)
    sift_threshold = config.get("sift_fallback_threshold", 3)
    nms_iou = config.get("nms_iou_threshold", 0.3)
    max_matches = config.get("max_matches_per_page", 100)

    if not multi_scale:
        scales = [1.0]

    # Tier 1: matchTemplate
    hits = tier1_match_template(template_gray, target, scales, threshold)
    hits = nms_boxes(hits, nms_iou)

    # Tier 2: SIFT fallback if too few hits
    if use_sift and len(hits) < sift_threshold:
        try:
            sift_hits = tier2_sift_match(template_gray, target)
            if sift_hits:
                # Merge and deduplicate
                all_hits = hits + sift_hits
                hits = nms_boxes(all_hits, nms_iou)
        except Exception as e:
            print(f"[template_match] SIFT fallback failed (opencv-contrib may not be installed): {e}", file=sys.stderr)

    # Cap matches
    if len(hits) > max_matches:
        hits.sort(key=lambda h: h[4], reverse=True)
        hits = hits[:max_matches]

    return hits


def run_search(config):
    """Mode: search — find all instances of template across multiple targets."""
    template_path = config["template_path"]
    target_paths = config["target_paths"]

    template = cv2.imread(template_path, cv2.IMREAD_GRAYSCALE)
    if template is None:
        print(json.dumps({"type": "error", "message": f"Failed to load template: {template_path}"}),
              flush=True)
        return

    print(f"[template_match] Template size: {template.shape[1]}x{template.shape[0]}", file=sys.stderr)
    print(f"[template_match] Searching {len(target_paths)} targets", file=sys.stderr)

    all_results = []

    for idx, tpath in enumerate(target_paths):
        hits = process_target(template, tpath, config)

        # Stream progress
        progress = {
            "type": "progress",
            "target_index": idx,
            "target_path": tpath,
            "matches": len(hits),
        }
        print(json.dumps(progress), flush=True)

        for h in hits:
            all_results.append({
                "target_index": idx,
                "bbox": [round(h[0], 6), round(h[1], 6), round(h[2], 6), round(h[3], 6)],
                "confidence": round(h[4], 4),
                "method": h[5],
                "scale": round(h[6], 3),
            })

        # Free memory between pages
        gc.collect()

    done = {
        "type": "done",
        "total_matches": len(all_results),
        "results": all_results,
    }
    print(json.dumps(done), flush=True)


def run_match_one(config):
    """Mode: match_one — check if template exists in ONE target, return best match."""
    template_path = config["template_path"]
    target_paths = config["target_paths"]

    if not target_paths:
        print(json.dumps({"type": "done", "total_matches": 0, "results": []}), flush=True)
        return

    template = cv2.imread(template_path, cv2.IMREAD_GRAYSCALE)
    if template is None:
        print(json.dumps({"type": "error", "message": f"Failed to load template: {template_path}"}),
              flush=True)
        return

    tpath = target_paths[0]
    hits = process_target(template, tpath, config)

    # Return only the best match
    if hits:
        hits.sort(key=lambda h: h[4], reverse=True)
        best = hits[0]
        result = {
            "target_index": 0,
            "bbox": [round(best[0], 6), round(best[1], 6), round(best[2], 6), round(best[3], 6)],
            "confidence": round(best[4], 4),
            "method": best[5],
            "scale": round(best[6], 3),
        }
        print(json.dumps({"type": "done", "total_matches": 1, "results": [result]}), flush=True)
    else:
        print(json.dumps({"type": "done", "total_matches": 0, "results": []}), flush=True)


def run_batch(config):
    """Mode: batch — multiple templates against multiple targets.

    Expects config.template_paths (plural) instead of template_path.
    Returns results tagged with template_index.
    """
    template_paths = config.get("template_paths", [])
    target_paths = config["target_paths"]

    if not template_paths:
        # Fallback: single template_path used as the only template
        tp = config.get("template_path")
        if tp:
            template_paths = [tp]
        else:
            print(json.dumps({"type": "error", "message": "No templates provided"}), flush=True)
            return

    all_results = []
    total_targets = len(target_paths)

    for t_idx, tpl_path in enumerate(template_paths):
        template = cv2.imread(tpl_path, cv2.IMREAD_GRAYSCALE)
        if template is None:
            print(f"[template_match] Failed to load template {t_idx}: {tpl_path}", file=sys.stderr)
            continue

        for idx, tpath in enumerate(target_paths):
            hits = process_target(template, tpath, config)

            progress = {
                "type": "progress",
                "template_index": t_idx,
                "target_index": idx,
                "target_path": tpath,
                "matches": len(hits),
            }
            print(json.dumps(progress), flush=True)

            for h in hits:
                all_results.append({
                    "template_index": t_idx,
                    "target_index": idx,
                    "bbox": [round(h[0], 6), round(h[1], 6), round(h[2], 6), round(h[3], 6)],
                    "confidence": round(h[4], 4),
                    "method": h[5],
                    "scale": round(h[6], 3),
                })

            gc.collect()

    done = {
        "type": "done",
        "total_matches": len(all_results),
        "results": all_results,
    }
    print(json.dumps(done), flush=True)


if __name__ == "__main__":
    # Read config from stdin
    raw = sys.stdin.read()
    try:
        config = json.loads(raw)
    except json.JSONDecodeError as e:
        print(json.dumps({"type": "error", "message": f"Invalid JSON input: {e}"}), flush=True)
        sys.exit(1)

    mode = config.get("mode", "search")
    print(f"[template_match] Mode: {mode}", file=sys.stderr)

    if mode == "search":
        run_search(config)
    elif mode == "match_one":
        run_match_one(config)
    elif mode == "batch":
        run_batch(config)
    else:
        print(json.dumps({"type": "error", "message": f"Unknown mode: {mode}"}), flush=True)
        sys.exit(1)
