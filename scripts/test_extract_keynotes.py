"""
Regression tests for extract_keynotes.py.

Covers the load-bearing contracts and the 2026-04-16 max_kn scale-down
regression that shipped silently and was only caught by the 2026-04-17
diag warning.

Unified sliding-window BB pipeline (2026-04-18): extract_from_image
always runs at native resolution with fixed filter bounds
(MIN_KN_ABS=15, MAX_KN_ABS=200). No scale_factor, no MIN_SIZE_FOR_TILING
dispatch, no MAX_DIM downscale. These tests gate the unified behavior so
a future refactor reintroducing scale-based filtering fails loudly.

Runs without tesseract: extract_keynotes gracefully disables OCR when
pytesseract is missing, and these tests don't assert on recognized text.
"""
import cv2
import numpy as np
import pytest

import extract_keynotes as ek
from extract_keynotes import main, extract_from_image


def test_returns_tuple(small_blank_png):
    """main() must return a 2-tuple of (list, list) — the contract that
    lambda_handler.process_pages and the ECS __main__ block both depend
    on. A shape change here is a silent Lambda crash."""
    out = main(small_blank_png)
    assert isinstance(out, tuple)
    assert len(out) == 2
    results, diag_warnings = out
    assert isinstance(results, list)
    assert isinstance(diag_warnings, list)


def test_small_image_produces_one_tile(small_blank_png):
    """Post-refactor: small images flow through the same tile loop as
    large images. generate_tiles(800, 800) yields exactly one tile of
    the full image, so the unified pipeline handles BB-sized crops and
    full pages identically — no size-based dispatch."""
    tiles = ek.generate_tiles(800, 800)
    assert len(tiles) == 1
    ty, tx, th, tw = tiles[0]
    assert (ty, tx, th, tw) == (0, 0, 800, 800)

    # main() still emits the diag warning for 0-keynote pages; the warning
    # now says "across 1 tiles" for small images, which is correct and
    # consistent (not a special "small-image path" branch anymore).
    results, diag_warnings = main(small_blank_png)
    assert results == []
    assert len(diag_warnings) == 1
    assert "across 1 tiles" in diag_warnings[0]


def test_tiled_zero_keynotes_emits_warning(large_blank_png):
    """Large blank image → multiple tiles → 0 keynotes → diag warning fires.
    This is the signal that exposed the Lambda silent-fail pre-PR-1, so
    it has to keep firing."""
    results, diag_warnings = main(large_blank_png)
    assert results == []
    assert len(diag_warnings) == 1
    w = diag_warnings[0]
    assert "0 keynotes across" in w
    assert "tiles" in w
    assert "Pipeline (all tiles):" in w


def test_filter_bounds_are_15_to_200(monkeypatch):
    """extract_from_image must call filter_components with width_range
    (MIN_KN_ABS, MAX_KN_ABS) = (15, 200) and height_range (15, 200).
    Gates the unified-pipeline filter bounds against future regressions
    — both the 2026-04-16 max_kn-scale-down bug (which clipped valid
    shapes) and a hypothetical min_kn-raise regression (which would
    miss the ~15-20px shapes the downscaled path used to catch)."""
    captured = _capture_filter_calls(monkeypatch)
    img = np.full((800, 800), 255, dtype=np.uint8)
    extract_from_image(img, skip_ocr=True)
    keynote_call = _keynote_filter_call(captured)
    assert keynote_call["width"] == (15, 200)
    assert keynote_call["height"] == (15, 200)


def test_main_never_downscales(monkeypatch, tmp_path):
    """Unified pipeline removes the MAX_DIM_BEFORE_DOWNSCALE step.
    A resize call in main() would reintroduce the information loss the
    refactor was meant to eliminate. Gate via monkeypatching cv2.resize
    and asserting it's never called on large input."""
    resize_calls = []
    original_resize = cv2.resize

    def spy_resize(*args, **kwargs):
        resize_calls.append(args[1] if len(args) > 1 else kwargs.get("dsize"))
        return original_resize(*args, **kwargs)

    monkeypatch.setattr(ek.cv2, "resize", spy_resize)

    # 14000×10000 — would have triggered the old 12000 downscale.
    path = tmp_path / "huge_blank.png"
    img = np.full((10000, 14000), 255, dtype=np.uint8)
    cv2.imwrite(str(path), img)

    main(str(path))

    assert resize_calls == [], (
        f"cv2.resize was called {len(resize_calls)} times during main() "
        "— the unified pipeline must not downscale. If you need a resize "
        "elsewhere in the call graph, tighten the spy scope."
    )


def test_overlap_300_dedupes_boundary_shape(monkeypatch, tmp_path):
    """TILE_OVERLAP=300 must be wide enough that shapes straddling a tile
    boundary appear in at least one tile whole, not fragmented across
    two. Synthetic test: a 60px circle at the (1150, 1150) boundary of
    a 1400×1400 image lives inside both tile (0,0,1200,1200) and tile
    (0,900,1200,500) — after dedup, exactly 1 result."""
    # Synthesize a 1400×1400 image with a solid white square 60px at
    # (1120, 1120) on a black background — a shape the extract pipeline
    # can pick up without OCR (since skip_ocr=True isn't exposed to main,
    # we monkeypatch the result to simulate two tiles each "finding" it).
    img = np.zeros((1400, 1400), dtype=np.uint8)
    cv2.rectangle(img, (1120, 1120), (1180, 1180), 255, -1)
    path = tmp_path / "boundary_shape.png"
    cv2.imwrite(str(path), img)

    # Directly test generate_tiles covers the boundary shape in >1 tile.
    tiles = ek.generate_tiles(1400, 1400)
    containing = [
        (ty, tx, th, tw) for (ty, tx, th, tw) in tiles
        if tx <= 1120 and tx + tw >= 1180
        and ty <= 1120 and ty + th >= 1180
    ]
    assert len(containing) >= 2, (
        f"A shape at (1120-1180, 1120-1180) must be fully inside at least "
        f"2 overlapping tiles with 300px overlap. Found {len(containing)} "
        f"out of {len(tiles)}. If this drops, TILE_OVERLAP is too narrow."
    )

    # Directly test deduplicate: two overlapping results (same bbox from
    # different tiles post-remap) must collapse to one.
    r1 = {"shape": "square", "bbox": [0.80, 0.80, 0.84, 0.84], "contour": [], "text": ""}
    r2 = {"shape": "square", "bbox": [0.80, 0.80, 0.84, 0.84], "contour": [], "text": ""}
    deduped = ek.deduplicate([r1, r2])
    assert len(deduped) == 1


# ─── Helpers ─────────────────────────────────────────────────────

def _capture_filter_calls(monkeypatch):
    """Monkeypatch filter_components to capture its call args, then
    forward to the real implementation so extract_from_image still
    completes normally."""
    captured = []
    original = ek.filter_components

    def spy(img, aspect_range, width_range, height_range, invert=False):
        captured.append({
            "aspect": aspect_range,
            "width": width_range,
            "height": height_range,
            "invert": invert,
        })
        return original(img, aspect_range, width_range, height_range, invert=invert)

    monkeypatch.setattr(ek, "filter_components", spy)
    return captured


def _keynote_filter_call(captured):
    """Return the captured filter_components call for keynote candidates
    (the one with invert=True; the other call is text candidates)."""
    for call in captured:
        if call["invert"]:
            return call
    pytest.fail("filter_components was never called with invert=True")
