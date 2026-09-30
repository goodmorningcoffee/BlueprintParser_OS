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
// (non-object JSON bodies → VALIDATION 400). NO B. Assertions tagged [S061 fold: … applied]
// were flipped in the fold commit; the freeze commit (59c4ba1) asserted the legacy
// behaviors stated inline. ⚠️ 0-arg-GET gotcha (S043/S060): legacy GET() took no args —
// the freeze called phGET(); the fold flipped call sites to phGET(getReq()).
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

// [S061 fold: A applied] — at freeze these were the legacy flat bodies
// {error:"Unauthorized"} / {error:"Admin only"}.
const UNAUTH = { error: { code: "UNAUTHORIZED", message: "Unauthorized" } };
const ADMIN_ONLY = { error: { code: "FORBIDDEN", message: "Admin only" } };

const AVAILABLE =
  "deps, tatr_files, tatr_import, img2table_import, ghostscript, tesseract, pymupdf, python_version";
const unknownMsg = (check: string) => `Unknown check: "${check}". Available: ${AVAILABLE}`;

const getReq = () => makeReq("/api/admin/parser-health", { method: "GET" });
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
    let r = await readJson(await phGET(getReq()));
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S061 fold: A applied]
    asUser(member);
    r = await readJson(await phGET(getReq()));
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ADMIN_ONLY); // [S061 fold: A applied]
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("PH-2 GET admin → 200 bare {checks:[8]} — ids + descriptions BYTE-exact, whitelist order", async () => {
    const { admin } = await makeAdmin();
    asUser(admin);
    const r = await readJson(await phGET(getReq()));
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
    expect(r.body).toEqual(UNAUTH); // [S061 fold: A applied]
    asUser(member);
    r = await readJson(await phPOST(postReq({ check: "ghostscript" })));
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ADMIN_ONLY); // [S061 fold: A applied]
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
      // [S061 DETECTOR closer FA-4] non-string check values interpolate stringified —
      // locks the zLooseBody loose-typing contract against a future z.string() tightening.
      [{ check: 123 }, unknownMsg("123")],
      [{ check: {} }, unknownMsg("[object Object]")],
    ] as const) {
      const r = await readJson(await phPOST(postReq(body)));
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: { code: "VALIDATION", message: expected } }); // [S061 fold: A applied — legacy flat {error: expected}]
    }
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("PH-5 POST malformed JSON → 400 'Invalid JSON body'", async () => {
    const { admin } = await makeAdmin();
    asUser(admin);
    // [S061 fold: E applied — legacy `.catch(() => ({}))` swallowed the parse failure to {}
    // and fell through to 400 unknownMsg("undefined"). Sanctioned E, recon §parser-health.]
    const r = await readJson(await phPOST(rawPost("{ nope")));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: { code: "BAD_REQUEST", message: "Invalid JSON body" } });
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("PH-5b SIGNED-OUT + malformed JSON → 401 (auth runs before the body is read)", async () => {
    // [S061 DETECTOR closer FA-1/SEC-1/PH-F1] The S061 shell parsed the body BEFORE auth (400).
    // [hardening sep30] REVERSED on purpose: routes whose auth needs no body now authenticate
    // FIRST, so a signed-out caller never makes the server read or parse a body → 401 here.
    // Only a body-keyed project lookup still parses first. No auth oracle / existence leak.
    const r = await readJson(await phPOST(rawPost("{ nope")));
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } });
    const r2 = await readJson(await phPOST(rawPost("[1,2]"))); // parses OK → auth wins
    expect(r2.status).toBe(401);
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("PH-6 POST non-object JSON bodies → shell zLooseBody VALIDATION 400 (US-20 uniform shell property)", async () => {
    const { admin } = await makeAdmin();
    asUser(admin);
    // [S061 fold: US-20 applied] Legacy: "[1,2]" destructured to check=undefined (→ 400
    // unknownMsg path); "null" THREW on destructure (unhandled → Next default 500); ""
    // json()-rejected → .catch {} → 400 unknownMsg path. The shell's z.record object-ness
    // check yields a uniform VALIDATION 400 instead — repo-wide shell property (remerge
    // precedent, DR006 noted-not-drift).
    for (const body of ["[1,2]", "null", ""] as const) {
      const r = await readJson(await phPOST(rawPost(body)));
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("VALIDATION");
    }
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("PH-6b POST prototype keys → clean 400 like any unknown check; spawn NEVER called [owner-sanctioned P1-review fix]", async () => {
    const { admin } = await makeAdmin();
    asUser(admin);
    // History: legacy `!CHECKS[check]` was a PLAIN lookup — prototype keys passed the guard
    // and crashed on args (500; spawn unreachable, crash-only). S061 pinned that quirk.
    // P1 phase review (2026-07-08): owner SANCTIONED the Object.hasOwn guard → these keys
    // now take the ordinary unknown-check VALIDATION 400, message verbatim. Spawn stays
    // unreachable — the security property is unchanged, only the status/envelope improved.
    for (const check of ["toString", "constructor", "__proto__"]) {
      const r = await readJson(await phPOST(postReq({ check })));
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: { code: "VALIDATION", message: unknownMsg(check) } });
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
    spawnScript((p) => {
      p.stderr.emit("data", "partial warn"); // [S061 DETECTOR closer FA-3] prior stderr must survive
      p.emit("error", new Error("spawn gs ENOENT"));
    });
    const r = await readJson(await phPOST(postReq({ check: "ghostscript" })));
    expect(r.status).toBe(200); // failure is DATA for the debug UI, not an error envelope
    expect(r.body).toMatchObject({
      check: "ghostscript",
      stdout: "",
      // accumulated stderr + APPENDED suffix; err.message = domain stderr data, NOT a B-leak
      stderr: "partial warn\n[spawn error] spawn gs ENOENT",
      exitCode: -1,
    });
  });

  it("PH-9 POST timeout: 30s → SIGKILL, stderr '[TIMEOUT after 30s]', exitCode -1 (promise resolves, never rejects)", async () => {
    const { admin } = await makeAdmin();
    asUser(admin); // DB fixtures BEFORE fake timers
    vi.useFakeTimers();
    try {
      let proc!: FakeProc;
      h.spawn.mockImplementationOnce(() => {
        proc = fakeProc(); // never emits close
        // [S061 DETECTOR closer FA-3] stderr emitted BEFORE the timeout must survive into
        // the suffixed value (microtasks run under fake timers; listeners attach sync).
        queueMicrotask(() => proc.stderr.emit("data", "loading torch..."));
        return proc;
      });
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
        stderr: "loading torch...\n[TIMEOUT after 30s]", // accumulated + APPENDED suffix
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

  it("PH-11 SECURITY-CORE table: every whitelist entry spawns its EXACT (cmd, args) — all 8 pinned", async () => {
    const { admin } = await makeAdmin();
    asUser(admin);
    // [S061 DETECTOR closer FA-2] PH-7/9/10 pinned only 3 of 8 arg-arrays; a silent mutation
    // of e.g. tatr_import's '/app/models/tatr' or deps' script path would otherwise pass.
    const TABLE: Array<[check: string, cmd: string, args: string[]]> = [
      ["deps", "python3", ["/app/scripts/check_deps.py"]],
      ["tatr_files", "ls", ["-la", "/app/models/tatr"]],
      ["tatr_import", "python3", ["-c", "from transformers import TableTransformerForObjectDetection; m = TableTransformerForObjectDetection.from_pretrained('/app/models/tatr'); print('OK', type(m).__name__)"]],
      ["img2table_import", "python3", ["-c", "from img2table.document import PDF, Image; from img2table.ocr import TesseractOCR; print('OK PDF Image TesseractOCR available')"]],
      ["ghostscript", "gs", ["--version"]],
      ["tesseract", "tesseract", ["--version"]],
      ["pymupdf", "python3", ["-c", "import fitz; print(fitz.__doc__[:120] if fitz.__doc__ else 'fitz available')"]],
      ["python_version", "python3", ["-c", "import sys; print(sys.version); print(sys.executable)"]],
    ];
    for (let i = 0; i < TABLE.length; i++) {
      const [check, cmd, args] = TABLE[i];
      spawnScript((p) => p.emit("close", 0));
      const r = await readJson(await phPOST(postReq({ check })));
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ check, command: [cmd, ...args].join(" "), exitCode: 0 });
      expect(h.spawn).toHaveBeenNthCalledWith(i + 1, cmd, args);
    }
    expect(h.spawn).toHaveBeenCalledTimes(TABLE.length);
  });
});
