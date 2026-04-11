#!/usr/bin/env python3
"""
check_deps.py — Verify all Python and system dependencies for BlueprintParser.

Run: python3 scripts/check_deps.py

Checks:
  - Python version (warn if 3.14+)
  - System tools: Ghostscript, Tesseract
  - Core Python packages: opencv, numpy, img2table, camelot, pdfplumber
  - ML packages: torch, torchvision, transformers, timm
  - TATR model files
"""

import sys
import shutil
import os

OK = "\033[92mOK\033[0m"
FAIL = "\033[91mFAIL\033[0m"
WARN = "\033[93mWARN\033[0m"

failures = 0


def check(label, passed, detail="", warn_only=False):
    global failures
    if passed:
        print(f"  [{OK}]   {label}" + (f" ({detail})" if detail else ""))
    elif warn_only:
        print(f"  [{WARN}]  {label}" + (f" — {detail}" if detail else ""))
    else:
        print(f"  [{FAIL}]  {label}" + (f" — {detail}" if detail else ""))
        failures += 1


print("=== Python Environment ===")
v = sys.version_info
check("Python version", v.major == 3 and v.minor <= 13,
      f"{v.major}.{v.minor}.{v.micro}" + (" — Python 3.14+ breaks torch/torchvision" if v.minor >= 14 else ""),
      warn_only=(v.minor >= 14))

print("\n=== System Tools ===")
gs = shutil.which("gs")
check("Ghostscript (gs)", gs is not None,
      gs if gs else "MISSING — needed for PDF rasterization (apt-get install ghostscript)")

tess = shutil.which("tesseract")
check("Tesseract OCR", tess is not None,
      tess if tess else "MISSING — needed for OCR (apt-get install tesseract-ocr)")

print("\n=== Core Python Packages ===")
for mod, name in [
    ("cv2", "opencv"),
    ("numpy", "numpy"),
    ("PIL", "Pillow"),
    ("pdfplumber", "pdfplumber"),
    ("polars", "polars"),
]:
    try:
        m = __import__(mod)
        ver = getattr(m, "__version__", "OK")
        check(name, True, ver)
    except ImportError as e:
        check(name, False, str(e))

print("\n=== Table Parsing Packages ===")
for mod, name, extra in [
    ("img2table.document", "img2table", ""),
    ("img2table.ocr", "img2table.ocr (TesseractOCR)", ""),
    ("camelot", "camelot-py", ""),
    ("pdfplumber", "pdfplumber", ""),
]:
    try:
        __import__(mod)
        check(name, True)
    except ImportError as e:
        check(name, False, str(e))

# PROD-FIX-3: PyMuPDF (fitz) is needed by Phase C's img2table PDF mode for
# in-memory PDF cropping AND by camelot-fix for the same purpose. img2table
# itself imports fine without it (lazy fitz import), so this needs to be
# checked explicitly. Production was missing this for one full release.
try:
    import fitz
    ver = getattr(fitz, "version", None) or getattr(fitz, "__doc__", "")
    short = (ver[:60] if isinstance(ver, str) else str(ver))
    check("PyMuPDF (fitz)", True, short.strip() or "OK")
except Exception as e:
    check("PyMuPDF (fitz)", False, f"{e} — needed for img2table PDF mode + camelot crop. pip install pymupdf")

# Check if img2table TesseractOCR actually instantiates
try:
    from img2table.ocr import TesseractOCR
    ocr = TesseractOCR(lang="eng")
    check("img2table TesseractOCR runtime", True)
except Exception as e:
    check("img2table TesseractOCR runtime", False, str(e))

print("\n=== ML Packages (TATR Cell Structure) ===")
for mod, name in [
    ("torch", "torch"),
    ("torchvision", "torchvision"),
]:
    try:
        m = __import__(mod)
        check(name, True, getattr(m, "__version__", "OK"))
    except Exception as e:
        msg = str(e).split("\n")[0][:80]
        check(name, False, msg)

for cls_name, mod_path in [
    ("TableTransformerForObjectDetection", "transformers"),
    ("AutoImageProcessor", "transformers"),
]:
    try:
        mod = __import__(mod_path, fromlist=[cls_name])
        getattr(mod, cls_name)
        check(f"{mod_path}.{cls_name}", True)
    except Exception as e:
        msg = str(e).split("\n")[0][:80]
        check(f"{mod_path}.{cls_name}", False, msg)

try:
    import timm
    check("timm", True, timm.__version__)
except Exception as e:
    msg = str(e).split("\n")[0][:80]
    check("timm", False, msg)

print("\n=== Model Files ===")
model_dir = os.path.join(os.path.dirname(__file__), "..", "models", "tatr")
model_dir = os.path.normpath(model_dir)
has_model = os.path.isfile(os.path.join(model_dir, "model.safetensors"))
has_config = os.path.isfile(os.path.join(model_dir, "config.json"))
check("TATR model directory", os.path.isdir(model_dir), model_dir if os.path.isdir(model_dir) else "NOT FOUND")
check("TATR model weights", has_model, "model.safetensors" if has_model else "MISSING")
check("TATR model config", has_config, "config.json" if has_config else "MISSING")

print(f"\n{'='*50}")
if failures == 0:
    print(f"All checks passed.")
else:
    print(f"{failures} check(s) failed. See above for details.")
sys.exit(1 if failures > 0 else 0)
