#!/usr/bin/env python3
"""
camelot_pdfplumber_extract.py — Table extraction using Camelot and pdfplumber.

Runs up to 3 methods on a native PDF:
  - Camelot Lattice (line-based, reads PDF vector lines)
  - Camelot Stream (text-positioning, for borderless tables)
  - pdfplumber (raw PDF line/rect objects with sub-pixel precision)

Input: JSON on stdin with pdf_path, page_number, region_bbox
Output: JSON array on stdout, one MethodResult per method

Debug instrumentation (added after camelot-pdfplumber timed out at 30s in
production on a 24×36 architectural sheet — needed visibility into WHICH
sub-method was eating the budget):

  - [CAMELOT_PROGRESS] <stage>          heartbeat markers; the LAST one printed
                                         before SIGKILL tells us exactly where
                                         the script was when the timeout fired
  - [CAMELOT_TIMING] <method> <fields>  per-sub-method duration + status
  - [PAGE_COMPLEXITY] <fields>          vector element counts on the page,
                                         pre-flight indicator of how hard
                                         camelot is going to have to work

  All print() calls use flush=True so the output appears in the wrapper's
  captured stderr even if the process is SIGKILLed mid-run. The wrapper
  surfaces this stderr in result.debug.stderr (Phase I.1.c) → visible in the
  admin Recent Parses drill-down.
"""

import sys
import json
import time


def overlap_ratio(bbox_a, bbox_b):
    """Compute intersection area / bbox_a area. All coords in same space."""
    x0 = max(bbox_a[0], bbox_b[0])
    y0 = max(bbox_a[1], bbox_b[1])
    x1 = min(bbox_a[2], bbox_b[2])
    y1 = min(bbox_a[3], bbox_b[3])
    if x0 >= x1 or y0 >= y1:
        return 0.0
    inter = (x1 - x0) * (y1 - y0)
    area_a = (bbox_a[2] - bbox_a[0]) * (bbox_a[3] - bbox_a[1])
    return inter / area_a if area_a > 0 else 0.0


def _progress(msg):
    """Print a [CAMELOT_PROGRESS] heartbeat marker to stderr.

    The wrapper captures this in debug.stderr. The LAST progress marker before
    SIGKILL tells us exactly which sub-method was running when the timeout fired.
    flush=True is critical so the marker appears even if the process is killed.
    """
    print(f"[CAMELOT_PROGRESS] {msg}", file=sys.stderr, flush=True)


def _run_timed(name, fn, *args):
    """Run a sub-method with timing instrumentation.

    Emits [CAMELOT_TIMING] structured stderr lines that the wrapper captures.
    On exception, the result dict still gets a duration field so partial info
    is available even when something failed.
    """
    t0 = time.time()
    _progress(f"{name} starting")
    try:
        result = fn(*args)
        elapsed_ms = round((time.time() - t0) * 1000)
        result["_sub_duration_ms"] = elapsed_ms
        rows = len(result.get("rows", []))
        cols = len(result.get("headers", []))
        status = "error" if result.get("error") else ("empty" if rows == 0 else "success")
        print(
            f"[CAMELOT_TIMING] {name} duration_ms={elapsed_ms} status={status} rows={rows} cols={cols}",
            file=sys.stderr,
            flush=True,
        )
        return result
    except Exception as e:
        elapsed_ms = round((time.time() - t0) * 1000)
        print(
            f"[CAMELOT_TIMING] {name} duration_ms={elapsed_ms} status=exception error={e}",
            file=sys.stderr,
            flush=True,
        )
        return {
            "method": name,
            "headers": [],
            "rows": [],
            "confidence": 0,
            "error": f"sub-method crashed: {e}",
            "_sub_duration_ms": elapsed_ms,
        }


