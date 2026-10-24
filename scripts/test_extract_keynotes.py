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
import pytest

# [refactor jun13 P0.5-G10] CV stack is a Lambda-image dep, not a devcontainer
# guarantee — skip this whole file when cv2 is missing OR when it's the stub
# that test_lambda_handler registers in cv2-less environments.
cv2 = pytest.importorskip("cv2")
if not hasattr(cv2, "imread"):
    pytest.skip("cv2 is a stub (cv2-less environment)", allow_module_level=True)
import numpy as np

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


def test_undecodable_image_raises_instead_of_returning_empty(tmp_path):
    """[fix 2026-10-21] An image cv2 cannot decode used to return ([], []) — the Lambda then
    reported the page as scanned-with-no-keynotes and callers cleared it. It must raise so the
    page is reported failed (lambda_handler page_errors / CLI "Extraction failed")."""
    bad = tmp_path / "bad.png"
    bad.write_bytes(b"not a png")
    with pytest.raises(ValueError, match="could not decode"):
        main(str(bad))


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


# ─── Tile parallelism (2026-10-24) ───────────────────────────────
#
# Every backend must hand deduplicate() the SAME list in the SAME order as the old serial
# loop, so results are byte-identical whichever executor ran. The fixture is a 9-tile page
# with glyphs in single tiles and in overlap bands (conftest.shapes_png).

import json
import os

from conftest import CENTER_TILE_MARKER_VALUE, SHAPES_ONLY_IN_CENTER_TILE


_PARENT_PID = None
_REAL_RUN_TILE = None


def _die_in_children(ti, tile):
    """Kill switch for test_broken_worker_pool_falls_back_to_serial: a worker process exits
    hard, the parent (same pid as the test) runs the real tile code."""
    if os.getpid() != _PARENT_PID:
        os._exit(1)
    return _REAL_RUN_TILE(ti, tile)


def _near(result, center, size=2500):
    l, t, r, b = result["bbox"]
    return abs((l + r) / 2 * size - center[0]) < 50 and abs((t + b) / 2 * size - center[1]) < 50


def test_parallel_backends_match_serial(shapes_png):
    """serial == pool == pipe == auto: identical results (order included) and warnings."""
    serial = main(shapes_png, workers=1)
    assert len(serial[0]) >= 8, "fixture must produce detections or the equality is vacuous"
    assert len(ek.generate_tiles(2500, 2500)) == 9
    for backend in ("pool", "pipe", "auto"):
        assert main(shapes_png, workers=3, backend=backend) == serial, backend


@pytest.mark.parametrize("workers,backend", [(1, "serial"), (3, "pool"), (3, "pipe")])
def test_bad_tile_adds_warning_and_keeps_other_tiles(shapes_png, monkeypatch, workers, backend):
    """One tile raising used to abort the page (87 good tiles discarded). Now it is a warning
    and only that tile's shapes are missing. The failing tile is recognised by the marker
    pixel conftest plants in the glyph that lives in the centre tile alone."""
    baseline, _ = main(shapes_png, workers=1)
    assert any(_near(r, SHAPES_ONLY_IN_CENTER_TILE) for r in baseline)

    real = ek.extract_from_image

    def boom(img, skip_ocr=False):
        if (img == CENTER_TILE_MARKER_VALUE).any():
            raise RuntimeError("synthetic tile failure")
        return real(img, skip_ocr=skip_ocr)

    monkeypatch.setattr(ek, "extract_from_image", boom)
    results, warnings = main(shapes_png, workers=workers, backend=backend)

    assert [w for w in warnings if w.startswith("Shape Parse skipped tile 4 @ (900,900)")], warnings
    assert all("synthetic tile failure" in w for w in warnings if "skipped tile" in w)
    assert not any(w.startswith("Extraction failed") for w in warnings), (
        "a skipped tile must not look like a failed page to src/lib/keynotes.ts"
    )
    assert not any(_near(r, SHAPES_ONLY_IN_CENTER_TILE) for r in results)
    # Everything that survived came from the other 8 tiles, unchanged; what is lost is bounded
    # by what tile 4 alone contributed (the detector is crop-sensitive, so an overlap-band
    # glyph may be seen by tile 4 only — the exact count is a fixture property, not a contract).
    base_boxes = {tuple(round(v, 6) for v in r["bbox"]) for r in baseline}
    assert all(tuple(round(v, 6) for v in r["bbox"]) in base_boxes for r in results)
    assert len(baseline) - 3 <= len(results) < len(baseline)


