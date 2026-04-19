"use client";

import { useMemo, useRef, useState } from "react";

interface UploadWidgetProps {
  onUploadComplete: () => void;
}

const ALLOWED_EXT = new Set(["pdf", "png", "jpg", "jpeg", "tif", "tiff", "heic"]);
const MAX_FILES = 30;
const MAX_FILE_BYTES = 250 * 1024 * 1024; // 250 MB
const MAX_AGGREGATE_BYTES = 1024 * 1024 * 1024; // 1 GB

const ACCEPT_ATTR = ".pdf,.png,.jpg,.jpeg,.tif,.tiff,.heic";

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function formatMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

interface PresignFile {
  filename: string;
  url: string;
  fields: Record<string, string>;
  stagingKey: string;
  index: number;
}

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
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () =>
      xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`));
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.open("POST", presign.url);
    xhr.send(formData);
  });
}

export default function UploadWidget({ onUploadComplete }: UploadWidgetProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [perFileProgress, setPerFileProgress] = useState<Record<string, number>>({});
  const [stage, setStage] = useState<"idle" | "credentialing" | "uploading" | "creating" | "error">("idle");
  const [globalError, setGlobalError] = useState("");
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  const collator = useMemo(
    () => new Intl.Collator("en", { numeric: true, sensitivity: "base" }),
    [],
  );

  const uploading = stage === "credentialing" || stage === "uploading" || stage === "creating";

  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  const aggregateProgress =
    files.length === 0
      ? 0
      : Math.round(
          files.reduce((sum, f) => sum + (perFileProgress[f.name] ?? 0), 0) / files.length,
        );

  function resetSelection() {
    setFiles([]);
    setPerFileProgress({});
    setRowErrors({});
    setGlobalError("");
    setStage("idle");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function handleFilesPicked(fileList: FileList | null) {
    if (!fileList) return;
    const picked = Array.from(fileList);
    const sorted = picked.slice().sort((a, b) => collator.compare(a.name, b.name));

    const errors: Record<string, string> = {};
    let aggregate = 0;
    for (const f of sorted) {
      const ext = extOf(f.name);
      if (!ALLOWED_EXT.has(ext)) {
        errors[f.name] = `Unsupported type: .${ext || "(none)"}`;
        continue;
      }
      if (f.size > MAX_FILE_BYTES) {
        errors[f.name] = `Too large (${formatMB(f.size)} > 250 MB)`;
        continue;
      }
      aggregate += f.size;
    }

    let global = "";
    if (sorted.length > MAX_FILES) {
      global = `Maximum ${MAX_FILES} files per project (got ${sorted.length})`;
    } else if (aggregate > MAX_AGGREGATE_BYTES) {
      global = `Aggregate size ${formatMB(aggregate)} exceeds 1 GB cap`;
    }

    setFiles(sorted);
    setRowErrors(errors);
    setGlobalError(global);
    setPerFileProgress({});
    setStage("idle");
  }

  function removeRow(filename: string) {
    setFiles((prev) => prev.filter((f) => f.name !== filename));
    setRowErrors((prev) => {
      const next = { ...prev };
      delete next[filename];
      return next;
    });
    setPerFileProgress((prev) => {
      const next = { ...prev };
      delete next[filename];
      return next;
    });
  }

  async function handleUpload() {
    const hasBlockingErrors =
      Object.keys(rowErrors).length > 0 || globalError || files.length === 0;
    if (hasBlockingErrors) return;

    setGlobalError("");
    setStage("credentialing");
    setPerFileProgress(Object.fromEntries(files.map((f) => [f.name, 0])));

    try {
      // 1. Get staging presigns (one per file, keyed in submission order).
      const credRes = await fetch("/api/s3/staging-credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filenames: files.map((f) => f.name) }),
      });
      if (!credRes.ok) {
        const j = await credRes.json().catch(() => ({}));
        throw new Error(j.error || `Failed to get upload credentials (${credRes.status})`);
      }
      const { projectPath, files: presigns } = (await credRes.json()) as {
        projectPath: string;
        files: PresignFile[];
      };
      if (!Array.isArray(presigns) || presigns.length !== files.length) {
        throw new Error("Presign response does not match file list");
      }

      // 2. Parallel upload each file to its staging key.
      setStage("uploading");
      const byFilename = new Map<string, PresignFile>();
      presigns.forEach((p) => byFilename.set(p.filename, p));

      const uploadResults = await Promise.allSettled(
        files.map(async (f) => {
          const p = byFilename.get(f.name);
          if (!p) throw new Error(`No presign issued for ${f.name}`);
          await uploadOne(f, p, (pct) =>
            setPerFileProgress((prev) => ({ ...prev, [f.name]: pct })),
          );
          return { filename: f.name, stagingKey: p.stagingKey };
        }),
      );

      const rowErrs: Record<string, string> = {};
      const stagingFiles: Array<{ filename: string; stagingKey: string }> = [];
      uploadResults.forEach((res, i) => {
        const fn = files[i].name;
        if (res.status === "rejected") {
          rowErrs[fn] = res.reason instanceof Error ? res.reason.message : String(res.reason);
        } else {
          stagingFiles.push(res.value);
        }
      });
      if (Object.keys(rowErrs).length > 0) {
        setRowErrors(rowErrs);
        throw new Error(`${Object.keys(rowErrs).length} upload(s) failed — see rows below`);
      }

      // 3. Create project — server validates + kicks off Step Function.
      setStage("creating");
      const firstBase = files[0].name.replace(/\.[^.]+$/, "") || "Project";
      const projectName = files.length === 1 ? firstBase : `${firstBase} (+${files.length - 1})`;

      const projectRes = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: projectName, dataUrl: projectPath, stagingFiles }),
      });
      if (!projectRes.ok) {
        const j = await projectRes.json().catch(() => ({}));
        throw new Error(j.error || `Failed to create project (${projectRes.status})`);
      }

      onUploadComplete();
      resetSelection();
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : "Upload failed");
      setStage("error");
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPT_ATTR}
        multiple
        className="hidden"
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
              uploading || Object.keys(rowErrors).length > 0 || Boolean(globalError)
            }
            className="px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors text-sm font-medium disabled:opacity-50"
          >
            {stage === "credentialing" && "Preparing…"}
            {stage === "uploading" && `Uploading ${aggregateProgress}%`}
            {stage === "creating" && "Creating project…"}
            {(stage === "idle" || stage === "error") && `Upload ${files.length} file${files.length > 1 ? "s" : ""}`}
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

      {files.length > 0 && (
        <div className="text-xs text-gray-400">
          Files are indexed alphabetically ({formatMB(totalBytes)} total). Rename
          locally with <code className="px-1 bg-black/30 rounded">1_</code>,{" "}
          <code className="px-1 bg-black/30 rounded">2_</code>,{" "}
          <code className="px-1 bg-black/30 rounded">3_</code> prefixes to control page order.
        </div>
      )}

      {files.length > 0 && (
        <ul className="flex flex-col gap-1 max-h-64 overflow-y-auto pr-1">
          {files.map((f, i) => {
            const rowErr = rowErrors[f.name];
            const pct = perFileProgress[f.name] ?? 0;
            return (
              <li
                key={f.name}
                className={`flex items-center gap-2 px-3 py-1.5 rounded text-sm ${
                  rowErr
                    ? "bg-red-500/10 border border-red-500/30"
                    : "bg-white/5 border border-white/10"
                }`}
              >
                <span className="text-gray-500 w-6 text-right tabular-nums">{i + 1}.</span>
                <span className="flex-1 truncate">{f.name}</span>
                <span className="text-xs text-gray-400 tabular-nums">{formatMB(f.size)}</span>
                <span className="px-1.5 py-0.5 text-[10px] uppercase rounded bg-black/30 text-gray-300">
                  {extOf(f.name)}
                </span>
                {stage === "uploading" && !rowErr && (
                  <span className="text-xs text-emerald-300 tabular-nums w-10 text-right">
                    {pct}%
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

      {globalError && (
        <p className="text-red-400 text-sm">{globalError}</p>
      )}
    </div>
  );
}
