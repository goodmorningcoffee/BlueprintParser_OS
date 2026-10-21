// Upload orchestration (owner ruling 2026-10-21): several selected files become several projects by
// default; "Merge into one project" keeps the original single-request flow.

import { describe, expect, it, vi } from "vitest";
import {
  type CreateProjectBody,
  type FileStatus,
  type PresignFile,
  type UploadDeps,
  type UploadableFile,
  MAX_AGGREGATE_BYTES,
  UploadHttpError,
  fileRowErrors,
  perFileSummaryMessage,
  projectNameFor,
  runMergedUpload,
  runPerFileUploads,
  selectionError,
  uploadModeFor,
} from "../upload-batch";

function f(name: string, size = 10): UploadableFile {
  return { name, size };
}

interface FakeOpts {
  failUpload?: Set<string>;
  failCreate?: Map<string, UploadHttpError>;
  failCredentials?: Map<string, UploadHttpError>;
}

function fakeDeps(opts: FakeOpts = {}) {
  let n = 0;
  const credentialCalls: string[][] = [];
  const createCalls: CreateProjectBody[] = [];
  const deps: UploadDeps<UploadableFile> = {
    async requestCredentials(filenames) {
      credentialCalls.push(filenames);
      const fail = opts.failCredentials?.get(filenames[0]);
      if (fail) throw fail;
      const projectPath = `co/p${++n}`;
      const files: PresignFile[] = filenames.map((filename, index) => ({
        filename,
        url: "https://s3.example/staging",
        fields: {},
        stagingKey: `${projectPath}/staging/${index}/${filename}`,
        index,
      }));
      return { projectPath, files };
    },
    async uploadFile(file, _presign, onProgress) {
      onProgress(50);
      if (opts.failUpload?.has(file.name)) throw new Error("Upload failed (403)");
      onProgress(100);
    },
    async createProject(body) {
      createCalls.push(body);
      const fail = opts.failCreate?.get(body.stagingFiles[0].filename);
      if (fail) throw fail;
    },
  };
  return { deps, credentialCalls, createCalls };
}

const quiet = { onStage: () => {}, onProgress: () => {}, onRowErrors: () => {} };

describe("mode + naming + validation", () => {
  it("a single file always takes the original path; ≥2 default to per-file", () => {
    expect(uploadModeFor(1, false)).toBe("merged");
    expect(uploadModeFor(1, true)).toBe("merged");
    expect(uploadModeFor(2, false)).toBe("per-file");
    expect(uploadModeFor(2, true)).toBe("merged");
  });

  it("keeps the original name rule", () => {
    expect(projectNameFor([f("A-101.pdf")])).toBe("A-101");
    expect(projectNameFor([f("A-101.pdf"), f("A-102.pdf"), f("A-103.pdf")])).toBe("A-101 (+2)");
    expect(projectNameFor([f(".pdf")])).toBe("Project");
  });

  it("per-file limits apply to each file", () => {
    expect(fileRowErrors([f("a.docx"), f("b.pdf", 501 * 1024 * 1024), f("c.png")])).toEqual({
      "a.docx": "Unsupported type: .docx",
      "b.pdf": "Too large (501.0 MB > 500 MB)",
    });
  });

  it("30-file cap in both modes; 2 GB aggregate only when merging", () => {
    const many = Array.from({ length: 31 }, (_, i) => f(`${i}.pdf`));
    expect(selectionError(many, "merged")).toBe("Maximum 30 files per project (got 31)");
    expect(selectionError(many, "per-file")).toBe("Maximum 30 files per upload (got 31)");
    const big = Array.from({ length: 5 }, (_, i) => f(`${i}.pdf`, 450 * 1024 * 1024));
    expect(big.reduce((s, x) => s + x.size, 0)).toBeGreaterThan(MAX_AGGREGATE_BYTES);
    expect(selectionError(big, "merged")).toBe("Aggregate size 2250.0 MB exceeds 2 GB cap");
    expect(selectionError(big, "per-file")).toBe("");
  });
});

describe("runMergedUpload (toggle ON: today's flow)", () => {
  it("one credentials request for all files, one project with every staged file", async () => {
    const { deps, credentialCalls, createCalls } = fakeDeps();
    const files = [f("A.pdf"), f("B.pdf"), f("C.pdf")];
    await runMergedUpload(files, deps, quiet);
    expect(credentialCalls).toEqual([["A.pdf", "B.pdf", "C.pdf"]]);
    expect(createCalls).toEqual([
      {
        name: "A (+2)",
        dataUrl: "co/p1",
        stagingFiles: [
          { filename: "A.pdf", stagingKey: "co/p1/staging/0/A.pdf" },
          { filename: "B.pdf", stagingKey: "co/p1/staging/1/B.pdf" },
          { filename: "C.pdf", stagingKey: "co/p1/staging/2/C.pdf" },
        ],
      },
    ]);
  });

  it("a failed staging upload reports the rows and creates nothing", async () => {
    const { deps, createCalls } = fakeDeps({ failUpload: new Set(["B.pdf"]) });
    const onRowErrors = vi.fn();
    await expect(
      runMergedUpload([f("A.pdf"), f("B.pdf")], deps, { ...quiet, onRowErrors }),
    ).rejects.toThrow("1 upload(s) failed — see rows below");
    expect(onRowErrors).toHaveBeenCalledWith({ "B.pdf": "Upload failed (403)" });
    expect(createCalls).toEqual([]);
  });
});

