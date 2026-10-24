#!/usr/bin/env python3
"""
tile_page.py — cut one page PNG into the tiles a plan names.

Input: JSON config via stdin
    {
        "input":     "/local/page.png",
        "outputDir": "/local/out",
        "tiles":     [{"name": "L3600/r0_c0.png", "x": 0, "y": 0, "w": 3600, "h": 3600}, ...]
    }

Output: JSON result to stdout
    Success:  {"status": "ok", "written": <int>, "width": <int>, "height": <int>}
    Error (exit code 1):
              {"status": "error", "error": "bad_input" | "image_decode_failed" | "rect_out_of_bounds"
                                         | "write_failed", "message": "<detail>"}

The geometry is decided by the TypeScript planner (src/lib/tiles/plan.ts); this script only
crops and encodes. Pillow is already in the processing image (build_project_pdf.py imports it).
A tile that reaches outside the image is an error, never silently clamped: the manifest the
caller writes must describe the pixels that were actually saved. No S3 or network I/O.
"""
from __future__ import annotations

import json
import os
import sys
from typing import Any

from PIL import Image

# 300-DPI sheets (30x42" = 113 MP) exceed Pillow's decompression-bomb threshold (~89 MP);
# the input is our own Ghostscript raster, not untrusted upload bytes.
Image.MAX_IMAGE_PIXELS = None


def fail(error: str, message: str) -> None:
    json.dump({"status": "error", "error": error, "message": message}, sys.stdout)
    sys.stdout.write("\n")
    sys.exit(1)


def validate_rect(tile: dict[str, Any], width: int, height: int) -> tuple[str, int, int, int, int]:
    name = tile.get("name")
    if not isinstance(name, str) or not name or name.startswith("/") or ".." in name.split("/"):
        raise ValueError(f"bad tile name: {name!r}")
    vals = []
    for field in ("x", "y", "w", "h"):
        v = tile.get(field)
        if not isinstance(v, int) or isinstance(v, bool) or v < 0:
            raise ValueError(f"tile {name}: {field} must be a non-negative integer, got {v!r}")
        vals.append(v)
    x, y, w, h = vals
    if w == 0 or h == 0 or x + w > width or y + h > height:
        raise IndexError(f"tile {name}: rect {x},{y} {w}x{h} is outside the {width}x{height} image")
    return name, x, y, w, h


def cut(config: dict[str, Any]) -> dict[str, Any]:
    src = config.get("input")
    out_dir = config.get("outputDir")
    tiles = config.get("tiles")
    if not isinstance(src, str) or not isinstance(out_dir, str) or not isinstance(tiles, list):
        fail("bad_input", "input, outputDir and tiles are required")

    try:
        img = Image.open(src)
        img.load()
    except Exception as exc:  # noqa: BLE001 — any decode problem is one outcome for the caller
        fail("image_decode_failed", f"{type(exc).__name__}: {exc}")

    width, height = img.size
    rects = []
    try:
        for tile in tiles:
            if not isinstance(tile, dict):
                raise ValueError("each tile must be an object")
            rects.append(validate_rect(tile, width, height))
    except ValueError as exc:
        fail("bad_input", str(exc))
    except IndexError as exc:
        fail("rect_out_of_bounds", str(exc))

    written = 0
    try:
        for name, x, y, w, h in rects:
            path = os.path.join(out_dir, name)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            # crop() is lazy on a loaded image; save() encodes just this tile.
            img.crop((x, y, x + w, y + h)).save(path, format="PNG", optimize=False)
            written += 1
    except Exception as exc:  # noqa: BLE001
        fail("write_failed", f"{type(exc).__name__}: {exc}")

    return {"status": "ok", "written": written, "width": width, "height": height}


def main() -> None:
    try:
        config = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        fail("bad_input", f"stdin is not JSON: {exc}")
    result = cut(config)
    json.dump(result, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
