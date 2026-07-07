// @vitest-environment node
// [refactor jul7 S054] CHARACTERIZATION for admin/s3-browser SOLO (GET — list S3 objects /
// presign a download), written as THE FREEZE before the fold onto services/s3-browser.ts.
// Solo. requireAdmin. ⚠️ SECURITY-LOAD-BEARING gates (preserve byte-exact):
//   • WEIGHTS-2 fail-closed backstop: !isRootAdmin && /^\/?models\//i.test(target) → 403
//     "Access denied" (no tenant may list/download model weights; root exempt).
//   • company scope: !isRootAdmin && target → !dataKey || !target.startsWith(dataKey+"/") →
//     403 "Access denied: path outside company scope".
// Behavior: target = download||prefix. download branch → getPresignedGetUrl → {url}; catch →
// 500 "Failed to generate download URL" (fixed literal). list branch → ListObjectsV2 →
// {prefix,bucket,folders,files,isTruncated} (humanSize, excludes prefix-self); catch →
// {error: err.message||"Failed to list S3 objects"} 500 (⚠️ err.message LEAK, DR002 :109).
// GET query-param → ZERO E. Sanctioned A (auth + security 403 literals) + B (both catch-500s
// → generic INTERNAL). @aws-sdk/client-s3 + @/lib/s3 mocked; real db (companies.dataKey).
// Assertions tagged [S054 fold] flip in the fold commit.
import { describe, expect, inject, it, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

const h = vi.hoisted(() => ({ s3Send: vi.fn(), getPresignedGetUrl: vi.fn() }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class { send = h.s3Send; },
  ListObjectsV2Command: class { constructor(public input: unknown) {} },
}));
vi.mock("@/lib/s3", () => ({ S3_BUCKET: "test-bucket", getPresignedGetUrl: h.getPresignedGetUrl }));

import { GET as sbGET } from "@/app/api/admin/s3-browser/route";
import { asUser, createCompany, createUser, makeReq, readJson, signedOut } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

const req = (qs = "") => makeReq(`/api/admin/s3-browser${qs}`, { method: "GET" });
const dkey = () => `co-${Math.random().toString(36).slice(2, 8)}`; // unique (companies.data_key is UNIQUE)
const UNAUTH = { error: "Unauthorized" }; // [S054 fold: A → {error:{code:"UNAUTHORIZED",message:"Unauthorized"}}]
const ADMIN_ONLY = { error: "Admin only" }; // [S054 fold: A → {error:{code:"FORBIDDEN",message:"Admin only"}}]

const LIST_RESP = {
  CommonPrefixes: [{ Prefix: "co-abc/proj1/sub/" }],
  Contents: [
    { Key: "co-abc/proj1/", Size: 0 }, // the prefix itself — excluded
    { Key: "co-abc/proj1/file.pdf", Size: 2048, LastModified: new Date("2026-07-01T00:00:00Z") },
  ],
  IsTruncated: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  signedOut();
  h.s3Send.mockResolvedValue(LIST_RESP);
  h.getPresignedGetUrl.mockResolvedValue("https://signed.example/x");
});

describe.skipIf(!dbUp)("admin/s3-browser (SB)", () => {
  it("SB-1 auth: signed-out→401, member→403", async () => {
    const company = await createCompany();
    await createUser(company.id, { isRootAdmin: true });
    const member = await createUser(company.id);
    let r = await readJson(await sbGET(req("?prefix=x/")));
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S054 fold: A]
    asUser(member);
    r = await readJson(await sbGET(req("?prefix=x/")));
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ADMIN_ONLY); // [S054 fold: A]
  });

  it("SB-2 ⚠️ WEIGHTS-2 backstop: company-admin CANNOT access models/; root exempt", async () => {
    const company = await createCompany({ dataKey: dkey() });
    const admin = await createUser(company.id, { role: "admin" });
    const root = await createUser(company.id, { isRootAdmin: true });
    // company-admin targeting models/ → 403 "Access denied" (fail-closed weights backstop)
    asUser(admin);
    let r = await readJson(await sbGET(req("?prefix=models/yolo/")));
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: "Access denied" }); // [S054 fold: A] — the WEIGHTS backstop
    // also blocks the leading-slash + download variants
    r = await readJson(await sbGET(req("?download=/models/yolo_precise.pt")));
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: "Access denied" }); // [S054 fold: A]
    // root admin IS exempt (trusted owner) — reaches the S3 list
    asUser(root);
    r = await readJson(await sbGET(req("?prefix=models/")));
    expect(r.status).toBe(200); // root not blocked by the weights gate
  });

  it("SB-3 company scope: company-admin blocked outside dataKey; allowed within", async () => {
    const dk = dkey();
    const company = await createCompany({ dataKey: dk });
    const admin = await createUser(company.id, { role: "admin" });
    asUser(admin);
    // outside scope → 403 scope literal
    let r = await readJson(await sbGET(req("?prefix=other-co/proj/")));
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: "Access denied: path outside company scope" }); // [S054 fold: A]
    // a dataKey PREFIX must NOT match (anchored dataKey+"/" check, not bare startsWith)
    r = await readJson(await sbGET(req(`?prefix=${dk}x/proj/`)));
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: "Access denied: path outside company scope" }); // [S054 fold: A]
    // within scope → passes to the list
    r = await readJson(await sbGET(req(`?prefix=${dk}/proj1/`)));
    expect(r.status).toBe(200);
  });

  it("SB-4 list: shapes folders/files (humanSize, excludes prefix-self)", async () => {
    const company = await createCompany({ dataKey: dkey() });
    asUser(await createUser(company.id, { isRootAdmin: true })); // root: no scope gate, so the fixed LIST_RESP keys shape cleanly
    const r = await readJson(await sbGET(req("?prefix=co-abc/proj1/")));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ prefix: "co-abc/proj1/", bucket: "test-bucket", isTruncated: false });
    expect(r.body.folders).toEqual([{ key: "co-abc/proj1/sub/", name: "sub", isFolder: true, size: null, lastModified: null }]);
    expect(r.body.files).toEqual([
      { key: "co-abc/proj1/file.pdf", name: "file.pdf", isFolder: false, size: "2.0 KB", sizeBytes: 2048, lastModified: "2026-07-01T00:00:00.000Z" },
    ]); // the bare-prefix Content is excluded
  });

  it("SB-5 download: presigned URL → {url}", async () => {
    const company = await createCompany({ dataKey: dkey() });
    asUser(await createUser(company.id, { isRootAdmin: true })); // root: no scope gate
    const r = await readJson(await sbGET(req("?download=co-abc/proj1/file.pdf")));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ url: "https://signed.example/x" });
    expect(h.getPresignedGetUrl).toHaveBeenCalledWith("co-abc/proj1/file.pdf", 300);
  });

  it("SB-6 catches: list err.message LEAK + download fixed-literal, both @500", async () => {
    // [S054 fold: B — both catch-500s retire → generic INTERNAL 500]
    const company = await createCompany({ dataKey: dkey() });
    asUser(await createUser(company.id, { isRootAdmin: true })); // root: no scope gate
    h.s3Send.mockRejectedValue(new Error("AccessDenied s3:ListBucket on arn:..."));
    let r = await readJson(await sbGET(req("?prefix=co-abc/")));
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: "AccessDenied s3:ListBucket on arn:..." }); // [S054 fold: B — leak dropped]
    h.getPresignedGetUrl.mockRejectedValue(new Error("presign boom"));
    r = await readJson(await sbGET(req("?download=co-abc/x.pdf")));
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: "Failed to generate download URL" }); // [S054 fold: B — → generic]
  });
});
