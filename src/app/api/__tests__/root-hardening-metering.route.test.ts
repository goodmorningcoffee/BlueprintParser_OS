// @vitest-environment node
// [2026-10-25 root hardening, phase 3] The money meters and the root grants behind them:
//   • checkTextractCap reads companies.textract_page_limit against the 'textract' ledger (it was a
//     decoration before); the webhook / table-parse / upload paths write and read it;
//   • checkLambdaQuota: root-set daily Lambda page quota (default + per-company override), root exempt;
//   • the owner's environment LLM keys are a ROOT GRANT per company: resolveLLMConfig returns null
//     for an ungranted company with no key of its own, the owner key once granted, and the demo
//     path is unchanged; GET/PUT /api/admin/llm-owner-key is root-only, audited, and the generic
//     settings route refuses the key;
//   • the ROOT_ADMIN_EMAIL address is reserved on both unverified registration paths;
//   • lib/secret-box: purpose-bound sealing, legacy ciphertext still opens, a changed key is a clear
//     SecretUnreadableError (not a 500), a wrong purpose never opens.
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { GET as grantGET, PUT as grantPUT } from "@/app/api/admin/llm-owner-key/route";
import { PUT as settingsPUT } from "@/app/api/admin/app-settings/route";
import { POST as usersPOST } from "@/app/api/admin/users/route";
import { POST as registerPOST } from "@/app/api/register/route";
import { db } from "@/lib/db";
import { appSettings, auditLog, companies, llmConfigs } from "@/lib/db/schema";
import { desc, eq } from "drizzle-orm";
import { checkTextractCap, recordComputeUsage } from "@/lib/compute-usage";
import { checkLambdaQuota } from "@/lib/quotas";
import { QUOTA_OVERRIDES_KEY } from "@/lib/quota-overrides";
import { resolveLLMConfig } from "@/lib/llm/resolve";
import { LLM_OWNER_KEY_GRANTS_KEY } from "@/lib/llm/owner-key-grant";
import { encryptApiKey } from "@/lib/crypto";
import { SecretUnreadableError, openSecret, sealSecret } from "@/lib/secret-box";
import { isReservedRootBootstrapEmail } from "@/lib/root-bootstrap-email";
import { asUser, createCompany, createUser, makeReq, readJson, sessionState, signedOut } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

const ENV_KEYS = ["GROQ_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "LLM_PROVIDER", "LLM_MODEL", "ROOT_ADMIN_EMAIL", "ROOT_2FA_KEY", "LLM_KEY_SECRET"] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  signedOut();
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  sessionState.current = null;
});

async function lastAudits(action: string) {
  await new Promise((resolve) => setTimeout(resolve, 150));
  return db.select().from(auditLog).where(eq(auditLog.action, action)).orderBy(desc(auditLog.id)).limit(5);
}

describe.skipIf(!dbUp)("Textract cap + Lambda quota (2026-10-25)", () => {
  it("checkTextractCap: counts the 'textract' ledger against companies.textract_page_limit; refuses past it; a window reset clears it", async () => {
    const company = await createCompany({ textractPageLimit: 5 });
    expect(await checkTextractCap(company.id, 1)).toMatchObject({ allowed: true, companyUsed: 0, companyLimit: 5 });
    await recordComputeUsage({ companyId: company.id, resource: "textract", pages: 4 });
    expect(await checkTextractCap(company.id, 1)).toMatchObject({ allowed: true, companyUsed: 4 });
    expect(await checkTextractCap(company.id, 2)).toMatchObject({ allowed: false, companyUsed: 4, companyLimit: 5 });
    await recordComputeUsage({ companyId: company.id, resource: "textract", pages: 1 });
    const refused = await checkTextractCap(company.id, 1);
    expect(refused.allowed).toBe(false);
    expect(refused.message).toContain("Textract page limit reached for your company (5/5 pages used)");
    // a window reset (what PUT /api/admin/usage action:reset does) starts the count over
    await db.update(companies).set({ usageWindowStart: new Date(Date.now() + 1000) }).where(eq(companies.id, company.id));
    expect(await checkTextractCap(company.id, 1)).toMatchObject({ allowed: true, companyUsed: 0 });
    expect(await checkTextractCap(2_000_000_000, 1)).toMatchObject({ allowed: false, message: "Company not found" });
  });

  it("checkLambdaQuota: default 20,000 pages/day per company, per-company override applies, root exempt, counts the lambda_cv ledger", async () => {
    const company = await createCompany();
    const user = await createUser(company.id);
    expect(await checkLambdaQuota(company.id, false, user.id, 100)).toMatchObject({ allowed: true, current: 0, limit: 20_000 });
    expect(await checkLambdaQuota(company.id, false, user.id, 20_001)).toMatchObject({ allowed: false });
    await db.insert(appSettings).values({ key: QUOTA_OVERRIDES_KEY, value: { companies: { [company.id]: { lambdaPagesPerDay: 10 } }, users: {} } })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: { companies: { [company.id]: { lambdaPagesPerDay: 10 } }, users: {} } } });
    await recordComputeUsage({ companyId: company.id, userId: user.id, resource: "lambda_cv", pages: 8 });
    expect(await checkLambdaQuota(company.id, false, user.id, 2)).toMatchObject({ allowed: true, current: 8, limit: 10 });
    const refused = await checkLambdaQuota(company.id, false, user.id, 3);
    expect(refused.allowed).toBe(false);
    expect(refused.message).toBe("Daily Lambda page limit reached (8/10 pages used; this request needs 3)");
    expect(await checkLambdaQuota(company.id, true, user.id, 5_000_000)).toEqual({ allowed: true });
    await db.delete(appSettings).where(eq(appSettings.key, QUOTA_OVERRIDES_KEY));
  });
});

