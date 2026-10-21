// Upload orchestration for UploadWidget, kept free of fetch/XHR/React so it can be unit-tested.
// The widget injects the three network steps (staging credentials, S3 staging upload, project
// create); the two API calls stay in UploadWidget.tsx, under its raw-fetch ceiling.
//
// Two modes (owner ruling 2026-10-21: "when im uploading a project, im uploading a blueprint"):
//   • "merged"   — today's behaviour: ONE credentials request for every file, parallel staging
//                  uploads, ONE POST /api/projects whose staged files the server concatenates.
//   • "per-file" — the default for ≥2 files: the single-file flow run once per file, one at a
//                  time, each project named after its own file. A failed file does not stop the
//                  rest; a 429 (upload quota / rate limit) stops everything still queued.

export const ALLOWED_EXT = new Set([
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "tif",
  "tiff",
  "heic",
]);
export const MAX_FILES = 30;
export const MAX_FILE_BYTES = 500 * 1024 * 1024; // 500 MB
export const MAX_AGGREGATE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

export type UploadMode = "merged" | "per-file";

export interface UploadableFile {
  name: string;
  size: number;
}

export interface PresignFile {
  filename: string;
  url: string;
  fields: Record<string, string>;
  stagingKey: string;
  index: number;
}

export interface StagedFile {
  filename: string;
  stagingKey: string;
}

export interface CreateProjectBody {
  name: string;
  dataUrl: string;
  stagingFiles: StagedFile[];
}

/** An API call that failed with an HTTP status; `status` 429 halts a per-file batch. */
export class UploadHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "UploadHttpError";
    this.status = status;
  }
}

export interface UploadDeps<F extends UploadableFile> {
  /** POST /api/s3/staging-credentials. Throws UploadHttpError when the response is not ok. */
  requestCredentials(
    filenames: string[],
  ): Promise<{ projectPath: string; files: PresignFile[] }>;
  /** Upload one file to its presigned staging key. */
  uploadFile(
    file: F,
    presign: PresignFile,
    onProgress: (pct: number) => void,
  ): Promise<void>;
  /** POST /api/projects. Throws UploadHttpError when the response is not ok. */
  createProject(body: CreateProjectBody): Promise<void>;
}

export function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function formatMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The mode a selection runs in. A single file always takes the original (merged) path. */
export function uploadModeFor(fileCount: number, merge: boolean): UploadMode {
  return fileCount >= 2 && !merge ? "per-file" : "merged";
}

/** Project name rule: the first file's base name, plus " (+N)" when several files are merged. */
export function projectNameFor(files: readonly UploadableFile[]): string {
  const firstBase = files[0].name.replace(/\.[^.]+$/, "") || "Project";
  return files.length === 1 ? firstBase : `${firstBase} (+${files.length - 1})`;
}

/** Per-file validation errors (type, 500 MB), keyed by filename. Applies in both modes. */
export function fileRowErrors(
  files: readonly UploadableFile[],
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of files) {
    const ext = extOf(f.name);
    if (!ALLOWED_EXT.has(ext)) {
      errors[f.name] = `Unsupported type: .${ext || "(none)"}`;
    } else if (f.size > MAX_FILE_BYTES) {
      errors[f.name] = `Too large (${formatMB(f.size)} > 500 MB)`;
    }
  }
  return errors;
}

/**
 * Selection-wide validation. The 30-file cap applies in both modes; the 2 GB aggregate applies
 * only when merging (each per-file project is bounded by the 500 MB per-file limit instead).
 */
