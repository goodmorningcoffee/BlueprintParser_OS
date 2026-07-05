// @vitest-environment node
// [refactor jul5 S025] CHARACTERIZATION for /api/ai/chat (POST SSE stream + DELETE), written as
// THE FREEZE before the P1.5 migration onto services/ai-chat.ts. The SECOND streaming route to
// fold (S024 symbol-search precedent). The chat ENGINES (@/lib/services/chat/global + scoped,
// @/lib/llm/stream) are NOT under test as such — the LLM provider is mocked at the module seam
// (@/lib/llm createLLMClient; index re-resolved by stream.ts's `./index` → same module id) and
// resolveLLMConfig/quotas at theirs; the engines run REAL through the route. This file freezes
// the ROUTE contract:
//   • FC-1 POST cascade order: message-400 → [global branch] → projectId-400 →
//     resolveProjectAccess({publicId},{allowDemo:true}) (miss→404 BEFORE auth; non-demo
//     signed-out→401; cross-tenant→404) → demo gate (403, scope-demo only) → quota 429 →
//     dispatch. All route-level errors are FLAT {error:string} at legacy.
//   • FC-2 `if (!message)` is a FALSY check — "", 0, null all → "message required".
//   • FC-3 isDemo = access.scope === "demo", NOT project.isDemo: same-company members (and
//     root) on a demo project get their REAL scope (api-utils.ts:190-199 carve-out) → NO demo
//     gate, COMPANY quota; only anon/cross-company callers get demo scope. Diverges from
//     symbol-search (which used project.isDemo) — do NOT harmonize.
//   • FC-4 scope:"global" while SIGNED OUT falls through the global branch (session?.user
//     guard) into the scoped path → "projectId required" 400, NOT global handling.
//   • FC-6 quota companyId source: global = session.user.companyId; scoped non-demo =
//     access.session!.user.companyId; scoped demo = checkDemoChatQuota() (no arg).
//     quota.message || "Rate limit exceeded" fallback on all three.
//   • FC-7 delegated-service errors ride through UNTOUCHED and STAY FLAT after the fold:
//     demo-gate 403 "LLM Chat is disabled for demo users. Sign in to use this feature.";
//     503 "No LLM configured. Set up a provider in Admin → AI Models." (both global's
//     Response.json and scoped's apiError); 400 "Provider does not support tool use".
//     These are pinned FLAT here and MUST NOT flip at fold (labeling-FQ-8/S024 precedent —
//     the owning modules migrate later).
//   • FC-8 Path A SSE bytes (stream.ts, ZERO diff at fold): `data: {"content":X}\n\n` per
//     delta; assistant row INSERT awaited BEFORE `data: [DONE]`; on ANY throw emits
//     `data: {"error":MSG}` THEN `data: [DONE]`; MSG = LLMError.isRateLimit → "Rate limited
//     by AI provider. Please wait and try again." / LLMError → err.message / other →
//     "Chat failed — check LLM configuration in admin panel." (em-dash). HTTP always 200.
//   • FC-9 Path B tool-use SSE (scoped.ts:483-540, ZERO diff at fold): {content} /
//     {tool_call,status:"start"} / result-with-.action → EXTRA {action:{...}} line BEFORE
//     {tool_call,status:"done"} / done → [DONE]; on throw → {error:msg} and NO [DONE]
//     (asymmetric vs Path A — load-bearing, ChatPanel reads reader-done); assistant row in
//     finally hardcodes userId null. Entry gate: companies.pipelineConfig.llm.toolUse &&
//     provider ∈ {anthropic,openai} && scope!=="global".
//   • FC-10 DELETE: searchParams not body; resolveProjectAccess WITHOUT allowDemo (demo
//     anon → 401); scope==="page"&&pageNumber → eq(pageNumber, parseInt(pageNum)) NO RADIX
//     ("abc"→NaN→pg cast throw = legacy raw rejection); scope==="project" → isNull; ANY
//     other scope (default "all") deletes ALL project chat rows; body IGNORED at legacy.
//   • FC-11 persistence: scoped inserts the USER row pre-stream (pageNumber only when
//     scope==="page"); global NEVER persists the user message (assistant only, projectId
//     null); Path A assistant userId = session dbId ?? null; Path B assistant userId null.
//   • malformed/empty/'null' POST bodies: legacy unguarded `await req.json()` + destructure
//     → raw rejection (framework 500 in prod). Non-uuid projectId → pg uuid-cast rejection
//     (no route catch) → raw rejection; flips to the shell's generic INTERNAL 500 (diff B) —
//     zPublicId pre-validation is DECLINED (would flip 500→400, unsanctioned).
// Assertions tagged [S025 fold] flip in the fold commit (sanctioned diffs A/B/E only).
import { describe, expect, inject, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

const h = vi.hoisted(() => ({
  createLLMClient: vi.fn(),
  resolveLLMConfig: vi.fn(),
  checkChatQuota: vi.fn(),
  checkDemoChatQuota: vi.fn(),
}));

// FULL mock (not importOriginal): keeps the provider SDK adapters (groq/anthropic/openai)
// out of the module graph. LLMError must be the REAL class from types.ts so stream.ts's
// `instanceof LLMError` works — types.ts is dependency-free. stream.ts imports from
// "./index" which resolves to the same module id as "@/lib/llm" → this mock covers both.
vi.mock("@/lib/llm", async () => ({
  createLLMClient: h.createLLMClient,
  LLMError: (await import("@/lib/llm/types")).LLMError,
}));
vi.mock("@/lib/llm/resolve", () => ({ resolveLLMConfig: h.resolveLLMConfig }));
// Partial mock: only the two functions this route touches; checkUploadQuota etc. stay real.
vi.mock("@/lib/quotas", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/quotas")>()),
  checkChatQuota: h.checkChatQuota,
  checkDemoChatQuota: h.checkDemoChatQuota,
}));