def crop_pdf_to_region(pdf_path, page_number, region_bbox):
    """
    CAMELOT-FIX-1: crop the source PDF to just the region the user selected,
    then return the path to a temp PDF that camelot/pdfplumber can read.

    The original `run_camelot()` (and the dead `overlap_ratio()` helper at the
    top of this file) suggested filtering camelot's whole-page output by region
    AFTER the fact. That doesn't help because the EXPENSIVE part is camelot
    lattice's Hough line detection on the whole-page rasterized image — for a
    24×36 architectural sheet at camelot's default 300 DPI that's a ~108 MP
    image with thousands of vector lines from walls/dimensions/grids/hatches.
    Camelot was hanging the entire 30s timeout on the lattice call alone.

    This is the same in-memory crop trick Phase C.1 uses for img2table:
    PyMuPDF show_pdf_page(clip=...) preserves text + vector graphics from the
    cropped region into a tiny new single-page PDF. Camelot then only sees the
    schedule, not the entire sheet.

    Args:
        pdf_path: Path to source PDF
        page_number: 1-indexed page number
        region_bbox: [minX, minY, maxX, maxY] normalized 0-1 (top-left origin)

    Returns:
        (cropped_pdf_path, page_dimensions_pts) tuple, where
        page_dimensions_pts is (crop_w_pts, crop_h_pts) for caller's reference

    Raises:
        ImportError if PyMuPDF/fitz not installed
        ValueError if page_number out of range or region_bbox invalid
    """
    import fitz  # PyMuPDF — REQUIRED, will raise ImportError if missing
    import os
    import tempfile
    import uuid

    rx0, ry0, rx1, ry1 = region_bbox
    if rx0 >= rx1 or ry0 >= ry1:
        raise ValueError(f"invalid region_bbox {region_bbox}: zero/negative dimensions")

    src_doc = fitz.open(pdf_path)
    try:
        if page_number < 1 or page_number > src_doc.page_count:
            raise ValueError(f"page {page_number} out of range (PDF has {src_doc.page_count} pages)")

        page = src_doc.load_page(page_number - 1)
        # IMPORTANT: use page.rect (rotation-aware visible rectangle) not
        # page.mediabox (raw PDF box). For pages with a rotation set, mediabox
        # width/height don't match the visible orientation, and clip rects
        # computed from mediabox land outside the actual page. The local spike
        # test with mediabox failed with "clip must be finite and not empty".
        page_rect = page.rect
        page_w_pts = page_rect.width
        page_h_pts = page_rect.height

        # Compute clip in the same coordinate space as page.rect (top-left
        # origin, accounts for any non-zero page.rect.x0/y0 offset).
        crop_x0 = page_rect.x0 + rx0 * page_w_pts
        crop_y0 = page_rect.y0 + ry0 * page_h_pts
        crop_x1 = page_rect.x0 + rx1 * page_w_pts
        crop_y1 = page_rect.y0 + ry1 * page_h_pts
        crop_w_pts = crop_x1 - crop_x0
        crop_h_pts = crop_y1 - crop_y0

        clip_rect = fitz.Rect(crop_x0, crop_y0, crop_x1, crop_y1)
        if clip_rect.is_empty or not clip_rect.is_valid:
            raise ValueError(
                f"computed clip rect is invalid: {clip_rect} "
                f"(page_rect={page_rect}, region_bbox={region_bbox})"
            )

        # Build a new in-memory PDF with just the cropped region.
        # show_pdf_page preserves text + vector graphics so camelot's downstream
        # text extraction and Hough line detection both still work.
        new_doc = fitz.open()
        try:
            new_page = new_doc.new_page(width=crop_w_pts, height=crop_h_pts)
            new_page.show_pdf_page(
                new_page.rect,
                src_doc,
                page_number - 1,
                clip=clip_rect,
            )
            cropped_bytes = new_doc.write()
        finally:
            new_doc.close()
    finally:
        src_doc.close()

    tmp_path = os.path.join(tempfile.gettempdir(), f"bp2_camelot_crop_{uuid.uuid4().hex[:8]}.pdf")
    with open(tmp_path, "wb") as f:
        f.write(cropped_bytes)

    return tmp_path, (crop_w_pts, crop_h_pts)


def probe_page_complexity(pdf_path, page_number):
    """Count vector elements on the page before running camelot.

    Architectural sheets typically have thousands of vector lines (walls,
    dimensions, hatches) that look like potential table edges to camelot
    lattice's Hough line detector. High counts predict slow camelot lattice.
    Cheap (~50-200ms) — pdfplumber is already loaded for the pdfplumber method.
    """
    try:
        import pdfplumber
        with pdfplumber.open(pdf_path) as pdf:
            if page_number < 1 or page_number > len(pdf.pages):
                return None
            page = pdf.pages[page_number - 1]
            return {
                "vector_lines": len(page.lines or []),
                "vector_rects": len(page.rects or []),
                "vector_curves": len(page.curves or []),
                "chars": len(page.chars or []),
                "page_w_pts": float(page.width),
                "page_h_pts": float(page.height),
            }
    except Exception as e:
        return {"error": f"complexity probe failed: {e}"}


