"""
[table pipeline WP-3.B, K16] detect_table_lines.py --crop: crop-relative thresholds on one table's box.

Synthetic page images only (white page, black rules drawn with cv2). Needs cv2 + numpy (an image
dependency, not a devcontainer guarantee): the module is skipped when they are missing.
Run: cd scripts && pytest test_detect_table_lines.py -q
"""
import json
import subprocess
import sys
from pathlib import Path

import pytest

cv2 = pytest.importorskip("cv2")
np = pytest.importorskip("numpy")

import detect_table_lines as dtl  # noqa: E402

SCRIPT = str(Path(__file__).with_name("detect_table_lines.py"))
W, H = 2400, 1600


def _page(tmp_path, rows_y, cols_x, box, name="page.png", border=True, glyphs=True):
    """A page with a ruled table (rules spanning `box` in pixels), an optional sheet border and text-like strokes."""
    img = np.full((H, W, 3), 255, dtype=np.uint8)
    x0, y0, x1, y1 = box
    for y in rows_y:
        cv2.line(img, (x0, y), (x1, y), (0, 0, 0), 2)
    for x in cols_x:
        cv2.line(img, (x, y0), (x, y1), (0, 0, 0), 2)
    if border:
        cv2.rectangle(img, (20, 20), (W - 20, H - 20), (0, 0, 0), 3)
        cv2.line(img, (20, 1300), (W - 20, 1300), (0, 0, 0), 3)  # a title-block rule across the sheet
    if glyphs:
        for k in range(len(rows_y) - 1):
            for c in range(len(cols_x) - 1):
                cx, cy = cols_x[c] + 12, rows_y[k] + 8
                cv2.rectangle(img, (cx, cy), (cx + 30, cy + 10), (0, 0, 0), 1)  # glyph-sized outlines
    path = tmp_path / name
    cv2.imwrite(str(path), img)
    return str(path)


def _norm_crop(box):
    return (box[0] / W, box[1] / H, box[2] / W, box[3] / H)


def test_parse_crop_validates():
    assert dtl.parse_crop("0.1,0.2,0.3,0.4") == (0.1, 0.2, 0.3, 0.4)
    for bad in ("0.1,0.2,0.3", "0.3,0.2,0.1,0.4", "0,0,1.5,1", "a,b,c,d"):
        with pytest.raises(ValueError):
            dtl.parse_crop(bad)


def test_crop_finds_the_tables_rules_only(tmp_path):
    box = (480, 400, 1200, 900)  # 720 x 500 px table
    rows_y = [400, 500, 600, 700, 800, 900]
    cols_x = [480, 640, 960, 1200]
    path = _page(tmp_path, rows_y, cols_x, box)
    crop = _norm_crop((470, 390, 1210, 910))
    out = dtl.detect_grid(path, crop=crop)
    assert out["mode"] == "crop"
    cx0, cy0, cx1, cy1 = out["crop"]
    cw, ch = (cx1 - cx0) * W, (cy1 - cy0) * H
    ys = [round(cy0 * H + r["y"] * ch) for r in out["rows"]]
    xs = [round(cx0 * W + c["x"] * cw) for c in out["cols"]]
    assert len(ys) == len(rows_y) and all(abs(a - b) <= 2 for a, b in zip(ys, rows_y))
    assert len(xs) == len(cols_x) and all(abs(a - b) <= 2 for a, b in zip(xs, cols_x))
    assert out["rowCount"] == 5 and out["colCount"] == 3


def test_full_page_mode_is_unchanged_and_sees_the_sheet(tmp_path):
    box = (480, 400, 1200, 900)
    path = _page(tmp_path, [400, 500, 600, 700, 800, 900], [480, 640, 960, 1200], box)
    out = dtl.detect_grid(path)  # no crop: the legacy page-relative defaults
    assert "mode" not in out and "crop" not in out
    ys = [round(r["y"] * H) for r in out["rows"]]
    # K16: on the whole page the sheet's own rules (the border, a title-block rule) are found with the
    # table's, so the classic method has to filter page lines to the box afterwards; --crop never sees them.
    assert any(abs(y - 1300) <= 3 for y in ys)
    assert any(abs(y - 20) <= 3 for y in ys)


def test_crop_mode_keeps_more_than_fifty_rows(tmp_path):
    rows_y = list(range(100, 100 + 61 * 20, 20))  # 61 rules -> 60 rows, 20 px pitch
    box = (300, 100, 900, rows_y[-1])
    path = _page(tmp_path, rows_y, [300, 600, 900], box, border=False, glyphs=False)
    crop = _norm_crop((290, 90, 910, rows_y[-1] + 10))
    out = dtl.detect_grid(path, crop=crop)
    assert len(out["rows"]) == 61
    # the same image without --crop is capped at the sheet's first 50 rows
    assert len(dtl.detect_grid(path, min_h_length=0.2)["rows"]) <= dtl.MAX_REASONABLE_ROWS


def test_explicit_arguments_win_over_crop_defaults(tmp_path):
    box = (480, 400, 1200, 900)
    path = _page(tmp_path, [400, 650, 900], [480, 840, 1200], box, border=False, glyphs=False)
    crop = _norm_crop((470, 390, 1210, 910))
    assert len(dtl.detect_grid(path, crop=crop)["cols"]) == 3
    # a vertical-length floor above the rules' length rejects them
    assert len(dtl.detect_grid(path, crop=crop, min_v_length=1.0)["cols"]) == 0


def test_cli_crop_and_bad_crop(tmp_path):
    box = (480, 400, 1200, 900)
    path = _page(tmp_path, [400, 650, 900], [480, 840, 1200], box, border=False, glyphs=False)
    crop = ",".join(str(v) for v in _norm_crop((470, 390, 1210, 910)))
    ok = json.loads(subprocess.run([sys.executable, SCRIPT, path, "--crop", crop], capture_output=True, text=True, check=True).stdout)
    assert ok["mode"] == "crop" and len(ok["rows"]) == 3
    bad = json.loads(subprocess.run([sys.executable, SCRIPT, path, "--crop", "0.5,0,0.4,1"], capture_output=True, text=True, check=True).stdout)
    assert "error" in bad and bad["rows"] == []