import { POST, DELETE } from "@/app/api/ai/chat/route";
import {
  asUser,
  createCompany,
  createPage,
  createProject,
  createUser,
  createWorld,
  makeReq,
  readJson,
  signedOut,
} from "@/test/harness";
import { db } from "@/lib/db";
import { chatMessages, companies } from "@/lib/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { LLMError } from "@/lib/llm/types";

const dbUp = inject("dbUp") as boolean;

const PATH = "/api/ai/chat";
const callPost = (b: unknown) => POST(makeReq(PATH, { body: b }));
const callDelete = (qs: string) => DELETE(makeReq(`${PATH}?${qs}`, { method: "DELETE" }));

/** Drain an SSE Response: `data: {json}\n\n` events; `data: [DONE]` kept as the string. */
async function drainSse(res: Response): Promise<{ events: unknown[]; sawDone: boolean }> {
  const text = await res.text();
  const events: unknown[] = [];
  let sawDone = false;
  for (const chunk of text.split("\n\n")) {
    const line = chunk.trim();
    if (!line) continue;
    expect(line.startsWith("data: ")).toBe(true);
    const payload = line.slice("data: ".length);
    if (payload === "[DONE]") {
      sawDone = true;
      events.push("[DONE]");
    } else {
      events.push(JSON.parse(payload));
    }
  }
  return { events, sawDone };
}

function expectSseHeaders(res: Response) {
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  expect(res.headers.get("cache-control")).toBe("no-cache");
  expect(res.headers.get("connection")).toBe("keep-alive");
}

async function setPipeline(companyId: number, cfg: Record<string, unknown>) {
  await db.update(companies).set({ pipelineConfig: cfg }).where(eq(companies.id, companyId));
}

const rowsFor = (projectId: number) =>
  db.select().from(chatMessages).where(eq(chatMessages.projectId, projectId));

const CONFIG = { provider: "groq", model: "llama-3.3-70b-versatile", apiKey: "k" };

