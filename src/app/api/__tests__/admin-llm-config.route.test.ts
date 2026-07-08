// @vitest-environment node
// [refactor jul7 S056] CHARACTERIZATION for the admin/llm-config SOLO (GET list configs +
// POST create/update + PUT company system-prompt + DELETE), written as THE FREEZE before the
// fold onto services/llm-config.ts. Solo. requireAdmin on ALL 4 methods (admin OR root passes;
// member 403; signed-out 401). Uses REAL @/lib/crypto (NOT mocked) — NEXTAUTH_SECRET is set in
// setup-env.ts so encrypt/decrypt round-trips; ciphertext is random-IV so we assert via
// maskApiKey / round-trip decrypt, NEVER exact ciphertext. Frozen quirk inventory:
//   • GET (searchParams only, no body): {configs, systemPrompt: sp||null, envDefaults:{groq,
//     anthropic,openai}}. Per-row maskedKey = maskApiKey(decryptApiKey(enc)); per-row decrypt
//     catch → "***decrypt-error***" (byte-verbatim). TWO SWALLOWING catches (LOAD-BEARING,
//     preserve — NOT sanctioned B): llmConfigs query throws → configs=[]; pipelineConfig query
//     throws → systemPrompt=null. includeUsers=true drops the userId IS NULL filter. Root admin
//     ?companyId=N overrides the config query's company (non-root ignores it) — BUT systemPrompt
//     is ALWAYS read for session.user.companyId, NOT the overridden query company (subtle).
//   • POST: !provider||!model → 400 "provider and model required". Upsert by (companyId, userId
//     |null, isDemo||false). Update leaves the key untouched when apiKey is falsy OR "unchanged".
//     Root honors targetCompanyId; non-root forced to own company.
//   • DELETE: !id → 400 "id required"; ownership scope (root any id, else id+own company); miss
//     → 404 "Not found"; success {success:true}.
//   • PUT: {systemPrompt}; jsonb SPREAD-MERGE into pipelineConfig.llm.systemPrompt (empty → set
//     undefined = dropped); sibling pipelineConfig.* and llm.* keys preserved. {success:true}.
// GET has no body → NO E. POST/PUT/DELETE read req.json() → E at fold. No catch-500 literal and
// no err.message leak → NO B (the shell's generic INTERNAL 500 is NEW uniform wrapping for the
// three currently-uncaught write methods, not a B retirement). Sanctioned A + E only.
// Assertions tagged [S056 fold: … applied] were flipped in the fold commit onto
// services/llm-config.ts (flat {error} → envelope; malformed JSON reject → 400 "Invalid JSON body").
import { describe, expect, inject, it, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { GET as lcGET, POST as lcPOST, PUT as lcPUT, DELETE as lcDELETE } from "@/app/api/admin/llm-config/route";
import { db } from "@/lib/db";
import { llmConfigs, companies } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { encryptApiKey, maskApiKey } from "@/lib/crypto";
import { asUser, createCompany, createUser, makeReq, readJson, signedOut } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

// [S056 fold: A applied] — at freeze these were the legacy flat bodies
// UNAUTH={error:"Unauthorized"}, ADMIN_ONLY={error:"Admin only"}.
const UNAUTH = { error: { code: "UNAUTHORIZED", message: "Unauthorized" } };
const ADMIN_ONLY = { error: { code: "FORBIDDEN", message: "Admin only" } };

async function makeWorld() {
  const company = await createCompany();
  const admin = await createUser(company.id, { role: "admin" });
  const member = await createUser(company.id);
  const root = await createUser(company.id, { isRootAdmin: true });
  return { company, admin, member, root };
}

async function seedConfig(companyId: number, over: Partial<typeof llmConfigs.$inferInsert> = {}) {
  const [row] = await db
    .insert(llmConfigs)
    .values({ companyId, provider: "groq", model: "llama-3.1", isDefault: true, ...over })
    .returning();
  return row;
}
async function configById(id: number) {
  const [row] = await db.select().from(llmConfigs).where(eq(llmConfigs.id, id)).limit(1);
  return row;
}
async function companyById(id: number) {
  const [row] = await db.select().from(companies).where(eq(companies.id, id)).limit(1);
  return row;
}

const getReq = (qs = "") => makeReq(`/api/admin/llm-config${qs}`, { method: "GET" });
const postReq = (body: unknown) => makeReq("/api/admin/llm-config", { method: "POST", body });
const putReq = (body: unknown) => makeReq("/api/admin/llm-config", { method: "PUT", body });
const delReq = (body: unknown) => makeReq("/api/admin/llm-config", { method: "DELETE", body });
// malformed JSON — build by hand (makeReq only JSON.stringifies)
const malformed = (method: string) =>
  new Request("http://test.local/api/admin/llm-config", {
    method,
    headers: { "content-type": "application/json" },
    body: "{ not valid json",
  });

// Save/restore the three envDefault env vars (unset by default in the test env).
let savedEnv: Record<string, string | undefined>;
beforeEach(() => {
  vi.clearAllMocks();
  signedOut();
  savedEnv = {
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  };
  delete process.env.GROQ_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe.skipIf(!dbUp)("admin/llm-config (LC)", () => {
  // ── auth (A) ────────────────────────────────────────────────────────────────
  it("LC-1 auth: all methods signed-out→401, member→403", async () => {
    const { member } = await makeWorld();
    // signed out
    for (const call of [
      () => lcGET(getReq()),
      () => lcPOST(postReq({ provider: "groq", model: "m" })),
      () => lcPUT(putReq({ systemPrompt: "x" })),
      () => lcDELETE(delReq({ id: 1 })),
    ]) {
      const r = await readJson(await call());
      expect(r.status).toBe(401);
      expect(r.body).toEqual(UNAUTH); // [S056 fold: A applied]
    }
    // member (non-admin)
    asUser(member);
    for (const call of [
      () => lcGET(getReq()),
      () => lcPOST(postReq({ provider: "groq", model: "m" })),
      () => lcPUT(putReq({ systemPrompt: "x" })),
      () => lcDELETE(delReq({ id: 1 })),
    ]) {
      const r = await readJson(await call());
      expect(r.status).toBe(403);
      expect(r.body).toEqual(ADMIN_ONLY); // [S056 fold: A applied]
    }
  });

  // ── GET ───────────────────────────────────────────────────────────────────────
  it("LC-2 GET happy: masks keyed configs, null for keyless, envDefaults + systemPrompt", async () => {
    const { company, admin } = await makeWorld();
    await db.update(companies)
      .set({ pipelineConfig: { llm: { systemPrompt: "You are helpful." } } as never })
      .where(eq(companies.id, company.id));
    const keyed = await seedConfig(company.id, {
      provider: "anthropic", model: "claude", encryptedApiKey: encryptApiKey("sk-ant-WXYZ"),
      baseUrl: "https://x", config: { temperature: 0.5 } as never,
    });
    const keyless = await seedConfig(company.id, { provider: "openai", model: "gpt", isDemo: true });
    process.env.GROQ_API_KEY = "present";
    asUser(admin);
    const r = await readJson(await lcGET(getReq()));
    expect(r.status).toBe(200);
    expect(r.body.systemPrompt).toBe("You are helpful.");
    expect(r.body.envDefaults).toEqual({ groq: true, anthropic: false, openai: false });
    const byId = Object.fromEntries(r.body.configs.map((c: { id: number }) => [c.id, c]));
    expect(byId[keyed.id]).toEqual({
      id: keyed.id, userId: null, provider: "anthropic", model: "claude",
      maskedKey: "••••WXYZ", hasKey: true, baseUrl: "https://x", isDemo: false,
      isDefault: true, config: { temperature: 0.5 },
    });
    expect(byId[keyless.id]).toMatchObject({ maskedKey: null, hasKey: false, isDemo: true });
  });

  it("LC-3 GET includeUsers: default drops user-scoped rows; includeUsers=true keeps them", async () => {
    const { company, admin } = await makeWorld();
    const companyWide = await seedConfig(company.id);
    const userScoped = await seedConfig(company.id, { userId: admin.id, provider: "openai", model: "gpt" });
    asUser(admin);
    // default: only company-wide (userId IS NULL)
    let r = await readJson(await lcGET(getReq()));
    let ids = r.body.configs.map((c: { id: number }) => c.id);
    expect(ids).toContain(companyWide.id);
    expect(ids).not.toContain(userScoped.id);
    // includeUsers=true: both
    r = await readJson(await lcGET(getReq("?includeUsers=true")));
    ids = r.body.configs.map((c: { id: number }) => c.id);
    expect(ids).toContain(companyWide.id);
    expect(ids).toContain(userScoped.id);
  });

  it("LC-4 GET root ?companyId override: configs from target co, but systemPrompt from ROOT's OWN co", async () => {
    const rootCo = await createCompany();
    const root = await createUser(rootCo.id, { isRootAdmin: true });
    const otherCo = await createCompany();
    await db.update(companies).set({ pipelineConfig: { llm: { systemPrompt: "ROOT-OWN" } } as never }).where(eq(companies.id, rootCo.id));
    await db.update(companies).set({ pipelineConfig: { llm: { systemPrompt: "OTHER-CO" } } as never }).where(eq(companies.id, otherCo.id));
    const otherCfg = await seedConfig(otherCo.id, { provider: "custom", model: "mixtral" });
    asUser(root);
    const r = await readJson(await lcGET(getReq(`?companyId=${otherCo.id}`)));
    expect(r.status).toBe(200);
    // configs come from the OVERRIDDEN company…
    expect(r.body.configs.map((c: { id: number }) => c.id)).toContain(otherCfg.id);
    // …but systemPrompt is read from the ROOT's OWN company (subtle, byte-exact)
    expect(r.body.systemPrompt).toBe("ROOT-OWN");
    // a NON-root ignores ?companyId entirely (sees own, empty here)
    const otherAdmin = await createUser(otherCo.id, { role: "admin" });
    asUser(otherAdmin);
    const r2 = await readJson(await lcGET(getReq(`?companyId=${rootCo.id}`)));
    expect(r2.body.configs.map((c: { id: number }) => c.id)).toContain(otherCfg.id); // own (otherCo)
  });

  it("LC-5 GET decrypt failure → maskedKey '***decrypt-error***'", async () => {
    const { company, admin } = await makeWorld();
    // a non-decryptable ciphertext (valid-length base64, wrong auth tag → decrypt throws)
    const bad = await seedConfig(company.id, { encryptedApiKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
    asUser(admin);
    const r = await readJson(await lcGET(getReq()));
    const row = r.body.configs.find((c: { id: number }) => c.id === bad.id);
    expect(row.hasKey).toBe(true);
    expect(row.maskedKey).toBe("***decrypt-error***");
  });

  it("LC-6 GET SWALLOW: llmConfigs query throws → configs=[] (not 500); systemPrompt still real", async () => {
    const { company, admin } = await makeWorld();
    await db.update(companies).set({ pipelineConfig: { llm: { systemPrompt: "SP" } } as never }).where(eq(companies.id, company.id));
    await seedConfig(company.id);
    asUser(admin);
    // first db.select() (llmConfigs) throws; the second (companies) calls through
    const spy = vi.spyOn(db, "select").mockImplementationOnce(() => { throw new Error("relation llm_configs does not exist"); });
    const r = await readJson(await lcGET(getReq()));
    expect(r.status).toBe(200);
    expect(r.body.configs).toEqual([]);
    expect(r.body.systemPrompt).toBe("SP");
    spy.mockRestore();
  });

  it("LC-7 GET SWALLOW: pipelineConfig query throws → systemPrompt=null (not 500); configs still real", async () => {
    const { company, admin } = await makeWorld();
    const cfg = await seedConfig(company.id);
    asUser(admin);
    const realSelect = db.select.bind(db);
    let n = 0;
    const spy = vi.spyOn(db, "select").mockImplementation(((...a: unknown[]) => {
      n += 1;
      if (n === 2) throw new Error("pipeline read failed");
      return (realSelect as (...args: unknown[]) => unknown)(...a);
    }) as typeof db.select);
    const r = await readJson(await lcGET(getReq()));
    expect(r.status).toBe(200);
    expect(r.body.configs.map((c: { id: number }) => c.id)).toContain(cfg.id);
    expect(r.body.systemPrompt).toBeNull();
    spy.mockRestore();
  });

  // ── POST ───────────────────────────────────────────────────────────────────────
  it("LC-8 POST validation: missing provider or model → 400 'provider and model required'", async () => {
    const { admin } = await makeWorld();
    asUser(admin);
    for (const body of [{}, { provider: "groq" }, { model: "m" }]) {
      const r = await readJson(await lcPOST(postReq(body)));
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: { code: "VALIDATION", message: "provider and model required" } }); // [S056 fold: A applied]
    }
  });

  it("LC-9 POST create-new: INSERT, key encrypted (round-trips), maskedKey from apiKey, own company", async () => {
    const { company, admin } = await makeWorld();
    asUser(admin);
    const r = await readJson(await lcPOST(postReq({
      provider: "groq", model: "llama-3.1", apiKey: "sk-groq-ABCD", baseUrl: "https://b", config: { maxTokens: 100 },
    })));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      provider: "groq", model: "llama-3.1", maskedKey: "••••ABCD", hasKey: true,
      baseUrl: "https://b", isDemo: false, isDefault: true, config: { maxTokens: 100 },
    });
    const row = await configById(r.body.id);
    expect(row.companyId).toBe(company.id);
    expect(row.userId).toBeNull();
    // stored ciphertext is real (masks back to the same last-4)
    expect(maskApiKey((await import("@/lib/crypto")).decryptApiKey(row.encryptedApiKey!))).toBe("••••ABCD");
  });

  it("LC-10 POST update-existing: apiKey 'unchanged' leaves key intact; maskedKey from existing decrypt", async () => {
    const { company, admin } = await makeWorld();
    const existing = await seedConfig(company.id, {
      provider: "groq", model: "old-model", encryptedApiKey: encryptApiKey("sk-old-9999"),
    });
    asUser(admin);
    const r = await readJson(await lcPOST(postReq({
      provider: "anthropic", model: "new-model", apiKey: "unchanged", baseUrl: "https://n",
    })));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      id: existing.id, provider: "anthropic", model: "new-model", maskedKey: "••••9999", hasKey: true,
    });
    const row = await configById(existing.id);
    expect(row.model).toBe("new-model");
    // key column untouched (still decrypts to the original)
    expect(maskApiKey((await import("@/lib/crypto")).decryptApiKey(row.encryptedApiKey!))).toBe("••••9999");
  });

  it("LC-11 POST scope: root honors targetCompanyId; non-root ignores it (writes to own)", async () => {
    const { company: ownCo, admin } = await makeWorld();
    const rootCo = await createCompany();
    const root = await createUser(rootCo.id, { isRootAdmin: true });
    const targetCo = await createCompany();
    // root → writes to targetCompanyId
    asUser(root);
    let r = await readJson(await lcPOST(postReq({ provider: "groq", model: "m", targetCompanyId: targetCo.id })));
    expect((await configById(r.body.id)).companyId).toBe(targetCo.id);
    // non-root admin → targetCompanyId ignored, writes to own company
    asUser(admin);
    r = await readJson(await lcPOST(postReq({ provider: "groq", model: "m2", targetCompanyId: targetCo.id })));
    expect((await configById(r.body.id)).companyId).toBe(ownCo.id);
  });

  it("LC-12 POST no apiKey → encrypted null, maskedKey null, hasKey false", async () => {
    const { admin } = await makeWorld();
    asUser(admin);
    const r = await readJson(await lcPOST(postReq({ provider: "groq", model: "m" })));
    expect(r.body).toMatchObject({ maskedKey: null, hasKey: false });
    expect((await configById(r.body.id)).encryptedApiKey).toBeNull();
  });

  // ── DELETE ─────────────────────────────────────────────────────────────────────
  it("LC-13 DELETE validation: missing id → 400 'id required'", async () => {
    const { admin } = await makeWorld();
    asUser(admin);
    const r = await readJson(await lcDELETE(delReq({})));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: { code: "VALIDATION", message: "id required" } }); // [S056 fold: A applied]
  });

  it("LC-14 DELETE scope: non-root cross-company → 404 'Not found'; root deletes any; success", async () => {
    const { company, admin } = await makeWorld();
    const otherCo = await createCompany();
    const foreign = await seedConfig(otherCo.id);
    asUser(admin);
    // non-root can't see/delete another company's config
    let r = await readJson(await lcDELETE(delReq({ id: foreign.id })));
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: { code: "NOT_FOUND", message: "Not found" } }); // [S056 fold: A applied]
    expect(await configById(foreign.id)).toBeTruthy(); // still there
    // own config deletes fine
    const mine = await seedConfig(company.id);
    r = await readJson(await lcDELETE(delReq({ id: mine.id })));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true });
    expect(await configById(mine.id)).toBeUndefined();
    // root can delete the foreign one
    const root = await createUser(company.id, { isRootAdmin: true });
    asUser(root);
    r = await readJson(await lcDELETE(delReq({ id: foreign.id })));
    expect(r.status).toBe(200);
    expect(await configById(foreign.id)).toBeUndefined();
  });

  // ── PUT ───────────────────────────────────────────────────────────────────────
  it("LC-15 PUT spread-merge: sets llm.systemPrompt, preserves sibling pipelineConfig.* and llm.* keys", async () => {
    const { company, admin } = await makeWorld();
    await db.update(companies).set({
      pipelineConfig: { csi: { tier2Weight: 5 }, llm: { toolUse: true, systemPrompt: "old" } } as never,
    }).where(eq(companies.id, company.id));
    asUser(admin);
    const r = await readJson(await lcPUT(putReq({ systemPrompt: "brand new" })));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true });
    const pc = (await companyById(company.id)).pipelineConfig as { csi?: unknown; llm?: Record<string, unknown> };
    expect(pc.csi).toEqual({ tier2Weight: 5 }); // sibling top-level key preserved
    expect(pc.llm!.toolUse).toBe(true); // sibling llm.* key preserved
    expect(pc.llm!.systemPrompt).toBe("brand new");
  });

  it("LC-16 PUT empty systemPrompt → stored undefined (dropped); siblings retained", async () => {
    const { company, admin } = await makeWorld();
    await db.update(companies).set({
      pipelineConfig: { llm: { toolUse: true, systemPrompt: "was here" } } as never,
    }).where(eq(companies.id, company.id));
    asUser(admin);
    const r = await readJson(await lcPUT(putReq({ systemPrompt: "" })));
    expect(r.status).toBe(200);
    const pc = (await companyById(company.id)).pipelineConfig as { llm?: Record<string, unknown> };
    expect(pc.llm!.systemPrompt).toBeUndefined(); // undefined key dropped by jsonb serialization
    expect(pc.llm!.toolUse).toBe(true);
  });

  // ── DETECTOR closers (wf_a473cb8f-818 FIX-2..5) ─────────────────────────────────
  it("LC-18 POST update-existing with a NEW apiKey: key ROTATED (round-trips), maskedKey from the new key", async () => {
    const { company, admin } = await makeWorld();
    const existing = await seedConfig(company.id, { encryptedApiKey: encryptApiKey("sk-old-1111") });
    asUser(admin);
    const r = await readJson(await lcPOST(postReq({ provider: "groq", model: "m", apiKey: "sk-new-2222" })));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: existing.id, maskedKey: "••••2222", hasKey: true });
    const row = await configById(existing.id);
    expect(maskApiKey((await import("@/lib/crypto")).decryptApiKey(row.encryptedApiKey!))).toBe("••••2222"); // rotated
  });

  it("LC-19 POST userId-scoped upsert: user row created/targeted, company-wide row NOT clobbered", async () => {
    const { company, admin } = await makeWorld();
    const companyWide = await seedConfig(company.id, { provider: "groq", model: "company-model" });
    asUser(admin);
    // userId present → the upsert match keys on eq(userId), NOT isNull → separate row
    const r = await readJson(await lcPOST(postReq({ provider: "openai", model: "user-model", userId: admin.id })));
    expect(r.status).toBe(200);
    expect(r.body.id).not.toBe(companyWide.id);
    expect((await configById(r.body.id)).userId).toBe(admin.id); // user-scoped insert
    expect((await configById(companyWide.id)).model).toBe("company-model"); // untouched
    // second user-scoped POST updates the USER row (upsert match hits eq(userId))
    const r2 = await readJson(await lcPOST(postReq({ provider: "openai", model: "user-model-v2", userId: admin.id })));
    expect(r2.body.id).toBe(r.body.id);
    expect((await configById(companyWide.id)).model).toBe("company-model"); // still untouched
  });

  it("LC-20 POST isDemo=true vs same-company isDemo=false: SEPARATE row (isDemo participates in the upsert match)", async () => {
    const { company, admin } = await makeWorld();
    const nonDemo = await seedConfig(company.id, { provider: "groq", model: "live-model" });
    asUser(admin);
    const r = await readJson(await lcPOST(postReq({ provider: "groq", model: "demo-model", isDemo: true })));
    expect(r.status).toBe(200);
    expect(r.body.id).not.toBe(nonDemo.id); // new row, not an update of the isDemo=false row
    expect((await configById(r.body.id)).isDemo).toBe(true);
    expect((await configById(nonDemo.id)).model).toBe("live-model"); // untouched
  });

  it("LC-21 POST update-branch decrypt ASYMMETRY: corrupt stored key + apiKey 'unchanged' → 500 INTERNAL (no GET-style swallow)", async () => {
    const { company, admin } = await makeWorld();
    // GET swallows a bad decrypt per-row ('***decrypt-error***', LC-5); the POST
    // update-branch response derivation decrypts BARE — a corrupt stored key THROWS →
    // shell generic INTERNAL 500 (legacy: framework 500). Frozen so a future shared-masker
    // refactor cannot silently convert this to a 200.
    await seedConfig(company.id, { encryptedApiKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
    asUser(admin);
    const r = await readJson(await lcPOST(postReq({ provider: "groq", model: "m", apiKey: "unchanged" })));
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: { code: "INTERNAL", message: "Internal server error" } });
  });

  // ── E (malformed body) ──────────────────────────────────────────────────────────
  it("LC-17 malformed JSON body on POST/PUT/DELETE → 400 'Invalid JSON body'", async () => {
    const { admin } = await makeWorld();
    asUser(admin);
    // [S056 fold: E applied] — at freeze legacy `await req.json()` threw (handler rejected);
    // the shell parses the body in step 1 → 400 BAD_REQUEST "Invalid JSON body".
    for (const call of [lcPOST(malformed("POST")), lcPUT(malformed("PUT")), lcDELETE(malformed("DELETE"))]) {
      const r = await readJson(await call);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: { code: "BAD_REQUEST", message: "Invalid JSON body" } });
    }
  });
});
