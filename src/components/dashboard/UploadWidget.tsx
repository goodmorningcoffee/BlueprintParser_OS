"use client";

import { useMemo, useRef, useState } from "react";
import { apiErrorMessage } from "@/lib/client-persist";
import {
  type CreateProjectBody,
  type FileStatus,
  type PresignFile,
  type UploadDeps,
  UploadHttpError,
  extOf,
  fileRowErrors,
  formatMB,
  perFileSummaryMessage,
  runMergedUpload,
  runPerFileUploads,
  selectionError,
  uploadModeFor,
} from "./upload-batch";

interface UploadWidgetProps {
  onUploadComplete: () => void;
}

const ACCEPT_ATTR = ".pdf,.png,.jpg,.jpeg,.tif,.tiff,.heic";

async function uploadOne(
  file: File,
  presign: PresignFile,
  onProgress: (pct: number) => void,
): Promise<void> {
  const formData = new FormData();
  Object.entries(presign.fields).forEach(([k, v]) => formData.append(k, v));
  formData.append("file", file);

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable)
        onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () =>
      xhr.status < 300
        ? resolve()
        : reject(new Error(`Upload failed (${xhr.status})`));
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.open("POST", presign.url);
    xhr.send(formData);
  });
}

// The only two API calls the upload flow makes; both modes in ./upload-batch go through these.
const API_DEPS: UploadDeps<File> = {
  async requestCredentials(filenames) {
    const credRes = await fetch("/api/s3/staging-credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filenames }),
    });
    if (!credRes.ok) {
      const j = await credRes.json().catch(() => ({}));
      // [refactor jul6 S033] staging-credentials now serves {error:{code,message}}
      throw new UploadHttpError(
        credRes.status,
        apiErrorMessage(j) ||
          `Failed to get upload credentials (${credRes.status})`,
      );
    }
    return (await credRes.json()) as {
      projectPath: string;
      files: PresignFile[];
    };
  },
  uploadFile: uploadOne,
  async createProject(body: CreateProjectBody) {
    const projectRes = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!projectRes.ok) {
      const j = await projectRes.json().catch(() => ({}));
      // [refactor jun17 P1.3] /api/projects now returns {error:{code,message}}; apiErrorMessage reads
      // both envelopes (legacy {error:str} + new) so the error line never shows "[object Object]".
      throw new UploadHttpError(
        projectRes.status,
        apiErrorMessage(j) ||
          `Failed to create project (${projectRes.status})`,
      );
    }
  },
};

function withoutKey<V>(map: Record<string, V>, key: string): Record<string, V> {
  const next = { ...map };
  delete next[key];
  return next;
}

function statusLabel(status: FileStatus): string {
  switch (status.state) {
    case "queued":
      return "queued";
    case "uploading":
      return `uploading ${status.pct}%`;
    case "creating":
      return "creating…";
    case "created":
      return "created";
    case "failed":
      return "failed";
    case "skipped":
      return "not uploaded";
  }
}

function statusClass(status: FileStatus): string {
  if (status.state === "created") return "text-emerald-300";
  if (status.state === "failed" || status.state === "skipped")
    return "text-red-300";
  return "text-gray-400";
}

