#!/usr/bin/env python3
"""
Keynote extraction from blueprint page images.
Adapted from theta_old's extract_keynotes.py for blueprintparser_2.

Supports tiling for large images (>1200px) to prevent Tesseract OOM crashes.
800px tiles with 100px overlap, IOU-based deduplication.

Usage: python3 extract_keynotes.py <image_path>
Output: JSON array to stdout
"""
import sys
import json
import string
import cv2
import numpy as np

# pytesseract is optional — if unavailable, shape detection still works, OCR returns empty
try:
    import pytesseract
    # Explicit path for Alpine Linux containers where PATH may not include /usr/bin
    pytesseract.pytesseract.tesseract_cmd = '/usr/bin/tesseract'
    _HAVE_OCR = True
except ImportError:
    _HAVE_OCR = False
    print("[keynote] pytesseract not available — shape detection only, no OCR", file=sys.stderr)

kernel = np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]], dtype="uint8")

TILE_SIZE = 1200
TILE_OVERLAP = 150
IOU_DEDUP_THRESHOLD = 0.5
MIN_SIZE_FOR_TILING = 1500  # Don't tile images smaller than this
MAX_DIM_BEFORE_DOWNSCALE = 4000  # Downscale images larger than this


# ── Geometry helpers ─────────────────────────────────────────────

def rect_overlap(b1, b2):
    left1, down1, right1, up1 = b1
    left2, down2, right2, up2 = b2
    area_a = abs(right1 - left1) * abs(up1 - down1)
    area_b = abs(right2 - left2) * abs(up2 - down2)
    if min(area_a, area_b) == 0:
        return 0
    inter_width = max(0, min(right1, right2) - max(left1, left2))
    inter_height = max(0, min(up1, up2) - max(down1, down2))
    inter = inter_height * inter_width
    return inter / min(area_a, area_b)


def iou_normalized(box1, box2):
    """IOU for normalized [l, t, r, b] boxes."""
    inter_l = max(box1[0], box2[0])
    inter_t = max(box1[1], box2[1])
    inter_r = min(box1[2], box2[2])
    inter_b = min(box1[3], box2[3])
    if inter_r <= inter_l or inter_b <= inter_t:
        return 0.0
    inter_area = (inter_r - inter_l) * (inter_b - inter_t)
    area1 = (box1[2] - box1[0]) * (box1[3] - box1[1])
    area2 = (box2[2] - box2[0]) * (box2[3] - box2[1])
    if min(area1, area2) == 0:
        return 0.0
    return inter_area / min(area1, area2)


def boxes_intersect(b1, b2):
    """Check if two boxes (left, top, right, bottom) overlap."""
    return b1[0] < b2[2] and b1[2] > b2[0] and b1[1] < b2[3] and b1[3] > b2[1]


# ── Component filtering ─────────────────────────────────────────

def filter_components(img, aspect_range, width_range, height_range, invert=False):
    if not invert:
        img = (img == 0).astype("uint8") * 255
    else:
        img = (img != 0).astype("uint8") * 255

    results = []
    n, mask, stats, centroids = cv2.connectedComponentsWithStats(img)

    for i in range(1, n):
        left, top, width, height, area = stats[i]
        if height == 0:
            continue
        aspect = width / height
        if aspect < aspect_range[0] or aspect > aspect_range[1]:
            continue
        if width_range[0] is not None and width < width_range[0]:
            continue
        if width_range[1] is not None and width > width_range[1]:
            continue
        if height_range[0] is not None and height < height_range[0]:
            continue
        if height_range[1] is not None and height > height_range[1]:
            continue
        results.append([left, top, width, height, area, centroids[i]])

    return mask, results


