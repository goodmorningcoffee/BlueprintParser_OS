#!/usr/bin/env python3
"""
img2table_extract.py — Table extraction using img2table library.

Two extraction modes:
- pdf:   Img2TablePDF on a PDF cropped to the region. Uses native PDF text via
         PdfOCR class (perfect spelling, no Tesseract OCR errors). Falls back
         to TesseractOCR internally for non-native pages.
- image: Img2TableImage on a rasterized + cropped PNG. Original behavior.

Input: JSON on stdin with at least region_bbox + (pdf_path OR image_path).
Output: JSON on stdout with MethodResult format.
"""

import sys
import json

try:
    import numpy as np
    from img2table.document import Image as Img2TableImage
    from img2table.document import PDF as Img2TablePDF
    from img2table.ocr import TesseractOCR
except ImportError:
    print(json.dumps({"method": "img2table", "headers": [], "rows": [], "confidence": 0,
                       "error": "img2table not installed"}))
    sys.exit(0)


def _table_to_method_result(best_table, region_bbox: list, crop_w: int, crop_h: int) -> dict:
    """
    Convert a single img2table ExtractedTable into a MethodResult dict.

    This is the shared post-processing for both image mode (Img2TableImage)
    and PDF mode (Img2TablePDF). Both modes produce ExtractedTable instances
    with the same shape: bbox in pixel coords at the rasterized DPI, df as a
    pandas DataFrame, content as OrderedDict[row_idx -> List[TableCell]].

    Args:
        best_table: img2table ExtractedTable instance (the chosen table)
        region_bbox: [rx0, ry0, rx1, ry1] normalized 0-1 of the source page
        crop_w: width of the rasterized crop in pixels
        crop_h: height of the rasterized crop in pixels

    Returns:
        dict matching the TS MethodResult shape (method/headers/rows/confidence/...)
        or an error dict if the table is empty.
    """
    rx0, ry0, rx1, ry1 = region_bbox

    df = best_table.df
    if df is None or df.empty:
        return {"method": "img2table", "headers": [], "rows": [], "confidence": 0,
                "error": "img2table found a table region but the DataFrame was empty (likely OCR returned no readable text)"}

    nr, nc = df.shape

    # Use first row as potential headers, or generate column names
    headers = [str(c) for c in df.columns]
    if all(str(h).isdigit() for h in headers):
        headers = [f"Column {int(h) + 1}" for h in headers]

    rows = []
    for _, row in df.iterrows():
        row_dict = {}
        for h_idx, h in enumerate(headers):
            val = str(row.iloc[h_idx]) if h_idx < len(row) else ""
            row_dict[h] = val if val != "None" and val != "nan" else ""
        rows.append(row_dict)

    if not rows:
        return {"method": "img2table", "headers": [], "rows": [], "confidence": 0,
                "error": "img2table parsed table headers but extracted no data rows"}

    # Compute column and row boundaries (normalized to page).
    # img2table content is OrderedDict[row_idx -> List[TableCell]] with .bbox
    # (BBox x1,y1,x2,y2) in pixel coords at the rasterized DPI of the crop.
    col_xs = set()
    row_ys = set()
    for row_cells in best_table.content.values():
        for cell in row_cells:
            col_xs.add(cell.bbox.x1)
            col_xs.add(cell.bbox.x2)
            row_ys.add(cell.bbox.y1)
            row_ys.add(cell.bbox.y2)

    sorted_cols = sorted(col_xs)
    sorted_rows = sorted(row_ys)

    # Normalize to page coords: pixel_in_crop / crop_size * region_size + region_offset
    col_boundaries = [rx0 + (x / crop_w) * (rx1 - rx0) for x in sorted_cols] if crop_w > 0 else []
    row_boundaries = [ry0 + (y / crop_h) * (ry1 - ry0) for y in sorted_rows] if crop_h > 0 else []

    # Confidence: content(0-0.4) + structure(0-0.3) + features(0-0.1), capped at 0.85
    filled = sum(1 for r in rows for v in r.values() if v.strip())
    total = len(rows) * len(headers)
    fill_rate = filled / total if total > 0 else 0
    confidence = fill_rate * 0.4
    if nr >= 3 and nc >= 2:
        confidence += 0.2
    if nr >= 5:
        confidence += 0.1
    confidence = min(confidence, 0.85)

    return {
        "method": "img2table",
        "headers": headers,
        "rows": rows,
        "confidence": round(confidence, 3),
        "colBoundaries": [round(x, 6) for x in col_boundaries],
        "rowBoundaries": [round(y, 6) for y in row_boundaries],
    }