export default function UploadWidget({ onUploadComplete }: UploadWidgetProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [perFileProgress, setPerFileProgress] = useState<
    Record<string, number>
  >({});
  const [stage, setStage] = useState<
    "idle" | "credentialing" | "uploading" | "creating" | "batch" | "error"
  >("idle");
  const [globalError, setGlobalError] = useState("");
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  // Off by default: several files become several projects unless the user asks to merge them.
  const [merge, setMerge] = useState(false);
  const [fileStatus, setFileStatus] = useState<Record<string, FileStatus>>({});
  const [batchNote, setBatchNote] = useState("");

  const collator = useMemo(
    () => new Intl.Collator("en", { numeric: true, sensitivity: "base" }),
    [],
  );

  const mode = uploadModeFor(files.length, merge);
  const selError = selectionError(files, mode);
  const shownError = globalError || selError;

  const uploading =
    stage === "credentialing" ||
    stage === "uploading" ||
    stage === "creating" ||
    stage === "batch";

  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  const aggregateProgress =
    files.length === 0
      ? 0
      : Math.round(
          files.reduce((sum, f) => sum + (perFileProgress[f.name] ?? 0), 0) /
            files.length,
        );
  const batchStarted = files.filter((f) => {
    const st = fileStatus[f.name];
    return st !== undefined && st.state !== "queued";
  }).length;

  function resetSelection() {
    setFiles([]);
    setPerFileProgress({});
    setRowErrors({});
    setGlobalError("");
    setFileStatus({});
    setBatchNote("");
    setMerge(false);
    setStage("idle");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function handleFilesPicked(fileList: FileList | null) {
    if (!fileList) return;
    const picked = Array.from(fileList);
    const sorted = picked
      .slice()
      .sort((a, b) => collator.compare(a.name, b.name));

    setFiles(sorted);
    setRowErrors(fileRowErrors(sorted));
    setGlobalError("");
    setFileStatus({});
    setBatchNote("");
    setPerFileProgress({});
    // A new selection starts from the per-file default, even if the last one was merged.
    setMerge(false);
    setStage("idle");
  }

  function removeRow(filename: string) {
    setFiles((prev) => prev.filter((f) => f.name !== filename));
    setRowErrors((prev) => withoutKey(prev, filename));
    setPerFileProgress((prev) => withoutKey(prev, filename));
    setFileStatus((prev) => withoutKey(prev, filename));
  }

  async function handleMergedUpload() {
    setGlobalError("");
    setPerFileProgress(Object.fromEntries(files.map((f) => [f.name, 0])));

    try {
      await runMergedUpload(files, API_DEPS, {
        onStage: setStage,
        onProgress: (name, pct) =>
          setPerFileProgress((prev) => ({ ...prev, [name]: pct })),
        onRowErrors: setRowErrors,
      });
      onUploadComplete();
      resetSelection();
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : "Upload failed");
      setStage("error");
    }
  }

  async function handlePerFileUpload() {
    setGlobalError("");
    setBatchNote("");
    setStage("batch");
    const batch = files.slice();
    const summary = await runPerFileUploads(batch, API_DEPS, (name, st) =>
      setFileStatus((prev) => ({ ...prev, [name]: st })),
    );

    if (summary.created.length > 0) onUploadComplete();
    if (summary.created.length === batch.length) {
      resetSelection();
      return;
    }
    // Keep only what did not become a project, so a retry never duplicates one.
    const created = new Set(summary.created);
    setFiles(batch.filter((f) => !created.has(f.name)));
    setBatchNote(perFileSummaryMessage(summary));
    setStage("idle");
  }

  async function handleUpload() {
    const hasBlockingErrors =
      Object.keys(rowErrors).length > 0 || shownError || files.length === 0;
    if (hasBlockingErrors) return;
    if (mode === "per-file") await handlePerFileUpload();
    else await handleMergedUpload();
  }

  return (
    <div className="flex flex-col gap-3">
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPT_ATTR}
        multiple
        className="hidden"
        data-testid="upload-input"
        onChange={(e) => handleFilesPicked(e.target.files)}
      />

      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="px-4 py-2 bg-[var(--accent)] text-white rounded-lg hover:bg-[var(--accent-hover)] transition-colors text-sm font-medium disabled:opacity-50"
        >
          {files.length === 0 ? "Choose files…" : "Replace selection"}
        </button>

        {files.length > 0 && (
          <button
            onClick={handleUpload}
            disabled={
              uploading ||
              Object.keys(rowErrors).length > 0 ||
              Boolean(shownError)
            }
            className="px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors text-sm font-medium disabled:opacity-50"
          >
            {stage === "credentialing" && "Preparing…"}
            {stage === "uploading" && `Uploading ${aggregateProgress}%`}
            {stage === "creating" && "Creating project…"}
            {stage === "batch" &&
              `Uploading ${batchStarted} of ${files.length}…`}
            {(stage === "idle" || stage === "error") &&
              (mode === "per-file"
                ? `Upload ${files.length} files as ${files.length} projects`
                : `Upload ${files.length} file${files.length > 1 ? "s" : ""}`)}
          </button>
        )}

        {files.length > 0 && !uploading && (
          <button
            onClick={resetSelection}
            className="px-3 py-1.5 text-sm text-gray-400 hover:text-gray-200"
          >
            Clear
          </button>
        )}
      </div>

      {files.length >= 2 && (
        <label className="flex items-center gap-2 text-sm text-gray-300 select-none">
          <input
            type="checkbox"
            checked={merge}
            disabled={uploading}
            onChange={(e) => {
              setMerge(e.target.checked);
              setGlobalError("");
              setFileStatus({});
              setBatchNote("");
            }}
          />
          Merge into one project
          <span className="text-xs text-gray-500">
            (off: each file becomes its own project)
          </span>
        </label>
      )}

      {files.length > 0 && mode === "merged" && (
        <div className="text-xs text-gray-400">
          Files are indexed alphabetically ({formatMB(totalBytes)} total).
          Rename locally with{" "}
          <code className="px-1 bg-black/30 rounded">1_</code>,{" "}
          <code className="px-1 bg-black/30 rounded">2_</code>,{" "}
          <code className="px-1 bg-black/30 rounded">3_</code> prefixes to
          control page order.
        </div>
      )}

      {files.length > 0 && mode === "per-file" && (
        <div className="text-xs text-gray-400">
          Each file becomes its own project, named after the file and
          uploaded one at a time ({formatMB(totalBytes)} total).
        </div>
      )}

      {files.length > 0 && (
        <ul className="flex flex-col gap-1 max-h-64 overflow-y-auto pr-1">
          {files.map((f, i) => {
            const st = fileStatus[f.name];
            const rowErr =
              rowErrors[f.name] ??
              (st?.state === "failed" ? st.message : undefined);
            const pct = perFileProgress[f.name] ?? 0;
            return (
              <li
                key={f.name}
                data-testid="upload-row"
                className={`flex items-center gap-2 px-3 py-1.5 rounded text-sm ${
                  rowErr
                    ? "bg-red-500/10 border border-red-500/30"
                    : "bg-white/5 border border-white/10"
                }`}
              >
                <span className="text-gray-500 w-6 text-right tabular-nums">
                  {i + 1}.
                </span>
                <span className="flex-1 truncate">{f.name}</span>
                <span className="text-xs text-gray-400 tabular-nums">
                  {formatMB(f.size)}
                </span>
                <span className="px-1.5 py-0.5 text-[10px] uppercase rounded bg-black/30 text-gray-300">
                  {extOf(f.name)}
                </span>
                {stage === "uploading" && !rowErr && (
                  <span className="text-xs text-emerald-300 tabular-nums w-10 text-right">
                    {pct}%
                  </span>
                )}
                {st && (
                  <span
                    className={`text-xs tabular-nums ${statusClass(st)}`}
                    data-testid="upload-row-status"
                  >
                    {statusLabel(st)}
                  </span>
                )}
                {!uploading && (
                  <button
                    onClick={() => removeRow(f.name)}
                    className="text-gray-500 hover:text-red-400 text-sm leading-none px-1"
                    aria-label={`Remove ${f.name}`}
                  >
                    ×
                  </button>
                )}
                {rowErr && (
                  <span className="text-xs text-red-300 truncate max-w-[12rem]">
                    {rowErr}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {batchNote && <p className="text-amber-300 text-sm">{batchNote}</p>}
      {shownError && <p className="text-red-400 text-sm">{shownError}</p>}
    </div>
  );
}
