// @vitest-environment node
// [refactor jul6 S047] CHARACTERIZATION for the admin/app-settings SOLO (GET all settings +
// PUT upsert one), written as THE FREEZE before the fold onto services/app-settings.ts. Solo.
// ⚠️ TRAP-b: BOTH methods requireAdmin, BUT PUT has a SECONDARY in-body isRootAdmin gate on
// top (403 "Root admin required") — a company-ADMIN passes requireAdmin yet is blocked by PUT.
// Fold auth:"admin" for both + keep the root check IN-SERVICE (do NOT bump PUT to auth:"root",
// which would break GET's admin-readable path). Frozen quirk inventory:
//   • GET (requireAdmin): db.select all appSettings → collapse into a BARE OBJECT {key:value}
//     map (NOT enveloped). auth 401 "Unauthorized" / 403 "Admin only".
//   • PUT (requireAdmin THEN !isRootAdmin → 403 "Root admin required"): {key, value};
//     !key || value===undefined → 400 "key and value required". header_links URL-normalize
//     (add "https://" to protocol-less string values, in place). UPSERT: existing key →
//     update {value, updatedBy:dbId, updatedAt:now}; else insert {key, value, updatedBy:dbId}.
//     value is jsonb WHOLE-REPLACE (correct key-value semantics, not a merge). → {success:true}.
// GET no body → no E; PUT reads body → E applies at fold. No catch-500 literal → NO B.
// Assertions tagged [S047 fold: … applied] were flipped in the fold commit onto
// services/app-settings.ts (sanctioned A/E only).
import { describe, expect, inject, it, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { GET as asGET, PUT as asPUT } from "@/app/api/admin/app-settings/route";
import { db } from "@/lib/db";
import { appSettings } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { asUser, createCompany, createUser, makeReq, readJson, signedOut } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

async function makeWorld() {
  const company = await createCompany();
  const admin = await createUser(company.id, { role: "admin" });
  const member = await createUser(company.id);
  const root = await createUser(company.id, { isRootAdmin: true });
  return { company, admin, member, root };
}

const getReq = () => makeReq("/api/admin/app-settings", { method: "GET" });
const putReq = (body: unknown) => makeReq("/api/admin/app-settings", { method: "PUT", body });
const UNAUTH = { error: { code: "UNAUTHORIZED", message: "Unauthorized" } }; // [S047 fold: A applied]
const ADMIN_ONLY = { error: { code: "FORBIDDEN", message: "Admin only" } }; // [S047 fold: A applied]
const ROOT_REQUIRED = { error: { code: "FORBIDDEN", message: "Root admin required" } }; // [S047 fold: A applied]

const tag = () => Math.random().toString(36).slice(2, 8);
async function settingRow(key: string) {
  const [r] = await db.select().from(appSettings).where(eq(appSettings.key, key)).limit(1);
  return r;
}

beforeEach(() => { vi.clearAllMocks(); signedOut(); });

describe.skipIf(!dbUp)("admin/app-settings (AS)", () => {
  it("AS-1 GET auth: signed-out→401, member→403, admin+root→200", async () => {
    const { admin, member, root } = await makeWorld();
    let r = await readJson(await asGET(getReq()));
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S047 fold: A applied]
    asUser(member);
    r = await readJson(await asGET(getReq()));
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ADMIN_ONLY); // [S047 fold: A applied]
    asUser(admin);
    expect((await readJson(await asGET(getReq()))).status).toBe(200);
    asUser(root);
    expect((await readJson(await asGET(getReq()))).status).toBe(200);
  });

  it("AS-2 GET: collapses rows into a BARE {key:value} object map", async () => {
    const { admin } = await makeWorld();
    const k1 = `k1-${tag()}`, k2 = `k2-${tag()}`;
    await db.insert(appSettings).values({ key: k1, value: { a: 1 } as never });
    await db.insert(appSettings).values({ key: k2, value: { b: "x" } as never });
    asUser(admin);
    const r = await readJson(await asGET(getReq()));
    expect(r.status).toBe(200);
    expect(r.body[k1]).toEqual({ a: 1 }); // bare object, keyed by setting key
    expect(r.body[k2]).toEqual({ b: "x" });
  });

  it("AS-3 PUT ⚠️ SECONDARY ROOT GATE: a company-ADMIN passes requireAdmin but is blocked → 403 'Root admin required'", async () => {
    const { admin, member } = await makeWorld();
    // signed-out → 401 (requireAdmin)
    let r = await readJson(await asPUT(putReq({ key: "x", value: 1 })));
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S047 fold: A applied]
    // member → 403 "Admin only" (requireAdmin)
    asUser(member);
    r = await readJson(await asPUT(putReq({ key: "x", value: 1 })));
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ADMIN_ONLY); // [S047 fold: A applied]
    // company-ADMIN (role admin, NOT root) → passes requireAdmin, blocked by the in-body gate
    asUser(admin);
    r = await readJson(await asPUT(putReq({ key: "x", value: 1 })));
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ROOT_REQUIRED); // [S047 fold: A applied] — the trap
  });

  it("AS-4 PUT validation (root): missing key / undefined value → 400 'key and value required'", async () => {
    const { root } = await makeWorld();
    asUser(root);
    for (const body of [{}, { value: 1 }, { key: "x" }]) { // {key:"x"} has value===undefined
      const r = await readJson(await asPUT(putReq(body)));
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: { code: "VALIDATION", message: "key and value required" } }); // [S047 fold: A applied]
    }
  });

  it("AS-5 PUT upsert (root): insert new key then update existing (value WHOLE-REPLACE, updatedBy=dbId)", async () => {
    const { root } = await makeWorld();
    asUser(root);
    const key = `set-${tag()}`;
    let r = await readJson(await asPUT(putReq({ key, value: { v: 1 } })));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true });
    let row = await settingRow(key);
    expect(row.value).toEqual({ v: 1 });
    expect(row.updatedBy).toBe(root.id);
    // update existing → whole-replace value (not merge)
    r = await readJson(await asPUT(putReq({ key, value: { w: 2 } })));
    expect(r.status).toBe(200);
    row = await settingRow(key);
    expect(row.value).toEqual({ w: 2 }); // v:1 GONE (whole-replace)
  });

  it("AS-6 PUT header_links: protocol-less string values get 'https://' prefixed (in place)", async () => {
    const { root } = await makeWorld();
    asUser(root);
    const r = await readJson(await asPUT(putReq({
      key: "header_links",
      value: { docs: "example.com/docs", api: "https://api.example.com", blank: "", weird: 5 },
    })));
    expect(r.status).toBe(200);
    const row = await settingRow("header_links");
    expect((row.value as Record<string, unknown>).docs).toBe("https://example.com/docs"); // prefixed
    expect((row.value as Record<string, unknown>).api).toBe("https://api.example.com"); // already has protocol → unchanged
    expect((row.value as Record<string, unknown>).blank).toBe(""); // empty string → unchanged (falsy guard)
    expect((row.value as Record<string, unknown>).weird).toBe(5); // non-string → unchanged
  });
});
