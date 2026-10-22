// @vitest-environment node
// [fix 2026-10-21 reprocess-persistence] CONTRACT test: the REAL scripts/lambda_handler.py
// (process_pages / result-writing) against the REAL src/lib/lambda-cv.ts reader.
//
// Owner: "we want the fan out to work thats the point of having lambda". The owner's
// 40-project reprocess got zero results back and nothing said why. This test runs the actual
// handler in python3 for every InvokeCommand the fan-out sends — same payload keys, same
// result_s3_key, an in-memory S3 shared by both sides — so a drift in the payload contract,
// the result-key contract or the per-page status contract fails here instead of in prod.
// Only the CV engine (extract_keynotes.main), boto3 and cv2 are stubbed inside python; the
// handler's own code runs unmodified. Skips when python3 is absent (it is present on CI
// runners and in this container).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const h = vi.hoisted(() => ({
  store: new Map<string, string>(),
  invoke: vi.fn(),
}));

vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    send(cmd: { input: { Payload: Uint8Array } }) {
      return h.invoke(JSON.parse(Buffer.from(cmd.input.Payload).toString("utf-8")));
    }
  },
  InvokeCommand: class {
    constructor(readonly input: unknown) {}
  },
}));

vi.mock("@/lib/s3", () => ({
  downloadFromS3: vi.fn(async (key: string) => {
    const body = h.store.get(key);
    if (body === undefined) throw new Error(`NoSuchKey: ${key}`);
    return Buffer.from(body, "utf-8");
  }),
  uploadToS3: vi.fn(async () => {}),
  deleteProjectFiles: vi.fn(async () => {}),
}));

import { fanOutShapeParse, type LambdaInvocationDiag } from "@/lib/lambda-cv";

