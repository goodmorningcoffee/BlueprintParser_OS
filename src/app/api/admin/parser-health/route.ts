/**
 * /api/admin/parser-health
 *
 * Phase I.2.b: Run a whitelisted diagnostic command inside the container and
 * return its output to the admin debug UI. Replaces routine ECS exec for the
 * common "is the parser stack healthy?" checks.
 *
 * GET  → list available checks (for the UI dropdown)
 * POST → run one of the whitelisted checks and return {stdout, stderr, exitCode, durationMs}
 *
 * Security: only whitelisted commands run; admin auth required. No arbitrary
 * shell access. Adding a new check requires a code change + redeploy.
 */
import { NextResponse } from "next/server";
import { spawn } from "child_process";
import { requireAdmin, apiError } from "@/lib/api-utils";

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

export async function GET() {
  const { error } = await requireAdmin();
  if (error) return error;
  return NextResponse.json({
    checks: Object.entries(CHECKS).map(([id, def]) => ({ id, description: def.description })),
  });
}

export async function POST(req: Request) {
  const { error } = await requireAdmin();
  if (error) return error;

  const body = await req.json().catch(() => ({}));
  const { check } = body as { check?: string };

  if (!check || !CHECKS[check]) {
    return apiError(`Unknown check: "${check}". Available: ${Object.keys(CHECKS).join(", ")}`, 400);
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

  return NextResponse.json({
    check,
    description,
    command: args.join(" "),
    durationMs: Date.now() - startedAt,
    ...result,
  });
}
