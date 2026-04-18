"""
pytest fixtures for the scripts/ Python test suite.

Fixtures generate synthetic test images on disk so tests don't depend on
checked-in binary blobs. Images are plain numpy arrays written via cv2 —
no Tesseract required (extract_keynotes.py gracefully falls back when
pytesseract is missing).
"""
import cv2
import numpy as np
import pytest


@pytest.fixture
def small_blank_png(tmp_path):
    """Blank 800x800 white PNG. Small enough that generate_tiles yields a
    single tile — exercises the unified tile loop's 1-tile case."""
    path = tmp_path / "small_blank.png"
    img = np.full((800, 800), 255, dtype=np.uint8)
    cv2.imwrite(str(path), img)
    return str(path)


@pytest.fixture
def large_blank_png(tmp_path):
    """Blank 2500x2500 white PNG. generate_tiles yields multiple tiles
    (>TILE_SIZE in both dims) — exercises the multi-tile dedup path."""
    path = tmp_path / "large_blank.png"
    img = np.full((2500, 2500), 255, dtype=np.uint8)
    cv2.imwrite(str(path), img)
    return str(path)