const hasPython = spawnSync("python3", ["--version"]).status === 0;
const SCRIPTS = join(process.cwd(), "scripts");
const work = mkdtempSync(join(tmpdir(), "bp-lambda-contract-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

// Stubs ONLY the CV engine + AWS/cv2 modules, then runs the real handler. TMP is pointed at a
// private directory first: the handler's clean_tmp() deletes every file in TMP.
const RUNNER = `
import json, sys, types
scripts_dir, tmp_dir, event_path, out_path = sys.argv[1:5]
store = {}
class FakeS3:
    def download_file(self, bucket, key, local_path):
        if "missing" in key:
            raise Exception("An error occurred (404) when calling the HeadObject operation: Not Found")
        with open(local_path, "w") as f:
            f.write(key)
    def put_object(self, Bucket, Key, Body, ContentType=None):
        store[Key] = Body.decode("utf-8")
boto3 = types.ModuleType("boto3"); boto3.client = lambda *_a, **_k: FakeS3()
cv2 = types.ModuleType("cv2")
tm = types.ModuleType("template_match"); tm.process_target = None; tm.nms_boxes = None
ek = types.ModuleType("extract_keynotes")
def main(path):
    key = open(path).read()
    if "page_0001" in key:
        return [{"shape": "hexagon", "text": "K1", "bbox": [0.1, 0.1, 0.2, 0.2], "contour": [[0.1, 0.1]]}], []
    if "page_0003" in key:
        raise ValueError("cv2 could not decode page image page_0003.png")
    return [], ["Shape Parse found 0 keynotes across 1 tiles"]
ek.main = main
for name, mod in (("boto3", boto3), ("cv2", cv2), ("template_match", tm), ("extract_keynotes", ek)):
    sys.modules[name] = mod
sys.path.insert(0, scripts_dir)
import lambda_handler
lambda_handler.TMP = tmp_dir
with open(event_path) as f:
    event = json.load(f)
ret = lambda_handler.handler(event, None)
with open(out_path, "w") as f:
    json.dump({"ret": ret, "store": store}, f)
`;
const runnerPath = join(work, "runner.py");
writeFileSync(runnerPath, RUNNER);

let seq = 0;
/** Run the real handler for one invocation; publish what it wrote into the shared S3 map. */
function runHandler(event: Record<string, unknown>): { ret: Record<string, unknown>; store: Record<string, string> } {
  const id = seq++;
  const eventPath = join(work, `event_${id}.json`);
  const outPath = join(work, `out_${id}.json`);
  const tmpDir = mkdtempSync(join(work, `tmp_${id}_`));
  writeFileSync(eventPath, JSON.stringify(event));
  const proc = spawnSync("python3", ["-I", runnerPath, SCRIPTS, tmpDir, eventPath, outPath], { encoding: "utf-8" });
  if (proc.status !== 0) throw new Error(`python runner failed: ${proc.stderr}`);
  return JSON.parse(readFileSync(outPath, "utf-8"));
}

const KEY = (n: number) => `co/proj/pages/page_${String(n).padStart(4, "0")}.png`;

beforeEach(() => {
  h.store.clear();
  h.invoke.mockReset();
  process.env.S3_BUCKET = "contract-bucket";
  process.env.LAMBDA_CV_FUNCTION_NAME = "beaver-cv-pipeline";
});

describe.skipIf(!hasPython)("lambda_handler.py ⇄ lambda-cv.ts contract (real handler, shared S3)", () => {
  it("payload → handler → result key → reader: shapes, confirmed-empty pages and failed pages are all distinguished", async () => {
    const events: Record<string, unknown>[] = [];
    h.invoke.mockImplementation(async (event: Record<string, unknown>) => {
      events.push(event);
      const { ret, store } = runHandler(event);
      for (const [k, v] of Object.entries(store)) h.store.set(k, v);
      return { Payload: Buffer.from(JSON.stringify(ret)) };
    });
    const diags: LambdaInvocationDiag[] = [];

    const out = await fanOutShapeParse({
      pageS3Keys: [KEY(1), KEY(2), KEY(3)],
      onInvocation: (d) => diags.push(d),
    });

    // The payload the TS sends is exactly what the handler reads.
    for (const e of events) {
      expect(e).toMatchObject({ action: "shape_parse", s3_bucket: "contract-bucket" });
      expect(Array.isArray(e.page_s3_keys)).toBe(true);
      expect(String(e.result_s3_key)).toMatch(/^tmp\/cv-jobs\/[^/]+\/results\/(batch_\d+|retry_.+)\.json$/);
    }
    // Shapes come back keyed to the page the handler scanned.
    expect(out.results).toEqual([
      { shape: "hexagon", text: "K1", bbox: [0.1, 0.1, 0.2, 0.2], contour: [[0.1, 0.1]], pageS3Key: KEY(1) },
    ]);
    // page 2 was scanned and has no shapes → ok; page 3 was NOT scanned → failed, with the reason.
    expect([...out.okPages].sort()).toEqual([KEY(1), KEY(2)]);
    expect(out.failedPages).toEqual([KEY(3)]);
    expect(out.pageErrors[KEY(3)]).toMatch(/could not decode/);
    expect(out.warnings).toContain("Shape Parse found 0 keynotes across 1 tiles");

    // Every invocation is reported: 3 batches + 1 retry of the failed page.
    expect(diags.filter((d) => d.attempt === "batch")).toHaveLength(3);
    expect(diags.filter((d) => d.attempt === "retry")).toHaveLength(1);
    const ok = diags.find((d) => d.pages[0] === "page_0001.png" && d.attempt === "batch")!;
    expect(ok).toMatchObject({ ok: true, lambdaStatus: "success", resultFound: true, resultCount: 1, reportedCount: 1, okPages: 1, failedPages: 0 });
    const bad = diags.find((d) => d.pages[0] === "page_0003.png" && d.attempt === "batch")!;
    expect(bad).toMatchObject({ ok: false, lambdaStatus: "error" });
    expect(bad.error).toMatch(/All 1 pages failed/);
    // diagnostics never carry the storage prefix
    expect(JSON.stringify(diags)).not.toContain("co/proj");
  });

  it("a page PNG that is missing in S3 is a FAILED page, never an empty one", async () => {
    h.invoke.mockImplementation(async (event: Record<string, unknown>) => {
      const { ret, store } = runHandler(event);
      for (const [k, v] of Object.entries(store)) h.store.set(k, v);
      return { Payload: Buffer.from(JSON.stringify(ret)) };
    });
    const out = await fanOutShapeParse({ pageS3Keys: ["co/proj/pages/missing_0009.png"] });
    expect(out.results).toEqual([]);
    expect(out.okPages).toEqual([]);
    expect(out.failedPages).toEqual(["co/proj/pages/missing_0009.png"]);
    expect(out.pageErrors["co/proj/pages/missing_0009.png"]).toMatch(/404|Not Found/);
  });

  it("a successful invoke whose result file cannot be read fails the page (the old reader returned 0 rows)", async () => {
    const diags: LambdaInvocationDiag[] = [];
    h.invoke.mockImplementation(async (event: Record<string, unknown>) => {
      const { ret } = runHandler(event); // handler wrote its result, but it never reaches our S3
      return { Payload: Buffer.from(JSON.stringify(ret)) };
    });
    const out = await fanOutShapeParse({ pageS3Keys: [KEY(1)], onInvocation: (d) => diags.push(d) });
    expect(out.results).toEqual([]);
    expect(out.okPages).toEqual([]);
    expect(out.failedPages).toEqual([KEY(1)]);
    expect(out.pageErrors[KEY(1)]).toMatch(/unreadable after a successful invoke/);
    expect(diags.every((d) => d.resultFound === false && d.ok === false)).toBe(true);
  });

  it("FunctionError (timeout/OOM/import error) fails the page with the runtime's message", async () => {
    const diags: LambdaInvocationDiag[] = [];
    h.invoke.mockResolvedValue({
      FunctionError: "Unhandled",
      Payload: Buffer.from(JSON.stringify({ errorMessage: "Task timed out after 120.00 seconds", errorType: "Sandbox.Timedout" })),
    });
    const out = await fanOutShapeParse({ pageS3Keys: [KEY(1)], onInvocation: (d) => diags.push(d) });
    expect(out.failedPages).toEqual([KEY(1)]);
    expect(out.pageErrors[KEY(1)]).toBe("Lambda error: Task timed out after 120.00 seconds (Sandbox.Timedout)");
    expect(diags[0]).toMatchObject({ functionError: "Unhandled", ok: false });
  });

  it("an SDK throw on the batch is retried per page, and a successful retry counts as scanned", async () => {
    let calls = 0;
    h.invoke.mockImplementation(async (event: Record<string, unknown>) => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("Rate exceeded"), { name: "TooManyRequestsException" });
      const { ret, store } = runHandler(event);
      for (const [k, v] of Object.entries(store)) h.store.set(k, v);
      return { Payload: Buffer.from(JSON.stringify(ret)) };
    });
    const out = await fanOutShapeParse({ pageS3Keys: [KEY(2)] });
    expect(out.okPages).toEqual([KEY(2)]);
    expect(out.failedPages).toEqual([]);
  });
});
