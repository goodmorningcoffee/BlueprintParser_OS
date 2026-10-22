// owner 2026-10-21: reprocess must persist — extractKeynotes must flag a scan that did not
// happen (`failed: true`) so persisting callers keep the page's old rows instead of writing
// keynotes=NULL. Every other test mocks @/lib/keynotes, so this is the only guard on it.
// A stub `python3` is put first on PATH (no module mocking: the real execFile/promisify path runs).
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { extractKeynotes } from "@/lib/keynotes";

let binDir = "";
const savedPath = process.env.PATH;

beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "bp2-fake-python-"));
  const stub = join(binDir, "python3");
  writeFileSync(stub, '#!/bin/sh\nprintf "%s" "$FAKE_KN_OUT"\nexit "${FAKE_KN_RC:-0}"\n');
  chmodSync(stub, 0o755);
  process.env.PATH = `${binDir}:${savedPath}`;
});
afterAll(() => {
  process.env.PATH = savedPath;
  delete process.env.FAKE_KN_OUT;
  delete process.env.FAKE_KN_RC;
  rmSync(binDir, { recursive: true, force: true });
});

function run(out: string, rc = 0) {
  process.env.FAKE_KN_OUT = out;
  process.env.FAKE_KN_RC = String(rc);
  return extractKeynotes(Buffer.from("png"));
}

describe("extractKeynotes failure signalling", () => {
  it("python crash / non-zero exit → failed: true, no keynotes", async () => {
    const r = await run("", 1);
    expect(r.failed).toBe(true);
    expect(r.keynotes).toEqual([]);
    expect(r.warnings[0]).toMatch(/^Extraction failed/);
  });

  it("CLI-caught fatal error (exit 0, 'Extraction failed' warning, no results) → failed: true", async () => {
    const r = await run(JSON.stringify({ results: [], warnings: ["Extraction failed: cannot decode image"] }));
    expect(r.failed).toBe(true);
  });

  it("genuinely empty page → not failed", async () => {
    const r = await run(JSON.stringify({ results: [], warnings: [] }));
    expect(r.failed).toBeUndefined();
    expect(r.keynotes).toEqual([]);
  });

  it("results present → not failed, shapes mapped", async () => {
    const r = await run(JSON.stringify({ results: [{ shape: "hexagon", text: "A1", bbox: [1, 2, 3, 4] }], warnings: [] }));
    expect(r.failed).toBeUndefined();
    expect(r.keynotes).toEqual([{ shape: "hexagon", text: "A1", bbox: [1, 2, 3, 4], contour: [] }]);
  });
});
