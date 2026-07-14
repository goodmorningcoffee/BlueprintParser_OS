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

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});
vi.mock("@/lib/api-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-utils")>();
  return { ...actual, resolveProjectAccess: mockResolve };
});

// import AFTER the mocks
import { defineRoute } from "@/server/api/defineRoute";
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
  });
});
