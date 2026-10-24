"""
pytest fixtures for the scripts/ Python test suite.

Fixtures generate synthetic test images on disk so tests don't depend on
checked-in binary blobs. Images are plain numpy arrays written via cv2 —
no Tesseract required (extract_keynotes.py gracefully falls back when
pytesseract is missing).
"""
import pytest

# [refactor jun13 P0.5-G10] The CV stack is a Lambda-image dependency, not a
# devcontainer guarantee (container rebuilds wipe pip packages). Import
# tolerantly so collection still works — cv2-needing fixtures skip themselves,
# while stub-based tests (test_lambda_handler.py) run everywhere.
try:
    import cv2
    import numpy as np
except ModuleNotFoundError:
    cv2 = None
    np = None


@pytest.fixture
def small_blank_png(tmp_path):
    """Blank 800x800 white PNG. Small enough that generate_tiles yields a
    single tile — exercises the unified tile loop's 1-tile case."""
    if cv2 is None:
        pytest.skip("cv2 not installed (Lambda-only dep)")
    path = tmp_path / "small_blank.png"
    img = np.full((800, 800), 255, dtype=np.uint8)
    cv2.imwrite(str(path), img)
    return str(path)


# Keynote-like glyphs the detector finds WITHOUT Tesseract: an outline (4 px — survives the
# distance-transform erosion of thin lines) with a solid "text" blob inside that satisfies the
# text-inside / vertically-centered / >=20%-height checks. Positions are chosen against
# generate_tiles(2500, 2500) (tile starts 0/900/1800): some sit in one tile, some in an
# overlap band (so dedupe has work to do), and exactly one — SHAPES_ONLY_IN_CENTER_TILE — lies
# in the centre tile alone (x, y in [1200, 1800)), which the bad-tile tests knock out.
SHAPE_CENTERS = [
    (200, 200), (1150, 300), (2300, 200), (600, 1150), (1150, 1150), (1900, 1150),
    (300, 2300), (1150, 2300), (2200, 2200), (900, 900), (1800, 1800), (2000, 600),
    (1500, 1500),
]
SHAPES_ONLY_IN_CENTER_TILE = (1500, 1500)
CENTER_TILE_MARKER_VALUE = 7  # pixel value written inside that one glyph's blob


@pytest.fixture
def shapes_png(tmp_path):
    """2500x2500 white page with 13 synthetic keynote glyphs across 9 tiles — the parallel ==
    serial fixture. Returns the path; SHAPE_CENTERS above says where the glyphs are."""
    if cv2 is None:
        pytest.skip("cv2 not installed (Lambda-only dep)")
    img = np.full((2500, 2500), 255, dtype=np.uint8)
    for i, (cx, cy) in enumerate(SHAPE_CENTERS):
        if i % 3 == 0:
            cv2.circle(img, (cx, cy), 35, 0, 4)
        elif i % 3 == 1:
            cv2.rectangle(img, (cx - 35, cy - 35), (cx + 35, cy + 35), 0, 4)
        else:
            pts = np.array([[cx, cy - 40], [cx + 40, cy], [cx, cy + 40], [cx - 40, cy]])
            cv2.polylines(img, [pts], True, 0, 4)
        cv2.rectangle(img, (cx - 12, cy - 8), (cx + 12, cy + 8), 0, -1)
    mx, my = SHAPES_ONLY_IN_CENTER_TILE
    img[my, mx] = CENTER_TILE_MARKER_VALUE  # inside the blob; thresholds to black like 0 does
    path = tmp_path / "shapes.png"
    cv2.imwrite(str(path), img)
    return str(path)


@pytest.fixture
def large_blank_png(tmp_path):
    """Blank 2500x2500 white PNG. generate_tiles yields multiple tiles
    (>TILE_SIZE in both dims) — exercises the multi-tile dedup path."""
    if cv2 is None:
        pytest.skip("cv2 not installed (Lambda-only dep)")
    path = tmp_path / "large_blank.png"
    img = np.full((2500, 2500), 255, dtype=np.uint8)
    cv2.imwrite(str(path), img)
    return str(path)
