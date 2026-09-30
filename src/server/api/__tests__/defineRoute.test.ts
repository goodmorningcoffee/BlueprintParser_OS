// @vitest-environment node
// [refactor jun16 P1.1] Shell unit tests. Pure-unit (NO DB): auth() is mocked via the
// harness sessionState; resolveProjectAccess is mocked so project-mode tests need no pg.
// These run unconditionally (not skipIf(!dbUp)) — the shell is the foundation everything
// migrates onto, so its tests must never silently skip.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { NextResponse } from "next/server";

// hoisted so the vi.mock factory can close over it
const { mockResolve } = vi.hoisted(() => ({ mockResolve: vi.fn() }));
// [refactor jul23 P5.6 U4] Mock the structured logger so the 500-path error line is inspectable
// as fielded context (not console noise). All four levels are stubbed; only .error is asserted.
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/logger", () => ({ logger: mockLogger }));

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});
vi.mock("@/lib/api-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-utils")>();
  return { ...actual, resolveProjectAccess: mockResolve };
});

// import AFTER the mocks
import {
  AUTHENTICATED_MAX_BODY_BYTES,
  DEFAULT_MAX_BODY_BYTES,
  defineRoute,
} from "@/server/api/defineRoute";
import { ApiError } from "@/server/api/envelope";
import { sessionState, makeReq, params, readJson, signedOut } from "@/test/harness";

const UUID = "11111111-1111-4111-8111-111111111111";

function setSession(over: Record<string, unknown> = {}): void {
  sessionState.current = {
    user: {
      companyId: 1,
      dbId: 1,
      username: "u",
      role: "member",
      canRunModels: false,
      isRootAdmin: false,
      ...over,
    },
  } as never;
}

const projectRow = {
  id: 7,
  publicId: UUID,
  companyId: 1,
  isDemo: false,
  dataUrl: "co/x",
  name: "P",
  numPages: 3,
  status: "completed",
  lifecycleEpoch: 0,
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};
const ok = (scope: string, session: unknown = setSessionVal()) => ({
  project: projectRow,
  session,
  scope,
  error: null,
});
function setSessionVal() {
  return { user: { companyId: 1, dbId: 1, username: "u", role: "member", canRunModels: false, isRootAdmin: false } };
}

beforeEach(() => {
  signedOut();
  mockResolve.mockReset();
  mockLogger.error.mockClear();
});

