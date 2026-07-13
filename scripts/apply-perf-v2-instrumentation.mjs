// Apply the same measurement-only React Profiler overlay to an exact detached app worktree.
// The production SHA is recorded separately; this script never runs against the owner checkout.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_VERSION = "bp-perf-v2-overlay-1";
const scriptPath = fileURLToPath(import.meta.url);
const harnessRoot = resolve(dirname(scriptPath), "..");

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function git(appRoot, ...args) {
  return execFileSync("git", ["-C", appRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function replaceExactlyOnce(text, before, after, label) {
  const first = text.indexOf(before);
  const last = text.lastIndexOf(before);
  if (first < 0 || first !== last) {
    throw new Error(`${label}: expected exactly one instrumentation marker, found ${first < 0 ? 0 : "multiple"}`);
  }
  return text.slice(0, first) + after + text.slice(first + before.length);
}

const appRoot = resolve(argument("app-root") ?? "");
const sourceSha = argument("source-sha");
if (!argument("app-root") || !sourceSha) {
  throw new Error("usage: node scripts/apply-perf-v2-instrumentation.mjs --app-root PATH --source-sha SHA");
}
if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
  throw new Error(`--source-sha must be the exact lowercase 40-character commit SHA; received ${JSON.stringify(sourceSha)}`);
}

const canonicalAppRoot = realpathSync(appRoot);
const canonicalHarnessRoot = realpathSync(harnessRoot);
const worktreeRoot = realpathSync(git(canonicalAppRoot, "rev-parse", "--show-toplevel"));
if (worktreeRoot !== canonicalAppRoot) {
  throw new Error(`--app-root must be the worktree root: expected ${worktreeRoot}, received ${canonicalAppRoot}`);
}
if (canonicalAppRoot === canonicalHarnessRoot) {
  throw new Error("refusing to apply the measurement overlay to the owner harness checkout");
}
const actualHead = git(canonicalAppRoot, "rev-parse", "--verify", "HEAD");
if (actualHead !== sourceSha) {
  throw new Error(`source SHA mismatch: --source-sha=${sourceSha}, worktree HEAD=${actualHead}`);
}
const preOverlayStatus = git(
  canonicalAppRoot,
  "status",
  "--porcelain=v1",
  "--untracked-files=all",
);
if (preOverlayStatus !== "") {
  throw new Error(`worktree must be clean before instrumentation:\n${preOverlayStatus}`);
}

const probeTemplatePath = join(harnessRoot, "e2e/perf-v2/PerfRenderProbe.tsx");
const probeSource = readFileSync(probeTemplatePath, "utf8");
const probeTargetPath = join(canonicalAppRoot, "src/components/viewer/PerfRenderProbe.tsx");

const transforms = [
  {
    file: "src/components/viewer/PDFPage.tsx",
    importBefore: 'import AnnotationOverlay from "./AnnotationOverlay";',
    importAfter: 'import AnnotationOverlay from "./AnnotationOverlay";\nimport PerfRenderProbe from "./PerfRenderProbe";',
    jsxBefore: "      {/* PNG background — ALWAYS in DOM behind canvas. Shows through when canvas is hidden.",
    jsxAfter: "      <PerfRenderProbe id=\"PDFPage\" />\n      {/* PNG background — ALWAYS in DOM behind canvas. Shows through when canvas is hidden.",
  },
  {
    file: "src/components/viewer/AnnotationOverlay.tsx",
    importBefore: 'import DrawingPreviewLayer from "./DrawingPreviewLayer";',
    importAfter: 'import DrawingPreviewLayer from "./DrawingPreviewLayer";\nimport PerfRenderProbe from "./PerfRenderProbe";',
    jsxBefore: "  return (\n    <>\n      <canvas\n        ref={canvasRef}",
    jsxAfter: "  return (\n    <>\n      <PerfRenderProbe id=\"AnnotationOverlay\" />\n      <canvas\n        ref={canvasRef}\n        data-perf-surface=\"annotation-overlay\"",
  },
  {
    file: "src/components/viewer/DrawingPreviewLayer.tsx",
    importBefore: 'import BucketFillAssignDialog from "./BucketFillAssignDialog";',
    importAfter: 'import BucketFillAssignDialog from "./BucketFillAssignDialog";\nimport PerfRenderProbe from "./PerfRenderProbe";',
    jsxBefore: "  return (\n    <>\n      <canvas\n        ref={canvasRef}",
    jsxAfter: "  return (\n    <>\n      <PerfRenderProbe id=\"DrawingPreviewLayer\" />\n      <canvas\n        ref={canvasRef}",
  },
];

// Preflight every marker before making the first write so a source-shape mismatch cannot leave a
// partially instrumented tree.
const preparedTransforms = transforms.map((transform) => {
  const path = join(canonicalAppRoot, transform.file);
  const before = readFileSync(path, "utf8");
  if (before.includes('from "./PerfRenderProbe"')) {
    throw new Error(`${transform.file}: overlay already applied`);
  }
  let after = replaceExactlyOnce(
    before,
    transform.importBefore,
    transform.importAfter,
    `${transform.file} import`,
  );
  after = replaceExactlyOnce(
    after,
    transform.jsxBefore,
    transform.jsxAfter,
    `${transform.file} JSX`,
  );
  return {
    path,
    after,
    target: {
      file: transform.file,
      beforeSha256: sha256(before),
      afterSha256: sha256(after),
    },
  };
});

mkdirSync(dirname(probeTargetPath), { recursive: true });
writeFileSync(probeTargetPath, probeSource);
for (const prepared of preparedTransforms) {
  writeFileSync(prepared.path, prepared.after);
}

// Hash the bytes back from disk; do not publish a manifest based only on the in-memory transforms.
const onDiskProbeSha256 = sha256(readFileSync(probeTargetPath));
const expectedProbeSha256 = sha256(probeSource);
if (onDiskProbeSha256 !== expectedProbeSha256) {
  throw new Error(`probe verification failed: expected ${expectedProbeSha256}, read ${onDiskProbeSha256}`);
}
const targets = preparedTransforms.map(({ path, target }) => {
  const onDiskAfterSha256 = sha256(readFileSync(path));
  if (onDiskAfterSha256 !== target.afterSha256) {
    throw new Error(`${target.file}: after-hash verification failed: expected ${target.afterSha256}, read ${onDiskAfterSha256}`);
  }
  return { ...target, afterSha256: onDiskAfterSha256 };
});

const overlayProtocolSha256 = sha256([
  SCRIPT_VERSION,
  readFileSync(scriptPath),
  probeSource,
].join("\n--overlay-part--\n"));
const manifest = {
  schemaVersion: "bp-perf-v2-instrumentation-manifest-1",
  scriptVersion: SCRIPT_VERSION,
  sourceSha,
  overlayProtocolSha256,
  probeSha256: onDiskProbeSha256,
  targets,
};
const manifestPath = join(canonicalAppRoot, ".perf-v2-instrumentation.json");
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
const onDiskManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (JSON.stringify(onDiskManifest) !== JSON.stringify(manifest)) {
  throw new Error("instrumentation manifest read-back verification failed");
}
console.log(JSON.stringify(manifest, null, 2));
