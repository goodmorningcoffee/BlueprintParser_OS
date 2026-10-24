"""
[census F2 2026-10-24] Regression tests for pdf_channels.py (the upload channel census behind
src/lib/pdf-channels). Every PDF is GENERATED here with fitz in tmp — no fixture files, no client
drawings. Pins: the per-page channel counts, the derived kind for each of the five kinds, the path
cap, the total-budget truncation, one bad page not killing the run, a clean JSON error for a
non-PDF, and the "last line is the JSON" stdout contract. Skips where PyMuPDF is absent.
"""
import json
import subprocess
import sys
from pathlib import Path

import pytest

fitz = pytest.importorskip("fitz")

SCRIPT = Path(__file__).with_name("pdf_channels.py")
sys.path.insert(0, str(SCRIPT.parent))
import pdf_channels  # noqa: E402


def run(config: dict) -> tuple[int, dict]:
    proc = subprocess.run(
        [sys.executable, str(SCRIPT)],
        input=json.dumps(config).encode(),
        capture_output=True,
        timeout=120,
    )
    lines = [ln for ln in proc.stdout.decode().splitlines() if ln.strip()]
    return proc.returncode, json.loads(lines[-1])


def add_lines(page, n: int) -> None:
    """n short strokes appended as raw content — fast even for 10^5 paths."""
    ops = [f"{(i * 7) % 500 + 20} {(i * 13) % 700 + 20} m {(i * 7) % 500 + 40} {(i * 13) % 700 + 25} l S" for i in range(n)]
    xref = page.get_contents()[0] if page.get_contents() else None
    if xref is None:
        page.insert_text((1, 1), " ")  # creates a content stream
        xref = page.get_contents()[0]
    doc = page.parent
    doc.update_stream(xref, doc.xref_stream(xref) + ("\nq 0.5 w\n" + "\n".join(ops) + "\nQ\n").encode())


def png_bytes(w: int, h: int) -> bytes:
    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, w, h), False)
    pix.clear_with(200)
    return pix.tobytes("png")


@pytest.fixture()
def five_kinds(tmp_path) -> Path:
    doc = fitz.open()
    # 1 text-only
    p = doc.new_page(width=612, height=792)
    p.insert_text((72, 72), "GENERAL NOTES 1. ALL WORK SHALL COMPLY", fontname="helv")
    p.insert_text((72, 100), "2. VERIFY DIMENSIONS", fontname="cour")
    # 2 vector (line-work + a label)
    p = doc.new_page(width=612, height=792)
    p.insert_text((72, 72), "FLOOR PLAN")
    add_lines(p, 300)
    # 3 scanned: one image over the whole page, no text
    p = doc.new_page(width=612, height=792)
    p.insert_image(p.rect, stream=png_bytes(60, 80))
    # 4 blank
    doc.new_page(width=612, height=792)
    # 5 mixed: full-page image + vector overlay + a link and an annotation
    p = doc.new_page(width=792, height=612)
    p.insert_image(p.rect, stream=png_bytes(80, 60))
    add_lines(p, 120)
    p.insert_link({"kind": fitz.LINK_URI, "from": fitz.Rect(10, 10, 50, 30), "uri": "https://example.invalid"})
    p.add_text_annot((100, 100), "check")
    path = tmp_path / "five.pdf"
    doc.set_metadata({"producer": "generated-test", "creator": "pytest"})
    doc.save(path)
    return path


def test_five_kinds_and_channel_counts(five_kinds):
    code, out = run({"pdfPath": str(five_kinds)})
    assert code == 0 and out["status"] == "ok" and out["v"] == 1
    assert out["pageCount"] == 5 and out["truncated"] is False
    assert out["producer"] == "generated-test" and out["creator"] == "pytest"
    assert out["encrypted"] is False and out["ocgLayers"] == 0
    kinds = [pg["kind"] for pg in out["pages"]]
    assert kinds == ["text-only", "vector", "scanned", "blank", "mixed"]
    text, vector, scanned, blank, mixed = out["pages"]
    assert [pg["pageNumber"] for pg in out["pages"]] == [1, 2, 3, 4, 5]
    assert text["textChars"] > 30 and text["textWords"] >= 9 and text["fonts"] == 2
    assert text["vectorPaths"] == 0 and text["images"] == 0
    assert vector["vectorPaths"] == 300 and vector["textWords"] == 2
    assert scanned["images"] == 1 and scanned["fullPageImage"] is True and scanned["textChars"] == 0
    assert blank["textChars"] == 0 and blank["images"] == 0 and blank["vectorPaths"] == 0
    assert mixed["fullPageImage"] is True and mixed["vectorPaths"] >= 120
    assert mixed["links"] == 1 and mixed["annots"] == 1
    assert mixed["widthPt"] == 792 and mixed["heightPt"] == 612 and mixed["rotation"] == 0
    assert all("capped" not in pg for pg in out["pages"])
    assert all(isinstance(pg["ms"], int) for pg in out["pages"])


def test_path_cap(tmp_path):
    doc = fitz.open()
    add_lines(doc.new_page(), 5000)
    path = tmp_path / "dense.pdf"
    doc.save(path)
    code, out = run({"pdfPath": str(path), "maxPaths": 1000})
    assert code == 0
    (pg,) = out["pages"]
    assert pg["vectorPaths"] == 1000 and pg["capped"] is True and pg["kind"] == "vector"


