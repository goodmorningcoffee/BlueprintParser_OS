# Bucket Fill — Paint-Bucket Tool for Surface Area Takeoff

## Status: Planning
## Date: April 6, 2026

---

## Problem
Tracing room polygons manually is the slowest part of surface-area takeoff. Each room requires 8-20 clicks to close a polygon. A 50-room floor plan takes 30+ minutes of clicking.

## Solution
Paint-bucket flood-fill: user clicks inside a room, OpenCV floods the contiguous area bounded by walls, returns a simplified polygon. "80% works great, 20% needs manual" — that's a 5-10x speedup on most plans.

---

## Architecture

### New Python Script: `scripts/flood_fill.py` (~60 LOC)

**Input (JSON via stdin):**
```json
{
  "image_path": "/tmp/page_0005.png",
  "seed_x": 850,
  "seed_y": 620,
  "tolerance": 30,
  "dilate_px": 3,
  "simplify_epsilon": 0.005,
  "page_width": 1700,
  "page_height": 2200
}
```

**Algorithm:**
```python
import cv2, numpy as np, json, sys

config = json.load(sys.stdin)
img = cv2.imread(config["image_path"], cv2.IMREAD_GRAYSCALE)

# 1. Pre-process: threshold to binary (walls = black, rooms = white)
_, binary = cv2.threshold(img, 200, 255, cv2.THRESH_BINARY)

# 2. Morphological closing to bridge small wall gaps
kernel = np.ones((config["dilate_px"], config["dilate_px"]), np.uint8)
closed = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)

# 3. Flood fill from seed point
h, w = closed.shape
mask = np.zeros((h + 2, w + 2), np.uint8)
seed = (int(config["seed_x"]), int(config["seed_y"]))
cv2.floodFill(closed, mask, seed, 128,
              loDiff=config["tolerance"], upDiff=config["tolerance"])

# 4. Extract the filled region as contour
filled = (closed == 128).astype(np.uint8) * 255
contours, _ = cv2.findContours(filled, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

if not contours:
    print(json.dumps({"error": "No contiguous area found at seed point"}))
    sys.exit(0)

# 5. Take largest contour, simplify
largest = max(contours, key=cv2.contourArea)
perimeter = cv2.arcLength(largest, True)
epsilon = config["simplify_epsilon"] * perimeter
simplified = cv2.approxPolyDP(largest, epsilon, True)

# 6. Normalize to 0-1 coordinates
pw, ph = config["page_width"], config["page_height"]
vertices = [{"x": round(pt[0][0] / pw, 6), "y": round(pt[0][1] / ph, 6)}
            for pt in simplified]

# 7. Compute area in pixels (for preview)
area_px = cv2.contourArea(simplified)

print(json.dumps({
    "type": "result",
    "vertices": vertices,
    "vertex_count": len(vertices),
    "area_px": area_px,
    "area_fraction": round(area_px / (pw * ph), 6),
}))
```

**Output (JSON via stdout):**
```json
{
  "type": "result",
  "vertices": [{"x": 0.12, "y": 0.30}, {"x": 0.35, "y": 0.30}, ...],
  "vertex_count": 12,
  "area_px": 185000,
  "area_fraction": 0.049
}
```

### New API Route: `src/app/api/bucket-fill/route.ts` (~80 LOC)

```
POST /api/bucket-fill
Body: { projectId, pageNumber, seedPoint: {x, y}, tolerance?, dilate? }

1. requireAuth + verify project ownership
2. Download page PNG from S3 (same pattern as symbol-search)
3. Fallback: rasterize from PDF if S3 missing (pdf-rasterize.ts)
4. Write PNG to tempDir
5. Spawn flood_fill.py with config JSON
6. Return polygon vertices
7. Clean up temp files
```

### New TypeScript Wrapper: `src/lib/flood-fill.ts` (~40 LOC)

Mirrors `src/lib/template-match.ts` pattern:
- Spawn Python subprocess
- Write config to stdin, read JSON from stdout
- 30-second timeout (flood fill is fast)
- Return `{ vertices: Array<{x: number, y: number}>, areaPx: number }`

### Frontend Integration

