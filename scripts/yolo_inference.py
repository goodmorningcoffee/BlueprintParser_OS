#!/usr/bin/env python3
"""YOLO inference script for SageMaker Processing Jobs.

Reads page images and a model from SageMaker input mounts, runs YOLO detection on EVERY GPU of the
instance, and writes per-page JSON results.

Layouts (src/lib/yolo.ts starts the job):
  • single project (legacy, BP_YOLO_SLOTS unset):
        /opt/ml/processing/input/images/page_*.png  →  /opt/ml/processing/output/page_*.json
  • batch of projects (BP_YOLO_SLOTS="p0,p1,…", at most 9 slots):
        /opt/ml/processing/input/projects/<slot>/page_*.png  →  /opt/ml/processing/output/<slot>/page_*.json
    Each <slot> output directory is its own ProcessingOutput, uploaded to that project's
    {dataUrl}/yolo-output/{modelName}/ prefix — the loader reads it exactly as before.

GPU use (owner 2026-10-22: "take FULL advantage of any given GPU"):
  • One worker per GPU (torch.cuda.device_count(), spawn processes, each pinned to one device).
  • ALL pages of ALL projects form ONE shared work queue of batches, so the GPUs finish together.
  • Batches are formed in the parent, deterministically (consecutive pages of the same project with
    the same image size, up to the batch size), so the output does not depend on GPU count or order.
  • Each worker decodes its next batch on CPU threads while the GPU runs the current one.
  • CUDA out-of-memory → the batch is split in half and retried, down to single pages.
  • CPU-only and 1-GPU instances run in this process, exactly as before.
Per-page output format is unchanged: {"detections": [...]} with the same keys and rounding.
"""

import glob
import json
import os
import queue as queue_mod
import re
import struct
import sys
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor

# SageMaker Processing Job well-known paths
INPUT_ROOT = "/opt/ml/processing/input"
INPUT_IMAGES = os.path.join(INPUT_ROOT, "images")
INPUT_MODELS = os.path.join(INPUT_ROOT, "models")
INPUT_PROJECTS = os.path.join(INPUT_ROOT, "projects")
OUTPUT_DIR = "/opt/ml/processing/output"

SLOTS_ENV = "BP_YOLO_SLOTS"
BATCH_SIZE_ENV = "BP_YOLO_BATCH_SIZE"
SLOT_PATTERN = re.compile(r"^p[0-9]{1,2}$")
MAX_SLOTS = 9
MAX_BATCH_SIZE = 32
PROGRESS_EVERY_PAGES = 50

# Defaults if config.yaml is missing or incomplete
DEFAULTS = {
    "model_file": "model.pt",
    "confidence_threshold": 0.10,
    "iou_threshold": 0.60,
    "image_size": 1280,
    "device": "auto",
    "half_precision": True,
    "max_detections": 2000,
    "classes": [],
    # 0 = choose from GPU memory (see resolve_batch_size); BP_YOLO_BATCH_SIZE overrides both.
    "batch_size": 0,
}


def log(message):
    print(message, flush=True)


# ── configuration ─────────────────────────────────────────────────────────────


def load_config(models_dir=INPUT_MODELS):
    """Load config.yaml from model input dir, falling back to defaults. Device stays unresolved."""
    import yaml

    config_path = os.path.join(models_dir, "config.yaml")
    config = dict(DEFAULTS)

    if os.path.exists(config_path):
        with open(config_path) as f:
            user_config = yaml.safe_load(f) or {}
        config.update({k: v for k, v in user_config.items() if v is not None})
        log(f"Loaded config from {config_path}")
    else:
        log(f"No config.yaml found at {config_path}, using defaults")
    return config


def resolve_devices(config, torch_mod):
    """→ (device label for the manifest, number of GPU workers; 0 = CPU).

    "auto"/"cuda" use every visible GPU; an explicit "cpu" or "cuda:N"/"N" keeps one device.
    """
    requested = str(config.get("device", "auto")).strip().lower()
    has_cuda = bool(torch_mod.cuda.is_available())
    if requested in ("auto", "cuda"):
        if not has_cuda:
            return "cpu", 0
        return "cuda", max(1, int(torch_mod.cuda.device_count()))
    if requested == "cpu" or not has_cuda:
        return "cpu", 0
    return requested, 1