def run_camelot(pdf_path: str, page_number: int, region_bbox: list, flavor: str):
    """
    Run Camelot on a PDF page.

    Args:
        pdf_path: Path to PDF file
        page_number: 1-indexed page number
        region_bbox: [minX, minY, maxX, maxY] normalized 0-1
        flavor: "lattice" or "stream"

    Returns:
        MethodResult dict
    """
    method_name = f"camelot-{flavor}"
    cropped_pdf_path = None
    import os as _os
    try:
        _progress(f"{flavor}: importing camelot")
        import camelot

        # CAMELOT-FIX-1: crop the source PDF to just the user's region first.
        # Previously camelot processed the whole 24×36 sheet looking for tables
        # in thousands of vector lines and the lattice flavor would hang the
        # entire wrapper timeout. Now camelot only sees the schedule region.
        _progress(f"{flavor}: cropping PDF to region {region_bbox}")
        cropped_pdf_path, (crop_w_pts, crop_h_pts) = crop_pdf_to_region(
            pdf_path, page_number, region_bbox
        )
        _progress(
            f"{flavor}: cropped to {crop_w_pts:.0f}×{crop_h_pts:.0f} pts → {cropped_pdf_path}"
        )

        # Cropped PDF is single-page, so we always read page 1.
        # CAMELOT-FIX-3: lattice flavor gets line_scale=40 (default 15) so it
        # picks up thin (0.5-1pt) vector borders common on architectural
        # schedules. Spike test on a door schedule returned 1 row at
        # line_scale=15; 40 detects the finer row separators. Stream flavor
        # does not use line_scale.
        read_pdf_kwargs = {
            "pages": "1",
            "flavor": flavor,
            "suppress_stdout": True,
        }
        if flavor == "lattice":
            read_pdf_kwargs["line_scale"] = 40

        _progress(f"{flavor}: read_pdf starting (cropped, single page)")
        tables = camelot.read_pdf(cropped_pdf_path, **read_pdf_kwargs)
        _progress(f"{flavor}: read_pdf returned {len(tables) if tables else 0} tables")

        if not tables or len(tables) == 0:
            return {"method": method_name, "headers": [], "rows": [], "confidence": 0,
                    "error": f"camelot {flavor} found no tables in the cropped region"}

        # Camelot returns table bboxes in PDF coordinate space (points from bottom-left)
        # We need to find tables that overlap with our region_bbox (normalized 0-1 from top-left)
        # First, get page dimensions from the first table's parsing report
        best_table = None
        best_overlap = 0.0

        for table in tables:
            # table._bbox is (x0, y0_bottom, x1, y1_bottom) in PDF points
            # For simplicity, take the table with most cells if multiple detected
            df = table.df
            cell_count = df.shape[0] * df.shape[1]
            if best_table is None or cell_count > best_table.df.shape[0] * best_table.df.shape[1]:
                best_table = table

        if best_table is None:
            return {"method": method_name, "headers": [], "rows": [], "confidence": 0}

        df = best_table.df
        if df.empty:
            return {"method": method_name, "headers": [], "rows": [], "confidence": 0}

        # Convert DataFrame to MethodResult format
        # First row may or may not be headers — use generic column names
        headers = [f"Column {i + 1}" for i in range(df.shape[1])]
        rows = []
        for _, row in df.iterrows():
            row_dict = {}
            for ci, h in enumerate(headers):
                val = str(row.iloc[ci]).strip() if ci < len(row) else ""
                row_dict[h] = val if val != "None" and val != "nan" else ""
            if any(v for v in row_dict.values()):
                rows.append(row_dict)

        if not rows:
            return {"method": method_name, "headers": [], "rows": [], "confidence": 0}

        # Confidence — normalized: content(0-0.4) + structure(0-0.3) + features(0-0.2)
        filled = sum(1 for r in rows for v in r.values() if v.strip())
        total_cells = len(rows) * len(headers)
        fill_rate = filled / total_cells if total_cells > 0 else 0
        accuracy = best_table.accuracy / 100.0 if hasattr(best_table, "accuracy") else 0.5
        confidence = min(fill_rate * 0.4 + accuracy * 0.3 + 0.1, 0.90)

        return {
            "method": method_name,
            "headers": headers,
            "rows": rows,
            "confidence": round(confidence, 3),
        }

    except Exception as e:
        print(f"Camelot {flavor} error: {e}", file=sys.stderr)
        return {"method": method_name, "headers": [], "rows": [], "confidence": 0,
                "error": str(e)}
    finally:
        # CAMELOT-FIX-1 cleanup: remove the temp cropped PDF
        if cropped_pdf_path:
            try:
                _os.unlink(cropped_pdf_path)
            except OSError:
                pass


