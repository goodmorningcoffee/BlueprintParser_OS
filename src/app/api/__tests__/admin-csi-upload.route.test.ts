// @vitest-environment node
// [refactor jul8 S059] CHARACTERIZATION for the admin/csi/upload SOLO (POST multipart upload
// custom CSI DB + DELETE revert to built-in), written as THE FREEZE before the fold onto
// services/csi-upload.ts. Solo. requireAdmin both methods. ⚠️ The app's ONLY multipart route —
// the fold uses the S056-built defineRoute rawBody:true skip-parse mode (07f0be3) so the
// handler owns the stream (req.formData()). Char requests are hand-built FormData Requests
// (makeReq only does JSON). @/lib/s3 mocked (uploadToS3 + deleteFromS3); real DB (companies).
// Frozen quirk inventory:
//   • POST: !file → 400 "No file uploaded"; ext branch on file.name.toLowerCase() (.json/.csv/
//     .tsv|.txt) else → 400 "Unsupported format. Use CSV, TSV, or JSON."; the parse try/catch →
//     400 `Parse error: <err.message|"Invalid file format">` — an err.message INTERPOLATION but
//     INTENTIONAL @400 domain feedback (parsers throw deliberate Errors), NOT a DR002 B-leak:
//     PRESERVE verbatim (assert by "Parse error:" PREFIX — native SyntaxError text is
//     node-version-dependent); entries.length===0 → 400 "No CSI codes found in file".
//     tsvContent: header literal + `${codeNoSpace}\t${phrase}\t${codeNoSpace}\t${phrase}\t
//     ${trade}\t${division}` rows (phrase=desc.toLowerCase(), codeNoSpace=\s+ stripped).
//     s3Key = csi-databases/company-<id>/custom-csi.tsv. jsonb SPREAD-MERGE into
//     pipelineConfig.csi (customDatabaseS3Key/Name/Codes; sibling keys survive). Response BARE
//     {success:true, codesLoaded, s3Key} — domain data, NOT enveloped.
//   • DELETE: destructure-strip ONLY the 3 customDatabase* keys (other csi.* + non-csi keys
//     retained); non-blocking S3 delete in try/catch (SILENT swallow — deleteFromS3 throw still
//     → 200). Response BARE {success:true}. Legacy DELETE() is 0-ARG (never reads the body).
//   • inferTradeFromCode: div "03" → Concrete/"03 00 00"; unknown "99" → "Division 99".
//   • NO catch-500 in either method → NO B; the fold-shell's generic INTERNAL 500 on uncaught
//     S3/DB throws is NEW uniform wrapping. E does NOT apply to POST (multipart, rawBody:true —
//     no JSON parse); DELETE gains the uniform shell property (malformed JSON body → 400
//     BAD_REQUEST — yolo-purge precedent, degenerate input, pinned at fold).
//   • Dead legacy import getS3Url dropped at fold.
// Assertions tagged [S059 fold: … applied] were flipped in the fold commit.
import { describe, expect, inject, it, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

const h = vi.hoisted(() => ({
  uploadToS3: vi.fn(),
  deleteFromS3: vi.fn(),
}));
vi.mock("@/lib/s3", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/s3")>();
  return { ...orig, uploadToS3: h.uploadToS3, deleteFromS3: h.deleteFromS3 };
});

import { POST as cuPOST, DELETE as cuDELETE } from "@/app/api/admin/csi/upload/route";
import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { asUser, createCompany, createUser, readJson, signedOut } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

// [S059 fold: A applied] — at freeze these were the legacy flat bodies
// UNAUTH={error:"Unauthorized"}, ADMIN_ONLY={error:"Admin only"}.
const UNAUTH = { error: { code: "UNAUTHORIZED", message: "Unauthorized" } };
const ADMIN_ONLY = { error: { code: "FORBIDDEN", message: "Admin only" } };
const BAD = (message: string) => ({ error: { code: "BAD_REQUEST", message } });

async function makeWorld() {
  const company = await createCompany();
  const admin = await createUser(company.id, { role: "admin" });
  const member = await createUser(company.id);
  return { company, admin, member };
}

function formReq(file?: { name: string; content: string }): Request {
  const fd = new FormData();
  if (file) fd.set("file", new File([file.content], file.name, { type: "text/plain" }));
  return new Request("http://test.local/api/admin/csi/upload", { method: "POST", body: fd });
}
const delReq = () => new Request("http://test.local/api/admin/csi/upload", { method: "DELETE" });

async function pipelineConfigOf(companyId: number) {
  const [row] = await db.select({ pipelineConfig: companies.pipelineConfig }).from(companies).where(eq(companies.id, companyId)).limit(1);
  return (row?.pipelineConfig || {}) as Record<string, any>;
}

