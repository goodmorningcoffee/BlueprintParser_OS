// @vitest-environment node
// [refactor jul6 S033] CHARACTERIZATION for the s3 pair (POST /api/s3/staging-credentials +
// GET /api/s3/credentials), written as THE FREEZE before the P1.5 fold onto services/s3.ts.
// Presign engines (@/lib/s3) mocked; REAL DB via harness. Frozen:
//   • SQ3-1 staging: requireAuth-first → OWN req.json try/catch → flat 400 "Invalid JSON
//     body" (SAME text the shell uses — the fold flip is SHAPE-ONLY for malformed) →
//     filenames validations IN ORDER (non-empty array → MAX 30 → per-file: non-empty
//     string ≤255 → extension allowlist w/ interpolated msg) → checkUploadQuota(companyId,
//     role) 2-ARG (root-limited semantics, S012 note) 429 quota.message no-fallback →
//     company 404 → presign fanout {projectPath, files:[{filename,url,fields,stagingKey,
//     index}]} (order = submission order).
//   • SQ3-2 credentials GET: requireAuth → company 404 → createUploadPresignedPost
//     passthrough. ⚠️ ZERO runtime consumers (docs-only, and the docs mislabel it POST) —
//     dead-route candidate for the P5 sweep; folded byte-faithful regardless.
//   • ⚠️ MIDDLEWARE DEAD RULE #2 (P1 ledger): the rate rule keys POST /api/s3/credentials
//     but the route only exports GET — the rule can never match (labeling/login class).
// Assertions tagged [S033 fold] flip in the fold commit (sanctioned A/E only — legacy has
// NO catch-all on either route; presign/db throws were raw Next 500s → shell generic, B).
import { describe, expect, inject, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

const h = vi.hoisted(() => ({
  createStagingUploadPresignedPost: vi.fn(),
  createUploadPresignedPost: vi.fn(),
  checkUploadQuota: vi.fn(),
}));
vi.mock("@/lib/s3", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/s3")>()),
  createStagingUploadPresignedPost: h.createStagingUploadPresignedPost,
  createUploadPresignedPost: h.createUploadPresignedPost,
}));
vi.mock("@/lib/quotas", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/quotas")>()),
  checkUploadQuota: h.checkUploadQuota,
}));