describe.skipIf(!dbUp)("owner LLM key grant (2026-10-25)", () => {
  async function setGrants(companyIds: number[]) {
    await db.insert(appSettings).values({ key: LLM_OWNER_KEY_GRANTS_KEY, value: { companies: companyIds } })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: { companies: companyIds } } });
  }

  it("resolveLLMConfig: no own key + no grant → null; granted → the owner's env key; own encrypted key always; demo unchanged", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-owner";
    const company = await createCompany();
    await setGrants([]);
    expect(await resolveLLMConfig(company.id)).toBeNull();
    // a company config pinned to a provider with NO key: still nothing without the grant
    await db.insert(llmConfigs).values({ companyId: company.id, userId: null, provider: "anthropic", model: "claude-sonnet-4-6", isDemo: false, isDefault: true });
    expect(await resolveLLMConfig(company.id)).toBeNull();
    // demo sessions keep their owner-billed path
    expect(await resolveLLMConfig(company.id, undefined, true)).toMatchObject({ provider: "anthropic", apiKey: "sk-owner" });
    await setGrants([company.id]);
    expect(await resolveLLMConfig(company.id)).toMatchObject({ provider: "anthropic", model: "claude-sonnet-4-6", apiKey: "sk-owner" });
    // the company's own key never needed the grant
    await setGrants([]);
    await db.update(llmConfigs).set({ encryptedApiKey: encryptApiKey("sk-company") }).where(eq(llmConfigs.companyId, company.id));
    expect(await resolveLLMConfig(company.id)).toMatchObject({ provider: "anthropic", apiKey: "sk-company" });
  });

  it("GET/PUT /api/admin/llm-owner-key: company admin 403, gated root 401, root toggles + audits; app-settings refuses the key", async () => {
    const company = await createCompany();
    const admin = await createUser(company.id, { role: "admin" });
    const root = await createUser(company.id, { isRootAdmin: true });
    asUser(admin);
    expect((await readJson(await grantGET(makeReq("/api/admin/llm-owner-key", { method: "GET" })))).status).toBe(403);
    expect((await readJson(await grantPUT(makeReq("/api/admin/llm-owner-key", { method: "PUT", body: { companyId: company.id, granted: true } })))).status).toBe(403);
    sessionState.current = { twoFactorGate: "verify" } as never;
    expect((await readJson(await grantPUT(makeReq("/api/admin/llm-owner-key", { method: "PUT", body: { companyId: company.id, granted: true } })))).status).toBe(401);
    asUser(root);
    let r = await readJson(await grantPUT(makeReq("/api/admin/llm-owner-key", { method: "PUT", body: { companyId: company.id, granted: true } })));
    expect(r.status).toBe(200);
    expect(r.body.companies).toContain(company.id);
    r = await readJson(await grantGET(makeReq("/api/admin/llm-owner-key", { method: "GET" })));
    expect(r.body.companies).toContain(company.id);
    r = await readJson(await grantPUT(makeReq("/api/admin/llm-owner-key", { method: "PUT", body: { companyId: company.id, granted: false } })));
    expect(r.body.companies).not.toContain(company.id);
    expect((await readJson(await grantPUT(makeReq("/api/admin/llm-owner-key", { method: "PUT", body: { companyId: company.id } })))).status).toBe(400);
    const audits = await lastAudits("llm_owner_key_grant_changed");
    expect(audits.some((a) => a.userId === root.id && (a.details as { targetCompanyId?: number })?.targetCompanyId === company.id)).toBe(true);
    const denied = await readJson(await settingsPUT(makeReq("/api/admin/app-settings", { method: "PUT", body: { key: LLM_OWNER_KEY_GRANTS_KEY, value: { companies: [company.id] } } })));
    expect(denied.status).toBe(400);
    expect(denied.body.error.message).toBe("Use /api/admin/llm-owner-key to change owner LLM key grants");
  });
});