def _pick_best_table(tables) -> object:
    """Pick the largest table by cell count from a list."""
    def table_size(t):
        d = t.df
        if d is None: return 0
        return d.shape[0] * d.shape[1] if hasattr(d, 'shape') else 0
    return max(tables, key=table_size)


def extract_table(image_path: str, region_bbox: list, dpi: int = 150,
                  detect_rotation: bool = False, implicit_rows: bool = True,
                  min_confidence: int = 50):
    """
    Extract tables from an image using img2table.

    Args:
        image_path: Path to the page image (PNG)
        region_bbox: [minX, minY, maxX, maxY] normalized 0-1
        dpi: Image DPI for processing
        detect_rotation: Whether to correct skew/rotation
        implicit_rows: Whether to split implicit rows
        min_confidence: Minimum OCR confidence (0-99)

    Returns:
        MethodResult dict
    """
    try:
        import cv2

        # Load image to get dimensions
        img_array = cv2.imread(image_path)
        if img_array is None:
            return {"method": "img2table", "headers": [], "rows": [], "confidence": 0,
                    "error": "Failed to load image"}

        img_h, img_w = img_array.shape[:2]

        # Crop to region
        rx0, ry0, rx1, ry1 = region_bbox
        crop_x0 = int(rx0 * img_w)
        crop_y0 = int(ry0 * img_h)
        crop_x1 = int(rx1 * img_w)
        crop_y1 = int(ry1 * img_h)
        cropped = img_array[crop_y0:crop_y1, crop_x0:crop_x1]

        # Write cropped image to temp file for img2table (unique name to avoid collisions)
        import tempfile
        import os
        import uuid
        tmp_path = os.path.join(tempfile.gettempdir(), f"bp2_img2table_{uuid.uuid4().hex[:8]}.png")
        cv2.imwrite(tmp_path, cropped)

        crop_h, crop_w = cropped.shape[:2]
        print(f"Cropped region: {crop_w}x{crop_h}", file=sys.stderr)

        # Create img2table Image from cropped region.
        # Do NOT pass dpi= here: the prod image's img2table rejects it with
        # TypeError even though the same 0.0.12 version accepts it in other
        # environments (stale/corrupted wheel suspected, unconfirmed). Class
        # default is 200 DPI which matches our pipeline, so dropping the kwarg
        # is a no-op functionally.
        doc = Img2TableImage(src=tmp_path, detect_rotation=detect_rotation)

        # Use Tesseract for OCR (already installed in our Docker image)
        ocr = TesseractOCR(lang="eng")

        # Extract tables
        tables = doc.extract_tables(ocr=ocr, implicit_rows=implicit_rows,
                                     min_confidence=min_confidence)

        # Clean up temp file after extraction completes
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

        if not tables:
            print("[image-mode] No tables detected by img2table", file=sys.stderr)
            return {"method": "img2table", "headers": [], "rows": [], "confidence": 0,
                    "error": "img2table image mode: no tables detected in region"}

        best_table = _pick_best_table(tables)
        d = best_table.df
        nr = d.shape[0] if d is not None and hasattr(d, 'shape') else 0
        nc = d.shape[1] if d is not None and hasattr(d, 'shape') else 0
        print(f"[image-mode] Best table: {nr}r x {nc}c", file=sys.stderr)

        return _table_to_method_result(best_table, region_bbox, crop_w, crop_h)

    except Exception as e:
        print(f"img2table error: {e}", file=sys.stderr)
        return {"method": "img2table", "headers": [], "rows": [], "confidence": 0,
                "error": str(e)}


