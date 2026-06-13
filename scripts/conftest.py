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
