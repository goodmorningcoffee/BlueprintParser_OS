#!/usr/bin/env python3
"""
pdf_channels.py — [census F2 2026-10-24] per-page channel census of a PDF.

Records, for every page, which channels the PDF itself carries — a text layer, vector line-work,
raster images, form XObjects, annotations, links — so later tools know which proposers can fire
(research: master_plan_2026-10-24 archive_ideas I-18). Record only: nothing downstream reads it yet.

Input: JSON config via stdin
    {
        "pdfPath":          "/local/path.pdf",
        "pageTimeBudgetMs": 1500,     # optional; a page slower than this is flagged "slow": true
        "totalBudgetMs":    55000,    # optional; a page that would end past it (elapsed + the slowest
                                      #   page so far) is not started: it and the rest are reported
                                      #   {"pageNumber": n, "error": "budget"} and "truncated": true
        "maxPaths":         200000,   # optional; vectorPaths is capped here with "capped": true
        "maxContentBytes":  8000000   # optional; a page whose content streams are larger skips
                                      #   bboxlog and counts paint operators instead ("estimated")
    }

Output: ONE JSON line on stdout, always the LAST line (pymupdf releases newer than the Dockerfile
pin print to STDOUT on import — the Node caller parses the last JSON line, never the whole stream):
    {"status": "ok", "v": 1, "pageCount", "ocgLayers", "producer", "creator", "encrypted",
     "truncated", "seconds", "pages": [<page>...]}
    {"status": "error", "error": "open_failed" | "pdf_encrypted" | "bad_input", "message": "..."}
A per-page failure is caught and reported on that page ({"pageNumber": n, "error": "..."}); it
never kills the run.

Per page: pageNumber, widthPt, heightPt (the rotated page rect), rotation, textChars (non-space
characters of the text layer), textWords, fonts (distinct base fonts in the page resources),
images (image placements, inline included), fullPageImage (one placement covers >= 90% of the
page), vectorPaths (path draws, fill and stroke counted separately, from page.get_bboxlog()),
capped, formXObjects, annots (markup only: links and popups excluded), links, ms, and the kind.
Bounded cost per page [census F2 2026-10-24]: get_bboxlog() materialises the whole log before any
cap applies (measured on a 2M-stroke page: 29 s, 592 MB RSS), so a page whose decompressed content
(page streams + its form XObjects) exceeds maxContentBytes skips it; vectorPaths is then a count of
path-painting operators in those streams, stopped past maxPaths, flagged "estimated": true (same
page: 0.5 s read + 0.25 s scan, ~64 MB). A shared form drawn many times is counted once there.
Why bboxlog: measured 2026-10-24 on a generated 200k-stroke sheet, bboxlog 2.1 s / +54 MB peak
RSS vs get_cdrawings() 1.2 s / +300 MB. The census runs inside the upload process, before the
page loop, on the same task, so memory wins over the second.

kind (VECTOR_MIN = 50 paths, so a title-block frame alone is not "vector"):
    blank      no text, no image, < VECTOR_MIN paths — nothing a proposer could read
    vector     >= VECTOR_MIN paths and no full-page image — born-digital line-work (text or not)
    mixed      >= VECTOR_MIN paths over a full-page image — raster underlay with vector overlay
    scanned    raster geometry only: a full-page image (any text is an OCR overlay), or images
               and no text layer at all
    text-only  a text layer, < VECTOR_MIN paths, no full-page image (spec sheets, covers, notes)
"""

from __future__ import annotations

import json
import re
import sys
import time
from typing import Any

import fitz  # PyMuPDF — provided via Dockerfile pip install (pinned 1.27.2.2)

VERSION = 1
VECTOR_MIN = 50
FULL_PAGE_COVER = 0.90
DEFAULT_MAX_PATHS = 200_000
DEFAULT_PAGE_BUDGET_MS = 1500
# ~250k synthetic strokes at ~32 B each (measured); bboxlog on 8 MB is ~3.5 s / ~75 MB
DEFAULT_MAX_CONTENT_BYTES = 8_000_000
# a path-painting operator token (S s f F f* B B* b b*) between delimiters — not `n` (clip/no-op)
PAINT_OP = re.compile(rb"(?<![^\s\]\)>])(?:[SsfFBb]\*?)(?=[\s\[(/<]|\Z)")
META_MAX = 120
PATH_OPS = ("fill-path", "stroke-path")
# links are counted on their own; a popup is the child window of another annotation
NOT_MARKUP = (fitz.PDF_ANNOT_LINK, fitz.PDF_ANNOT_POPUP)


def classify(text_chars: int, images: int, full_page_image: bool, vector_paths: int) -> str:
    """The derived kind — definitions in the module docstring."""
    has_vector = vector_paths >= VECTOR_MIN
    if has_vector:
        return "mixed" if full_page_image else "vector"
    if full_page_image:
        return "scanned"
    if text_chars > 0:
        return "text-only"
    return "scanned" if images > 0 else "blank"


def _cover(bbox: Any, page_rect: fitz.Rect) -> float:
    area = page_rect.get_area()
    if area <= 0:
        return 0.0
    return (fitz.Rect(bbox) & page_rect).get_area() / area


def _content_streams(page: fitz.Page) -> list[bytes]:
    """The page's decompressed content streams plus each form XObject it references."""
    doc = page.parent
    streams = [page.read_contents()]
    for xobj in page.get_xobjects():
        try:
            streams.append(doc.xref_stream(xobj[0]) or b"")
        except Exception:  # noqa: BLE001 — an unreadable form only lowers the estimate
            pass
    return streams


