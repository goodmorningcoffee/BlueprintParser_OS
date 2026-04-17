#!/usr/bin/env python3
"""
Lambda handler for the CV pipeline.

Dual-mode: template_match (symbol search) and shape_parse (keynote detection).
Downloads page images from S3, runs the existing Python CV functions, uploads
results JSON back to S3. The web server orchestrates fan-out and collects results.

Lambda stays pure: image in → bboxes out. OCR-to-shape binding (Textract word
matching) runs on the web server because it needs DB access.
"""

import json
import os
import sys
import time
import traceback

import boto3
import cv2

from template_match import process_target, nms_boxes
# Worker contract: worker_fn(page_path) → (results_list, warnings_list).
# `extract_keynotes.main()` already returns this shape; `template_match`
# has no warnings and returns []. Warnings flow through process_pages
# into the S3 result JSON so the TS fan-out can surface them to the UI.
from extract_keynotes import main as extract_keynotes_main

s3 = boto3.client("s3")

TMP = "/tmp"


def download_s3(bucket, key, local_path):
    s3.download_file(bucket, key, local_path)


def upload_json(bucket, key, data):
    s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=json.dumps(data).encode("utf-8"),
        ContentType="application/json",
    )


def clean_tmp():
    for f in os.listdir(TMP):
        path = os.path.join(TMP, f)
        if os.path.isfile(path) and f != "runtime":
            try:
                os.remove(path)
            except OSError:
                pass


def process_pages(event, worker_fn):
    """
    Generic page processor.

    worker_fn(page_path) → (results_list, warnings_list).
      results_list: result dicts, each with at least bbox/confidence fields.
      warnings_list: human-readable diagnostic strings (e.g. "0 keynotes
      after tiled sweep"). Empty list when the worker has no diagnostics.
    Downloads pages from S3, calls worker_fn, collects results + warnings,
    uploads JSON.
    """
    bucket = event["s3_bucket"]
    page_keys = event["page_s3_keys"]
    result_key = event["result_s3_key"]
    action = event.get("action", "unknown")

    all_results = []
    all_warnings = []
    pages_processed = 0
    pages_failed = 0
    errors = []

    for i, page_key in enumerate(page_keys):
        page_path = os.path.join(TMP, f"page_{i:04d}.png")
        try:
            download_s3(bucket, page_key, page_path)
            hits, page_warnings = worker_fn(page_path)

            for h in hits:
                h["page_s3_key"] = page_key
                h["page_index"] = i
            all_results.extend(hits)
            if page_warnings:
                all_warnings.extend(page_warnings)
            pages_processed += 1
        except Exception as e:
            pages_failed += 1
            errors.append(f"Page {page_key}: {e}")
            print(f"[lambda] {action} failed for {page_key}: {e}", file=sys.stderr)
        finally:
            try:
                os.remove(page_path)
            except OSError:
                pass

    upload_json(bucket, result_key, {
        "action": action,
        "results": all_results,
        "warnings": all_warnings,
        "pages_processed": pages_processed,
        "pages_failed": pages_failed,
        "errors": errors[:50],
    })

    return {
        "status": "success" if pages_failed == 0 else "partial",
        "match_count": len(all_results),
        "warnings_count": len(all_warnings),
        "pages_processed": pages_processed,
        "pages_failed": pages_failed,
        "result_s3_key": result_key,
    }


def handler(event, context):
    """
    AWS Lambda entry point. Dispatches to template_match or shape_parse.

    Event schema:
    {
        "action": "template_match" | "shape_parse",
        "s3_bucket": str,
        "template_s3_key": str,          // template_match only
        "page_s3_keys": [str, ...],      // S3 keys for page PNGs
        "result_s3_key": str,            // where to write results JSON
        "config": { ... }               // matching parameters (optional)
    }
    """
    action = event.get("action")
    start = time.time()

    try:
        clean_tmp()

        if action == "template_match":
            bucket = event["s3_bucket"]
            config = event.get("config", {})
            template_path = os.path.join(TMP, "template.png")
            download_s3(bucket, event["template_s3_key"], template_path)

            template_gray = cv2.imread(template_path, cv2.IMREAD_GRAYSCALE)
            if template_gray is None:
                return {
                    "status": "error",
                    "error": f"Failed to load template from s3://{bucket}/{event['template_s3_key']}",
                }

            def match_worker(page_path):
                hits = process_target(template_gray, page_path, config)
                results = [
                    {
                        "bbox": [round(h[0], 6), round(h[1], 6), round(h[2], 6), round(h[3], 6)],
                        "confidence": round(h[4], 4),
                        "method": h[5],
                        "scale": round(h[6], 3),
                    }
                    for h in hits
                ]
                return results, []

            result = process_pages(event, match_worker)

        elif action == "shape_parse":
            # extract_keynotes.main() already returns (results, diag_warnings) —
            # the worker_fn contract, so pass it through directly.
            result = process_pages(event, extract_keynotes_main)

        else:
            return {"status": "error", "error": f"Unknown action: {action}"}

        result["elapsed_ms"] = int((time.time() - start) * 1000)
        return result

    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        return {
            "status": "error",
            "error": str(e),
            "elapsed_ms": int((time.time() - start) * 1000),
        }
    finally:
        clean_tmp()
