// @vitest-environment node
// [refactor jul8 S060] CHARACTERIZATION for the admin/llm-config/test SOLO (POST connection
// test — tiny streamChat probe, nothing saved), written as THE FREEZE before the fold onto
// services/llm-config-test.ts. Solo. requireAdmin. ⚠️ THE EVICTION RESOLUTION: this route
// returns DOMAIN {success:false, error:<msg>, responseTime} bodies AT 200 — the `error` field
// is connection-test OUTCOME data (deliberately incl. err.message — the tool's purpose is
// telling the admin WHY the key failed), NOT the error envelope and NOT a DR002 B-leak. The
// fold keeps the try/catch IN-SERVICE producing these 200 bodies verbatim; the shell passes a
// returned object through untouched (it envelopes only THROWN errors). Do NOT convert the
// @200 domain-error bodies to ApiErrors. Frozen quirk inventory:
//   • !provider || !model → 400 "provider and model required" (the only true error path + auth).
//   • createLLMClient(provider, apiKey || "", baseUrl) — undefined apiKey coerces to "".
//   • first stream chunk → {success:true, responseTime}; an EMPTY stream (returns without
//     yielding) ALSO counts as success (quirk).
//   • Promise.race 10s timeout (resolve-not-throw — the uncaughtException crash fix, comment
//     preserved) → 200 {success:false, error:"Timeout waiting for LLM response", responseTime}.
//   • catch: LLMError.isRateLimit → the friendly rate-limit literal; LLMError → err.message;
//     Error → err.message; non-Error → "Connection failed". All @200 {success:false}.
//   • responseTime = Date.now() delta — assert typeof number only.
// NO B (the catch is domain control-flow @200). POST reads req.json() → E at fold.
// Assertions tagged [S060 fold: … applied] were flipped in the fold commit.
import { describe, expect, inject, it, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

const h = vi.hoisted(() => ({
  createLLMClient: vi.fn(),
}));
vi.mock("@/lib/llm", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/llm")>();
  return { ...orig, createLLMClient: h.createLLMClient }; // real LLMError class, mocked factory
});

import { POST as ltPOST } from "@/app/api/admin/llm-config/test/route";
import { LLMError } from "@/lib/llm";
import { asUser, createCompany, createUser, makeReq, readJson, signedOut } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

// [S060 fold: A applied] — at freeze these were the legacy flat bodies.
const UNAUTH = { error: "Unauthorized" };
const ADMIN_ONLY = { error: "Admin only" };

const postReq = (body: unknown) => makeReq("/api/admin/llm-config/test", { method: "POST", body });

function okStream() {
  return (async function* () { yield { delta: "OK" }; })();
}
function emptyStream() {
  return (async function* () { /* returns without yielding */ })();
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
  h.createLLMClient.mockReturnValue({ streamChat: vi.fn(() => okStream()) });
});

describe.skipIf(!dbUp)("admin/llm-config/test (LT)", () => {
  it("LT-1 auth: signed-out→401, member→403", async () => {
    const { member } = await makeAdmin();
    let r = await readJson(await ltPOST(postReq({ provider: "groq", model: "m" })));
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S060 fold: A applied]
    asUser(member);
    r = await readJson(await ltPOST(postReq({ provider: "groq", model: "m" })));
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ADMIN_ONLY); // [S060 fold: A applied]
  });

  it("LT-2 validation: missing provider or model → 400 'provider and model required'", async () => {
    const { admin } = await makeAdmin();
    asUser(admin);
    for (const body of [{}, { provider: "groq" }, { model: "m" }]) {
      const r = await readJson(await ltPOST(postReq(body)));
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: "provider and model required" }); // [S060 fold: A applied]
    }
  });

  it("LT-3 happy: first chunk → 200 {success:true, responseTime}; apiKey undefined coerces to ''", async () => {
    const { admin } = await makeAdmin();
    asUser(admin);
    const r = await readJson(await ltPOST(postReq({ provider: "groq", model: "llama", baseUrl: "https://b" })));
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(typeof r.body.responseTime).toBe("number");
    expect(h.createLLMClient).toHaveBeenCalledWith("groq", "", "https://b"); // apiKey || ""
    const client = h.createLLMClient.mock.results[0].value;
    expect(client.streamChat).toHaveBeenCalledWith({
      model: "llama", messages: [{ role: "user", content: "Say OK" }], maxTokens: 5, temperature: 0,
    });
  });

  it("LT-4 EMPTY stream (no chunks) still counts as success (quirk)", async () => {
    const { admin } = await makeAdmin();
    asUser(admin);
    h.createLLMClient.mockReturnValue({ streamChat: vi.fn(() => emptyStream()) });
    const r = await readJson(await ltPOST(postReq({ provider: "groq", model: "m" })));
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
  });

  it("LT-5 DOMAIN failures at 200: rate-limit literal / LLMError message / Error message / non-Error fallback", async () => {
    const { admin } = await makeAdmin();
    asUser(admin);
    // LLMError rate-limit → friendly literal (isRateLimit = statusCode === 429)
    h.createLLMClient.mockImplementationOnce(() => { throw new LLMError("429 too many requests", "groq", 429); });
    let r = await readJson(await ltPOST(postReq({ provider: "groq", model: "m" })));
    expect(r.status).toBe(200); // DOMAIN body at 200 — never enveloped
    expect(r.body).toEqual({ success: false, error: "Rate limited by provider — key is valid but try again later", responseTime: expect.any(Number) });
    // LLMError non-rate-limit → its message
    h.createLLMClient.mockImplementationOnce(() => { throw new LLMError("Invalid API key", "groq", 401); });
    r = await readJson(await ltPOST(postReq({ provider: "groq", model: "m" })));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: false, error: "Invalid API key" });
    // plain Error → its message (deliberate domain feedback, NOT a B-leak)
    h.createLLMClient.mockImplementationOnce(() => { throw new Error("ECONNREFUSED 1.2.3.4"); });
    r = await readJson(await ltPOST(postReq({ provider: "groq", model: "m" })));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: false, error: "ECONNREFUSED 1.2.3.4" });
    // non-Error throw → fallback literal
    h.createLLMClient.mockImplementationOnce(() => { throw "weird"; });
    r = await readJson(await ltPOST(postReq({ provider: "groq", model: "m" })));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: false, error: "Connection failed" });
  });

  it("LT-6 timeout: never-yielding stream + 10s → 200 {success:false, 'Timeout waiting for LLM response'}", async () => {
    const { admin } = await makeAdmin();
    asUser(admin);
    vi.useFakeTimers();
    try {
      // a stream whose first (and only) await never settles
      h.createLLMClient.mockReturnValue({
        streamChat: vi.fn(() => (async function* () { await new Promise(() => {}); yield {}; })()),
      });
      const pending = ltPOST(postReq({ provider: "groq", model: "m" }));
      await vi.advanceTimersByTimeAsync(10_000);
      const r = await readJson(await pending);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ success: false, error: "Timeout waiting for LLM response", responseTime: expect.any(Number) });
    } finally {
      vi.useRealTimers();
    }
  });

  it("LT-7 malformed JSON → legacy REJECTS (fold: 400 'Invalid JSON body')", async () => {
    const { admin } = await makeAdmin();
    asUser(admin);
    // [S060 fold: E applied]
    await expect(ltPOST(new Request("http://test.local/api/admin/llm-config/test", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{ nope",
    }))).rejects.toThrow();
  });
});
