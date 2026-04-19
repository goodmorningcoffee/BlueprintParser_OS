#!/usr/bin/env python3
"""
build_project_pdf.py — concatenate mixed-format uploads into a single PDF.

Input: JSON config via stdin
    {
        "files":      [{"filename": "...", "tmpPath": "/local/path"}, ...],
        "outputPath": "/local/output.pdf"
    }

Output: JSON result to stdout
    Success:
        {
            "status":      "ok",
            "totalPages":  <int>,
            "fileOffsets": [{"filename": "...", "startPage": 1, "endPage": 3}, ...]
        }
    Error (exit code 1):
        {
            "status":   "error",
            "error":    "pdf_encrypted" | "image_decode_failed" | "unsupported_format"
                      | "page_count_exceeded",
            "filename": "<relevant file>",
            "message":  "<detail>"
        }

Inputs are files already downloaded from S3 to a local tmpdir by the TS
caller (see src/lib/processing.ts::buildProjectPdf). This script only reads
from disk and writes the final PDF to disk — no S3 or network I/O.

Ordering: the caller sorts files via Intl.Collator client-side + server-side
before downloading. This script preserves input order.

Dispatch by extension:
    .pdf                 -> fitz.open + insert_pdf (fails on encrypted)
    .png .jpg .jpeg      -> Pillow + exif_transpose + convert("RGB") -> fitz page
    .tif .tiff           -> Pillow ImageSequence.Iterator -> one page per frame
    .heic                -> pillow_heif.register_heif_opener + Pillow path

Page sizing for images: native pixels at 200 DPI equivalent. If longest edge
exceeds 50 inches (3600 pt), scale down proportionally. Downstream
processing.ts re-rasterizes at 300 DPI and auto-clamps at 9500 px, so these
pages survive the full pipeline.
"""

from __future__ import annotations

import io
import json
import os
import sys
from typing import Any

import fitz  # PyMuPDF — provided via Dockerfile pip install
from PIL import Image, ImageOps, ImageSequence, UnidentifiedImageError
import pillow_heif

# Register once at module load so Pillow can open .heic via Image.open.
pillow_heif.register_heif_opener()

# ─── Tunables ────────────────────────────────────────────────
TARGET_DPI = 200           # image -> PDF page sizing (72 pt/in * px/DPI)
MAX_EDGE_POINTS = 3600     # 50 inches; cap page dimension
MAX_TOTAL_PAGES = 500      # abort if concat exceeds this


# ─── Error emission ──────────────────────────────────────────
def fail(error: str, filename: str = "", message: str = "") -> None:
    """Emit error JSON to stdout and exit 1."""
    payload: dict[str, Any] = {"status": "error", "error": error}
    if filename:
        payload["filename"] = filename
    if message:
        payload["message"] = message
    print(json.dumps(payload))
    sys.exit(1)


# ─── Image -> PDF page helpers ───────────────────────────────
def image_page_rect(pixel_w: int, pixel_h: int) -> fitz.Rect:
    """Return a fitz.Rect sized to embed the image at ~TARGET_DPI, capped at MAX_EDGE_POINTS."""
    w_pt = pixel_w * 72 / TARGET_DPI
    h_pt = pixel_h * 72 / TARGET_DPI
    longest = max(w_pt, h_pt)
    if longest > MAX_EDGE_POINTS:
        scale = MAX_EDGE_POINTS / longest
        w_pt *= scale
        h_pt *= scale
    return fitz.Rect(0, 0, w_pt, h_pt)


def insert_pil_image_as_page(output_doc: fitz.Document, img: Image.Image) -> None:
    """Apply EXIF rotation, normalize to RGB, insert as a new page."""
    img = ImageOps.exif_transpose(img) or img
    if img.mode != "RGB":
        img = img.convert("RGB")

    rect = image_page_rect(img.width, img.height)
    page = output_doc.new_page(width=rect.width, height=rect.height)

    # fitz.Pixmap from PIL bytes — PNG encode keeps the image lossless for the
    # re-raster step downstream. JPEG would add extra compression artifacts.
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    page.insert_image(rect, stream=buf.getvalue())


