/**
 * Access control matrix tests for resolveProjectAccess() and checkProjectAccess().
 *
 * Tests every caller type × project type combination to ensure
 * the centralized access layer enforces tenancy correctly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────
// Must be declared before imports that use them
const mockAuth = vi.fn();
const mockLimit = vi.fn();
const mockWhere = vi.fn(() => ({ limit: mockLimit }));
const mockFrom = vi.fn(() => ({ where: mockWhere }));
const mockSelect = vi.fn(() => ({ from: mockFrom }));

vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({
  db: { select: () => mockSelect() },
}));
vi.mock("@/lib/db/schema", () => ({
  projects: { publicId: "publicId", id: "id" },
}));
vi.mock("drizzle-orm", () => ({
  eq: (col: string, val: any) => ({ col, val, type: "eq" }),
}));

import { resolveProjectAccess, checkProjectAccess, apiError, parseBboxMinMax } from "@/lib/api-utils";

// ─── Fixtures ────────────────────────────────────────────────
const PROJECT_A = {
  id: 1, publicId: "proj-aaa", name: "Test Project", dataUrl: "company-a/proj-aaa",
  companyId: 100, isDemo: false, numPages: 5, status: "completed",
  authorId: 1, address: null, latitude: null, longitude: null,
  processingError: null, processingTime: null, jobId: null,
  projectIntelligence: null, projectSummary: null,
  createdAt: new Date(), updatedAt: new Date(),
};

const PROJECT_DEMO = { ...PROJECT_A, id: 2, publicId: "proj-demo", isDemo: true };
const PROJECT_B = { ...PROJECT_A, id: 3, publicId: "proj-bbb", companyId: 200 };

const SESSION_MEMBER_A = { user: { companyId: 100, dbId: 1, username: "user1", role: "member", canRunModels: false, isRootAdmin: false } };
const SESSION_ADMIN_A = { user: { ...SESSION_MEMBER_A.user, role: "admin" } };
const SESSION_ROOT = { user: { ...SESSION_MEMBER_A.user, companyId: 100, role: "admin", isRootAdmin: true } };
const SESSION_MEMBER_B = { user: { ...SESSION_MEMBER_A.user, companyId: 200, dbId: 2 } };

// ─── Helpers ─────────────────────────────────────────────────
function setSession(session: any) {
  mockAuth.mockResolvedValue(session);
}

function setProject(project: any) {
  mockLimit.mockResolvedValue(project ? [project] : []);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSelect.mockReturnValue({ from: mockFrom });
  mockFrom.mockReturnValue({ where: mockWhere });
  mockWhere.mockReturnValue({ limit: mockLimit });
});

// ─── resolveProjectAccess tests ──────────────────────────────
describe("resolveProjectAccess", () => {
  it("returns 401 for anonymous user on non-demo project", async () => {
    setSession(null);
    setProject(PROJECT_A);
    const result = await resolveProjectAccess({ publicId: "proj-aaa" });
    expect(result.error).not.toBeNull();
    const body = await result.error!.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns demo scope for anonymous user on demo project with allowDemo", async () => {
    setSession(null);
    setProject(PROJECT_DEMO);
    const result = await resolveProjectAccess({ publicId: "proj-demo" }, { allowDemo: true });
    expect(result.error).toBeNull();
    expect(result.scope).toBe("demo");
    expect(result.session).toBeNull();
  });

  it("returns 401 for anonymous user on demo project without allowDemo", async () => {
    setSession(null);
    setProject(PROJECT_DEMO);
    const result = await resolveProjectAccess({ publicId: "proj-demo" });
    expect(result.error).not.toBeNull();
    const body = await result.error!.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns member scope for company member accessing own project", async () => {
    setSession(SESSION_MEMBER_A);
    setProject(PROJECT_A);
    const result = await resolveProjectAccess({ publicId: "proj-aaa" });
    expect(result.error).toBeNull();
    expect(result.scope).toBe("member");
    expect(result.project?.id).toBe(1);
  });

  it("returns 404 for company member accessing another company's project", async () => {
    setSession(SESSION_MEMBER_A);
    setProject(PROJECT_B);
    const result = await resolveProjectAccess({ publicId: "proj-bbb" });
    expect(result.error).not.toBeNull();
    const body = await result.error!.json();
    expect(body.error).toBe("Not found");
  });

  it("returns admin scope for company admin accessing own project", async () => {
    setSession(SESSION_ADMIN_A);
    setProject(PROJECT_A);
    const result = await resolveProjectAccess({ publicId: "proj-aaa" });
    expect(result.error).toBeNull();
    expect(result.scope).toBe("admin");
  });

  it("returns 404 for company admin accessing another company's project", async () => {
    setSession(SESSION_ADMIN_A);
    setProject(PROJECT_B);
    const result = await resolveProjectAccess({ publicId: "proj-bbb" });
    expect(result.error).not.toBeNull();
  });

  it("returns root scope for root admin accessing any project", async () => {
    setSession(SESSION_ROOT);
    setProject(PROJECT_B);
    const result = await resolveProjectAccess({ publicId: "proj-bbb" });
    expect(result.error).toBeNull();
    expect(result.scope).toBe("root");
  });

  it("returns root scope (not demo) for root admin on demo project even with allowDemo", async () => {
    // Authenticated users get their real scope so their LLM config + quota apply,
    // not the demo defaults. allowDemo only grants demo scope to unauthenticated
    // viewers (and cross-tenant authenticated users who otherwise wouldn't have access).
    setSession(SESSION_ROOT);
    setProject(PROJECT_DEMO);
    const result = await resolveProjectAccess({ publicId: "proj-demo" }, { allowDemo: true });
    expect(result.error).toBeNull();
    expect(result.scope).toBe("root");
  });

  it("returns 404 for nonexistent project", async () => {
    setSession(SESSION_MEMBER_A);
    setProject(null);
    const result = await resolveProjectAccess({ publicId: "nonexistent" });
    expect(result.error).not.toBeNull();
    const body = await result.error!.json();
    expect(body.error).toBe("Not found");
  });

  it("works with dbId lookup", async () => {
    setSession(SESSION_MEMBER_A);
    setProject(PROJECT_A);
    const result = await resolveProjectAccess({ dbId: 1 });
    expect(result.error).toBeNull();
    expect(result.scope).toBe("member");
  });

  it("allows demo access via dbId", async () => {
    setSession(null);
    setProject(PROJECT_DEMO);
    const result = await resolveProjectAccess({ dbId: 2 }, { allowDemo: true });
    expect(result.error).toBeNull();
    expect(result.scope).toBe("demo");
  });
});

// ─── checkProjectAccess tests ────────────────────────────────
describe("checkProjectAccess", () => {
  it("returns 401 for anonymous on non-demo project", async () => {
    setSession(null);
    const result = await checkProjectAccess({ isDemo: false, companyId: 100 });
    expect(result.error).not.toBeNull();
  });

  it("returns demo scope for anonymous on demo project with allowDemo", async () => {
    setSession(null);
    const result = await checkProjectAccess({ isDemo: true, companyId: 100 }, { allowDemo: true });
    expect(result.error).toBeNull();
    expect(result.scope).toBe("demo");
  });

  it("returns member scope for matching company", async () => {
    setSession(SESSION_MEMBER_A);
    const result = await checkProjectAccess({ isDemo: false, companyId: 100 });
    expect(result.error).toBeNull();
    expect(result.scope).toBe("member");
  });

  it("returns 404 for mismatched company", async () => {
    setSession(SESSION_MEMBER_A);
    const result = await checkProjectAccess({ isDemo: false, companyId: 200 });
    expect(result.error).not.toBeNull();
  });

  it("returns root scope for root admin on any company", async () => {
    setSession(SESSION_ROOT);
    const result = await checkProjectAccess({ isDemo: false, companyId: 200 });
    expect(result.error).toBeNull();
    expect(result.scope).toBe("root");
  });
});

// ─── apiError tests ──────────────────────────────────────────
describe("apiError", () => {
  it("returns correct status code", async () => {
    const resp = apiError("test", 400);
    expect(resp.status).toBe(400);
  });

  it("returns correct error message shape", async () => {
    const resp = apiError("Something broke", 500);
    const body = await resp.json();
    expect(body).toEqual({ error: "Something broke" });
  });

  it("defaults to 500 when no status given", async () => {
    const resp = apiError("oops");
    expect(resp.status).toBe(500);
  });
});

// ─── parseBboxMinMax tests ───────────────────────────────────
describe("parseBboxMinMax", () => {
  it("accepts valid bbox", () => {
    const result = parseBboxMinMax([0.1, 0.2, 0.8, 0.9]);
    expect(result.error).toBeNull();
    expect(result.bbox).toEqual([0.1, 0.2, 0.8, 0.9]);
  });

  it("rejects non-array", () => {
    const result = parseBboxMinMax("not an array");
    expect(result.error).not.toBeNull();
  });

  it("rejects wrong length", () => {
    const result = parseBboxMinMax([0.1, 0.2, 0.3]);
    expect(result.error).not.toBeNull();
  });

  it("rejects out-of-range values", () => {
    const result = parseBboxMinMax([0.1, 0.2, 1.5, 0.9]);
    expect(result.error).not.toBeNull();
  });

  it("rejects min >= max", () => {
    const result = parseBboxMinMax([0.8, 0.2, 0.1, 0.9]);
    expect(result.error).not.toBeNull();
  });

  it("rejects negative values", () => {
    const result = parseBboxMinMax([-0.1, 0.2, 0.8, 0.9]);
    expect(result.error).not.toBeNull();
  });
});
