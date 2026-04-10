#!/usr/bin/env python3
"""
patch_img2table.py — Fix Polars API incompatibilities in img2table 0.0.12.

img2table uses deprecated Polars API that breaks with Polars >=0.20.
Run this once after `pip install img2table`.

Fixes:
  - pl.max([...]) → pl.max_horizontal(*[...])
  - pl.min([...]) → pl.min_horizontal(*[...])
  - .with_row_count() → .with_row_index()
  - .groupby() → .group_by()
  - .arr.lengths() → .list.len()
  - reverse=[...] → descending=[...]
"""

import os
import sys
import shutil


def find_img2table_dir():
    try:
        import img2table
        return os.path.dirname(img2table.__file__)
    except ImportError:
        print("img2table not installed, skipping patch")
        sys.exit(0)


def patch_file(filepath, replacements):
    if not os.path.exists(filepath):
        print(f"  SKIP (not found): {filepath}")
        return False

    with open(filepath, "r") as f:
        content = f.read()

    original = content
    for old, new in replacements:
        content = content.replace(old, new)

    if content == original:
        print(f"  OK (already patched): {os.path.basename(filepath)}")
        return False

    with open(filepath, "w") as f:
        f.write(content)

    print(f"  PATCHED: {os.path.basename(filepath)}")
    return True


# These replacements are safe because they only target the specific
# deprecated patterns used by img2table, and the *[] unpack trick
# preserves the closing bracket so no other code is affected.
COMMON_REPLACEMENTS = [
    ("pl.max([", "pl.max_horizontal(*["),
    ("pl.min([", "pl.min_horizontal(*["),
    (".with_row_count(", ".with_row_index("),
    (".groupby(", ".group_by("),
    (".cumsum(", ".cum_sum("),
    (".apply(", ".map_elements("),
    ("pl.from_dicts(dicts=", "pl.from_dicts("),
]

# Fixes for ocr/data.py specifically — the generic .apply → .map_elements patch
# converts syntactically but breaks semantically in Polars 1.x.
# .map_elements() in new Polars operates on individual elements, not grouped lists,
# so `lambda x: ' '.join(x)` operates on a single string at a time, producing
# character-separated output ('hello' → 'h e l l o') and a list[str] column.
# The correct modern Polars API for joining strings in an aggregation is .str.join().
OCR_DATA_FIXES = [
    (
        ".map_elements(lambda x: ' '.join(x)).alias('value')",
        ".str.join(' ').alias('value')",
    ),
    (
        ".map_elements(lambda x: '\\n'.join(x).strip()).alias('text')",
        ".str.join('\\n').str.strip_chars().alias('text')",
    ),
]


def main():
    pkg_dir = find_img2table_dir()
    print(f"Patching img2table at: {pkg_dir}")

    patched = 0

    if patch_file(
        os.path.join(pkg_dir, "tables/processing/cells/identification.py"),
        COMMON_REPLACEMENTS + [(".arr.lengths()", ".list.len()")],
    ):
        patched += 1

    if patch_file(
        os.path.join(pkg_dir, "tables/processing/cells/deduplication.py"),
        COMMON_REPLACEMENTS + [("reverse=[", "descending=[")],
    ):
        patched += 1

    if patch_file(
        os.path.join(pkg_dir, "tables/processing/lines.py"),
        COMMON_REPLACEMENTS,
    ):
        patched += 1

    if patch_file(
        os.path.join(pkg_dir, "ocr/data.py"),
        COMMON_REPLACEMENTS + OCR_DATA_FIXES,
    ):
        patched += 1

    # Clear __pycache__ so Python uses the patched source
    for root, dirs, _ in os.walk(pkg_dir):
        for d in dirs:
            if d == "__pycache__":
                shutil.rmtree(os.path.join(root, d), ignore_errors=True)

    print(f"\nDone. {patched} file(s) patched.")


if __name__ == "__main__":
    main()