# ─── Per-format dispatchers ──────────────────────────────────
def append_pdf(output_doc: fitz.Document, filename: str, tmp_path: str) -> int:
    """Append all pages from a PDF. Returns number of pages added."""
    try:
        src = fitz.open(tmp_path)
    except Exception as e:  # pragma: no cover
        fail("image_decode_failed", filename, f"fitz.open failed: {e}")
        return 0  # unreachable, keeps linters happy

    try:
        if src.needs_pass:
            fail("pdf_encrypted", filename, "password-protected PDFs are not supported")
        added = src.page_count
        output_doc.insert_pdf(src)
        return added
    finally:
        src.close()


def append_image(output_doc: fitz.Document, filename: str, tmp_path: str) -> int:
    """Append a raster image (png/jpg/jpeg/heic). Returns 1."""
    try:
        img = Image.open(tmp_path)
    except (UnidentifiedImageError, OSError) as e:
        fail("image_decode_failed", filename, str(e))
        return 0

    try:
        insert_pil_image_as_page(output_doc, img)
        return 1
    finally:
        img.close()


def append_tiff(output_doc: fitz.Document, filename: str, tmp_path: str) -> int:
    """Append every frame of a (possibly multi-page) TIFF. Returns frame count."""
    try:
        img = Image.open(tmp_path)
    except (UnidentifiedImageError, OSError) as e:
        fail("image_decode_failed", filename, str(e))
        return 0

    try:
        count = 0
        for frame in ImageSequence.Iterator(img):
            # Iterator yields shared buffers; copy so exif_transpose + convert
            # don't mutate the iterator state.
            insert_pil_image_as_page(output_doc, frame.copy())
            count += 1
        return count
    finally:
        img.close()


DISPATCH = {
    "pdf":  append_pdf,
    "png":  append_image,
    "jpg":  append_image,
    "jpeg": append_image,
    "tif":  append_tiff,
    "tiff": append_tiff,
    "heic": append_image,
}


# ─── Main ────────────────────────────────────────────────────
def main() -> None:
    try:
        config = json.loads(sys.stdin.read())
    except json.JSONDecodeError as e:
        fail("unsupported_format", "", f"invalid stdin JSON: {e}")
        return

    files = config.get("files") or []
    output_path = config.get("outputPath") or ""
    if not files or not output_path:
        fail("unsupported_format", "", "files and outputPath are required")
        return

    output_doc = fitz.open()  # empty PDF
    file_offsets: list[dict[str, Any]] = []

    try:
        for entry in files:
            filename = str(entry.get("filename") or "")
            tmp_path = str(entry.get("tmpPath") or "")
            if not filename or not tmp_path or not os.path.exists(tmp_path):
                fail("image_decode_failed", filename, f"missing tmpPath: {tmp_path}")
                return

            ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
            handler = DISPATCH.get(ext)
            if handler is None:
                fail("unsupported_format", filename, f"unknown extension: .{ext}")
                return

            start_page = output_doc.page_count + 1
            added = handler(output_doc, filename, tmp_path)
            end_page = start_page + added - 1

            file_offsets.append({
                "filename":  filename,
                "startPage": start_page,
                "endPage":   end_page,
            })

            # Cap check mid-loop so we fail fast on runaway multi-page TIFFs.
            if output_doc.page_count > MAX_TOTAL_PAGES:
                fail(
                    "page_count_exceeded",
                    filename,
                    f"project exceeds {MAX_TOTAL_PAGES}-page cap (got {output_doc.page_count})",
                )
                return

        # Write final PDF. `garbage=4, deflate=True` trims cross-references
        # and compresses streams — shaves 10-40% from the file size with no
        # content change.
        output_doc.save(output_path, garbage=4, deflate=True)
    finally:
        output_doc.close()

    print(json.dumps({
        "status":      "ok",
        "totalPages":  sum(f["endPage"] - f["startPage"] + 1 for f in file_offsets),
        "fileOffsets": file_offsets,
    }))


if __name__ == "__main__":
    main()