**viewerStore additions:**
```typescript
bucketFillActive: boolean;
setBucketFillActive: (active: boolean) => void;
bucketFillTolerance: number;       // default 30
setBucketFillTolerance: (t: number) => void;
bucketFillPreview: Array<{x: number, y: number}> | null;  // preview polygon before commit
setBucketFillPreview: (v: Array<{x: number, y: number}> | null) => void;
```

**AnnotationOverlay.tsx — new handler in handleMouseDown:**
```typescript
if (bucketFillActive && activeTakeoffItemId !== null) {
  e.stopPropagation();
  const normX = pos.x / width;
  const normY = pos.y / height;
  // Show loading indicator
  setBucketFillPreview(null);
  
  const resp = await fetch("/api/bucket-fill", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId: publicId,
      pageNumber,
      seedPoint: { x: normX, y: normY },
      tolerance: bucketFillTolerance,
    }),
  });
  
  if (resp.ok) {
    const data = await resp.json();
    if (data.vertices?.length >= 3) {
      setBucketFillPreview(data.vertices);
      // Show preview overlay — user clicks "Accept" or "Retry"
    }
  }
  return;
}
```

**AreaTab.tsx — bucket fill toggle:**
Add a paint-bucket icon button next to "Set Scale". When active, cursor = crosshair with bucket icon overlay. Tolerance slider (10-80, default 30).

**DrawingPreviewLayer.tsx — preview rendering:**
When `bucketFillPreview` is set, render the polygon as a semi-transparent fill (same color as active takeoff item) with dashed outline. Show "Accept" / "Retry" / "Cancel" floating buttons near the polygon centroid.

**Accept flow:**
1. Take `bucketFillPreview` vertices
2. Call `savePolygon()` with those vertices (same as manual polygon close)
3. Clear preview state
4. Stays in bucket-fill mode for next click

---

## Tuning Parameters (exposed in UI)

| Param | Default | Range | Effect |
|---|---|---|---|
| tolerance | 30 | 5-80 | Color similarity threshold for flood boundary |
| dilate_px | 3 | 0-10 | Morphological closing kernel size (bridges wall gaps) |
| simplify_epsilon | 0.005 | 0.001-0.02 | Polygon simplification (lower = more vertices, tighter fit) |

Slider in AreaTab when bucket-fill mode is active.

---

## Known Limitations & Mitigations

| Limitation | Impact | Mitigation |
|---|---|---|
| Gaps in walls → flood bleeds | Wrong polygon (too large) | dilate_px closes small gaps; user retries with higher dilate |
| Hatch/fill patterns | Flood stops at hatch lines | Pre-process: blur before threshold to smooth hatching |
| Scanned PDF noise | Noisy polygon edges | Higher simplify_epsilon smooths |
| Very thin walls | May bleed through | User falls back to manual polygon |
| Multiple rooms share open boundary | Flood fills both | User draws manual dividing line first, then bucket-fills each side |

---

## File List

| File | Action | LOC |
|---|---|---|
| `scripts/flood_fill.py` | NEW | ~60 |
| `src/lib/flood-fill.ts` | NEW | ~40 |
| `src/app/api/bucket-fill/route.ts` | NEW | ~80 |
| `src/stores/viewerStore.ts` | EDIT | +10 (3 state fields + actions) |
| `src/components/viewer/AnnotationOverlay.tsx` | EDIT | +20 (bucket-fill click handler) |
| `src/components/viewer/DrawingPreviewLayer.tsx` | EDIT | +30 (preview polygon rendering) |
| `src/components/viewer/AreaTab.tsx` | EDIT | +25 (bucket-fill toggle + tolerance slider) |
| **Total** | | ~265 |

---

## Implementation Order

1. `flood_fill.py` — test standalone with sample PNGs
2. `flood-fill.ts` wrapper + API route
3. Store state + AnnotationOverlay click handler
4. Preview rendering in DrawingPreviewLayer
5. AreaTab UI (toggle button + tolerance slider)
6. Accept/Retry/Cancel flow
7. Edge case testing (gaps, hatching, noise)

---

## Verification

1. Upload a floor plan PDF with distinct rooms
2. Open surface area takeoff, create a polygon item
3. Activate bucket fill → click inside a room
4. Preview polygon should appear matching room boundary
5. Click Accept → polygon saved, area computed
6. Repeat for multiple rooms — each click creates one room polygon
7. Test edge cases: click on a wall line (should get "no area" error), click near gap (should fill correctly with dilate=3)