beforeEach(() => {
  vi.clearAllMocks(); // wipes impls too — EVERY default below must be re-seeded here
  signedOut();
  h.resolveLLMConfig.mockResolvedValue(CONFIG);
  // mockImplementation, NOT a shared value: each call must get a FRESH single-use generator
  h.createLLMClient.mockImplementation(() => ({
    provider: "groq",
    streamChat: async function* () {
      yield "Hello";
      yield " world";
    },
  }));
  h.checkChatQuota.mockResolvedValue({ allowed: true });
  h.checkDemoChatQuota.mockResolvedValue({ allowed: true });
});

describe.skipIf(!dbUp)("POST /api/ai/chat — validation cascade (FC-1/FC-2/FC-4)", () => {
  it("400 'message required' for absent/falsy message — FALSY check (FC-2)", async () => {
    for (const body of [{}, { message: "" }, { message: 0 }, { scope: "global" }]) {
      const { status, body: resBody } = await readJson(await callPost(body));
      expect(status).toBe(400);
      expect(resBody).toEqual({ error: "message required" }); // [S025 fold: A → {error:{code:"VALIDATION",message:"message required"}}]
    }
  });

  it("primitive/array bodies destructure to undefined → 400 'message required'", async () => {
    // [S025 fold: E — zLooseBody rejects these at 400 VALIDATION; status preserved, message drifts to zod wording]
    for (const raw of ["5", "[1]", '"abc"', "true"]) {
      const req = new Request(`http://test.local${PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw,
      });
      const { status, body: resBody } = await readJson(await POST(req));
      expect(status).toBe(400);
      expect(resBody).toEqual({ error: "message required" });
    }
  });

  it("malformed / empty / 'null' bodies: legacy unguarded req.json() → raw rejection", async () => {
    // [S025 fold: E — malformed → 400 BAD_REQUEST "Invalid JSON body"; empty/'null' → 400 VALIDATION]
    const mk = (raw: string | undefined) =>
      new Request(`http://test.local${PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw,
      });
    await expect(POST(mk("{oops"))).rejects.toThrow();
    await expect(POST(mk(undefined))).rejects.toThrow();
    await expect(POST(mk("null"))).rejects.toThrow(); // destructure of null → TypeError
  });

  it("400 'projectId required' when message present but no projectId", async () => {
    const { status, body } = await readJson(await callPost({ message: "hi", scope: "page" }));
    expect(status).toBe(400);
    expect(body).toEqual({ error: "projectId required" }); // [S025 fold: A]
  });

  it("FC-4: scope global while SIGNED OUT falls through to 'projectId required'", async () => {
    const { status, body } = await readJson(await callPost({ message: "hi", scope: "global" }));
    expect(status).toBe(400);
    expect(body).toEqual({ error: "projectId required" }); // [S025 fold: A]
  });
});

describe.skipIf(!dbUp)("POST — global branch (FC-6/FC-11)", () => {
  it("authed global: 200 SSE happy transcript; assistant persisted projectId-null; user msg NOT persisted", async () => {
    const company = await createCompany();
    const user = await createUser(company.id);
    asUser(user);
    const res = await POST(makeReq(PATH, { body: { message: "hi", scope: "global" } }));
    expectSseHeaders(res);
    const { events } = await drainSse(res);
    expect(events).toEqual([{ content: "Hello" }, { content: " world" }, "[DONE]"]);
    expect(h.checkChatQuota).toHaveBeenCalledWith(user.companyId);
    const mine = await db
      .select()
      .from(chatMessages)
      .where(and(isNull(chatMessages.projectId), eq(chatMessages.userId, user.id)));
    expect(mine).toHaveLength(1); // assistant ONLY — global never persists the user message (FC-11)
    expect(mine[0]).toMatchObject({
      role: "assistant",
      content: "Hello world",
      model: "groq/llama-3.3-70b-versatile",
      pageNumber: null,
    });
  });

  it("global quota exceeded → flat 429 with quota.message, and the || fallback", async () => {
    const company = await createCompany();
    const user = await createUser(company.id);
    asUser(user);
    h.checkChatQuota.mockResolvedValue({ allowed: false, message: "Daily chat limit reached" });
    let r = await readJson(await callPost({ message: "hi", scope: "global" }));
    expect(r.status).toBe(429);
    expect(r.body).toEqual({ error: "Daily chat limit reached" }); // [S025 fold: A]
    h.checkChatQuota.mockResolvedValue({ allowed: false });
    r = await readJson(await callPost({ message: "hi", scope: "global" }));
    expect(r.status).toBe(429);
    expect(r.body).toEqual({ error: "Rate limit exceeded" }); // [S025 fold: A]
  });

  it("global no-LLM: flat 503 from global.ts Response.json — FC-7, does NOT flip at fold", async () => {
    const company = await createCompany();
    const user = await createUser(company.id);
    asUser(user);
    h.resolveLLMConfig.mockResolvedValue(null);
    const { status, body } = await readJson(await callPost({ message: "hi", scope: "global" }));
    expect(status).toBe(503);
    expect(body).toEqual({ error: "No LLM configured. Set up a provider in Admin → AI Models." });
  });

  it("toolUse company config does NOT hijack the global branch (Path A still)", async () => {
    const company = await createCompany();
    const user = await createUser(company.id);
    await setPipeline(company.id, { llm: { toolUse: true } });
    asUser(user);
    const res = await POST(makeReq(PATH, { body: { message: "hi", scope: "global" } }));
    const { events } = await drainSse(res);
    expect(events).toEqual([{ content: "Hello" }, { content: " world" }, "[DONE]"]);
  });
});