def extract_from_pdf(pdf_path: str, page_number: int, region_bbox: list,
                     dpi: int = 200, implicit_rows: bool = True,
                     min_confidence: int = 30):
    """
    Extract a table from a PDF page region using img2table PDF mode.

    Crops the source PDF to the region using PyMuPDF (preserves native text),
    then runs Img2TablePDF on the cropped PDF. PDF mode auto-extracts native
    text via PdfOCR class — for vector blueprints this bypasses Tesseract OCR
    errors entirely. Falls back to TesseractOCR for pages without native text.

    Args:
        pdf_path: Path to the source PDF (full sheet)
        page_number: 1-indexed page number
        region_bbox: [minX, minY, maxX, maxY] normalized 0-1 of the page
        dpi: Rasterization DPI for img2table's internal table detection
        implicit_rows: Whether to split implicit rows
        min_confidence: Min OCR confidence (only used for non-native pages)

    Returns:
        MethodResult dict
    """
    try:
        import fitz  # PyMuPDF (transitive dep of img2table)
        import os
        import tempfile
        import uuid

        rx0, ry0, rx1, ry1 = region_bbox

        # Open source PDF and crop to region using PyMuPDF
        src_doc = fitz.open(pdf_path)
        if page_number < 1 or page_number > src_doc.page_count:
            src_doc.close()
            return {"method": "img2table", "headers": [], "rows": [], "confidence": 0,
                    "error": f"page {page_number} out of range (PDF has {src_doc.page_count} pages)"}

        page = src_doc.load_page(page_number - 1)
        page_w_pts = page.mediabox.width
        page_h_pts = page.mediabox.height

        # Compute crop in PDF points
        crop_x0 = rx0 * page_w_pts
        crop_y0 = ry0 * page_h_pts
        crop_x1 = rx1 * page_w_pts
        crop_y1 = ry1 * page_h_pts
        crop_w_pts = crop_x1 - crop_x0
        crop_h_pts = crop_y1 - crop_y0

        if crop_w_pts <= 0 or crop_h_pts <= 0:
            src_doc.close()
            return {"method": "img2table", "headers": [], "rows": [], "confidence": 0,
                    "error": f"invalid region bbox {region_bbox}: zero or negative dimensions"}

        # Create a new in-memory PDF with just the cropped region.
        # show_pdf_page preserves text (so PdfOCR can extract native text from
        # the crop) and vector graphics (so Hough line detection still works).
        new_doc = fitz.open()
        new_page = new_doc.new_page(width=crop_w_pts, height=crop_h_pts)
        new_page.show_pdf_page(
            new_page.rect,
            src_doc,
            page_number - 1,
            clip=fitz.Rect(crop_x0, crop_y0, crop_x1, crop_y1),
        )
        cropped_pdf_bytes = new_doc.write()
        new_doc.close()
        src_doc.close()

        # Crop dimensions in pixels at the chosen DPI (used to normalize cell
        # bboxes back to page coordinates in the helper).
        crop_w = round(crop_w_pts * dpi / 72)
        crop_h = round(crop_h_pts * dpi / 72)
        print(f"[pdf-mode] Cropped region: {crop_w_pts:.0f}x{crop_h_pts:.0f} pts "
              f"-> {crop_w}x{crop_h} px @ {dpi} DPI", file=sys.stderr)

        # Write cropped PDF to a temp file (img2table accepts bytes too, but
        # a path is simpler to debug if something goes wrong).
        tmp_path = os.path.join(tempfile.gettempdir(), f"bp2_img2table_pdf_{uuid.uuid4().hex[:8]}.pdf")
        with open(tmp_path, "wb") as f:
            f.write(cropped_pdf_bytes)

        try:
            # Do NOT pass dpi= here — see note above on Img2TableImage call.
            doc = Img2TablePDF(src=tmp_path)
            ocr = TesseractOCR(lang="eng")
            tables_by_page = doc.extract_tables(ocr=ocr, implicit_rows=implicit_rows,
                                                 min_confidence=min_confidence)
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

        # Single-page cropped PDF, so always page index 0
        page_tables = tables_by_page.get(0, [])
        if not page_tables:
            print("[pdf-mode] No tables detected by img2table", file=sys.stderr)
            return {"method": "img2table", "headers": [], "rows": [], "confidence": 0,
                    "error": "img2table PDF mode: no tables detected in cropped region"}

        best_table = _pick_best_table(page_tables)
        d = best_table.df
        nr = d.shape[0] if d is not None and hasattr(d, 'shape') else 0
        nc = d.shape[1] if d is not None and hasattr(d, 'shape') else 0
        print(f"[pdf-mode] Best table: {nr}r x {nc}c", file=sys.stderr)

        return _table_to_method_result(best_table, region_bbox, crop_w, crop_h)

    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        return {"method": "img2table", "headers": [], "rows": [], "confidence": 0,
                "error": f"img2table PDF mode failed: {e}"}