def run_pdfplumber(pdf_path: str, page_number: int, region_bbox: list):
    """
    Run pdfplumber on a PDF page to extract tables using actual vector lines.

    Args:
        pdf_path: Path to PDF file
        page_number: 1-indexed page number
        region_bbox: [minX, minY, maxX, maxY] normalized 0-1

    Returns:
        MethodResult dict
    """
    method_name = "pdfplumber"
    try:
        _progress("pdfplumber: importing pdfplumber")
        import pdfplumber

        _progress("pdfplumber: opening PDF")
        pdf = pdfplumber.open(pdf_path)
        if page_number > len(pdf.pages):
            pdf.close()
            return {"method": method_name, "headers": [], "rows": [], "confidence": 0}

        page = pdf.pages[page_number - 1]  # 0-indexed
        page_w = float(page.width)
        page_h = float(page.height)

        # Convert normalized bbox to PDF points (pdfplumber uses top-left origin, same as us)
        rx0, ry0, rx1, ry1 = region_bbox
        crop_bbox = (rx0 * page_w, ry0 * page_h, rx1 * page_w, ry1 * page_h)

        # Crop page to region
        cropped = page.within_bbox(crop_bbox)

        # Check if there are actual vector lines in this region
        lines = cropped.lines or []
        rects = cropped.rects or []
        _progress(f"pdfplumber: {len(lines)} lines, {len(rects)} rects in cropped region")

        # Extract tables
        _progress("pdfplumber: extract_tables starting")
        table_data = cropped.extract_tables()
        _progress(f"pdfplumber: extract_tables returned {len(table_data) if table_data else 0} tables")

        if not table_data:
            # Try find_tables for more info
            found = cropped.find_tables()
            if found:
                table_data = [found[0].extract()]
            else:
                pdf.close()
                return {"method": method_name, "headers": [], "rows": [], "confidence": 0}

        # Take the largest table
        best = max(table_data, key=lambda t: len(t) * (len(t[0]) if t else 0))

        if not best or len(best) < 1:
            pdf.close()
            return {"method": method_name, "headers": [], "rows": [], "confidence": 0}

        # Convert to MethodResult format
        num_cols = max(len(row) for row in best)
        headers = [f"Column {i + 1}" for i in range(num_cols)]
        rows = []
        for row in best:
            row_dict = {}
            for ci, h in enumerate(headers):
                val = (row[ci] or "").strip() if ci < len(row) else ""
                row_dict[h] = val
            if any(v for v in row_dict.values()):
                rows.append(row_dict)

        pdf.close()

        if not rows:
            return {"method": method_name, "headers": [], "rows": [], "confidence": 0}

        # Confidence — normalized: content(0-0.4) + structure(0-0.3) + features(0-0.2)
        has_lines = len(lines) > 3 or len(rects) > 1
        filled = sum(1 for r in rows for v in r.values() if v)
        total_cells = len(rows) * len(headers)
        fill_rate = filled / total_cells if total_cells > 0 else 0
        confidence = fill_rate * 0.4 + (0.25 if has_lines else 0.1) + 0.1
        confidence = min(confidence, 0.90)

        return {
            "method": method_name,
            "headers": headers,
            "rows": rows,
            "confidence": round(confidence, 3),
        }

    except Exception as e:
        print(f"pdfplumber error: {e}", file=sys.stderr)
        return {"method": method_name, "headers": [], "rows": [], "confidence": 0,
                "error": str(e)}


if __name__ == "__main__":
    overall_t0 = time.time()
    config = json.loads(sys.stdin.read())
    pdf_path = config["pdf_path"]
    page_number = config["page_number"]
    region_bbox = config["region_bbox"]
    methods = config.get("methods", ["camelot-lattice", "camelot-stream", "pdfplumber"])

    # Pre-flight: probe the page complexity. Architectural sheets typically have
    # thousands of vector lines that camelot lattice has to wade through.
    _progress(f"probing page complexity (page={page_number})")
    complexity = probe_page_complexity(pdf_path, page_number)
    print(f"[PAGE_COMPLEXITY] {json.dumps(complexity)}", file=sys.stderr, flush=True)

    results = []

    if "camelot-lattice" in methods:
        results.append(_run_timed("camelot-lattice", run_camelot, pdf_path, page_number, region_bbox, "lattice"))

    if "camelot-stream" in methods:
        results.append(_run_timed("camelot-stream", run_camelot, pdf_path, page_number, region_bbox, "stream"))

    if "pdfplumber" in methods:
        results.append(_run_timed("pdfplumber", run_pdfplumber, pdf_path, page_number, region_bbox))

    overall_ms = round((time.time() - overall_t0) * 1000)
    _progress(f"all sub-methods complete, total {overall_ms}ms")

    print(json.dumps(results))
