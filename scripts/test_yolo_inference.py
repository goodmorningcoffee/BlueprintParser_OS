"""Tests for scripts/yolo_inference.py: layouts, deterministic batching, and identical output on 1 vs N
workers (torch/ultralytics are not needed: the model and decoder are fakes).

Run:  python3 -m unittest scripts/test_yolo_inference.py   (or pytest scripts/test_yolo_inference.py)
"""

import importlib.util
import json
import os
import struct
import sys
import tempfile
import threading
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("yolo_inference", os.path.join(HERE, "yolo_inference.py"))
yi = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(yi)

CONFIG = dict(yi.DEFAULTS, classes=["door", "window"])


def write_png_header(path, width, height):
    """Just enough PNG for png_size() — the fake decoder never reads pixels."""
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + struct.pack(">II", width, height) + b"\x00" * 9)


class FakeArray(list):
    def cpu(self):
        return self

    def numpy(self):
        return self

    def int(self):
        return FakeArray(int(v) for v in self)


class FakeBoxes:
    def __init__(self, rows):
        self.xyxy = FakeArray(FakeArray(r[:4]) for r in rows)
        self.conf = FakeArray(r[4] for r in rows)
        self.cls = FakeArray(r[5] for r in rows)

    def __len__(self):
        return len(self.conf)


class FakeResult:
    def __init__(self, image):
        self.orig_shape = (image["h"], image["w"])
        seed = sum(ord(c) for c in image["path"])
        rows = [
            [seed % 97 + i * 10.7, seed % 53 + i * 3.3, seed % 97 + 40.2 + i, seed % 53 + 60.9 + i,
             ((seed + i) % 1000) / 1000.0, (seed + i) % 3]
            for i in range(seed % 4)
        ]
        self.boxes = FakeBoxes(rows) if rows else None


class OutOfMemoryError(RuntimeError):
    pass


class FakeModel:
    names = {0: "door", 1: "window", 2: "stair"}

    def __init__(self, max_batch=None):
        self.max_batch = max_batch
        self.calls = []
        self.lock = threading.Lock()

    def predict(self, source, **kwargs):
        images = source if isinstance(source, list) else [source]
        with self.lock:
            self.calls.append((len(images), kwargs["device"], kwargs["half"]))
        if self.max_batch is not None and len(images) > self.max_batch:
            raise OutOfMemoryError("CUDA out of memory. Tried to allocate 2.00 GiB")
        return [FakeResult(img) for img in images]


def fake_imread(path):
    w, h = yi.png_size(path)
    return {"path": os.path.basename(os.path.dirname(path)) + "/" + os.path.basename(path), "w": w, "h": h}


def make_input(root, layout):
    """3 projects (mixed page sizes) in the batch layout, or one project in the legacy layout."""
    if layout == "legacy":
        images = os.path.join(root, "input", "images")
        os.makedirs(images)
        for n in range(1, 6):
            write_png_header(os.path.join(images, f"page_{n:04d}.png"), 3400, 2200)
        return {}
    sizes = {"p0": [(3400, 2200)] * 7, "p1": [(2200, 1700), (2200, 1700), (3400, 2200)], "p2": [(4800, 3600)] * 2}
    for slot, page_sizes in sizes.items():
        d = os.path.join(root, "input", "projects", slot)
        os.makedirs(d)
        for n, (w, h) in enumerate(page_sizes, start=1):
            write_png_header(os.path.join(d, f"page_{n:04d}.png"), w, h)
    return {yi.SLOTS_ENV: "p0,p1,p2"}


