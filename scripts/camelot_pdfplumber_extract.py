#!/usr/bin/env python3
"""
camelot_pdfplumber_extract.py — Table extraction using Camelot and pdfplumber.

Runs up to 3 methods on a native PDF:
  - Camelot Lattice (line-based, reads PDF vector lines)
  - Camelot Stream (text-positioning, for borderless tables)
  - pdfplumber (raw PDF line/rect objects with sub-pixel precision)

Input: JSON on stdin with pdf_path, page_number, region_bbox
Output: JSON array on stdout, one MethodResult per method
"""

import sys
import json


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
    try:
        import camelot

        # Camelot uses 1-indexed page strings
        tables = camelot.read_pdf(
            pdf_path,
            pages=str(page_number),
            flavor=flavor,
            suppress_stdout=True,
        )

        if not tables or len(tables) == 0:
            return {"method": method_name, "headers": [], "rows": [], "confidence": 0}

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
        import pdfplumber

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
        print(f"pdfplumber: {len(lines)} lines, {len(rects)} rects in region", file=sys.stderr)

        # Extract tables
        table_data = cropped.extract_tables()

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
    config = json.loads(sys.stdin.read())
    pdf_path = config["pdf_path"]
    page_number = config["page_number"]
    region_bbox = config["region_bbox"]
    methods = config.get("methods", ["camelot-lattice", "camelot-stream", "pdfplumber"])

    results = []

    if "camelot-lattice" in methods:
        results.append(run_camelot(pdf_path, page_number, region_bbox, "lattice"))

    if "camelot-stream" in methods:
        results.append(run_camelot(pdf_path, page_number, region_bbox, "stream"))

    if "pdfplumber" in methods:
        results.append(run_pdfplumber(pdf_path, page_number, region_bbox))

    print(json.dumps(results))
