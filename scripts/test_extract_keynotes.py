"""
Regression tests for extract_keynotes.py.

Covers the load-bearing contracts and the 2026-04-16 max_kn scale-down
regression that shipped silently and was only caught by the 2026-04-17
diag warning.

Runs without tesseract: extract_keynotes gracefully disables OCR when
pytesseract is missing, and these tests don't assert on recognized text.
"""
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


def test_small_image_takes_small_image_path(small_blank_png):
    """Both dims <= MIN_SIZE_FOR_TILING hits the small-image branch at
    L474-494 — no tiling, so the 'across N tiles' warning must NOT appear
    even when 0 keynotes are found. Distinguishing the two branches guards
    against the paths being swapped again."""
    results, diag_warnings = main(small_blank_png)
    assert results == []
    assert not any("across" in w and "tiles" in w for w in diag_warnings)


def test_tiled_zero_keynotes_emits_warning(large_blank_png):
    """Large blank image → tiled path → 0 keynotes → diag warning fires.
    This is the signal that exposed the Lambda silent-fail pre-PR-1, so
    it has to keep firing."""
    results, diag_warnings = main(large_blank_png)
    assert results == []
    assert len(diag_warnings) == 1
    w = diag_warnings[0]
    assert "0 keynotes across" in w
    assert "tiles" in w
    assert "Pipeline (all tiles):" in w


def test_max_kn_is_200_at_scale_1(monkeypatch):
    """extract_from_image must call filter_components with width_range
    (20, 200) and height_range (20, 200) at scale_factor=1.0. The `20`
    is the base min_kn; `200` is max_kn (never scales down)."""
    captured = _capture_filter_calls(monkeypatch)
    img = np.full((800, 800), 255, dtype=np.uint8)
    extract_from_image(img, skip_ocr=True, scale_factor=1.0)
    keynote_call = _keynote_filter_call(captured)
    assert keynote_call["width"] == (20, 200)
    assert keynote_call["height"] == (20, 200)


def test_max_kn_does_not_scale_down(monkeypatch):
    """The 2026-04-16 regression gate. max_kn was being scaled by
    scale_factor, clipping valid native-size keynotes (reference bubbles,
    column markers at 200-300px native) once scale dropped to ~0.4. Even
    at scale_factor=0.3, max_kn MUST stay at 200."""
    captured = _capture_filter_calls(monkeypatch)
    img = np.full((800, 800), 255, dtype=np.uint8)
    extract_from_image(img, skip_ocr=True, scale_factor=0.3)
    keynote_call = _keynote_filter_call(captured)
    assert keynote_call["width"][1] == 200, (
        f"max_kn (width upper bound) was {keynote_call['width'][1]}, "
        "expected 200 — max_kn must not scale down"
    )
    assert keynote_call["height"][1] == 200, (
        f"max_kn (height upper bound) was {keynote_call['height'][1]}, "
        "expected 200 — max_kn must not scale down"
    )


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
