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
from extract_keynotes import main as extract_keynotes_main

s3 = boto3.client("s3")

TMP = "/tmp"


def download_s3(bucket, key, local_path):
    """Download an S3 object to a local path."""
    s3.download_file(bucket, key, local_path)


def upload_json(bucket, key, data):
    """Upload a JSON object to S3."""
    s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=json.dumps(data).encode("utf-8"),
        ContentType="application/json",
    )


def clean_tmp():
    """Remove all files from /tmp to free ephemeral storage between invocations."""
    for f in os.listdir(TMP):
        path = os.path.join(TMP, f)
        if os.path.isfile(path) and f != "runtime":
            try:
                os.remove(path)
            except OSError:
                pass


def handle_template_match(event):
    """
    Download template + page PNGs from S3, run template matching, upload results.

    process_target(template_gray, target_path, config) takes:
      - template_gray: numpy array (grayscale image)
      - target_path: str (file path to target image)
      - config: dict with matching parameters
    Returns list of tuples: (nx, ny, nw, nh, confidence, method, scale) — LTWH normalized.
    """
    bucket = event["s3_bucket"]
    template_key = event["template_s3_key"]
    page_keys = event["page_s3_keys"]
    result_key = event["result_s3_key"]
    config = event.get("config", {})

    template_path = os.path.join(TMP, "template.png")
    download_s3(bucket, template_key, template_path)

    template_gray = cv2.imread(template_path, cv2.IMREAD_GRAYSCALE)
    if template_gray is None:
        return {
            "status": "error",
            "error": f"Failed to load template from s3://{bucket}/{template_key}",
            "match_count": 0,
        }

    all_results = []
    pages_processed = 0
    pages_failed = 0
    errors = []

    for i, page_key in enumerate(page_keys):
        page_path = os.path.join(TMP, f"page_{i:04d}.png")
        try:
            download_s3(bucket, page_key, page_path)
            hits = process_target(template_gray, page_path, config)

            for h in hits:
                all_results.append({
                    "page_s3_key": page_key,
                    "page_index": i,
                    "bbox": [round(h[0], 6), round(h[1], 6), round(h[2], 6), round(h[3], 6)],
                    "confidence": round(h[4], 4),
                    "method": h[5],
                    "scale": round(h[6], 3),
                })
            pages_processed += 1
        except Exception as e:
            pages_failed += 1
            errors.append(f"Page {page_key}: {e}")
            print(f"[lambda] template_match failed for {page_key}: {e}", file=sys.stderr)
        finally:
            try:
                os.remove(page_path)
            except OSError:
                pass

    upload_json(bucket, result_key, {
        "action": "template_match",
        "results": all_results,
        "pages_processed": pages_processed,
        "pages_failed": pages_failed,
        "errors": errors,
    })

    return {
        "status": "success" if pages_failed == 0 else "partial",
        "match_count": len(all_results),
        "pages_processed": pages_processed,
        "pages_failed": pages_failed,
        "result_s3_key": result_key,
    }


def handle_shape_parse(event):
    """
    Download page PNGs from S3, run keynote extraction, upload results.

    extract_keynotes_main(img_path) takes a file path string.
    Returns list of dicts: {"shape", "bbox": [l,t,r,b], "text", "contour"} — MinMax normalized.
    """
    bucket = event["s3_bucket"]
    page_keys = event["page_s3_keys"]
    result_key = event["result_s3_key"]

    all_results = []
    pages_processed = 0
    pages_failed = 0
    errors = []

    for i, page_key in enumerate(page_keys):
        page_path = os.path.join(TMP, f"page_{i:04d}.png")
        try:
            download_s3(bucket, page_key, page_path)
            keynotes = extract_keynotes_main(page_path)

            for k in keynotes:
                k["page_s3_key"] = page_key
                k["page_index"] = i
            all_results.extend(keynotes)
            pages_processed += 1
        except Exception as e:
            pages_failed += 1
            errors.append(f"Page {page_key}: {e}")
            print(f"[lambda] shape_parse failed for {page_key}: {e}", file=sys.stderr)
        finally:
            try:
                os.remove(page_path)
            except OSError:
                pass

    upload_json(bucket, result_key, {
        "action": "shape_parse",
        "results": all_results,
        "pages_processed": pages_processed,
        "pages_failed": pages_failed,
        "errors": errors,
    })

    return {
        "status": "success" if pages_failed == 0 else "partial",
        "match_count": len(all_results),
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
            result = handle_template_match(event)
        elif action == "shape_parse":
            result = handle_shape_parse(event)
        else:
            return {
                "status": "error",
                "error": f"Unknown action: {action}",
            }

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