describe.skipIf(!dbUp)("POST — scoped access matrix ({publicId}, allowDemo:true)", () => {
  it("non-demo signed-out → flat 401 'Unauthorized'", async () => {
    const { project } = await createWorld();
    const { status, body } = await readJson(await callPost({ projectId: project.publicId, message: "hi" }));
    expect(status).toBe(401);
    expect(body).toEqual({ error: "Unauthorized" }); // [S025 fold: A]
  });

  it("unknown valid uuid → flat 404 'Not found' (miss BEFORE auth, even signed-out)", async () => {
    const { status, body } = await readJson(
      await callPost({ projectId: "00000000-0000-4000-8000-000000000000", message: "hi" }),
    );
    expect(status).toBe(404);
    expect(body).toEqual({ error: "Not found" }); // [S025 fold: A]
  });

  it("cross-tenant authed on non-demo → flat 404 'Not found'", async () => {
    const { project } = await createWorld();
    const other = await createCompany();
    const intruder = await createUser(other.id);
    asUser(intruder);
    const { status, body } = await readJson(await callPost({ projectId: project.publicId, message: "hi" }));
    expect(status).toBe(404);
    expect(body).toEqual({ error: "Not found" }); // [S025 fold: A]
  });

  it("owner project scope: 200 stream; user + assistant rows persisted, pageNumber null (FC-11)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const res = await POST(
      makeReq(PATH, { body: { projectId: project.publicId, message: "count doors", scope: "project" } }),
    );
    expectSseHeaders(res);
    const { events } = await drainSse(res);
    expect(events).toEqual([{ content: "Hello" }, { content: " world" }, "[DONE]"]);
    expect(h.checkChatQuota).toHaveBeenCalledWith(user.companyId);
    const rows = await rowsFor(project.id);
    expect(rows).toHaveLength(2);
    const byRole = Object.fromEntries(rows.map((r) => [r.role, r]));
    expect(byRole.user).toMatchObject({ content: "count doors", pageNumber: null, userId: user.id });
    expect(byRole.assistant).toMatchObject({ content: "Hello world", pageNumber: null, userId: user.id });
  });

  it("page scope: user + assistant rows carry pageNumber (FC-11)", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1);
    asUser(user);
    const res = await POST(
      makeReq(PATH, { body: { projectId: project.publicId, message: "hi", scope: "page", pageNumber: 1 } }),
    );
    const { events, sawDone } = await drainSse(res);
    expect(sawDone).toBe(true);
    expect(events[0]).toEqual({ content: "Hello" });
    const rows = await rowsFor(project.id);
    expect(rows.map((r) => [r.role, r.pageNumber]).sort()).toEqual([
      ["assistant", 1],
      ["user", 1],
    ]);
  });

  it("non-uuid projectId → pg uuid-cast rejection (no route catch): raw rejection", async () => {
    // [S025 fold: B → generic INTERNAL 500 "Internal server error". zPublicId pre-validation
    // DECLINED — would flip this 500 to a 400, unsanctioned (symbol-search dbId precedent).]
    await expect(callPost({ projectId: "not-a-uuid", message: "hi" })).rejects.toThrow();
  });
});