def test_all_tiles_failed_raises(shapes_png, monkeypatch):
    """Zero tiles scanned is a failed page, not an empty one — same rule as an undecodable
    image: the Lambda must put it in page_errors, the CLI must print 'Extraction failed'."""
    def boom(img, skip_ocr=False):
        raise RuntimeError("everything is on fire")

    monkeypatch.setattr(ek, "extract_from_image", boom)
    with pytest.raises(RuntimeError, match="all 9 tiles failed; first: RuntimeError: everything"):
        main(shapes_png, workers=1)


@pytest.mark.parametrize("backend", ["pool", "pipe"])
def test_broken_worker_pool_falls_back_to_serial(shapes_png, monkeypatch, backend):
    """A worker killed mid-page (the Lambda OOM case) must not fail the page: the parent
    finishes the unfinished tiles itself and says so in a warning. Workers die via os._exit
    only in child processes (pid check), so the in-parent sweep runs the real tile code."""
    serial = main(shapes_png, workers=1)
    global _PARENT_PID, _REAL_RUN_TILE
    _PARENT_PID, _REAL_RUN_TILE = os.getpid(), ek._run_tile
    # Module-level, not a closure: the pool backend pickles the callable by reference.
    monkeypatch.setattr(ek, "_run_tile", _die_in_children)
    results, warnings = main(shapes_png, workers=3, backend=backend)
    assert results == serial[0]
    assert any(f"tile worker pool ({backend}) broke" in w for w in warnings), warnings


def test_timing_line_is_structured(shapes_png, capfd, monkeypatch):
    """One '[keynote] timing {json}' line per page, honouring KEYNOTE_TILE_WORKERS."""
    monkeypatch.setenv(ek.TILE_WORKERS_ENV, "2")
    monkeypatch.setenv(ek.TILE_BACKEND_ENV, "pipe")
    main(shapes_png)
    err = capfd.readouterr().err
    lines = [l for l in err.splitlines() if l.startswith("[keynote] timing ")]
    assert len(lines) == 1, err
    t = json.loads(lines[0][len("[keynote] timing "):])
    assert t["tiles"] == 9 and t["failed_tiles"] == 0
    assert t["workers"] == 2 and t["backend"] == "pipe"
    for key in ("decode_s", "extract_s", "tile_cpu_s", "dedup_s", "total_s",
                "text_candidates", "shape_candidates", "selected", "before_dedup", "keynotes"):
        assert key in t, key
    assert t["total_s"] >= t["extract_s"] >= 0
    assert "in " in [l for l in err.splitlines() if l.startswith("[keynote] Tile 0 ")][0]


def test_tile_worker_count_knobs(monkeypatch):
    monkeypatch.delenv(ek.TILE_WORKERS_ENV, raising=False)
    assert ek.tile_worker_count(1) == 1                       # never more workers than tiles
    assert ek.tile_worker_count(500) <= ek.MAX_TILE_WORKERS   # never more than the cap
    assert ek.tile_worker_count(500, workers=0) == 1          # 0/1 → serial
    assert ek.tile_worker_count(500, workers=3) == 3
    monkeypatch.setenv(ek.TILE_WORKERS_ENV, "2")
    assert ek.tile_worker_count(500) == 2
    monkeypatch.setenv(ek.TILE_WORKERS_ENV, "banana")
    assert 1 <= ek.tile_worker_count(500) <= ek.MAX_TILE_WORKERS  # ignored, not fatal


def test_fork_after_cv2_threads_does_not_deadlock(shapes_png):
    """Regression for the 2026-10-24 hang: the parent had used OpenCV's thread pool (a serial
    page) before forking tile workers, and every worker blocked forever. Parent pins threads=1
    around the fork and children never call cv2.setNumThreads. A hang here is a 300 s Lambda
    timeout in production, so the run is a bounded subprocess (a hang must fail, not stall
    the suite)."""
    import subprocess
    import sys

    script = (
        "import sys, json, cv2; sys.path.insert(0, %r); import extract_keynotes as ek\n"
        "warm = ek.main(%r, workers=1)\n"  # parent uses cv2 (thread pool created) BEFORE forking
        "before = cv2.getNumThreads()\n"
        "par = ek.main(%r, workers=3, backend='pool')\n"
        "print(json.dumps({'same': par == warm, 'restored': cv2.getNumThreads() == before}))\n"
    ) % (os.path.dirname(os.path.abspath(__file__)), shapes_png, shapes_png)
    try:
        proc = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, timeout=90)
    except subprocess.TimeoutExpired:
        pytest.fail("parallel tile run hung after the parent had used cv2 threads")
    assert proc.returncode == 0, proc.stderr[-2000:]
    verdict = json.loads(proc.stdout.strip().splitlines()[-1])
    assert verdict == {"same": True, "restored": True}, proc.stderr[-2000:]


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