describe("runPerFileUploads (default for ≥2 files)", () => {
  it("creates one project per file, each named after its own file, sequentially", async () => {
    const { deps, credentialCalls, createCalls } = fakeDeps();
    const summary = await runPerFileUploads([f("A.pdf"), f("B.pdf"), f("C.png")], deps, () => {});
    expect(credentialCalls).toEqual([["A.pdf"], ["B.pdf"], ["C.png"]]);
    expect(createCalls.map((c) => c.name)).toEqual(["A", "B", "C"]);
    expect(createCalls.map((c) => c.stagingFiles.length)).toEqual([1, 1, 1]);
    expect(new Set(createCalls.map((c) => c.dataUrl)).size).toBe(3);
    expect(summary).toEqual({ created: ["A.pdf", "B.pdf", "C.png"], failed: [], skipped: [], haltMessage: null });
  });

  it("never runs two files at once", async () => {
    const { deps } = fakeDeps();
    let inFlight = 0;
    let peak = 0;
    const slow: UploadDeps<UploadableFile> = {
      ...deps,
      async uploadFile(file, presign, onProgress) {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        await deps.uploadFile(file, presign, onProgress);
        inFlight--;
      },
    };
    await runPerFileUploads([f("A.pdf"), f("B.pdf"), f("C.pdf")], slow, () => {});
    expect(peak).toBe(1);
  });

  it("a failing file does not stop the rest", async () => {
    const { deps, createCalls } = fakeDeps({
      failUpload: new Set(["A.pdf"]),
      failCreate: new Map([["B.pdf", new UploadHttpError(400, "Staged file missing in S3: B.pdf")]]),
    });
    const statuses: Record<string, FileStatus> = {};
    const summary = await runPerFileUploads(
      [f("A.pdf"), f("B.pdf"), f("C.pdf")],
      deps,
      (name, st) => (statuses[name] = st),
    );
    expect(createCalls.map((c) => c.name)).toEqual(["B", "C"]);
    expect(summary.created).toEqual(["C.pdf"]);
    expect(summary.failed).toEqual(["A.pdf", "B.pdf"]);
    expect(statuses).toEqual({
      "A.pdf": { state: "failed", message: "Upload failed (403)" },
      "B.pdf": { state: "failed", message: "Staged file missing in S3: B.pdf" },
      "C.pdf": { state: "created" },
    });
    expect(perFileSummaryMessage(summary)).toBe("1 of 3 projects created · 2 failed — see rows below");
  });

  it("a 429 stops the remaining files and says how many were not uploaded", async () => {
    const quota = new UploadHttpError(429, "Daily upload limit reached (10/day)");
    const { deps, credentialCalls, createCalls } = fakeDeps({ failCreate: new Map([["B.pdf", quota]]) });
    const statuses: Record<string, FileStatus> = {};
    const summary = await runPerFileUploads(
      [f("A.pdf"), f("B.pdf"), f("C.pdf"), f("D.pdf")],
      deps,
      (name, st) => (statuses[name] = st),
    );
    expect(credentialCalls).toEqual([["A.pdf"], ["B.pdf"]]);
    expect(createCalls.map((c) => c.name)).toEqual(["A", "B"]);
    expect(summary).toEqual({
      created: ["A.pdf"],
      failed: [],
      skipped: ["B.pdf", "C.pdf", "D.pdf"],
      haltMessage: "Daily upload limit reached (10/day)",
    });
    expect(statuses["C.pdf"]).toEqual({ state: "skipped" });
    expect(perFileSummaryMessage(summary)).toBe(
      "Daily upload limit reached (10/day) · 3 not uploaded · 1 of 4 projects created",
    );
  });

  it("a 429 from staging credentials also halts the batch", async () => {
    const { deps, createCalls } = fakeDeps({
      failCredentials: new Map([["A.pdf", new UploadHttpError(429, "Too many requests")]]),
    });
    const summary = await runPerFileUploads([f("A.pdf"), f("B.pdf")], deps, () => {});
    expect(createCalls).toEqual([]);
    expect(summary.skipped).toEqual(["A.pdf", "B.pdf"]);
    expect(summary.haltMessage).toBe("Too many requests");
  });
});
