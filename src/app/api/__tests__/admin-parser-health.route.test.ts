// @vitest-environment node
// [refactor jul8 S061] CHARACTERIZATION for the admin/parser-health SOLO (whitelisted
// container diagnostics — GET lists checks, POST spawns ONE canned command), written as THE
// FREEZE before the fold onto services/parser-health.ts. Solo. requireAdmin both methods.
// ⚠️ SUBPROCESS route: child_process.spawn is MOCKED throughout (EventEmitter fake proc);
// the whitelist (CHECKS map) is the SECURITY CORE — no user input ever reaches spawn except
// the check KEY, and the freeze pins spawn's exact (cmd, args) call. Frozen quirk inventory:
//   • POST 200 success body is BARE domain data {check,description,command,durationMs,
//     stdout,stderr,exitCode} — NOT enveloped; stays bare after fold.
//   • the spawn promise NEVER rejects: timeout → SIGKILL + stderr+"\n[TIMEOUT after 30s]"
//     exitCode -1; proc "error" → stderr+"\n[spawn error] "+err.message exitCode -1; close
//     code null → -1 (code ?? -1). The [spawn error] err.message is DOMAIN stderr data at
//     200 — NOT a B-leak, do NOT retire (recon batch-2 §parser-health).
//   • durationMs = Date.now() delta — assert expect.any(Number) only (non-deterministic).
//   • whitelist guard `!check || !CHECKS[check]` uses PLAIN property lookup → prototype keys
//     ("toString", "constructor", "__proto__") PASS the guard, then crash on `args[0]` of a
//     non-CheckDef → unhandled throw (Next default 500). NOTHING reaches spawn (args is
//     undefined) — no command execution, crash-only. PRESERVED verbatim per the
//     numeric-newPassword precedent (do not "fix" during a fold); flagged for the P1 phase
//     review as a candidate sanctioned hasOwnProperty fix. PH-6b pins it.
// Sanctioned at fold (recon batch-2): A (auth + the sole 400 literal → envelope, message
// BYTE-verbatim incl. the interpolated check) + E (malformed JSON: legacy .catch(()=>({}))
// →400 unknown-undefined becomes shell 400 "Invalid JSON body") + US-20 shell property
// (non-object JSON bodies → VALIDATION 400). NO B. Assertions tagged [S061 fold: … flips]
// state the post-fold expectation; this freeze commit asserts the LEGACY behavior.
// ⚠️ 0-arg-GET gotcha (S043/S060): legacy GET() takes no args — freeze calls phGET();
// the fold flips call sites to phGET(getReq()).
import { EventEmitter } from "events";
import { describe, expect, inject, it, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

const h = vi.hoisted(() => ({
  spawn: vi.fn(),
}));
vi.mock("child_process", async (importOriginal) => {
  const orig = await importOriginal<typeof import("child_process")>();
  return { ...orig, spawn: h.spawn }; // real module, mocked spawn only
});

import { GET as phGET, POST as phPOST } from "@/app/api/admin/parser-health/route";
import { asUser, createCompany, createUser, makeReq, readJson, signedOut } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

// [S061 fold: A flips these to {error:{code:"UNAUTHORIZED"|"FORBIDDEN", message}}]
const UNAUTH = { error: "Unauthorized" };
const ADMIN_ONLY = { error: "Admin only" };

const AVAILABLE =
  "deps, tatr_files, tatr_import, img2table_import, ghostscript, tesseract, pymupdf, python_version";
const unknownMsg = (check: string) => `Unknown check: "${check}". Available: ${AVAILABLE}`;

const postReq = (body: unknown) => makeReq("/api/admin/parser-health", { method: "POST", body });
const rawPost = (body: string) =>
  new Request("http://test.local/api/admin/parser-health", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

// EventEmitter fake proc matching exactly what the route consumes:
// .stdout.on("data") .stderr.on("data") .on("close"|"error") .kill(signal)
type FakeProc = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };
function fakeProc(): FakeProc {
  const p = new EventEmitter() as FakeProc;
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.kill = vi.fn();
  return p;
}
/** spawn mock whose emissions run AFTER the route attaches its listeners (next microtask). */
function spawnScript(run: (p: FakeProc) => void): void {
  h.spawn.mockImplementationOnce(() => {
    const p = fakeProc();
    queueMicrotask(() => run(p));
    return p;
  });
}

async function makeAdmin() {
  const company = await createCompany();
  const admin = await createUser(company.id, { role: "admin" });
  const member = await createUser(company.id);
  return { admin, member };
}

beforeEach(() => {
  vi.clearAllMocks();
  signedOut();
});

describe.skipIf(!dbUp)("admin/parser-health (PH)", () => {
  it("PH-1 GET auth: signed-out→401, member→403; spawn never touched", async () => {
    const { member } = await makeAdmin();
    let r = await readJson(await phGET());
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S061 fold: A flips]
    asUser(member);
    r = await readJson(await phGET());
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ADMIN_ONLY); // [S061 fold: A flips]
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("PH-2 GET admin → 200 bare {checks:[8]} — ids + descriptions BYTE-exact, whitelist order", async () => {
    const { admin } = await makeAdmin();
    asUser(admin);
    const r = await readJson(await phGET());
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      checks: [
        { id: "deps", description: "Run check_deps.py — verifies all parser dependencies (Python, Ghostscript, Tesseract, img2table, torch, transformers, TATR model files)" },
        { id: "tatr_files", description: "List TATR model files (verifies Phase B.2 packaging — should show model.safetensors ~115MB)" },
        { id: "tatr_import", description: "TATR import + model load test (verifies torch/transformers/timm + model packaging end-to-end)" },
        { id: "img2table_import", description: "img2table import test (verifies polars patch was applied)" },
        { id: "ghostscript", description: "Ghostscript version (required for PDF rasterization)" },
        { id: "tesseract", description: "Tesseract OCR version (required for img2table image mode)" },
        { id: "pymupdf", description: "PyMuPDF (fitz) version (required for img2table PDF mode + cropping)" },
        { id: "python_version", description: "Python version + executable path" },
      ],
    });
  });

  it("PH-3 POST auth: signed-out→401, member→403; spawn never touched", async () => {
    const { member } = await makeAdmin();
    let r = await readJson(await phPOST(postReq({ check: "ghostscript" })));
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S061 fold: A flips]
    asUser(member);
    r = await readJson(await phPOST(postReq({ check: "ghostscript" })));
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ADMIN_ONLY); // [S061 fold: A flips]
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("PH-4 POST whitelist: missing/unknown/empty check → 400, message BYTE-verbatim (interpolated value + Available list); spawn never called", async () => {
    const { admin } = await makeAdmin();
    asUser(admin);
    for (const [body, expected] of [
      [{}, unknownMsg("undefined")],
      [{ check: "foo" }, unknownMsg("foo")],
      [{ check: "" }, unknownMsg("")],
      [{ check: "deps; rm -rf /" }, unknownMsg("deps; rm -rf /")], // injection attempt = just an unknown key
    ] as const) {
      const r = await readJson(await phPOST(postReq(body)));
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: expected }); // [S061 fold: A flips to {error:{code:"VALIDATION",message:expected}}]
    }
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("PH-5 POST malformed JSON → legacy .catch(()=>({})) swallow → 400 unknownMsg('undefined')", async () => {
    const { admin } = await makeAdmin();
    asUser(admin);
    // [S061 fold: E flips this to 400 {error:{code:"BAD_REQUEST",message:"Invalid JSON body"}}
    // — the shell's safe-parse replaces the legacy silent {}-swallow. Sanctioned E, recon §parser-health.]
    const r = await readJson(await phPOST(rawPost("{ nope")));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: unknownMsg("undefined") });
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("PH-6 POST non-object JSON bodies: legacy array/empty → 400 unknownMsg, null → UNHANDLED throw", async () => {
    const { admin } = await makeAdmin();
    asUser(admin);
    // [S061 fold: US-20 flips ALL THREE to a uniform zLooseBody VALIDATION 400 (repo-wide
    // shell property; remerge precedent, DR006 noted-not-drift).]
    // "[1,2]" → destructure of an array → check=undefined → the 400 unknownMsg path.
    let r = await readJson(await phPOST(rawPost("[1,2]")));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: unknownMsg("undefined") });
    // "null" → `const { check } = null` THROWS (unhandled → Next default 500).
    await expect(phPOST(rawPost("null"))).rejects.toThrow(TypeError);
    // "" → req.json() rejects → .catch {} → the 400 unknownMsg path.
    r = await readJson(await phPOST(rawPost("")));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: unknownMsg("undefined") });
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("PH-6b POST prototype-key whitelist quirk ('toString' passes the guard, crashes on args) → UNHANDLED throw; spawn NEVER called", async () => {
    const { admin } = await makeAdmin();
    asUser(admin);
    // Legacy: `!CHECKS[check]` is a PLAIN lookup, so Object.prototype keys pass the guard,
    // then `spawn(args[0], …)` crashes on args=undefined INSIDE the Promise executor →
    // rejected promise (Next default 500). SECURITY: nothing reaches spawn — crash-only.
    // [S061 fold: shell-catch flips this to 500 {error:{code:"INTERNAL",message:"Internal
    // server error"}}. PRESERVED-not-fixed; P1 phase-review candidate: sanction a
    // hasOwnProperty guard → 400.]
    for (const check of ["toString", "constructor", "__proto__"]) {
      await expect(phPOST(postReq({ check }))).rejects.toThrow(TypeError);
    }
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("PH-7 POST happy: spawn (cmd,args) EXACT, stdout chunks concatenate, 200 BARE body shape", async () => {
    const { admin } = await makeAdmin();
    asUser(admin);
    spawnScript((p) => {
      p.stdout.emit("data", "10.02.1");
      p.stdout.emit("data", "\n"); // two chunks → concatenation pinned
      p.stderr.emit("data", "warn: cidfmap");
      p.emit("close", 0);
    });
    const r = await readJson(await phPOST(postReq({ check: "ghostscript" })));
    expect(h.spawn).toHaveBeenCalledExactlyOnceWith("gs", ["--version"]); // whitelist → spawn, verbatim
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      check: "ghostscript",
      description: "Ghostscript version (required for PDF rasterization)",
      command: "gs --version",
      durationMs: expect.any(Number), // Date.now() delta — non-deterministic, type-only
      stdout: "10.02.1\n",
      stderr: "warn: cidfmap",
      exitCode: 0,
    });
  });

  it("PH-8 POST spawn error (ENOENT class) → 200 DOMAIN data: stderr '[spawn error] '+message, exitCode -1", async () => {
    const { admin } = await makeAdmin();
    asUser(admin);
    spawnScript((p) => p.emit("error", new Error("spawn gs ENOENT")));
    const r = await readJson(await phPOST(postReq({ check: "ghostscript" })));
    expect(r.status).toBe(200); // failure is DATA for the debug UI, not an error envelope
    expect(r.body).toMatchObject({
      check: "ghostscript",
      stdout: "",
      stderr: "\n[spawn error] spawn gs ENOENT", // err.message = domain stderr data, NOT a B-leak
      exitCode: -1,
    });
  });

  it("PH-9 POST timeout: 30s → SIGKILL, stderr '[TIMEOUT after 30s]', exitCode -1 (promise resolves, never rejects)", async () => {
    const { admin } = await makeAdmin();
    asUser(admin); // DB fixtures BEFORE fake timers
    vi.useFakeTimers();
    try {
      let proc!: FakeProc;
      h.spawn.mockImplementationOnce(() => (proc = fakeProc())); // never emits close
      const pending = phPOST(postReq({ check: "python_version" }));
      await vi.advanceTimersByTimeAsync(30_000);
      const r = await readJson(await pending);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({
        check: "python_version",
        description: "Python version + executable path",
        command: "python3 -c import sys; print(sys.version); print(sys.executable)",
        durationMs: expect.any(Number),
        stdout: "",
        stderr: "\n[TIMEOUT after 30s]",
        exitCode: -1,
      });
      expect(proc.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("PH-10 POST close with null exit code → exitCode -1 (code ?? -1)", async () => {
    const { admin } = await makeAdmin();
    asUser(admin);
    spawnScript((p) => {
      p.stdout.emit("data", "partial");
      p.emit("close", null);
    });
    const r = await readJson(await phPOST(postReq({ check: "tesseract" })));
    expect(h.spawn).toHaveBeenCalledExactlyOnceWith("tesseract", ["--version"]);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ stdout: "partial", stderr: "", exitCode: -1 });
  });
});
