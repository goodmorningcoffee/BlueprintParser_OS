// [refactor jul8 S061 P1.5] Extracted from app/api/admin/parser-health/route.ts — behavior
// identical (solo fold; char: admin-parser-health.route.test.ts PH-*). The CHECKS whitelist
// is the SECURITY CORE of this feature: only these canned commands ever run, no user input
// reaches spawn except the check KEY, and adding a check requires a code change + redeploy.
// The spawn promise NEVER rejects — timeout/spawn-error/exit-code all resolve into the bare
// result object; failure details are DOMAIN data for the admin debug UI (returned at 200),
// deliberately including err.message in stderr (recon batch-2: NOT a B-leak, do not retire).

import { spawn } from "child_process";
import { ApiError } from "@/server/api/envelope";

interface CheckDef {
  description: string;
  args: string[];
}

const CHECKS: Record<string, CheckDef> = {
  deps: {
    description: "Run check_deps.py — verifies all parser dependencies (Python, Ghostscript, Tesseract, img2table, torch, transformers, TATR model files)",
    args: ["python3", "/app/scripts/check_deps.py"],
  },
  tatr_files: {
    description: "List TATR model files (verifies Phase B.2 packaging — should show model.safetensors ~115MB)",
    args: ["ls", "-la", "/app/models/tatr"],
  },
  tatr_import: {
    description: "TATR import + model load test (verifies torch/transformers/timm + model packaging end-to-end)",
    args: [
      "python3",
      "-c",
      "from transformers import TableTransformerForObjectDetection; m = TableTransformerForObjectDetection.from_pretrained('/app/models/tatr'); print('OK', type(m).__name__)",
    ],
  },
  img2table_import: {
    description: "img2table import test (verifies polars patch was applied)",
    args: [
      "python3",
      "-c",
      "from img2table.document import PDF, Image; from img2table.ocr import TesseractOCR; print('OK PDF Image TesseractOCR available')",
    ],
  },
  ghostscript: {
    description: "Ghostscript version (required for PDF rasterization)",
    args: ["gs", "--version"],
  },
  tesseract: {
    description: "Tesseract OCR version (required for img2table image mode)",
    args: ["tesseract", "--version"],
  },
  pymupdf: {
    description: "PyMuPDF (fitz) version (required for img2table PDF mode + cropping)",
    args: ["python3", "-c", "import fitz; print(fitz.__doc__[:120] if fitz.__doc__ else 'fitz available')"],
  },
  python_version: {
    description: "Python version + executable path",
    args: ["python3", "-c", "import sys; print(sys.version); print(sys.executable)"],
  },
};

/** GET — the UI dropdown's check list. Pure read of the module-const whitelist. */
export function listParserChecks() {
  return {
    checks: Object.entries(CHECKS).map(([id, def]) => ({ id, description: def.description })),
  };
}

/** POST — run one whitelisted check; bare result object (NOT enveloped) for the debug UI. */
export async function runParserCheck(body: Record<string, unknown>) {
  const { check } = body as { check?: string };

  if (!check || !Object.hasOwn(CHECKS, check)) {
    // [refactor jul8 S061] sanctioned A: was flat apiError(...,400) — message byte-verbatim.
    // [refactor jul8 P1-review PH-6b, OWNER-SANCTIONED] was a PLAIN `!CHECKS[check]` lookup:
    // Object.prototype keys ("toString"/"constructor"/"__proto__") passed the guard and
    // crashed on args below → generic 500 (spawn was NEVER reachable — crash-only, no RCE).
    // Object.hasOwn routes them into THIS clean 400 like any other unknown check. The only
    // behavior delta is prototype-keys 500→400; every real check id is unaffected.
    throw new ApiError("VALIDATION", `Unknown check: "${check}". Available: ${Object.keys(CHECKS).join(", ")}`);
  }

  const { description, args } = CHECKS[check];
  const startedAt = Date.now();

  // Run the canned command with a 30s timeout. Capture stdout, stderr, exit code.
  const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
    const proc = spawn(args[0], args.slice(1));
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve({ stdout, stderr: stderr + "\n[TIMEOUT after 30s]", exitCode: -1 });
    }, 30_000);

    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: `${stderr}\n[spawn error] ${err.message}`, exitCode: -1 });
    });
  });

  return {
    check,
    description,
    command: args.join(" "),
    durationMs: Date.now() - startedAt,
    ...result,
  };
}