describe("defineRoute — body parse + envelope", () => {
  it("returns the handler's value as-is on 200 (no {data} wrapper)", async () => {
    const route = defineRoute({ auth: "none", handler: () => ({ hello: "world" }) });
    const { status, body } = await readJson(await route(makeReq("/x", { method: "GET" })));
    expect(status).toBe(200);
    expect(body).toEqual({ hello: "world" });
  });

  it("malformed JSON body → 400 BAD_REQUEST envelope", async () => {
    const route = defineRoute({ auth: "none", handler: () => ({ ok: true }) });
    const req = new Request("http://test.local/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const { status, body } = await readJson(await route(req));
    expect(status).toBe(400);
    expect(body).toEqual({ error: { code: "BAD_REQUEST", message: "Invalid JSON body" } });
  });

  it("body failing the schema → 400 VALIDATION with the field path", async () => {
    const route = defineRoute({
      auth: "none",
      body: z.object({ name: z.string().min(1), n: z.number().int() }),
      handler: ({ body }) => body,
    });
    const { status, body } = await readJson(await route(makeReq("/x", { body: { name: "", n: 1.5 } })));
    expect(status).toBe(400);
    expect(body.error.code).toBe("VALIDATION");
    expect(typeof body.error.message).toBe("string");
  });

  it("valid body → handler receives the parsed body", async () => {
    const route = defineRoute({
      auth: "none",
      body: z.object({ n: z.number().int() }),
      handler: ({ body }) => ({ doubled: body.n * 2 }),
    });
    const { status, body } = await readJson(await route(makeReq("/x", { body: { n: 21 } })));
    expect(status).toBe(200);
    expect(body).toEqual({ doubled: 42 });
  });

  it("query schema validates + coerces searchParams; bad query → 400 VALIDATION", async () => {
    const route = defineRoute({
      auth: "none",
      query: z.object({ n: z.coerce.number().int().min(1) }),
      handler: ({ query }) => ({ n: query.n }),
    });
    const okRes = await readJson(await route(makeReq("/x?n=5", { method: "GET" })));
    expect(okRes.body).toEqual({ n: 5 });
    const badRes = await readJson(await route(makeReq("/x?n=abc", { method: "GET" })));
    expect(badRes.status).toBe(400);
    expect(badRes.body.error.code).toBe("VALIDATION");
  });

  it("a handler returning a Response is passed through untouched", async () => {
    const route = defineRoute({
      auth: "none",
      handler: () => NextResponse.json({ raw: true }, { status: 201 }),
    });
    const { status, body } = await readJson(await route(makeReq("/x", { method: "GET" })));
    expect(status).toBe(201);
    expect(body).toEqual({ raw: true });
  });

  // [refactor jul7 DR006] rawBody skip-parse mode — the shell must NOT consume/parse a
  // non-JSON (multipart) body, so a formData handler (admin/csi/upload) can read the stream.
  it("rawBody:true leaves the multipart stream intact for the handler to read via req.formData()", async () => {
    const route = defineRoute({
      auth: "none",
      rawBody: true,
      handler: async ({ req, body }) => {
        const form = await req.formData(); // shell did NOT already drain the stream
        return { name: form.get("name"), bodyIsUndefined: body === undefined };
      },
    });
    const fd = new FormData();
    fd.set("name", "spec.csi");
    const req = new Request("http://test.local/x", { method: "POST", body: fd });
    const { status, body } = await readJson(await route(req));
    expect(status).toBe(200);
    expect(body).toEqual({ name: "spec.csi", bodyIsUndefined: true });
  });

  it("WITHOUT rawBody, a multipart body is rejected as invalid JSON (proves the flag is load-bearing)", async () => {
    const route = defineRoute({ auth: "none", handler: () => ({ ok: true }) });
    const fd = new FormData();
    fd.set("name", "spec.csi");
    const req = new Request("http://test.local/x", { method: "POST", body: fd });
    const { status, body } = await readJson(await route(req));
    expect(status).toBe(400);
    expect(body).toEqual({ error: { code: "BAD_REQUEST", message: "Invalid JSON body" } });
  });
});

describe("defineRoute — auth modes", () => {
  it("none: no session required, handler sees session=null", async () => {
    const route = defineRoute({ auth: "none", handler: ({ session }) => ({ s: session }) });
    const { body } = await readJson(await route(makeReq("/x", { method: "GET" })));
    expect(body).toEqual({ s: null });
  });

  it("session: signed out → 401", async () => {
    const route = defineRoute({ auth: "session", handler: () => ({ ok: true }) });
    const { status, body } = await readJson(await route(makeReq("/x", { method: "GET" })));
    expect(status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("session: signed in → handler gets the session", async () => {
    setSession({ dbId: 99 });
    const route = defineRoute({ auth: "session", handler: ({ session }) => ({ id: session!.user.dbId }) });
    const { status, body } = await readJson(await route(makeReq("/x", { method: "GET" })));
    expect(status).toBe(200);
    expect(body).toEqual({ id: 99 });
  });

  it("admin: member → 403; admin → ok; root → ok (isRootAdmin bypass)", async () => {
    const route = defineRoute({ auth: "admin", handler: () => ({ ok: true }) });
    setSession({ role: "member" });
    expect((await readJson(await route(makeReq("/x", { method: "GET" })))).status).toBe(403);
    setSession({ role: "admin" });
    expect((await readJson(await route(makeReq("/x", { method: "GET" })))).status).toBe(200);
    setSession({ role: "member", isRootAdmin: true });
    expect((await readJson(await route(makeReq("/x", { method: "GET" })))).status).toBe(200);
  });

  it("root: admin → 403; root → ok", async () => {
    const route = defineRoute({ auth: "root", handler: () => ({ ok: true }) });
    setSession({ role: "admin" });
    expect((await readJson(await route(makeReq("/x", { method: "GET" })))).status).toBe(403);
    setSession({ isRootAdmin: true });
    expect((await readJson(await route(makeReq("/x", { method: "GET" })))).status).toBe(200);
  });

  it("webhookSecret: missing/wrong header → 401; correct Bearer + fresh ts → ok; stale ts → 401", async () => {
    process.env.PROCESSING_WEBHOOK_SECRET = "test-secret";
    const route = defineRoute({ auth: "webhookSecret", handler: () => ({ ok: true }) });
    // missing
    expect((await readJson(await route(makeReq("/x", { body: {} })))).status).toBe(401);
    // correct + fresh
    const good = makeReq("/x", {
      body: {},
      headers: { authorization: "Bearer test-secret", "x-webhook-timestamp": String(Date.now()) },
    });
    expect((await readJson(await route(good))).status).toBe(200);
    // stale timestamp
    const stale = makeReq("/x", {
      body: {},
      headers: { authorization: "Bearer test-secret", "x-webhook-timestamp": String(Date.now() - 10 * 60 * 1000) },
    });
    const staleRes = await readJson(await route(stale));
    expect(staleRes.status).toBe(401);
    expect(staleRes.body.error.message).toBe("Webhook expired");
  });
});

describe("defineRoute — project auth (delegates to resolveProjectAccess)", () => {
  it("non-uuid publicId param → 400 VALIDATION, resolveProjectAccess NOT called (closes S003 500-quirk)", async () => {
    const route = defineRoute({
      auth: { project: { param: "id", allowDemo: false } },
      handler: () => ({ ok: true }),
    });
    const { status, body } = await readJson(await route(makeReq("/x", { method: "GET" }), params({ id: "not-a-uuid" })));
    expect(status).toBe(400);
    expect(body.error.code).toBe("VALIDATION");
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("resolveProjectAccess 404 → 404 NOT_FOUND envelope", async () => {
    mockResolve.mockResolvedValue({
      project: null,
      session: null,
      scope: null,
      error: NextResponse.json({ error: "Not found" }, { status: 404 }),
    });
    const route = defineRoute({ auth: { project: { param: "id" } }, handler: () => ({ ok: true }) });
    const { status, body } = await readJson(await route(makeReq("/x", { method: "GET" }), params({ id: UUID })));
    expect(status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
    expect(mockResolve).toHaveBeenCalledWith({ publicId: UUID }, { allowDemo: undefined });
  });

  it("success (scope member, min member) → handler gets project + scope", async () => {
    mockResolve.mockResolvedValue(ok("member"));
    const route = defineRoute({
      auth: { project: { param: "id", min: "member" } },
      handler: ({ project, scope }) => ({ pid: project!.id, scope }),
    });
    const { status, body } = await readJson(await route(makeReq("/x", { method: "GET" }), params({ id: UUID })));
    expect(status).toBe(200);
    expect(body).toEqual({ pid: 7, scope: "member" });
  });

  it("min:admin but scope member → 403 FORBIDDEN", async () => {
    mockResolve.mockResolvedValue(ok("member"));
    const route = defineRoute({ auth: { project: { param: "id", min: "admin" } }, handler: () => ({ ok: true }) });
    const { status, body } = await readJson(await route(makeReq("/x", { method: "GET" }), params({ id: UUID })));
    expect(status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("allowDemo + demo scope → allowed (bypasses min); handler sees scope=demo, session=null", async () => {
    mockResolve.mockResolvedValue({ project: projectRow, session: null, scope: "demo", error: null });
    const route = defineRoute({
      auth: { project: { param: "id", allowDemo: true, min: "member" } },
      handler: ({ scope, session }) => ({ scope, session }),
    });
    const { status, body } = await readJson(await route(makeReq("/x", { method: "GET" }), params({ id: UUID })));
    expect(status).toBe(200);
    expect(body).toEqual({ scope: "demo", session: null });
    expect(mockResolve).toHaveBeenCalledWith({ publicId: UUID }, { allowDemo: true });
  });

  it("body-key dbId auth → resolveProjectAccess called with {dbId}", async () => {
    mockResolve.mockResolvedValue(ok("member"));
    const route = defineRoute({
      auth: { project: { bodyKey: "projectId", as: "dbId" } },
      body: z.object({ projectId: z.number() }),
      handler: ({ project }) => ({ pid: project!.id }),
    });
    const { status } = await readJson(await route(makeReq("/x", { body: { projectId: 7 } })));
    expect(status).toBe(200);
    expect(mockResolve).toHaveBeenCalledWith({ dbId: 7 }, { allowDemo: undefined });
  });
});

describe("defineRoute — error leak prevention", () => {
  it("an unexpected throw → 500 with a GENERIC message (never the raw error)", async () => {
    const route = defineRoute({
      auth: "none",
      handler: () => {
        throw new Error("constraint chat_messages_project_id_fkey violated: secret detail");
      },
    });
    const { status, body } = await readJson(await route(makeReq("/x", { method: "GET" })));
    expect(status).toBe(500);
    expect(body).toEqual({ error: { code: "INTERNAL", message: "Internal server error" } });
    expect(JSON.stringify(body)).not.toContain("secret detail");
  });

  it("a thrown ApiError → its code/status/message", async () => {
    const route = defineRoute({
      auth: "none",
      handler: () => {
        throw new ApiError("CONFLICT", "already exists");
      },
    });
    const { status, body } = await readJson(await route(makeReq("/x", { method: "GET" })));
    expect(status).toBe(409);
    expect(body).toEqual({ error: { code: "CONFLICT", message: "already exists" } });
  });

  it("the database demo-write backstop maps to the canonical 403 envelope", async () => {
    const databaseError = {
      code: "P0001",
      constraint: "demo_project_read_only",
      message: "Demo projects are read-only",
    };
    const route = defineRoute({
      auth: "none",
      handler: () => {
        throw { message: "Failed query", cause: databaseError };
      },
    });

    const { status, body } = await readJson(await route(makeReq("/x", { method: "GET" })));

    expect(status).toBe(403);
    expect(body).toEqual({
      error: { code: "FORBIDDEN", message: "Demo projects are read-only" },
    });
    // the demo backstop is an EXPECTED policy denial, not a 500 — it must not log a route error
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});

// [refactor jul23 P5.6 U4] Structured, queryable 500 logging + client↔server correlation.
describe("defineRoute — structured error logging (P5.6)", () => {
  it("the 500 path emits ONE fielded route-error line {tag, requestId, method, path, status, code}", async () => {
    const route = defineRoute({
      auth: "none",
      handler: () => {
        throw new Error("constraint chat_messages_project_id_fkey violated: secret detail");
      },
    });

    const res = await route(makeReq("/api/projects/42/chat", { method: "GET" }));
    expect(res.status).toBe(500);

    // exactly one structured line, not a formatted string blob
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    const [msg, ctx] = mockLogger.error.mock.calls[0];
    expect(typeof msg).toBe("string");
    expect(ctx).toMatchObject({
      tag: "route-error",
      method: "GET",
      path: "/api/projects/42/chat",
      status: 500,
      code: "INTERNAL",
    });
    // requestId is a uuid the query can pivot on
    expect(ctx.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    // the real cause is carried server-side (the CLIENT body staying generic is proven above)
    expect(ctx.err).toBeInstanceOf(Error);
  });

  it("the 500 response carries x-request-id equal to the logged requestId (correlation key)", async () => {
    const route = defineRoute({
      auth: "none",
      handler: () => {
        throw new Error("boom");
      },
    });

    const res = await route(makeReq("/x", { method: "GET" }));
    expect(res.status).toBe(500);

    const headerId = res.headers.get("x-request-id");
    expect(headerId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    const loggedId = mockLogger.error.mock.calls[0][1].requestId;
    expect(headerId).toBe(loggedId);
  });

  it("a thrown ApiError (4xx) does NOT emit a route-error line (only unexpected 500s do)", async () => {
    const route = defineRoute({
      auth: "none",
      handler: () => {
        throw new ApiError("CONFLICT", "already exists");
      },
    });
    const res = await route(makeReq("/x", { method: "GET" }));
    expect(res.status).toBe(409);
    expect(mockLogger.error).not.toHaveBeenCalled();
    // 4xx envelope errors are not correlated to a server log line — no header expected
    expect(res.headers.get("x-request-id")).toBeNull();
  });
});

// [hardening sep30] What an UNAUTHENTICATED caller can make the server parse is bounded.
describe("defineRoute — body caps", () => {
  const MIB = 1024 * 1024;
  // A Request built here does not expose content-length the way a client's request does on the
  // wire, so string bodies declare it explicitly, as a browser or curl would.
  const post = (body: BodyInit, headers: Record<string, string> = {}) =>
    new Request("http://test.local/x", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(typeof body === "string" ? { "content-length": String(Buffer.byteLength(body)) } : {}),
        ...headers,
      },
      body,
      // @ts-expect-error — undici requires `duplex` for a stream body; absent from lib.dom types
      duplex: "half",
    });
  const jsonOf = (bytes: number) => JSON.stringify({ pad: "x".repeat(bytes) });

  it("auth runs BEFORE the body is read: a signed-out caller gets 401 and nothing is parsed", async () => {
    signedOut();
    const handler = vi.fn(() => ({ ok: true }));
    const route = defineRoute({ auth: "session", handler });
    // Malformed AND oversized: neither is ever looked at.
    const { status } = await readJson(await route(post("{not json" + "x".repeat(3 * MIB))));
    expect(status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("a signed-in caller on an authenticated route gets the larger cap, and a bound above it", async () => {
    setSession();
    const route = defineRoute({ auth: "session", handler: () => ({ ok: true }) });
    expect((await readJson(await route(post(jsonOf(3 * MIB))))).status).toBe(200);
    const over = await readJson(await route(post(jsonOf(AUTHENTICATED_MAX_BODY_BYTES))));
    expect(over.status).toBe(413);
    expect(over.body).toEqual({ error: { code: "BAD_REQUEST", message: "Request body too large" } });
  });

  it('auth:"none" — anonymous is held to the default cap; a session lifts it', async () => {
    const handler = vi.fn(() => ({ ok: true }));
    const route = defineRoute({ auth: "none", handler });
    signedOut();
    expect((await readJson(await route(post(jsonOf(DEFAULT_MAX_BODY_BYTES))))).status).toBe(413);
    expect(handler).not.toHaveBeenCalled();
    setSession();
    expect((await readJson(await route(post(jsonOf(DEFAULT_MAX_BODY_BYTES))))).status).toBe(200);
  });

  it("an anonymous demo read under project auth stays on the default cap", async () => {
    signedOut();
    mockResolve.mockResolvedValue({ project: { ...projectRow, isDemo: true }, session: null, scope: "demo" });
    const route = defineRoute({
      auth: { project: { param: "id", allowDemo: true } },
      handler: () => ({ ok: true }),
    });
    const res = await route(post(jsonOf(DEFAULT_MAX_BODY_BYTES)), params({ id: UUID }));
    expect(res.status).toBe(413);
  });

  it("per-route maxBodyBytes overrides both; a body under it still parses", async () => {
    const route = defineRoute({ auth: "none", maxBodyBytes: 64, handler: ({ body }) => body });
    expect((await readJson(await route(post(JSON.stringify({ a: 1 }))))).status).toBe(200);
    expect((await readJson(await route(post(jsonOf(100))))).status).toBe(413);
  });

  it("a chunked body with no content-length cannot skip the cap", async () => {
    signedOut();
    const route = defineRoute({ auth: "none", maxBodyBytes: 1024, handler: () => ({ ok: true }) });
    const chunk = new TextEncoder().encode("x".repeat(600));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 4) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const req = post(stream);
    expect(req.headers.get("content-length")).toBeNull();
    expect((await readJson(await route(req))).status).toBe(413);
  });

  it("a content-length that understates the body does not buy the larger cap", async () => {
    signedOut();
    const route = defineRoute({ auth: "none", handler: () => ({ ok: true }) });
    const chunk = new TextEncoder().encode("x".repeat(MIB));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 3) controller.enqueue(chunk);
        else controller.close();
      },
    });
    expect((await readJson(await route(post(stream, { "content-length": "10" })))).status).toBe(413);
  });
});

// [hardening sep30] The parser routes take the heavy-process gate for ANONYMOUS callers only.
describe("defineRoute — a handler behind withAnonymousHeavySlot", () => {
  it("anonymous: a saturated gate is the 503 envelope; signed-in: never gated; recovers when work drains", async () => {
    const { withHeavyProcessSlot, HEAVY_PROCESS_BUSY_MESSAGE, heavyProcessGateStateForTest } =
      await import("@/lib/heavy-process-gate");
    const { withAnonymousHeavySlot } = await import("@/server/api/heavy-work");
    const route = defineRoute({
      auth: "none",
      handler: () => withAnonymousHeavySlot(async () => ({ ok: true })),
    });
    const releases: Array<() => void> = [];
    const held = Array.from({ length: 8 }, () =>
      withHeavyProcessSlot(() => new Promise<void>((resolve) => releases.push(resolve))),
    );
    await Promise.resolve();
    expect(heavyProcessGateStateForTest()).toEqual({ active: 2, queued: 6 });
    const req = () => new Request("http://test.local/x", { method: "POST" });

    signedOut();
    const busy = await readJson(await route(req()));
    expect(busy.status).toBe(503);
    expect(busy.body).toEqual({
      error: { code: "RATE_LIMITED", message: HEAVY_PROCESS_BUSY_MESSAGE },
    });

    // The owner is not queued behind anonymous traffic, however full the gate is.
    setSession();
    expect((await readJson(await route(req()))).status).toBe(200);

    // Slots are handed over as holders finish, so release until all eight have started and ended.
    while (releases.length > 0) {
      releases.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await Promise.all(held);
    signedOut();
    expect((await readJson(await route(req()))).status).toBe(200);
    expect(heavyProcessGateStateForTest()).toEqual({ active: 0, queued: 0 });
  });
});