describe.skipIf(!dbUp)("POST — demo semantics (FC-3/FC-6/FC-7)", () => {
  it("demo project ANON, demo.chat=false → FLAT 403 gate — FC-7, does NOT flip at fold", async () => {
    const { company, project } = await createWorld({ isDemo: true });
    await setPipeline(company.id, { demo: { chat: false } });
    const { status, body } = await readJson(await callPost({ projectId: project.publicId, message: "hi" }));
    expect(status).toBe(403);
    // FLAT shape pinned — demo-features.ts owns this envelope; it flips only when THAT module migrates
    expect(body).toEqual({ error: "LLM Chat is disabled for demo users. Sign in to use this feature." });
  });

  it("demo project ANON, chat default-on → 200 stream via DEMO quota (not company quota)", async () => {
    const { project } = await createWorld({ isDemo: true });
    const res = await callPost({ projectId: project.publicId, message: "hi" });
    const { events, sawDone } = await drainSse(res);
    expect(sawDone).toBe(true);
    expect(events[0]).toEqual({ content: "Hello" });
    expect(h.checkDemoChatQuota).toHaveBeenCalledTimes(1);
    expect(h.checkChatQuota).not.toHaveBeenCalled();
  });

  it("FC-3 CRITICAL: same-company member on demo project, demo.chat=false → NO gate, COMPANY quota, streams", async () => {
    const { company, user, project } = await createWorld({ isDemo: true });
    await setPipeline(company.id, { demo: { chat: false } });
    asUser(user); // scope resolves member (api-utils carve-out), NOT demo → isDemo=false in the route
    const res = await callPost({ projectId: project.publicId, message: "hi" });
    const { sawDone } = await drainSse(res);
    expect(sawDone).toBe(true);
    expect(h.checkChatQuota).toHaveBeenCalledWith(user.companyId);
    expect(h.checkDemoChatQuota).not.toHaveBeenCalled();
  });

  it("CROSS-company authed on demo project → scope demo: gate applies (session does not escape demo)", async () => {
    const { company, project } = await createWorld({ isDemo: true });
    await setPipeline(company.id, { demo: { chat: false } });
    const other = await createCompany();
    const outsider = await createUser(other.id);
    asUser(outsider);
    const { status, body } = await readJson(await callPost({ projectId: project.publicId, message: "hi" }));
    expect(status).toBe(403);
    expect(body).toEqual({ error: "LLM Chat is disabled for demo users. Sign in to use this feature." });
  });

  it("demo quota exceeded → flat 429", async () => {
    const { project } = await createWorld({ isDemo: true });
    h.checkDemoChatQuota.mockResolvedValue({ allowed: false, message: "Demo chat limit reached for today." });
    const { status, body } = await readJson(await callPost({ projectId: project.publicId, message: "hi" }));
    expect(status).toBe(429);
    expect(body).toEqual({ error: "Demo chat limit reached for today." }); // [S025 fold: A]
  });

  it("scoped no-LLM: flat 503 via scoped.ts apiError — FC-7, does NOT flip at fold", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    h.resolveLLMConfig.mockResolvedValue(null);
    const { status, body } = await readJson(await callPost({ projectId: project.publicId, message: "hi" }));
    expect(status).toBe(503);
    expect(body).toEqual({ error: "No LLM configured. Set up a provider in Admin → AI Models." });
  });
});