def valid_keynote_candidate(keynote_box, text_boxes):
    """
    Theta's proven parameters: text must be fully inside shape,
    vertically centered within 20% of shape height, at least 20% of shape height tall.
    """
    left, top, right, bottom = keynote_box
    for t_left, t_top, t_right, t_bottom in text_boxes:
        if not boxes_intersect(keynote_box, (t_left, t_top, t_right, t_bottom)):
            continue
        # Text must be fully contained (strictly inside)
        if t_left <= left or t_top <= top or t_right >= right or t_bottom >= bottom:
            continue
        text_center = (t_bottom + t_top) / 2
        keynote_center = (bottom + top) / 2
        keynote_height = bottom - top
        text_height = t_bottom - t_top
        # Text must be vertically centered within 20% of shape height (theta: 0.20)
        if abs(text_center - keynote_center) > 0.20 * keynote_height:
            continue
        # Text must be at least 20% of shape height (theta: 0.20)
        if text_height < 0.20 * keynote_height:
            continue
        return True
    return False


def filter_keynote_candidates(keynotes, text):
    text_boxes = []
    for left, top, width, height, area, center in text:
        text_boxes.append((left, top, left + width, top + height))

    keynote_boxes = []
    to_remove = set()

    for i, (left, top, width, height, area, center) in enumerate(keynotes):
        keynote_box = (left, top, left + width, top + height)

        if not valid_keynote_candidate(keynote_box, text_boxes):
            to_remove.add(i)
            keynote_boxes.append(keynote_box)
            continue

        delete_this = False
        for j, prev_box in enumerate(keynote_boxes):
            if j in to_remove:
                continue
            if rect_overlap(keynote_box, prev_box) < 0.95:
                continue
            other_area = keynotes[j][-2]
            if other_area > area:
                to_remove.add(j)
            else:
                delete_this = True
                break

        if delete_this:
            to_remove.add(i)

        keynote_boxes.append(keynote_box)

    return [data for i, data in enumerate(keynotes) if i not in to_remove]


# ── Shape & text extraction ──────────────────────────────────────