if __name__ == "__main__":
    config = json.loads(sys.stdin.read())

    # Mode dispatch:
    #   "auto": try PDF mode if pdf_path present, fall back to image mode on empty
    #   "pdf":  PDF mode only (error if pdf_path missing)
    #   "image": image mode only (existing behavior)
    mode = config.get("mode", "auto")
    pdf_path = config.get("pdf_path")
    image_path = config.get("image_path")
    region_bbox = config["region_bbox"]
    page_number = config.get("page_number", 1)

    def run_pdf_mode():
        return extract_from_pdf(
            pdf_path=pdf_path,
            page_number=page_number,
            region_bbox=region_bbox,
            dpi=config.get("dpi", 200),
            implicit_rows=config.get("implicit_rows", True),
            min_confidence=config.get("min_confidence", 30),
        )

    def run_image_mode():
        return extract_table(
            image_path=image_path,
            region_bbox=region_bbox,
            dpi=config.get("dpi", 200),
            detect_rotation=config.get("detect_rotation", False),
            implicit_rows=config.get("implicit_rows", True),
            min_confidence=config.get("min_confidence", 30),
        )

    if mode == "pdf":
        if not pdf_path:
            result = {"method": "img2table", "headers": [], "rows": [], "confidence": 0,
                      "error": "mode=pdf requires pdf_path in stdin config"}
        else:
            result = run_pdf_mode()
    elif mode == "image":
        if not image_path:
            result = {"method": "img2table", "headers": [], "rows": [], "confidence": 0,
                      "error": "mode=image requires image_path in stdin config"}
        else:
            result = run_image_mode()
    else:  # mode == "auto"
        if pdf_path:
            result = run_pdf_mode()
            # Fall back to image mode if PDF mode produced nothing AND we have an image
            if (not result.get("rows") or not result.get("headers")) and image_path:
                print(f"[auto-mode] PDF mode returned empty ({result.get('error', 'no error')}), falling back to image mode", file=sys.stderr)
                image_result = run_image_mode()
                # Prefer image result only if it has actual data
                if image_result.get("rows") and image_result.get("headers"):
                    image_result["method"] = "img2table"  # keep method name consistent
                    result = image_result
        elif image_path:
            result = run_image_mode()
        else:
            result = {"method": "img2table", "headers": [], "rows": [], "confidence": 0,
                      "error": "mode=auto requires pdf_path or image_path in stdin config"}

    print(json.dumps(result))