describe.skipIf(!dbUp)("POST — in-stream Path A errors at HTTP 200 (FC-8, ZERO diff at fold)", () => {
  async function errorStream(thrown: unknown) {
    const { user, project } = await createWorld();
    asUser(user);
    h.createLLMClient.mockImplementation(() => ({
      provider: "groq",
      // eslint-disable-next-line require-yield
      streamChat: async function* () {
        throw thrown;
      },
    }));
    const res = await callPost({ projectId: project.publicId, message: "hi" });
    expectSseHeaders(res); // errors are IN-BAND — HTTP stays 200
    return { drained: await drainSse(res), project };
  }

  it("generic throw → fallback message (em-dash) then [DONE]; assistant row NOT saved", async () => {
    const { drained, project } = await errorStream(new Error("kaboom"));
    expect(drained.events).toEqual([
      { error: "Chat failed — check LLM configuration in admin panel." },
      "[DONE]",
    ]);
    const rows = await rowsFor(project.id);
    expect(rows.map((r) => r.role)).toEqual(["user"]); // pre-stream user insert survives, no assistant
  });

  it("LLMError non-rate → err.message leaks in-band", async () => {
    const { drained } = await errorStream(new LLMError("boom from provider", "groq", 500));
    expect(drained.events).toEqual([{ error: "boom from provider" }, "[DONE]"]);
  });

  it("LLMError 429 → canned rate-limit message", async () => {
    const { drained } = await errorStream(new LLMError("ignored", "groq", 429));
    expect(drained.events).toEqual([
      { error: "Rate limited by AI provider. Please wait and try again." },
      "[DONE]",
    ]);
  });
});

describe.skipIf(!dbUp)("POST — tool-use Path B (FC-9, ZERO diff at fold)", () => {
  async function toolWorld() {
    const w = await createWorld();
    await setPipeline(w.company.id, { llm: { toolUse: true } });
    h.resolveLLMConfig.mockResolvedValue({ ...CONFIG, provider: "anthropic" });
    asUser(w.user);
    return w;
  }

  it("full event protocol: content / start / action-extra-line / done ×2 / [DONE]; assistant userId null", async () => {
    const { user, project } = await toolWorld();
    h.createLLMClient.mockImplementation(() => ({
      provider: "anthropic",
      streamChat: async function* () {
        yield "unused";
      },
      streamChatWithTools: async function* () {
        yield { type: "text_delta", text: "Hi" };
        yield { type: "tool_call_start", name: "getProjectOverview" };
        yield {
          type: "tool_call_result",
          name: "getProjectOverview",
          result: JSON.stringify({ action: "navigate", page: 2 }),
        };
        yield { type: "tool_call_result", name: "getProjectOverview", result: "plain text" };
        yield { type: "done" };
      },
    }));
    const res = await callPost({ projectId: project.publicId, message: "hi", scope: "project" });
    expectSseHeaders(res);
    const { events } = await drainSse(res);
    expect(events).toEqual([
      { content: "Hi" },
      { tool_call: "getProjectOverview", status: "start" },
      { action: { action: "navigate", page: 2 } }, // extra line ONLY when result parses with .action
      { tool_call: "getProjectOverview", status: "done" },
      { tool_call: "getProjectOverview", status: "done" }, // non-action result → done line only
      "[DONE]",
    ]);
    const rows = await rowsFor(project.id);
    const byRole = Object.fromEntries(rows.map((r) => [r.role, r]));
    expect(byRole.user).toMatchObject({ userId: user.id });
    expect(byRole.assistant).toMatchObject({ content: "Hi", userId: null }); // hardcoded null (FC-9)
  });

  it("ASYMMETRY: tool-use throw → {error} with NO [DONE] (vs Path A which always DONEs)", async () => {
    const { project } = await toolWorld();
    h.createLLMClient.mockImplementation(() => ({
      provider: "anthropic",
      // eslint-disable-next-line require-yield
      streamChatWithTools: async function* () {
        throw new Error("tool engine died");
      },
    }));
    const res = await callPost({ projectId: project.publicId, message: "hi" });
    expect(res.status).toBe(200);
    const { events, sawDone } = await drainSse(res);
    expect(events).toEqual([{ error: "tool engine died" }]);
    expect(sawDone).toBe(false); // load-bearing: ChatPanel relies on reader-done, do NOT "fix"
  });

  it("provider without streamChatWithTools → flat 400 — FC-7, does NOT flip at fold", async () => {
    const { project } = await toolWorld();
    h.resolveLLMConfig.mockResolvedValue({ ...CONFIG, provider: "openai" });
    h.createLLMClient.mockImplementation(() => ({
      provider: "openai",
      streamChat: async function* () {
        yield "x";
      },
    }));
    const { status, body } = await readJson(await callPost({ projectId: project.publicId, message: "hi" }));
    expect(status).toBe(400);
    expect(body).toEqual({ error: "Provider does not support tool use" });
  });
});