def run_job(root, env, workers, batch_size, max_batch=None):
    projects = yi.discover_projects(env, os.path.join(root, "input", "images"),
                                    os.path.join(root, "input", "projects"), os.path.join(root, "output"))
    for p in projects:
        os.makedirs(p["output"], exist_ok=True)
    pages = yi.list_pages(projects)
    batches = yi.make_batches(pages, batch_size)
    records = []
    lock = threading.Lock()
    models = []

    def emit(rec):
        with lock:
            records.append(rec)

    def run_one(worker_id, next_batch):
        model = FakeModel(max_batch)
        models.append(model)
        worker = yi.PageWorker(worker_id, model, CONFIG, "cuda:0", projects, emit, imread=fake_imread)
        worker.run(next_batch)

    if workers == 1:
        model = FakeModel(max_batch)
        models.append(model)
        records, _ = yi.run_in_process(batches, model, CONFIG, "cuda", projects, 2, imread=fake_imread)
    else:
        yi.run_pool(batches, workers, run_one)
    yi.fill_missing(pages, records, projects)
    # gpus is the only manifest field that may differ by worker count; hold it fixed to compare the rest.
    yi.write_manifests(projects, pages, records, CONFIG, "cuda", 1, 1.0)
    return models


def tree(root):
    out = {}
    for dirpath, _, files in os.walk(os.path.join(root, "output")):
        for name in files:
            path = os.path.join(dirpath, name)
            with open(path, "rb") as f:
                out[os.path.relpath(path, root)] = f.read()
    return out


class LayoutTests(unittest.TestCase):
    def test_legacy_layout_when_slots_unset(self):
        projects = yi.discover_projects({}, "/in/images", "/in/projects", "/out")
        self.assertEqual(projects, [{"slot": None, "images": "/in/images", "output": "/out"}])

    def test_batch_layout_maps_each_slot(self):
        projects = yi.discover_projects({yi.SLOTS_ENV: "p0,p1"}, "/in/images", "/in/projects", "/out")
        self.assertEqual([p["images"] for p in projects], ["/in/projects/p0", "/in/projects/p1"])
        self.assertEqual([p["output"] for p in projects], ["/out/p0", "/out/p1"])

    def test_rejects_bad_slots(self):
        for raw in ("p0,p0", "../x", "p0,images", ",".join(f"p{i}" for i in range(10))):
            with self.assertRaises(ValueError):
                yi.discover_projects({yi.SLOTS_ENV: raw})


class BatchingTests(unittest.TestCase):
    def test_batches_split_on_project_size_and_limit(self):
        with tempfile.TemporaryDirectory() as root:
            env = make_input(root, "batch")
            projects = yi.discover_projects(env, None, os.path.join(root, "input", "projects"), os.path.join(root, "output"))
            batches = yi.make_batches(yi.list_pages(projects), 4)
            shapes = [[(p, os.path.basename(path)) for p, path in b] for b in batches]
            self.assertEqual([len(b) for b in batches], [4, 3, 2, 1, 2])
            for b in batches:
                self.assertEqual(len({p for p, _ in b}), 1, "a batch never mixes projects")
                self.assertEqual(len({yi.png_size(path) for _, path in b}), 1, "a batch never mixes sizes")
            self.assertEqual(shapes, [[(p, os.path.basename(path)) for p, path in b]
                                      for b in yi.make_batches(yi.list_pages(projects), 4)])

    def test_batch_size_resolution(self):
        class Props:
            total_memory = 24 * 1024 ** 3

        class Cuda:
            @staticmethod
            def get_device_properties(_):
                return Props()

        class Torch:
            cuda = Cuda()

        self.assertEqual(yi.resolve_batch_size(dict(CONFIG), 4, Torch, env={}), 6)
        self.assertEqual(yi.resolve_batch_size(dict(CONFIG), 0, Torch, env={}), 1)
        self.assertEqual(yi.resolve_batch_size(dict(CONFIG, batch_size=3), 4, Torch, env={}), 3)
        self.assertEqual(yi.resolve_batch_size(dict(CONFIG, batch_size=3), 4, Torch, env={yi.BATCH_SIZE_ENV: "8"}), 8)

    def test_device_resolution(self):
        def torch_with(n):
            class Cuda:
                @staticmethod
                def is_available():
                    return n > 0

                @staticmethod
                def device_count():
                    return n

            class Torch:
                cuda = Cuda()

            return Torch

        self.assertEqual(yi.resolve_devices({"device": "auto"}, torch_with(4)), ("cuda", 4))
        self.assertEqual(yi.resolve_devices({"device": "auto"}, torch_with(1)), ("cuda", 1))
        self.assertEqual(yi.resolve_devices({"device": "auto"}, torch_with(0)), ("cpu", 0))
        self.assertEqual(yi.resolve_devices({"device": "cpu"}, torch_with(4)), ("cpu", 0))


