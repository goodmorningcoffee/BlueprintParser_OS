"""
Regression tests for tile_page.py (the tile-pyramid cutter behind src/lib/tiles/tiler.ts).

The geometry is the TypeScript planner's job (src/lib/tiles/__tests__/plan.test.ts); these tests
pin the cutter's contract: every named tile is written with exactly the requested pixels, nested
level directories are created, a rect outside the image is refused as a whole (nothing written),
and a non-image input is a clean JSON error. Pillow-only; skips where Pillow is absent.
"""
import json
import subprocess
import sys
from pathlib import Path

import pytest

Image = pytest.importorskip("PIL.Image")

SCRIPT = Path(__file__).with_name("tile_page.py")


def run(config: dict) -> tuple[int, dict]:
    proc = subprocess.run(
        [sys.executable, str(SCRIPT)],
        input=json.dumps(config).encode(),
        capture_output=True,
        timeout=60,
    )
    return proc.returncode, json.loads(proc.stdout.decode().strip())


def gradient_page(path: Path, width: int, height: int) -> Image.Image:
    """RGB page whose pixel value encodes its coordinates (x in R, y in G) so crops are checkable."""
    img = Image.new("RGB", (width, height))
    px = img.load()
    for y in range(height):
        for x in range(width):
            px[x, y] = (x % 256, y % 256, (x + y) % 256)
    img.save(path, format="PNG")
    return img


def test_writes_every_tile_with_the_requested_pixels(tmp_path):
    page = tmp_path / "page.png"
    src = gradient_page(page, 300, 200)
    out = tmp_path / "out"
    tiles = [
        {"name": "L128/r0_c0.png", "x": 0, "y": 0, "w": 128, "h": 128},
        {"name": "L128/r0_c1.png", "x": 172, "y": 0, "w": 128, "h": 128},   # edge tile anchored right
        {"name": "L128/r1_c0.png", "x": 0, "y": 72, "w": 128, "h": 128},
        {"name": "L300/r0_c0.png", "x": 0, "y": 0, "w": 300, "h": 200},     # whole page in one tile
    ]
    code, result = run({"input": str(page), "outputDir": str(out), "tiles": tiles})
    assert code == 0
    assert result == {"status": "ok", "written": 4, "width": 300, "height": 200}
    for t in tiles:
        tile = Image.open(out / t["name"])
        assert tile.size == (t["w"], t["h"])
        expected = src.crop((t["x"], t["y"], t["x"] + t["w"], t["y"] + t["h"]))
        assert tile.tobytes() == expected.tobytes()


def test_rect_outside_the_image_refuses_the_whole_job(tmp_path):
    page = tmp_path / "page.png"
    gradient_page(page, 100, 100)
    out = tmp_path / "out"
    tiles = [
        {"name": "L64/r0_c0.png", "x": 0, "y": 0, "w": 64, "h": 64},
        {"name": "L64/r0_c1.png", "x": 40, "y": 0, "w": 64, "h": 64},  # 40 + 64 > 100
    ]
    code, result = run({"input": str(page), "outputDir": str(out), "tiles": tiles})
    assert code == 1
    assert result["status"] == "error"
    assert result["error"] == "rect_out_of_bounds"
    assert "r0_c1" in result["message"]
    assert not out.exists() or not any(out.rglob("*.png"))


def test_bad_name_and_non_integer_rect_are_bad_input(tmp_path):
    page = tmp_path / "page.png"
    gradient_page(page, 100, 100)
    out = tmp_path / "out"
    for tile in (
        {"name": "../escape.png", "x": 0, "y": 0, "w": 10, "h": 10},
        {"name": "L10/r0_c0.png", "x": 0.5, "y": 0, "w": 10, "h": 10},
        {"name": "L10/r0_c0.png", "x": 0, "y": 0, "w": -10, "h": 10},
    ):
        code, result = run({"input": str(page), "outputDir": str(out), "tiles": [tile]})
        assert code == 1
        assert result["error"] == "bad_input"


def test_non_png_input_is_a_decode_error(tmp_path):
    bogus = tmp_path / "page.png"
    bogus.write_bytes(b"this is not an image")
    code, result = run({"input": str(bogus), "outputDir": str(tmp_path / "out"), "tiles": []})
    assert code == 1
    assert result["error"] == "image_decode_failed"


def test_malformed_stdin_is_bad_input():
    proc = subprocess.run([sys.executable, str(SCRIPT)], input=b"{not json", capture_output=True, timeout=60)
    assert proc.returncode == 1
    assert json.loads(proc.stdout.decode())["error"] == "bad_input"