describe.skipIf(!dbUp)("DELETE /api/ai/chat (FC-10)", () => {
  async function seededWorld() {
    const w = await createWorld();
    await db.insert(chatMessages).values([
      { projectId: w.project.id, pageNumber: 1, role: "user", content: "p1" },
      { projectId: w.project.id, pageNumber: 2, role: "user", content: "p2" },
      { projectId: w.project.id, pageNumber: null, role: "user", content: "proj-wide" },
    ]);
    return w;
  }

  it("400 'projectId required' without projectId", async () => {
    const { status, body } = await readJson(await callDelete("scope=all"));
    expect(status).toBe(400);
    expect(body).toEqual({ error: "projectId required" }); // [S025 fold: A]
  });

  it("demo project ANON → 401 (NO allowDemo on DELETE) and unknown uuid → 404", async () => {
    const { project } = await createWorld({ isDemo: true });
    let r = await readJson(await callDelete(`projectId=${project.publicId}`));
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: "Unauthorized" }); // [S025 fold: A]
    signedOut();
    r = await readJson(await callDelete("projectId=00000000-0000-4000-8000-000000000000"));
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "Not found" }); // [S025 fold: A]
  });

  it("scope=page&pageNumber=1 → only that page's rows deleted; {success:true}", async () => {
    const { user, project } = await seededWorld();
    asUser(user);
    const { status, body } = await readJson(
      await callDelete(`projectId=${project.publicId}&scope=page&pageNumber=1`),
    );
    expect(status).toBe(200);
    expect(body).toEqual({ success: true }); // success body byte-identical after fold
    const left = await rowsFor(project.id);
    expect(left.map((r) => r.pageNumber).sort()).toEqual([2, null].sort());
  });

  it("scope=project → only pageNumber-IS-NULL rows deleted", async () => {
    const { user, project } = await seededWorld();
    asUser(user);
    await callDelete(`projectId=${project.publicId}&scope=project`);
    const left = await rowsFor(project.id);
    expect(left.map((r) => r.pageNumber).sort()).toEqual([1, 2]);
  });

  it("default scope ('all', or anything unrecognized) → ALL project rows deleted", async () => {
    const { user, project } = await seededWorld();
    asUser(user);
    await callDelete(`projectId=${project.publicId}`);
    expect(await rowsFor(project.id)).toHaveLength(0);
  });

  it("pageNumber non-numeric → parseInt NaN → pg int-cast rejection (legacy raw)", async () => {
    // [S025 fold: B → generic INTERNAL 500. Radix/NaN guard DECLINED — frozen quirk.]
    const { user, project } = await seededWorld();
    asUser(user);
    await expect(callDelete(`projectId=${project.publicId}&scope=page&pageNumber=abc`)).rejects.toThrow();
  });

  it("request body is IGNORED at legacy (even malformed)", async () => {
    // [S025 fold: E2 (S020 annotation-groups precedent) — the shell parses DELETE bodies, so a
    // non-empty malformed body will 400 BAD_REQUEST before auth after the fold. PINNED here.]
    const { user, project } = await seededWorld();
    asUser(user);
    const req = new Request(`http://test.local${PATH}?projectId=${project.publicId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: "{oops",
    });
    const { status, body } = await readJson(await DELETE(req));
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(await rowsFor(project.id)).toHaveLength(0);
  });
});