export function selectionError(
  files: readonly UploadableFile[],
  mode: UploadMode,
): string {
  if (files.length > MAX_FILES) {
    return mode === "merged"
      ? `Maximum ${MAX_FILES} files per project (got ${files.length})`
      : `Maximum ${MAX_FILES} files per upload (got ${files.length})`;
  }
  if (mode === "merged") {
    const rowErrors = fileRowErrors(files);
    const aggregate = files.reduce(
      (sum, f) => (rowErrors[f.name] ? sum : sum + f.size),
      0,
    );
    if (aggregate > MAX_AGGREGATE_BYTES) {
      return `Aggregate size ${formatMB(aggregate)} exceeds 2 GB cap`;
    }
  }
  return "";
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type MergedStage = "credentialing" | "uploading" | "creating";

export interface MergedHooks {
  onStage(stage: MergedStage): void;
  onProgress(filename: string, pct: number): void;
  onRowErrors(errors: Record<string, string>): void;
}

/**
 * Today's flow, unchanged: one credentials request for all files, parallel staging uploads,
 * one project. Throws an Error whose message is shown as the widget's global error.
 */
export async function runMergedUpload<F extends UploadableFile>(
  files: readonly F[],
  deps: UploadDeps<F>,
  hooks: MergedHooks,
): Promise<void> {
  // 1. Staging presigns (one per file, keyed in submission order).
  hooks.onStage("credentialing");
  const { projectPath, files: presigns } = await deps.requestCredentials(
    files.map((f) => f.name),
  );
  if (!Array.isArray(presigns) || presigns.length !== files.length) {
    throw new Error("Presign response does not match file list");
  }

  // 2. Parallel upload each file to its staging key.
  hooks.onStage("uploading");
  const uploadResults = await Promise.allSettled(
    files.map(async (f, index) => {
      const p = presigns[index];
      if (!p || p.index !== index || p.filename !== f.name) {
        throw new Error(`No matching presign issued for file ${index + 1}`);
      }
      await deps.uploadFile(f, p, (pct) => hooks.onProgress(f.name, pct));
      return { filename: f.name, stagingKey: p.stagingKey };
    }),
  );

  const rowErrs: Record<string, string> = {};
  const stagingFiles: StagedFile[] = [];
  uploadResults.forEach((res, i) => {
    if (res.status === "rejected") {
      rowErrs[files[i].name] = messageOf(res.reason);
    } else {
      stagingFiles.push(res.value);
    }
  });
  if (Object.keys(rowErrs).length > 0) {
    hooks.onRowErrors(rowErrs);
    throw new Error(
      `${Object.keys(rowErrs).length} upload(s) failed — see rows below`,
    );
  }

  // 3. Create project — server validates + kicks off processing.
  hooks.onStage("creating");
  await deps.createProject({
    name: projectNameFor(files),
    dataUrl: projectPath,
    stagingFiles,
  });
}

export type FileStatus =
  | { state: "queued" }
  | { state: "uploading"; pct: number }
  | { state: "creating" }
  | { state: "created" }
  | { state: "failed"; message: string }
  | { state: "skipped" };

export interface PerFileSummary {
  created: string[];
  failed: string[];
  /** Not uploaded because of a 429: the refused file plus every file still queued after it. */
  skipped: string[];
  /** The server's 429 message when the batch was halted by quota / rate limit. */
  haltMessage: string | null;
}

/** Run the single-file flow once per file, sequentially. Never throws. */
export async function runPerFileUploads<F extends UploadableFile>(
  files: readonly F[],
  deps: UploadDeps<F>,
  onStatus: (filename: string, status: FileStatus) => void,
): Promise<PerFileSummary> {
  const summary: PerFileSummary = {
    created: [],
    failed: [],
    skipped: [],
    haltMessage: null,
  };
  for (const f of files) onStatus(f.name, { state: "queued" });

  for (const f of files) {
    if (summary.haltMessage !== null) {
      summary.skipped.push(f.name);
      onStatus(f.name, { state: "skipped" });
      continue;
    }
    let rowMessage: string | null = null;
    try {
      onStatus(f.name, { state: "uploading", pct: 0 });
      await runMergedUpload([f], deps, {
        onStage: (stage) => {
          if (stage === "creating") onStatus(f.name, { state: "creating" });
        },
        onProgress: (_name, pct) =>
          onStatus(f.name, { state: "uploading", pct }),
        onRowErrors: (errors) => {
          rowMessage = errors[f.name] ?? null;
        },
      });
      summary.created.push(f.name);
      onStatus(f.name, { state: "created" });
    } catch (err) {
      // A one-file run reports a staging-upload failure as "1 upload(s) failed — see rows
      // below"; this row IS the row, so show the underlying upload message instead.
      const message = rowMessage ?? messageOf(err);
      onStatus(f.name, { state: "failed", message });
      if (err instanceof UploadHttpError && err.status === 429) {
        // Quota / rate limit: this file and every one after it are "not uploaded".
        summary.haltMessage = message;
        summary.skipped.push(f.name);
      } else {
        summary.failed.push(f.name);
      }
    }
  }
  return summary;
}

/** The global line shown after a per-file batch that did not fully succeed. */
export function perFileSummaryMessage(summary: PerFileSummary): string {
  const parts: string[] = [];
  if (summary.haltMessage !== null) {
    parts.push(summary.haltMessage);
    parts.push(`${summary.skipped.length} not uploaded`);
  }
  const total =
    summary.created.length + summary.failed.length + summary.skipped.length;
  parts.push(`${summary.created.length} of ${total} projects created`);
  if (summary.failed.length > 0) {
    parts.push(`${summary.failed.length} failed — see rows below`);
  }
  return parts.join(" · ");
}