def test_partial_image_without_text_is_scanned_and_small_logo_on_text_is_text_only():
    assert pdf_channels.classify(0, 2, False, 0) == "scanned"
    assert pdf_channels.classify(400, 1, False, 3) == "text-only"
    assert pdf_channels.classify(0, 0, False, pdf_channels.VECTOR_MIN - 1) == "blank"
    assert pdf_channels.classify(0, 0, False, pdf_channels.VECTOR_MIN) == "vector"
    assert pdf_channels.classify(900, 1, True, 10) == "scanned"  # OCR overlay on a scan


def test_total_budget_truncates_instead_of_running_on(five_kinds):
    code, out = run({"pdfPath": str(five_kinds), "totalBudgetMs": 0.0001})
    assert code == 0 and out["truncated"] is True
    assert out["pages"][-1] == {"pageNumber": 5, "error": "budget"}
    assert len(out["pages"]) == 5


def test_rotation_and_slow_flag(tmp_path):
    doc = fitz.open()
    p = doc.new_page(width=612, height=792)
    p.insert_text((72, 72), "ROTATED")
    p.set_rotation(90)
    path = tmp_path / "rot.pdf"
    doc.save(path)
    code, out = run({"pdfPath": str(path), "pageTimeBudgetMs": 0.0001})
    (pg,) = out["pages"]
    assert pg["rotation"] == 90 and pg["widthPt"] == 792 and pg["heightPt"] == 612
    assert pg["slow"] is True


def test_one_failing_page_does_not_kill_the_run(five_kinds, monkeypatch):
    real = pdf_channels.census_page

    def flaky(page, *args):
        if page.number == 1:
            raise RuntimeError("boom")
        return real(page, *args)

    monkeypatch.setattr(pdf_channels, "census_page", flaky)
    out = pdf_channels.run({"pdfPath": str(five_kinds)})
    assert out["status"] == "ok"
    assert out["pages"][1]["error"] == "boom" and "kind" not in out["pages"][1]
    assert out["pages"][0]["kind"] == "text-only" and out["pages"][2]["kind"] == "scanned"


def test_not_a_pdf_is_a_clean_error(tmp_path):
    bad = tmp_path / "bad.pdf"
    bad.write_bytes(b"this is not a pdf")
    code, out = run({"pdfPath": str(bad)})
    assert code == 1 and out["status"] == "error" and out["error"] == "open_failed"


def test_bad_input_is_a_clean_error():
    proc = subprocess.run([sys.executable, str(SCRIPT)], input=b"not json", capture_output=True, timeout=60)
    out = json.loads(proc.stdout.decode().strip().splitlines()[-1])
    assert proc.returncode == 1 and out == {"status": "error", "error": "bad_input", "message": out["message"]}
    code, out = run({})
    assert code == 1 and out["error"] == "bad_input"


def test_big_content_skips_bboxlog_and_estimates(tmp_path, monkeypatch):
    """[census F2 2026-10-24] past maxContentBytes the page is never handed to get_bboxlog (its
    memory is unbounded); paint operators are counted instead, stopped past maxPaths."""
    doc = fitz.open()
    add_lines(doc.new_page(), 3000)
    path = tmp_path / "big.pdf"
    doc.save(path)

    def no_bboxlog(self):
        raise AssertionError("get_bboxlog must not run over maxContentBytes")

    code, exact = run({"pdfPath": str(path)})
    assert code == 0 and exact["pages"][0]["vectorPaths"] == 3000 and "estimated" not in exact["pages"][0]
    code, out = run({"pdfPath": str(path), "maxContentBytes": 1000})
    (pg,) = out["pages"]
    assert pg["vectorPaths"] == 3000 and pg["estimated"] is True and "capped" not in pg and pg["kind"] == "vector"
    code, out = run({"pdfPath": str(path), "maxContentBytes": 1000, "maxPaths": 500})
    (pg,) = out["pages"]
    assert pg["vectorPaths"] == 500 and pg["capped"] is True and pg["estimated"] is True
    monkeypatch.setattr(fitz.Page, "get_bboxlog", no_bboxlog)
    out = pdf_channels.run({"pdfPath": str(path), "maxContentBytes": 1000})
    assert out["pages"][0]["vectorPaths"] == 3000 and out["pages"][0]["estimated"] is True


def test_paint_operator_scan_counts_only_paints():
    data = b"q 1 0 0 1 0 0 cm 0 0 m 1 1 l S 0 0 5 5 re f* 0 0 m 2 2 l h B\n0 0 9 9 re W n (S f) Tj /Fm0 Do Q"
    assert sum(1 for _ in pdf_channels.PAINT_OP.finditer(data)) == 3


def test_budget_stops_before_a_page_that_cannot_finish(five_kinds, monkeypatch):
    """[census F2 2026-10-24] elapsed + the slowest page so far past the budget → stop, so the Node
    kill (budget + 5 s) never lands mid-page and loses the whole result."""
    import time as _time

    real = pdf_channels.census_page

    def slow(page, *args):
        _time.sleep(0.25)
        return real(page, *args)

    monkeypatch.setattr(pdf_channels, "census_page", slow)
    out = pdf_channels.run({"pdfPath": str(five_kinds), "totalBudgetMs": 400})
    assert out["truncated"] is True
    assert "kind" in out["pages"][0]
    assert out["pages"][1:] == [{"pageNumber": n, "error": "budget"} for n in range(2, 6)]