def resolve_batch_size(config, gpu_workers, torch_mod, env=None):
    """Pages per predict call: env override → config → from GPU memory (≈ 1 page per 4 GiB, 1–16)."""
    env = os.environ if env is None else env
    for raw in (env.get(BATCH_SIZE_ENV), config.get("batch_size")):
        try:
            value = int(raw)
        except (TypeError, ValueError):
            continue
        if value > 0:
            return min(value, MAX_BATCH_SIZE)
    if gpu_workers <= 0:
        return 1
    try:
        mem_gib = torch_mod.cuda.get_device_properties(0).total_memory / (1024 ** 3)
    except Exception:  # noqa: BLE001 — a probe failure must not stop the job
        return 4
    return max(1, min(16, int(mem_gib // 4)))


# ── inputs ────────────────────────────────────────────────────────────────────


def discover_projects(env=None, input_images=INPUT_IMAGES, input_projects=INPUT_PROJECTS, output_dir=OUTPUT_DIR):
    """The projects this job serves, in slot order: [{"slot", "images", "output"}]."""
    env = os.environ if env is None else env
    raw = (env.get(SLOTS_ENV) or "").strip()
    if not raw:
        return [{"slot": None, "images": input_images, "output": output_dir}]
    slots = [s.strip() for s in raw.split(",") if s.strip()]
    if not slots or len(slots) > MAX_SLOTS or len(set(slots)) != len(slots):
        raise ValueError(f"{SLOTS_ENV} must name 1–{MAX_SLOTS} distinct slots, got {raw!r}")
    for slot in slots:
        if not SLOT_PATTERN.match(slot):
            raise ValueError(f"invalid slot {slot!r} in {SLOTS_ENV}")
    return [
        {"slot": s, "images": os.path.join(input_projects, s), "output": os.path.join(output_dir, s)}
        for s in slots
    ]


def list_pages(projects):
    """[(project_index, image_path)] — projects in slot order, pages sorted by name within each."""
    pages = []
    for index, project in enumerate(projects):
        for path in sorted(glob.glob(os.path.join(project["images"], "page_*.png"))):
            pages.append((index, path))
    return pages


def png_size(path):
    """(width, height) from a PNG header, or None."""
    try:
        with open(path, "rb") as f:
            head = f.read(24)
    except OSError:
        return None
    if len(head) < 24 or head[:8] != b"\x89PNG\r\n\x1a\n" or head[12:16] != b"IHDR":
        return None
    return struct.unpack(">II", head[16:24])


def make_batches(pages, batch_size, size_of=png_size):
    """Consecutive pages of one project with the same image size, at most batch_size each.

    Same-size batches keep the letterbox identical to a single-image predict, and forming them here
    (not in the workers) makes the result independent of how many GPUs run them.
    """
    batches = []
    current = []
    current_key = None
    for project_index, path in pages:
        size = size_of(path)
        key = (project_index, size) if size is not None else (project_index, "unknown", path)
        if current and (key != current_key or len(current) >= batch_size):
            batches.append(current)
            current = []
        current.append((project_index, path))
        current_key = key
    if current:
        batches.append(current)
    return batches


def page_stem(path):
    return os.path.splitext(os.path.basename(path))[0]  # e.g. "page_0001"


# ── inference ─────────────────────────────────────────────────────────────────


def default_imread(path):
    """The same decoder ultralytics uses for a path source (BGR, 3 channels)."""
    try:
        from ultralytics.utils.patches import imread
    except ImportError:  # pragma: no cover — older/newer ultralytics layouts
        import cv2

        return cv2.imread(path, cv2.IMREAD_COLOR)
    return imread(path)


def detections_from_result(result, model_names, class_names):
    """One ultralytics Result → the detections list written to page_*.json (unchanged format)."""
    h, w = result.orig_shape
    detections = []

    if result.boxes is not None and len(result.boxes) > 0:
        boxes_xyxy = result.boxes.xyxy.cpu().numpy()
        confidences = result.boxes.conf.cpu().numpy()
        class_ids = result.boxes.cls.cpu().int().numpy()

        for i in range(len(boxes_xyxy)):
            x1, y1, x2, y2 = boxes_xyxy[i]
            cls_id = int(class_ids[i])
            conf = float(confidences[i])

            # Resolve class name: config classes first, then model metadata
            if cls_id < len(class_names):
                cls_name = class_names[cls_id]
            elif cls_id in model_names:
                cls_name = model_names[cls_id]
            else:
                cls_name = f"class_{cls_id}"

            detections.append({
                "class_id": cls_id,
                "class_name": cls_name,
                "confidence": round(conf, 4),
                "bbox": [int(x1), int(y1), int(x2), int(y2)],
                "bbox_normalized": [
                    round(float(x1) / w, 6),
                    round(float(y1) / h, 6),
                    round(float(x2) / w, 6),
                    round(float(y2) / h, 6),
                ],
            })

    return detections


def is_cuda_oom(err):
    name = type(err).__name__
    return name == "OutOfMemoryError" or "out of memory" in str(err).lower()


def write_page(output_dir, stem, detections):
    with open(os.path.join(output_dir, f"{stem}.json"), "w") as f:
        json.dump({"detections": detections}, f)


class PageWorker:
    """Runs batches on one device and writes each page's JSON. Records go to `emit`."""

    def __init__(self, worker_id, model, config, device, projects, emit, imread=default_imread,
                 empty_cache=None, decode_threads=2):
        self.worker_id = worker_id
        self.model = model
        self.config = config
        self.device = device
        self.projects = projects
        self.emit = emit
        self.imread = imread
        self.empty_cache = empty_cache
        self.decode_threads = max(1, int(decode_threads))
        self.pages = 0
        self.busy_seconds = 0.0
        self.oom_splits = 0
        self.class_names = list(config.get("classes") or [])
        self.model_names = getattr(model, "names", {}) or {}

    def _predict(self, images):
        device = str(self.device)
        return self.model.predict(
            source=images if len(images) > 1 else images[0],
            conf=self.config["confidence_threshold"],
            iou=self.config["iou_threshold"],
            imgsz=self.config["image_size"],
            device=self.device,
            half=bool(self.config["half_precision"]) and device.startswith("cuda"),
            max_det=self.config["max_detections"],
            verbose=False,
        )

    def _infer(self, images):
        """Results for `images` (same order); on CUDA OOM, halves and retries."""
        try:
            results = list(self._predict(images))
            if len(results) != len(images):
                raise RuntimeError(f"predict returned {len(results)} results for {len(images)} images")
            return results
        except Exception as err:  # noqa: BLE001
            if len(images) <= 1 or not is_cuda_oom(err):
                raise
            self.oom_splits += 1
            if self.empty_cache:
                self.empty_cache()
            half = len(images) // 2
            log(f"  [gpu {self.worker_id}] CUDA out of memory on a batch of {len(images)}; retrying as {half} + {len(images) - half}")
            return self._infer(images[:half]) + self._infer(images[half:])

    def decode(self, batch, pool=None):
        paths = [path for _, path in batch]
        if pool is None:
            return [self.imread(p) for p in paths]
        return list(pool.map(self.imread, paths))

    def _record(self, project_index, path, detections, error):
        project = self.projects[project_index]
        stem = page_stem(path)
        write_page(project["output"], stem, detections)
        self.pages += 1
        self.emit({"project": project_index, "page": stem, "detections": len(detections), "error": error,
                   "worker": self.worker_id})
        if self.pages % PROGRESS_EVERY_PAGES == 0:
            rate = self.pages / self.busy_seconds if self.busy_seconds > 0 else 0.0
            log(f"  [gpu {self.worker_id}] {self.pages} pages, {rate:.2f} pages/s")

    def run_batch(self, batch, images):
        started = time.time()
        ok = [(item, img) for item, img in zip(batch, images) if img is not None]
        for (project_index, path), img in zip(batch, images):
            if img is None:
                self._record(project_index, path, [], f"{os.path.basename(path)}: could not decode image")
        if ok:
            try:
                results = self._infer([img for _, img in ok])
            except Exception:  # noqa: BLE001 — isolate the failing page(s) one at a time
                traceback.print_exc()
                results = None
            for index, ((project_index, path), img) in enumerate(ok):
                try:
                    result = results[index] if results is not None else self._infer([img])[0]
                    detections = detections_from_result(result, self.model_names, self.class_names)
                    self._record(project_index, path, detections, None)
                except Exception as err:  # noqa: BLE001
                    traceback.print_exc()
                    # Write empty detections for failed pages so the load route doesn't skip them
                    self._record(project_index, path, [], f"{os.path.basename(path)}: {err}")
        self.busy_seconds += time.time() - started

    def run(self, next_batch):
        """Pull batches until `next_batch()` returns None; decode the next while predicting this one."""
        prefetched = queue_mod.Queue(maxsize=2)
        done = object()

        def producer(pool):
            try:
                while True:
                    batch = next_batch()
                    if batch is None:
                        break
                    try:
                        images = self.decode(batch, pool)
                    except Exception:  # noqa: BLE001
                        traceback.print_exc()
                        images = [None] * len(batch)
                    prefetched.put((batch, images))
            finally:
                prefetched.put(done)

        with ThreadPoolExecutor(max_workers=self.decode_threads) as pool:
            thread = threading.Thread(target=producer, args=(pool,), daemon=True)
            thread.start()
            while True:
                item = prefetched.get()
                if item is done:
                    break
                self.run_batch(*item)
            thread.join()

    def stats(self):
        rate = self.pages / self.busy_seconds if self.busy_seconds > 0 else 0.0
        return {"worker": self.worker_id, "device": str(self.device), "pages": self.pages,
                "busy_seconds": round(self.busy_seconds, 2), "pages_per_second": round(rate, 3),
                "oom_splits": self.oom_splits}


def queue_source(q):
    """next_batch() over a queue that ends with one None per worker."""
    return lambda: q.get()


def run_pool(batches, workers, run_one):
    """Threads sharing ONE queue: each `run_one(worker_id, next_batch)` pulls until the queue ends.

    The multi-GPU path is the same shape with processes (run_multi_gpu); tests use this one.
    """
    q = queue_mod.Queue()
    for batch in batches:
        q.put(batch)
    for _ in range(workers):
        q.put(None)
    threads = [threading.Thread(target=run_one, args=(i, queue_source(q))) for i in range(workers)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()


def load_model(model_path):
    from ultralytics import YOLO

    return YOLO(model_path)


def _worker_entry(gpu_index, model_path, config, projects, tasks, results, decode_threads):
    """Spawned process for one GPU. CUDA_VISIBLE_DEVICES is pinned BEFORE torch loads, and CUDA is
    initialised at once: ultralytics' select_device rewrites CUDA_VISIBLE_DEVICES from the device
    string, which is harmless only after initialisation — otherwise every worker would land on GPU 0."""
    os.environ["CUDA_VISIBLE_DEVICES"] = str(gpu_index)
    try:
        import torch

        torch.zeros(1, device="cuda:0")
        name = torch.cuda.get_device_name(0)
        log(f"  [gpu {gpu_index}] {name} ready (pid {os.getpid()})")
        model = load_model(model_path)
        worker = PageWorker(gpu_index, model, config, "cuda:0", projects, lambda rec: results.put(("page", rec)),
                            empty_cache=torch.cuda.empty_cache, decode_threads=decode_threads)
        worker.run(queue_source(tasks))
        results.put(("done", worker.stats()))
    except Exception as err:  # noqa: BLE001
        traceback.print_exc()
        results.put(("dead", {"worker": gpu_index, "error": str(err)[:500]}))


def run_multi_gpu(batches, gpu_workers, model_path, config, projects, decode_threads):
    """One spawned process per GPU over one shared task queue. → (page records, worker stats)."""
    import multiprocessing as mp

    ctx = mp.get_context("spawn")
    tasks = ctx.Queue()
    results = ctx.Queue()
    for batch in batches:
        tasks.put(batch)
    for _ in range(gpu_workers):
        tasks.put(None)
    procs = [
        ctx.Process(target=_worker_entry, args=(i, model_path, config, projects, tasks, results, decode_threads))
        for i in range(gpu_workers)
    ]
    for p in procs:
        p.start()

    records, stats = [], []
    finished = 0
    while finished < gpu_workers:
        try:
            kind, payload = results.get(timeout=15)
        except queue_mod.Empty:
            if not any(p.is_alive() for p in procs):
                break  # a worker died without reporting; its pages are filled in as failed
            continue
        if kind == "page":
            records.append(payload)
        else:
            finished += 1
            stats.append(payload)
            if kind == "dead":
                log(f"  WARNING: GPU worker {payload['worker']} failed: {payload['error']}")
    # Drain anything that arrived after the last done marker.
    while True:
        try:
            kind, payload = results.get(timeout=1)
        except queue_mod.Empty:
            break
        if kind == "page":
            records.append(payload)
    for p in procs:
        p.join(timeout=60)
    return records, stats


def run_in_process(batches, model, config, device, projects, decode_threads, empty_cache=None,
                   imread=default_imread):
    records = []
    worker = PageWorker(0, model, config, device, projects, records.append, imread=imread,
                        empty_cache=empty_cache, decode_threads=decode_threads)
    iterator = iter(batches)
    worker.run(lambda: next(iterator, None))
    return records, [worker.stats()]


# ── outputs ───────────────────────────────────────────────────────────────────


def fill_missing(pages, records, projects):
    """Pages no worker reported (a worker died) get empty detections + an error, like a failed page."""
    seen = {(r["project"], r["page"]) for r in records}
    for project_index, path in pages:
        stem = page_stem(path)
        if (project_index, stem) not in seen:
            write_page(projects[project_index]["output"], stem, [])
            records.append({"project": project_index, "page": stem, "detections": 0,
                            "error": f"{os.path.basename(path)}: no result (GPU worker failed)", "worker": None})
    return records


def write_manifests(projects, pages, records, config, device, gpu_workers, elapsed):
    """One _manifest.json per project (skipped by the load route). → [(project, manifest)]."""
    out = []
    for index, project in enumerate(projects):
        mine = [r for r in records if r["project"] == index]
        errors = sorted(r["error"] for r in mine if r["error"])
        page_count = sum(1 for p, _ in pages if p == index)
        manifest = {
            "pages_processed": page_count,
            "pages_failed": len(errors),
            "total_detections": sum(r["detections"] for r in mine),
            "errors": errors if page_count else [f"No page_*.png images found in {project['images']}"],
            "runtime_seconds": elapsed,
            "config": {
                "model_file": config["model_file"],
                "confidence_threshold": config["confidence_threshold"],
                "iou_threshold": config["iou_threshold"],
                "image_size": config["image_size"],
                "device": device,
                "half_precision": config["half_precision"],
            },
            "gpus": gpu_workers,
        }
        if project["slot"] is not None:
            manifest["slot"] = project["slot"]
        with open(os.path.join(project["output"], "_manifest.json"), "w") as f:
            json.dump(manifest, f, indent=2)
        out.append((project, manifest))
    return out


def main():
    import torch

    start_time = time.time()
    log("=" * 60)
    log("YOLO Inference — Beaver Blueprint Parser")
    log("=" * 60)

    config = load_config()
    device, gpu_workers = resolve_devices(config, torch)
    batch_size = resolve_batch_size(config, gpu_workers, torch)
    cpu_count = os.cpu_count() or 1
    decode_threads = max(1, min(8, cpu_count // max(1, gpu_workers)))
    log(f"Config: device={device}, gpus={gpu_workers}, batch={batch_size}, decode_threads={decode_threads}, "
        f"conf={config['confidence_threshold']}, iou={config['iou_threshold']}, imgsz={config['image_size']}, "
        f"half={config['half_precision']}, max_det={config['max_detections']}")

    model_path = os.path.join(INPUT_MODELS, config["model_file"])
    if not os.path.exists(model_path):
        log(f"ERROR: Model not found at {model_path}")
        sys.exit(1)

    projects = discover_projects()
    for project in projects:
        os.makedirs(project["output"], exist_ok=True)
    pages = list_pages(projects)
    if not pages:
        log(f"ERROR: No page_*.png images found in {', '.join(p['images'] for p in projects)}")
        sys.exit(1)
    batches = make_batches(pages, batch_size)
    log(f"Found {len(pages)} pages in {len(projects)} project(s) → {len(batches)} batches")

    if gpu_workers > 1:
        records, stats = run_multi_gpu(batches, gpu_workers, model_path, config, projects, decode_threads)
    else:
        log(f"Loading model from {model_path}...")
        model = load_model(model_path)
        log(f"Model loaded: {len(model.names)} classes")
        empty_cache = torch.cuda.empty_cache if device.startswith("cuda") else None
        records, stats = run_in_process(batches, model, config, device, projects, decode_threads, empty_cache)

    records = fill_missing(pages, records, projects)
    elapsed = round(time.time() - start_time, 2)
    manifests = write_manifests(projects, pages, records, config, device, gpu_workers, elapsed)

    log("=" * 60)
    for s in sorted(stats, key=lambda s: s.get("worker", 0)):
        if "pages" in s:
            log(f"GPU worker {s['worker']} ({s['device']}): {s['pages']} pages, {s['busy_seconds']} s busy, "
                f"{s['pages_per_second']} pages/s, {s['oom_splits']} OOM splits")
    for project, manifest in manifests:
        label = project["slot"] or "project"
        log(f"{label}: {manifest['pages_processed']} pages, {manifest['total_detections']} detections, "
            f"{manifest['pages_failed']} errors")
    failed = sum(1 for r in records if r["error"])
    total = sum(r["detections"] for r in records)
    log(f"Done: {len(pages)} pages, {total} detections, {failed} errors, {elapsed}s wall, "
        f"{len(pages) / elapsed if elapsed > 0 else 0:.2f} pages/s overall on {max(1, gpu_workers)} device(s)")
    log("=" * 60)

    if failed == len(pages):
        log("ERROR: All pages failed")
        sys.exit(1)


if __name__ == "__main__":
    main()
