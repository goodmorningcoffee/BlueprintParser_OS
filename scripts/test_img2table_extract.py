"""
[table pipeline WP-2.A] K06 in the img2table adapter: duplicate printed column names must not
collapse into one row key.

img2table / numpy are image dependencies; they are stubbed before import so this runs in any
container (the module exits at import time when img2table is missing). All labels are synthetic.
Run: cd scripts && pytest test_img2table_extract.py -q
"""
import sys
import types

for _name in ("numpy", "img2table", "img2table.document", "img2table.ocr"):
    _mod = types.ModuleType(_name)
    if _name == "img2table.document":
        _mod.Image = object
        _mod.PDF = object
    elif _name == "img2table.ocr":
        _mod.TesseractOCR = object
    sys.modules.setdefault(_name, _mod)

import img2table_extract as ix  # noqa: E402


class _Row:
    def __init__(self, values):
        self._values = values
        self.iloc = values

    def __len__(self):
        return len(self._values)


class _Df:
    def __init__(self, columns, rows):
        self.columns = columns
        self._rows = rows
        self.empty = not rows
        self.shape = (len(rows), len(columns))

    def iterrows(self):
        for i, r in enumerate(self._rows):
            yield i, _Row(r)


class _Box:
    def __init__(self, x1, y1, x2, y2):
        self.x1, self.y1, self.x2, self.y2 = x1, y1, x2, y2


class _Cell:
    def __init__(self, x1, y1, x2, y2):
        self.bbox = _Box(x1, y1, x2, y2)


class _Table:
    def __init__(self, columns, rows):
        self.df = _Df(columns, rows)
        self.content = {
            ri: [_Cell(ci * 10, ri * 10, ci * 10 + 10, ri * 10 + 10) for ci in range(len(columns))]
            for ri in range(len(rows))
        }


def test_unique_headers_rule_matches_ts():
    assert ix._unique_headers(["QA", "QB", "QA", "QA"]) == ["QA", "QB", "QA (2)", "QA (3)"]
    # A printed "QA (2)" keeps its label; the generated suffix skips it.
    assert ix._unique_headers(["QA", "QA", "QA (2)"]) == ["QA", "QA (3)", "QA (2)"]
    assert ix._unique_headers(["", "QB", "  "]) == ["Column 1", "QB", "Column 3"]
    assert ix._unique_headers(["qa", "QA"]) == ["qa", "QA"]


def test_duplicate_columns_keep_both_values():
    table = _Table(["QK", "ZTYPE", "ZMAT", "ZTYPE", "ZMAT"], [["K1", "v1", "v2", "v3", "v4"]])
    out = ix._table_to_method_result(table, [0, 0, 1, 1], 100, 100)
    assert out["headers"] == ["QK", "ZTYPE", "ZMAT", "ZTYPE (2)", "ZMAT (2)"]
    assert out["rows"] == [{"QK": "K1", "ZTYPE": "v1", "ZMAT": "v2", "ZTYPE (2)": "v3", "ZMAT (2)": "v4"}]


def test_numeric_columns_unchanged():
    table = _Table(["0", "1"], [["a", "b"], ["c", "None"]])
    out = ix._table_to_method_result(table, [0, 0, 1, 1], 100, 100)
    assert out["headers"] == ["Column 1", "Column 2"]
    assert out["rows"] == [{"Column 1": "a", "Column 2": "b"}, {"Column 1": "c", "Column 2": ""}]