import { POST as stagingPOST } from "@/app/api/s3/staging-credentials/route";
import { GET as credsGET } from "@/app/api/s3/credentials/route";
import { projectUploadStagingKey } from "@/lib/project-upload-authority";
import {
  asUser,
  createWorld,
  makeReq,
  readJson,
  signedOut,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;
const call = (b: unknown) =>
  stagingPOST(makeReq("/api/s3/staging-credentials", { body: b }));
// signature-agnostic: legacy GET() took no args; the shell takes (req) — cast covers both
const callCreds = () =>
  (credsGET as unknown as (req?: Request) => Promise<Response>)(
    makeReq("/api/s3/credentials", { method: "GET" }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  signedOut();
  h.createStagingUploadPresignedPost.mockImplementation(
    async (path: string, fn: string, idx: number) => ({
      url: "https://s3.test/upload",
      fields: { key: projectUploadStagingKey(path, fn, idx) },
      stagingKey: projectUploadStagingKey(path, fn, idx),
    }),
  );
  h.createUploadPresignedPost.mockResolvedValue({
    url: "https://s3.test/up",
    fields: { k: "v" },
  });
  h.checkUploadQuota.mockResolvedValue({ allowed: true });
});

describe.skipIf(!dbUp)("POST /api/s3/staging-credentials (SQ3-1)", () => {
  it("auth-first 401; malformed body → the route's OWN flat 400 'Invalid JSON body'", async () => {
    let r = await readJson(await call({ filenames: ["a.pdf"] }));
    expect(r.status).toBe(401);
    expect(r.body).toEqual({
      error: { code: "UNAUTHORIZED", message: "Unauthorized" },
    }); // [S033 fold: A applied]
    const { user } = await createWorld();
    asUser(user);
    const raw = new Request("http://test.local/api/s3/staging-credentials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{oops",
    });
    r = await readJson(await stagingPOST(raw));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({
      error: { code: "BAD_REQUEST", message: "Invalid JSON body" },
    }); // SHAPE-ONLY, text identical [S033 fold: A/E applied]
  });

  it("validation ladder in order: array → max → per-file string/length → extension", async () => {
    const { user } = await createWorld();
    asUser(user);
    for (const b of [{}, { filenames: [] }, { filenames: "a.pdf" }]) {
      const r = await readJson(await call(b));
      expect(r.status).toBe(400);
      expect(r.body).toEqual({
        error: {
          code: "VALIDATION",
          message: "filenames must be a non-empty array of strings",
        },
      }); // [S033 fold: A applied]
    }
    let r = await readJson(
      await call({
        filenames: Array.from({ length: 31 }, (_, i) => `${i}.pdf`),
      }),
    );
    expect(r.body).toEqual({
      error: { code: "VALIDATION", message: "Maximum 30 files per project" },
    }); // [S033 fold: A applied]
    for (const bad of [[""], [123], ["x".repeat(256) + ".pdf"]]) {
      r = await readJson(await call({ filenames: bad }));
      expect(r.body).toEqual({
        error: {
          code: "VALIDATION",
          message: "Each filename must be a non-empty string ≤255 chars",
        },
      }); // [S033 fold: A applied]
    }
    r = await readJson(await call({ filenames: ["notes.docx"] }));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({
      error: {
        code: "VALIDATION",
        message:
          "Unsupported file type: notes.docx (allowed: pdf, png, jpg, jpeg, tif, tiff, heic)",
      },
    }); // interpolated allowlist pinned [S033 fold: A applied]
  });

  it("2-ARG quota (companyId, role) 429 no-fallback; happy fanout preserves order + shape", async () => {
    const { user, company } = await createWorld();
    asUser(user);
    h.checkUploadQuota.mockResolvedValue({
      allowed: false,
      message: "Daily project limit reached",
    });
    let r = await readJson(await call({ filenames: ["a.pdf"] }));
    expect(r.status).toBe(429);
    expect(r.body).toEqual({
      error: { code: "RATE_LIMITED", message: "Daily project limit reached" },
    }); // [S033 fold: A applied]
    expect(h.checkUploadQuota).toHaveBeenCalledWith(user.companyId, user.role); // 2-arg pinned
    h.checkUploadQuota.mockResolvedValue({ allowed: true });
    r = await readJson(await call({ filenames: ["b.pdf", "a.PNG"] }));
    expect(r.status).toBe(200);
    expect(r.body.projectPath.startsWith(company.dataKey)).toBe(true);
    expect(r.body.files).toHaveLength(2);
    expect(r.body.files[0]).toMatchObject({ filename: "b.pdf", index: 0 }); // submission order kept
    expect(r.body.files[1]).toMatchObject({ filename: "a.PNG", index: 1 }); // case-insensitive ext
    expect(r.body.files[0].stagingKey).toBe(
      projectUploadStagingKey(r.body.projectPath, "b.pdf", 0),
    );
    expect(
      r.body.files[0].stagingKey.startsWith(`${r.body.projectPath}/`),
    ).toBe(false);
  });
});

describe.skipIf(!dbUp)(
  "GET /api/s3/credentials (SQ3-2 — disabled direct-final upload)",
  () => {
    it("401 signed-out; authenticated callers cannot mint replayable original.pdf credentials", async () => {
      let r = await readJson(await callCreds());
      expect(r.status).toBe(401);
      expect(r.body).toEqual({
        error: { code: "UNAUTHORIZED", message: "Unauthorized" },
      }); // [S033 fold: A applied]
      const { user } = await createWorld();
      asUser(user);
      r = await readJson(await callCreds());
      expect(r.status).toBe(410);
      expect(r.body).toEqual({
        error: {
          code: "NOT_FOUND",
          message: "Legacy direct upload credentials are disabled",
        },
      });
      expect(h.createUploadPresignedPost).not.toHaveBeenCalled();
    });
  },
);
