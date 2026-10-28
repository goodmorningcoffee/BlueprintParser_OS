// [2026-10-22 owner: "a debug statement printer I can copy and paste"] Redaction, the 2,000-event ring
// buffer (sessionStorage-backed), and the report text carrying a failing job's FailureReason.
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEBUG_LOG_MAX,
  clearYoloDebugLog,
  logYoloDebug,
  readYoloDebugEvents,
  redactDebugText,
  resetYoloDebugLogForTests,
} from "../yolo-debug-log";
import { buildYoloDebugReport, debugJobNames } from "../yolo-debug-report";

beforeEach(() => {
  try {
    window.sessionStorage.clear();
  } catch {
    /* ignore */
  }
  resetYoloDebugLogForTests();
  clearYoloDebugLog();
});

describe("redactDebugText", () => {
  it("strips presigned query strings, tokens, keys, account ids and foreign emails; keeps the root's email", () => {
    const text = [
      "GET https://beaver-data-123456789012.s3.amazonaws.com/co/p/pages/page_0001.png?X-Amz-Signature=abc&X-Amz-Credential=AKIAxyz",
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig",
      'body {"token":"s3cr3t","password":"hunter2","apiKey":"k-123"}',
      "key AKIAABCDEFGHIJKLMNOP leaked",
      "role arn:aws:iam::123456789012:role/beaver-sagemaker-role",
      "image 123456789012.dkr.ecr.us-east-1.amazonaws.com/beaver-yolo-pipeline@sha256:abc",
      "bucket beaver-data-123456789012",
      "from owner@example.com and someone@other.example",
      "relative /api/yolo/status?jobName=bp-yolo-doors-x stays",
    ].join("\n");
    const out = redactDebugText(text, "Owner@Example.com");
    expect(out).not.toMatch(/X-Amz-Signature=abc|AKIAxyz|s3cr3t|hunter2|k-123|AKIAABCDEFGHIJKLMNOP|someone@other\.example|123456789012/u);
    expect(out).toMatch(/page_0001\.png\?\[redacted\]/u);
    expect(out).toMatch(/Authorization: \[redacted\]/u);
    expect(out).not.toMatch(/eyJ/u);
    expect(out).toMatch(/owner@example\.com/u);
    expect(out).toMatch(/\[redacted-email\]/u);
    expect(out).toMatch(/arn:aws:iam::<account>:role/u);
    expect(out).toMatch(/\/api\/yolo\/status\?jobName=bp-yolo-doors-x stays/u);
  });
});

describe("debug event log", () => {
  it("is a ring buffer of DEBUG_LOG_MAX events, oldest dropped", () => {
    for (let i = 0; i < DEBUG_LOG_MAX + 25; i += 1) logYoloDebug("poll", `event ${i}`);
    const events = readYoloDebugEvents();
    expect(events).toHaveLength(DEBUG_LOG_MAX);
    expect(events[0].msg).toBe("event 25");
    expect(events[events.length - 1].msg).toBe(`event ${DEBUG_LOG_MAX + 24}`);
  });

  it("survives a reload through sessionStorage, redacted on the way in", () => {
    logYoloDebug("http", "POST /api/yolo/run-batch → 500", { error: { message: "token=abc123 for x@y.example" } });
    resetYoloDebugLogForTests(); // a reload: the in-memory copy is gone
    const [e] = readYoloDebugEvents();
    expect(e.kind).toBe("http");
    expect(JSON.stringify(e.data)).not.toMatch(/abc123|x@y\.example/u);
    expect(e.t).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });

  it("Clear empties it", () => {
    logYoloDebug("x", "y");
    clearYoloDebugLog();
    expect(readYoloDebugEvents()).toHaveLength(0);
  });
});

describe("buildYoloDebugReport", () => {
  it("includes the failing job's FailureReason, the plan, per-project rows, and the CloudWatch fallback command", () => {
    logYoloDebug("poll", "bp-yolo-doors-1: Failed", { failureReason: "AlgorithmError: CUDA out of memory" });
    const snapshot = {
      mode: "run" as const,
      modelId: 7,
      modelName: "doors",
      items: [{ projectId: "p1", projectName: "Alpha", phase: "failed" as const, jobName: "bp-yolo-doors-1", message: "Failed: AlgorithmError: CUDA out of memory" }],
      pausedForQuota: false,
      stopped: false,
      finished: true,
    };
    const report = buildYoloDebugReport({
      now: "2026-10-22T12:00:00.000Z",
      commit: null,
      options: null,
      machines: 5,
      plan: {
        at: "2026-10-22T11:00:00.000Z",
        modelId: 7,
        modelName: "doors",
        instanceType: "ml.g5.12xlarge",
        machines: 5,
        gpusPerMachine: 4,
        chunks: [{ projectIds: ["p1"], pages: 40, seconds: 255, overBudget: false }],
        estimate: "≈ $0.50",
      },
      snapshot,
      rowStatuses: { p1: "" },
      projectNames: { p1: "Alpha" },
      jobs: [
        {
          jobName: "bp-yolo-doors-1",
          details: { status: "Failed", failureReason: "AlgorithmError: CUDA out of memory", exitMessage: "exit 1", instanceType: "ml.g5.12xlarge" },
          server: {
            viewerEmail: "root@example.com",
            yoloImageDigest: `sha256:${"b".repeat(64)}`,
            rows: [{ projectName: "Alpha", projectPublicId: "p1", status: "failed", error: null, startedAt: "x", completedAt: "y", modelConfig: { batchPages: 40 } }],
            leases: [],
            computeUsage: [{ projectPublicId: "p1", pages: 40 }],
            logs: { readable: false, reason: "not readable by the app role", command: "aws logs tail /aws/sagemaker/ProcessingJobs --log-stream-name-prefix bp-yolo-doors-1 --since 1d" },
          },
        },
      ],
      events: readYoloDebugEvents(),
      keepEmail: "root@example.com",
    });
    expect(report).toMatch(/failureReason AlgorithmError: CUDA out of memory/u);
    expect(report).toMatch(/job 1: 1 project\(s\) · 40 pages · est 255 s: Alpha/u);
    expect(report).toMatch(/Alpha \[p1\]: failed · job bp-yolo-doors-1/u);
    expect(report).toMatch(/CloudWatch logs: not readable by the app role \(owner can run: aws logs tail \/aws\/sagemaker\/ProcessingJobs --log-stream-name-prefix bp-yolo-doors-1/u);
    expect(report).toMatch(/\[poll\] bp-yolo-doors-1: Failed/u);
    expect(report).toMatch(/yolo image digest: sha256:b{64}/u);
  });

  it("collects job names from the queue and the tab's Running rows, newest first, bounded", () => {
    const snapshot = {
      mode: "run" as const, modelId: 1, modelName: "m", pausedForQuota: false, stopped: false, finished: false,
      items: [
        { projectId: "a", projectName: "A", phase: "running" as const, jobName: "j1" },
        { projectId: "b", projectName: "B", phase: "running" as const, jobName: "j2" },
      ],
    };
    expect(debugJobNames(snapshot, { c: "Running: j3", d: "Completed — 1 detections loaded" })).toEqual(["j2", "j1", "j3"]);
    expect(debugJobNames(null, { c: "Running: j3" }, 0)).toEqual([]);
  });
});