describe.skipIf(!dbUp)("reserved ROOT_ADMIN_EMAIL (2026-10-25)", () => {
  it("createUser (company admin) and /api/register refuse the bootstrap address; root may create it", async () => {
    process.env.ROOT_ADMIN_EMAIL = "Owner@Example.Test";
    expect(isReservedRootBootstrapEmail("owner@example.test")).toBe(true);
    expect(isReservedRootBootstrapEmail("other@example.test")).toBe(false);
    const company = await createCompany({ accessKey: "ak-reserved-test" });
    const admin = await createUser(company.id, { role: "admin" });
    asUser(admin);
    let r = await readJson(await usersPOST(makeReq("/api/admin/users", { method: "POST", body: { username: "o", email: "owner@example.test", password: "longenough" } })));
    expect(r.status).toBe(403);
    expect(r.body.error.message).toBe("This email address is reserved");
    signedOut();
    r = await readJson(await registerPOST(makeReq("/api/register", { method: "POST", body: { username: "o", email: "OWNER@example.test", password: "Longenough1", accessKey: "ak-reserved-test" } })));
    expect(r.status).toBe(400);
    expect(r.body.error.message).toBe("Invalid access key or email already in use");
    asUser(await createUser(company.id, { isRootAdmin: true }));
    r = await readJson(await usersPOST(makeReq("/api/admin/users", { method: "POST", body: { username: "o", email: "owner@example.test", password: "longenough" } })));
    expect(r.status).toBe(200);
  });
});

describe("secret-box (2026-10-25)", () => {
  it("seals per purpose, opens legacy ciphertext, refuses a wrong purpose; opens under ANY candidate key, and a lost key is a clear error", () => {
    process.env.LLM_KEY_SECRET = "box-secret-one";
    const sealed = sealSecret("seed-bytes", "root-2fa");
    expect(sealed.startsWith("v2:")).toBe(true);
    expect(openSecret(sealed, "root-2fa")).toBe("seed-bytes");
    expect(() => openSecret(sealed, "llm-key")).toThrow(SecretUnreadableError);
    expect(openSecret(encryptApiKey("legacy-seed"), "root-2fa")).toBe("legacy-seed");
    // a dedicated ROOT_2FA_KEY takes precedence for SEALING and separates the TOTP key from the session secret
    process.env.ROOT_2FA_KEY = "dedicated-two-factor-key";
    const dedicated = sealSecret("seed-2", "root-2fa");
    expect(openSecret(dedicated, "root-2fa")).toBe("seed-2");
    // [fix round M1] ... but OPENING tries every candidate: a seed sealed before ROOT_2FA_KEY was
    // set still opens after it is set (no lockout at the release that wires the key) ...
    expect(openSecret(sealed, "root-2fa")).toBe("seed-bytes");
    // ... and one sealed under ROOT_2FA_KEY still opens if a task definition ever lacks it.
    delete process.env.ROOT_2FA_KEY;
    expect(openSecret(sealed, "root-2fa")).toBe("seed-bytes");
    expect(() => openSecret(dedicated, "root-2fa")).toThrow(/cannot be decrypted .* break-glass/u);
    // A seed under a key that is in NO candidate (rotated ROOT_2FA_KEY, old value gone) is the break-glass case.
    process.env.ROOT_2FA_KEY = "rotated-two-factor-key";
    expect(() => openSecret(dedicated, "root-2fa")).toThrow(SecretUnreadableError);
    expect(openSecret(sealed, "root-2fa")).toBe("seed-bytes");
    delete process.env.ROOT_2FA_KEY;
  });
});