def largest_cc(img):
    result = np.zeros_like(img, dtype="uint8")
    n, cc_mask, stats, centroids = cv2.connectedComponentsWithStats(img)
    if n <= 1:
        return result, np.array([])
    largest = 1 + np.argmax(stats[1:, 4])
    largest_mask = (cc_mask == largest).astype("uint8")
    contours, _ = cv2.findContours(largest_mask, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return result, np.array([])
    hull = cv2.convexHull(contours[0])
    hull_cnt = hull.reshape(-1, 2)
    cv2.drawContours(result, [hull_cnt], 0, 255, -1)
    return result, hull_cnt


def detect_shape(contour):
    if len(contour) == 0:
        return "circle"
    contour_2d = contour.reshape(-1, 1, 2) if contour.ndim == 2 else contour
    contour_2d = cv2.approxPolyDP(contour_2d, 0.01 * cv2.arcLength(contour_2d, True), True)
    (x, y, w, h) = cv2.boundingRect(contour_2d)
    if h == 0:
        return "circle"
    ar = w / float(h)

    n = len(contour_2d)
    if n == 3:
        return "triangle"
    if n == 4:
        if 0.9 <= ar <= 1.1:
            cx = x + w / 2
            mx, _ = np.abs(contour_2d.reshape(-1, 2) - [cx, 0]).min(axis=0)
            if mx < 0.1 * w:
                return "diamond"
            else:
                return "square"
        else:
            return "rectangle"
    if n == 5:
        return "pentagon"
    if n == 6:
        return "hexagon"
    if n in [7, 8, 9]:
        return "half-circle" if ar <= 2.5 else "pill"
    return "circle" if 0.95 <= ar <= 1.05 else "oval"


def extract_text(img, psm=8):
    if not _HAVE_OCR:
        return ""
    img = cv2.blur(img, (3, 3))
    whitelist = string.ascii_letters + string.digits + "()$#-"
    txt = pytesseract.image_to_string(
        img, config="--psm %i -c tessedit_char_whitelist=%s" % (psm, whitelist)
    )
    txt = txt.replace("\u2014", "-").strip()
    return txt


def remove_single_line(img):
    blur = cv2.blur(img, (3, 3))
    _, img2 = cv2.threshold(blur, 140, 255, cv2.THRESH_BINARY)
    return img2


def clean_img(img):
    # Theta's proven preprocessing: threshold + distance transform + erode thin lines
    img = cv2.threshold(img, 50, 255, cv2.THRESH_BINARY)[1]
    dist_transform = cv2.distanceTransform(255 - img, cv2.DIST_L2, 3)
    img = 255 - ((dist_transform > 1.0).astype("uint8") * 255)
    return img


def clean_img_text(img, p=8):
    _, img = cv2.threshold(img, 50, 255, cv2.THRESH_BINARY)
    img = remove_single_line(img)
    candidate_text = filter_components(
        img, (0.1, 2), (None, img.shape[1] * 0.9), (15, img.shape[0] * 0.9)
    )[1]

    if len(candidate_text) == 0:
        return img

    left = min(r[0] for r in candidate_text)
    top = min(r[1] for r in candidate_text)
    right = max(r[0] + r[2] for r in candidate_text)
    bottom = max(r[1] + r[3] for r in candidate_text)
    img = img[top:bottom, left:right]
    img = np.pad(img, p, mode="constant", constant_values=(255, 255))
    return img


def shrink_region(img):
    img[0] = 0
    img[-1] = 0
    img[:, 0] = 0
    img[:, -1] = 0
    img = cv2.erode(img, kernel, iterations=1)
    return img


# ── Tiling ───────────────────────────────────────────────────────

def generate_tiles(h, w, tile_size=TILE_SIZE, overlap=TILE_OVERLAP):
    """Generate tile coordinates with overlap. Returns list of (y, x, th, tw)."""
    step = tile_size - overlap
    tiles = []
    y = 0
    while y < h:
        x = 0
        th = min(tile_size, h - y)
        while x < w:
            tw = min(tile_size, w - x)
            tiles.append((y, x, th, tw))
            x += step
            if x + overlap >= w:
                break
        y += step
        if y + overlap >= h:
            break
    return tiles


def remap_result(result, offset_x, offset_y, tile_w, tile_h, full_w, full_h):
    """Remap a single result from tile-normalized coords to full-page-normalized coords."""
    l, t, r, b = result["bbox"]
    result["bbox"] = [
        (l * tile_w + offset_x) / full_w,
        (t * tile_h + offset_y) / full_h,
        (r * tile_w + offset_x) / full_w,
        (b * tile_h + offset_y) / full_h,
    ]
    if result.get("contour"):
        result["contour"] = [
            [
                (p[0] * tile_w + offset_x) / full_w,
                (p[1] * tile_h + offset_y) / full_h,
            ]
            for p in result["contour"]
        ]
    return result


def deduplicate(results, threshold=IOU_DEDUP_THRESHOLD):
    """Remove duplicate keynotes from overlapping tiles using IOU."""
    if len(results) <= 1:
        return results

    keep = [True] * len(results)
    for i in range(len(results)):
        if not keep[i]:
            continue
        for j in range(i + 1, len(results)):
            if not keep[j]:
                continue
            overlap = iou_normalized(results[i]["bbox"], results[j]["bbox"])
            if overlap > threshold:
                # Keep the one with more text (likely better OCR result)
                if len(results[j].get("text", "")) > len(results[i].get("text", "")):
                    keep[i] = False
                    break
                else:
                    keep[j] = False

    return [r for r, k in zip(results, keep) if k]


# ── Per-tile extraction (core logic) ────────────────────────────

def extract_from_image(img, skip_ocr=False):
    """
    Run keynote extraction on a single image (tile or full page).
    Returns list of result dicts with tile-local normalized coords.
    When skip_ocr=True, skips Tesseract OCR (the crash-prone step) and returns empty text.
    """
    h, w = img.shape
    img_cleaned = clean_img(img)

    # Theta's proven candidate filters:
    # - Text: loose aspect (0.1-2), any size
    # - Keynotes: tight aspect (0.9-4), size 20-200px (matches real architectural symbols)
    candidate_text = filter_components(
        img_cleaned, (0.1, 2), (None, None), (None, None)
    )[1]
    candidate_keynotes = filter_components(
        img_cleaned, (0.9, 4), (20, 200), (20, 200), invert=True
    )[1]

    selected_keynotes = filter_keynote_candidates(candidate_keynotes, candidate_text)

    if not selected_keynotes:
        del img_cleaned
        return []

    # Get contour and shape for each keynote region
    results = []
    for left, top, kw, kh, _, _ in selected_keynotes:
        region_cleaned = img_cleaned[top : top + kh, left : left + kw]
        _, contour_pts = largest_cc(region_cleaned)
        shape = detect_shape(contour_pts)

        # OCR (optional — skip for tiled mode to avoid crashes)
        text = ""
        if not skip_ocr:
            try:
                region_img = img[top : top + kh, left : left + kw]
                mask, _ = largest_cc(region_cleaned)
                mask = shrink_region(mask)
                content = 255 - cv2.bitwise_and(mask, 255 - region_img)
                content_clean = clean_img_text(content)
                text = extract_text(content_clean)
            except Exception:
                pass

        contour = []
        if len(contour_pts) > 0:
            contour = [
                [(float(p[0]) + left) / w, (float(p[1]) + top) / h]
                for p in contour_pts.tolist()
            ]

        results.append({
            "shape": shape,
            "bbox": [left / w, top / h, (left + kw) / w, (top + kh) / h],
            "contour": contour,
            "text": text,
        })

    del img_cleaned
    return results


# ── Main entry point ─────────────────────────────────────────────

def main(img_path):
    import gc

    img = cv2.imread(img_path, 0)
    if img is None:
        return []

    h, w = img.shape
    print(f"[keynote] Image: {w}x{h}", file=sys.stderr)

    # Downscale very large images (like old Theta's 4x reduction)
    scale_factor = 1.0
    if max(w, h) > MAX_DIM_BEFORE_DOWNSCALE:
        scale_factor = MAX_DIM_BEFORE_DOWNSCALE / max(w, h)
        new_w = int(w * scale_factor)
        new_h = int(h * scale_factor)
        img = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)
        h, w = img.shape
        print(f"[keynote] Downscaled to {w}x{h} (factor {scale_factor:.2f})", file=sys.stderr)

    # Small images: process directly without tiling
    if w <= MIN_SIZE_FOR_TILING and h <= MIN_SIZE_FOR_TILING:
        print(f"[keynote] Small image, no tiling needed", file=sys.stderr)
        results = extract_from_image(img, skip_ocr=False)
        print(f"[keynote] Returning {len(results)} keynotes", file=sys.stderr)
        return results

    # Large images: tile and merge. Run OCR per-shape inside each tile —
    # per-shape OCR is fast (shapes are 20-200px), only whole-image OCR is problematic.
    tiles = generate_tiles(h, w)
    num_tiles = len(tiles)
    print(f"[keynote] Tiling: {num_tiles} tiles ({TILE_SIZE}px, {TILE_OVERLAP}px overlap)", file=sys.stderr)

    all_results = []
    for ti, (ty, tx, th, tw) in enumerate(tiles):
        tile_img = img[ty : ty + th, tx : tx + tw].copy()  # copy to avoid holding ref to full image
        tile_results = extract_from_image(tile_img, skip_ocr=False)
        del tile_img

        if tile_results:
            for r in tile_results:
                remap_result(r, tx, ty, tw, th, w, h)
            all_results.extend(tile_results)
            print(f"[keynote] Tile {ti}: {len(tile_results)} keynotes", file=sys.stderr)

        # Free memory every 10 tiles
        if ti % 10 == 9:
            gc.collect()

    print(f"[keynote] Total before dedup: {len(all_results)}", file=sys.stderr)

    results = deduplicate(all_results)
    print(f"[keynote] After dedup: {len(results)} keynotes", file=sys.stderr)

    return results


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 extract_keynotes.py <image_path>", file=sys.stderr)
        sys.exit(1)

    try:
        results = main(sys.argv[1])
        warnings = []
        if not _HAVE_OCR:
            warnings.append("Tesseract not installed — shapes detected but text will be empty")
        print(json.dumps({"results": results, "warnings": warnings}))
    except Exception as e:
        import traceback
        print(f"[keynote] FATAL: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"results": [], "warnings": [f"Extraction failed: {e}"]}))