class OutputTests(unittest.TestCase):
    def test_same_output_on_one_or_many_workers(self):
        outputs = []
        for workers in (1, 2, 4):
            with tempfile.TemporaryDirectory() as root:
                env = make_input(root, "batch")
                run_job(root, env, workers, batch_size=4)
                outputs.append(tree(root))
        self.assertEqual(sorted(outputs[0]), sorted(outputs[1]))
        self.assertEqual(outputs[0], outputs[1])
        self.assertEqual(outputs[0], outputs[2])
        files = sorted(outputs[0])
        self.assertIn("output/p0/page_0007.json", files)
        self.assertIn("output/p2/_manifest.json", files)
        self.assertEqual(len([f for f in files if f.endswith(".json")]), 7 + 3 + 2 + 3)

    def test_page_json_format_is_unchanged(self):
        with tempfile.TemporaryDirectory() as root:
            run_job(root, make_input(root, "legacy"), 1, batch_size=4)
            with open(os.path.join(root, "output", "page_0001.json")) as f:
                body = json.load(f)
            self.assertEqual(list(body), ["detections"])
            for det in body["detections"]:
                self.assertEqual(list(det), ["class_id", "class_name", "confidence", "bbox", "bbox_normalized"])
            self.assertTrue(os.path.exists(os.path.join(root, "output", "_manifest.json")))

    def test_oom_splits_keep_the_output(self):
        with tempfile.TemporaryDirectory() as root:
            env = make_input(root, "batch")
            run_job(root, env, 1, batch_size=4)
            baseline = tree(root)
        with tempfile.TemporaryDirectory() as root:
            env = make_input(root, "batch")
            models = run_job(root, env, 2, batch_size=4, max_batch=1)
            self.assertEqual(tree(root), baseline)
            self.assertTrue(any(n > 1 for m in models for n, _, _ in m.calls), "batched predict was attempted")

    def test_half_precision_only_on_cuda(self):
        model = FakeModel()
        with tempfile.TemporaryDirectory() as root:
            env = make_input(root, "batch")
            projects = yi.discover_projects(env, None, os.path.join(root, "input", "projects"), os.path.join(root, "output"))
            for p in projects:
                os.makedirs(p["output"])
            batches = yi.make_batches(yi.list_pages(projects), 4)
            yi.run_in_process(batches[:1], model, CONFIG, "cpu", projects, 1, imread=fake_imread)
            yi.run_in_process(batches[1:2], model, CONFIG, "cuda:0", projects, 1, imread=fake_imread)
        self.assertEqual([(d, h) for _, d, h in model.calls], [("cpu", False), ("cuda:0", True)])

    def test_missing_pages_are_filled_as_failed(self):
        with tempfile.TemporaryDirectory() as root:
            env = make_input(root, "batch")
            projects = yi.discover_projects(env, None, os.path.join(root, "input", "projects"), os.path.join(root, "output"))
            for p in projects:
                os.makedirs(p["output"])
            pages = yi.list_pages(projects)
            records = yi.fill_missing(pages, [], projects)
            self.assertEqual(len(records), len(pages))
            self.assertTrue(all(r["error"] for r in records))
            with open(os.path.join(root, "output", "p1", "page_0002.json")) as f:
                self.assertEqual(json.load(f), {"detections": []})


if __name__ == "__main__":
    sys.exit(unittest.main())
