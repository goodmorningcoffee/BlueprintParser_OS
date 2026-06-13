"""
[refactor jun13 P0.5-G10] process_pages status semantics.

All-pages-failed must be "error" — the TS fan-out treats "partial" as usable,
so an all-failed sweep used to surface as success-with-0-hits.

The CV stack (cv2/boto3/template_match/extract_keynotes) is a Lambda-image
dependency; modules are stubbed before import so this runs in any container.
Run: cd scripts && pytest test_lambda_handler.py -q
"""
import sys
import types

for _name in ("boto3", "cv2", "template_match", "extract_keynotes"):
    _mod = types.ModuleType(_name)
    if _name == "boto3":
        _mod.client = lambda *_a, **_k: None
    elif _name == "template_match":
        _mod.process_target = None
        _mod.nms_boxes = None
    elif _name == "extract_keynotes":
        _mod.main = None
    sys.modules.setdefault(_name, _mod)

import lambda_handler  # noqa: E402


def _event():
    return {
        "s3_bucket": "b",
        "page_s3_keys": ["pages/p1.png", "pages/p2.png"],
        "result_s3_key": "results/r.json",
        "action": "shape_parse",
    }


def _quiet_io(monkeypatch, uploaded):
    monkeypatch.setattr(lambda_handler, "download_s3", lambda *_a: None)
    monkeypatch.setattr(lambda_handler, "upload_json", lambda _b, _k, d: uploaded.update(d))


def test_all_pages_failed_is_error(monkeypatch):
    uploaded = {}
    _quiet_io(monkeypatch, uploaded)

    def boom(_path):
        raise RuntimeError("cv blew up")

    out = lambda_handler.process_pages(_event(), boom)
    assert out["status"] == "error"
    assert "All 2 pages failed" in out["error"]
    assert uploaded["pages_failed"] == 2


def test_some_pages_failed_stays_partial(monkeypatch):
    uploaded = {}
    _quiet_io(monkeypatch, uploaded)
    calls = {"n": 0}

    def flaky(_path):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("first page broke")
        return [{"bbox": [0, 0, 1, 1], "confidence": 0.9}], ["low contrast"]

    out = lambda_handler.process_pages(_event(), flaky)
    assert out["status"] == "partial"
    assert "error" not in out
    assert out["pages_processed"] == 1
    assert out["warnings_count"] == 1


def test_no_failures_is_success_and_warnings_flow(monkeypatch):
    uploaded = {}
    _quiet_io(monkeypatch, uploaded)

    def clean(_path):
        return [], ["0 keynotes after tiled sweep"]

    out = lambda_handler.process_pages(_event(), clean)
    assert out["status"] == "success"
    assert out["warnings_count"] == 2  # one per page
    assert uploaded["warnings"] == ["0 keynotes after tiled sweep"] * 2