def _count_paths(page: fitz.Page, max_paths: int, max_content_bytes: int) -> tuple[int, bool]:
    """(path draws, estimated) — bboxlog when the content is small enough, else an operator scan."""
    streams = _content_streams(page)
    if sum(len(s) for s in streams) <= max_content_bytes:
        del streams
        return sum(1 for entry in page.get_bboxlog() if entry[0] in PATH_OPS), False
    n = 0
    for data in streams:
        for _ in PAINT_OP.finditer(data):
            n += 1
            if n > max_paths:
                return n, True
    return n, True


def census_page(page: fitz.Page, max_paths: int, max_content_bytes: int = DEFAULT_MAX_CONTENT_BYTES) -> dict[str, Any]:
    rect = page.rect
    textpage = page.get_textpage()  # one content-stream pass for both reads (~1.9 s each on a 2M-path page)
    text = page.get_text("text", textpage=textpage)
    text_chars = sum(1 for ch in text if not ch.isspace())
    words = len(page.get_text("words", textpage=textpage))
    del textpage
    fonts = len({f[3] for f in page.get_fonts(full=False)})

    infos = page.get_image_info()
    full_page_image = any(_cover(i["bbox"], rect) >= FULL_PAGE_COVER for i in infos)

    paths, estimated = _count_paths(page, max_paths, max_content_bytes)
    capped = paths > max_paths

    out: dict[str, Any] = {
        "widthPt": round(rect.width, 1),
        "heightPt": round(rect.height, 1),
        "rotation": page.rotation,
        "textChars": text_chars,
        "textWords": words,
        "fonts": fonts,
        "images": len(infos),
        "fullPageImage": full_page_image,
        "vectorPaths": min(paths, max_paths),
        "formXObjects": len(page.get_xobjects()),
        "annots": sum(1 for a in page.annot_xrefs() if a[1] not in NOT_MARKUP),
        "links": len(page.get_links()),
    }
    if capped:
        out["capped"] = True
    if estimated:
        out["estimated"] = True
    out["kind"] = classify(text_chars, len(infos), full_page_image, paths)
    return out


def _meta(doc: fitz.Document, key: str) -> str | None:
    value = (doc.metadata or {}).get(key)
    return value[:META_MAX] if isinstance(value, str) and value else None


def run(config: dict[str, Any]) -> dict[str, Any]:
    pdf_path = config.get("pdfPath")
    if not isinstance(pdf_path, str) or not pdf_path:
        return {"status": "error", "error": "bad_input", "message": "pdfPath is required"}
    max_paths = int(config.get("maxPaths") or DEFAULT_MAX_PATHS)
    max_content_bytes = int(config.get("maxContentBytes") or DEFAULT_MAX_CONTENT_BYTES)
    page_budget = float(config.get("pageTimeBudgetMs") or DEFAULT_PAGE_BUDGET_MS)
    total_budget = config.get("totalBudgetMs")
    total_budget = float(total_budget) if total_budget else None

    started = time.monotonic()
    try:
        doc = fitz.open(pdf_path)
    except Exception as exc:  # noqa: BLE001 — any open failure is one error line
        return {"status": "error", "error": "open_failed", "message": str(exc)[:300]}
    try:
        if doc.needs_pass:
            return {"status": "error", "error": "pdf_encrypted", "message": "a password is required"}
        try:
            ocg_layers = len(doc.get_ocgs() or {})
        except Exception:  # noqa: BLE001
            ocg_layers = 0
        pages: list[dict[str, Any]] = []
        truncated = False
        slowest_ms = 0.0  # [census F2 2026-10-24] a page that cannot finish inside the budget never starts
        for index in range(doc.page_count):
            number = index + 1
            if total_budget is not None and (time.monotonic() - started) * 1000 + slowest_ms > total_budget:
                truncated = True
                pages.append({"pageNumber": number, "error": "budget"})
                continue
            t0 = time.monotonic()
            try:
                record = {"pageNumber": number, **census_page(doc[index], max_paths, max_content_bytes)}
            except Exception as exc:  # noqa: BLE001 — one page never kills the run
                record = {"pageNumber": number, "error": str(exc)[:200] or type(exc).__name__}
            ms = round((time.monotonic() - t0) * 1000)
            slowest_ms = max(slowest_ms, (time.monotonic() - t0) * 1000)
            record["ms"] = ms
            if ms > page_budget:
                record["slow"] = True
            pages.append(record)
        return {
            "status": "ok",
            "v": VERSION,
            "pageCount": doc.page_count,
            "ocgLayers": ocg_layers,
            "producer": _meta(doc, "producer"),
            "creator": _meta(doc, "creator"),
            "encrypted": bool(doc.is_encrypted or (doc.metadata or {}).get("encryption")),
            "truncated": truncated,
            "seconds": round(time.monotonic() - started, 3),
            "pages": pages,
        }
    finally:
        doc.close()


def main() -> int:
    try:
        fitz.TOOLS.mupdf_display_errors(False)
    except Exception:  # noqa: BLE001 — older/newer bindings without the switch
        pass
    try:
        config = json.loads(sys.stdin.read() or "{}")
        if not isinstance(config, dict):
            raise ValueError("config must be a JSON object")
    except Exception as exc:  # noqa: BLE001
        result: dict[str, Any] = {"status": "error", "error": "bad_input", "message": str(exc)[:300]}
    else:
        result = run(config)
    sys.stdout.write("\n" + json.dumps(result, separators=(",", ":")) + "\n")
    sys.stdout.flush()
    return 0 if result["status"] == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