beforeEach(() => {
  vi.clearAllMocks();
  signedOut();
  h.uploadToS3.mockResolvedValue(undefined);
  h.deleteFromS3.mockResolvedValue(undefined);
});

describe.skipIf(!dbUp)("admin/csi/upload (CU)", () => {
  it("CU-1 auth: POST+DELETE signed-out→401, member→403", async () => {
    const { member } = await makeWorld();
    let r = await readJson(await cuPOST(formReq({ name: "x.csv", content: "code,description\n03 05,concrete mix" })));
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S059 fold: A applied]
    r = await readJson(await cuDELETE(delReq()));
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S059 fold: A applied]
    asUser(member);
    r = await readJson(await cuPOST(formReq({ name: "x.csv", content: "code,description\n03 05,concrete mix" })));
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ADMIN_ONLY); // [S059 fold: A applied]
    r = await readJson(await cuDELETE(delReq()));
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ADMIN_ONLY); // [S059 fold: A applied]
  });

  it("CU-2 POST no file part → 400 'No file uploaded'", async () => {
    const { admin } = await makeWorld();
    asUser(admin);
    const r = await readJson(await cuPOST(formReq()));
    expect(r.status).toBe(400);
    expect(r.body).toEqual(BAD("No file uploaded")); // [S059 fold: A applied]
  });

  it("CU-3 POST unsupported extension → 400 byte-verbatim", async () => {
    const { admin } = await makeWorld();
    asUser(admin);
    const r = await readJson(await cuPOST(formReq({ name: "codes.pdf", content: "x" })));
    expect(r.status).toBe(400);
    expect(r.body).toEqual(BAD("Unsupported format. Use CSV, TSV, or JSON.")); // [S059 fold: A applied]
  });

  it("CU-4 POST parse errors → 400 'Parse error: …' (deliberate parser messages verbatim; json by PREFIX)", async () => {
    const { admin } = await makeWorld();
    asUser(admin);
    // <2 lines
    let r = await readJson(await cuPOST(formReq({ name: "a.csv", content: "code,description" })));
    expect(r.status).toBe(400);
    expect(r.body).toEqual(BAD("Parse error: File must have a header row and at least one data row")); // [S059 fold: A applied]
    // no code column
    r = await readJson(await cuPOST(formReq({ name: "a.csv", content: "foo,description\nx,y" })));
    expect(r.status).toBe(400);
    expect(r.body).toEqual(BAD("Parse error: No 'code' or 'number' column found in header")); // [S059 fold: A applied]
    // no description column
    r = await readJson(await cuPOST(formReq({ name: "a.csv", content: "code,foo\nx,y" })));
    expect(r.status).toBe(400);
    expect(r.body).toEqual(BAD("Parse error: No 'description' or 'title' column found in header")); // [S059 fold: A applied]
    // invalid JSON in a .json file — SyntaxError text is node-version-dependent → prefix only
    r = await readJson(await cuPOST(formReq({ name: "a.json", content: "{ not json" })));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("BAD_REQUEST"); // [S059 fold: A applied]
    expect(r.body.error.message).toMatch(/^Parse error: /);
  });

  it("CU-5 POST valid file with 0 usable rows → 400 'No CSI codes found in file'", async () => {
    const { admin } = await makeWorld();
    asUser(admin);
    // rows missing description → filtered out → empty
    const r = await readJson(await cuPOST(formReq({ name: "a.csv", content: "code,description\n03 05,\n," })));
    expect(r.status).toBe(400);
    expect(r.body).toEqual(BAD("No CSI codes found in file")); // [S059 fold: A applied]
  });

  it("CU-6 POST happy CSV: exact TSV bytes to S3 + jsonb spread-merge + bare success body", async () => {
    const { company, admin } = await makeWorld();
    // pre-existing config that MUST survive the merge
    await db.update(companies).set({
      pipelineConfig: { llm: { toolUse: true }, csi: { tier2Weight: 7 } } as never,
    }).where(eq(companies.id, company.id));
    asUser(admin);
    const csv = "code,description,trade,division\n03 05 13,Concrete Mix DESIGN,Concrete Custom,03 05 00\n26 05,electrical wiring,,";
    const r = await readJson(await cuPOST(formReq({ name: "MyCodes.csv", content: csv })));
    expect(r.status).toBe(200);
    const expectedKey = `csi-databases/company-${company.id}/custom-csi.tsv`;
    expect(r.body).toEqual({ success: true, codesLoaded: 2, s3Key: expectedKey }); // BARE domain body
    // exact TSV content: row1 explicit trade + division; row2 empty trade → inferred (26=Electrical)
    const expectedTsv =
      "1995 CSI #\tCSI Description\t2004 CSI #\tCSI Description\tTrade\tDivision #\n" +
      "030513\tconcrete mix design\t030513\tconcrete mix design\tConcrete Custom\t03 05 00\n" +
      "2605\telectrical wiring\t2605\telectrical wiring\tElectrical\t26 00 00";
    expect(h.uploadToS3).toHaveBeenCalledTimes(1);
    const [key, buf, ctype] = h.uploadToS3.mock.calls[0];
    expect(key).toBe(expectedKey);
    expect((buf as Buffer).toString("utf-8")).toBe(expectedTsv);
    expect(ctype).toBe("text/tab-separated-values");
    // jsonb spread-merge: siblings retained, 3 keys added
    const pc = await pipelineConfigOf(company.id);
    expect(pc.llm).toEqual({ toolUse: true });
    expect(pc.csi).toEqual({
      tier2Weight: 7,
      customDatabaseS3Key: expectedKey,
      customDatabaseName: "MyCodes.csv",
      customDatabaseCodes: 2,
    });
  });

  it("CU-7 POST .json: object-map accepted, provided trade wins, inferTradeFromCode fallback (unknown div → 'Division 99')", async () => {
    const { company, admin } = await makeWorld();
    asUser(admin);
    const json = JSON.stringify({
      a: { code: "03 11 13", label: "Cast-In-Place Forming" }, // inferred: Concrete / 03 00 00
      b: { number: "99 99", title: "Mystery", trade: "Custom Trade" }, // provided trade, inferred division
    });
    const r = await readJson(await cuPOST(formReq({ name: "db.JSON", content: json })));
    expect(r.status).toBe(200);
    expect(r.body.codesLoaded).toBe(2);
    const tsv = (h.uploadToS3.mock.calls[0][1] as Buffer).toString("utf-8");
    expect(tsv).toContain("031113\tcast-in-place forming\t031113\tcast-in-place forming\tConcrete\t03 00 00");
    expect(tsv).toContain("9999\tmystery\t9999\tmystery\tCustom Trade\t99 00 00");
  });

  it("CU-8 POST .txt uses TAB delimiter", async () => {
    const { admin } = await makeWorld();
    asUser(admin);
    const tsv = "code\tdescription\n09 91\tPainting";
    const r = await readJson(await cuPOST(formReq({ name: "codes.txt", content: tsv })));
    expect(r.status).toBe(200);
    expect(r.body.codesLoaded).toBe(1);
    expect((h.uploadToS3.mock.calls[0][1] as Buffer).toString("utf-8")).toContain("0991\tpainting\t0991\tpainting\tFinishes\t09 00 00");
  });

  it("CU-9 DELETE: strips ONLY the 3 customDatabase* keys, siblings survive; S3 delete fired; bare success", async () => {
    const { company, admin } = await makeWorld();
    await db.update(companies).set({
      pipelineConfig: {
        llm: { toolUse: true },
        csi: { tier2Weight: 7, customDatabaseS3Key: "k", customDatabaseName: "n.csv", customDatabaseCodes: 5 },
      } as never,
    }).where(eq(companies.id, company.id));
    asUser(admin);
    const r = await readJson(await cuDELETE(delReq()));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true }); // BARE
    expect(h.deleteFromS3).toHaveBeenCalledWith(`csi-databases/company-${company.id}/custom-csi.tsv`);
    const pc = await pipelineConfigOf(company.id);
    expect(pc.llm).toEqual({ toolUse: true });
    expect(pc.csi).toEqual({ tier2Weight: 7 }); // 3 keys stripped, sibling retained
  });

  it("CU-10 DELETE S3 failure SILENTLY swallowed → still 200 {success:true}", async () => {
    const { admin } = await makeWorld();
    asUser(admin);
    h.deleteFromS3.mockRejectedValueOnce(new Error("no such key"));
    const r = await readJson(await cuDELETE(delReq()));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true });
  });

  it("CU-11 [fold-only] DELETE malformed JSON body → 400 'Invalid JSON body' (uniform shell property; legacy 0-arg DELETE ignored the body)", async () => {
    const { admin } = await makeWorld();
    asUser(admin);
    // yolo-purge precedent: DELETE ∈ METHODS_WITH_BODY under the shell — degenerate input,
    // arguably safer, sanctioned. Pinned so a future "optimization" can't silently change it.
    const r = await readJson(await cuDELETE(new Request("http://test.local/api/admin/csi/upload", {
      method: "DELETE", headers: { "content-type": "application/json" }, body: "{ nope",
    })));
    expect(r.status).toBe(400);
    expect(r.body).toEqual(BAD("Invalid JSON body"));
  });
});
