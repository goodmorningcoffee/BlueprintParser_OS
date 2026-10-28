// @vitest-environment node
// [table pipeline WP-3.P] POST /api/admin/classifiers/parse-preview through the real route shell, the real
// page-evidence loader (Postgres) and the REAL parse engine at `instant`: root only (signed-out 401, member and
// company admin 403, a 2FA-gated root 401), any company's project (root spans companies), demo refused, compute
// only (no S3 object, the page row unchanged), per-item errors, strict body, kill switch. S3 is an in-memory
// spy; the flags read is controlled here (the DB row is owned by parse-engine-flags.route.test.ts).
// Synthetic page data only (rule 12): pseudo-tokens QA…QZ.
import { beforeEach, describe, expect, inject, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ uploads: [] as string[], downloads: [] as string[], flags: null as null | Record<string, unknown> }));

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});
vi.mock("@/lib/s3", async (orig) => {
  const m = await orig<typeof import("@/lib/s3")>();
  return {
    ...m,
    downloadFromS3: vi.fn(async (key: string) => { h.downloads.push(key); throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" }); }),
    uploadToS3: vi.fn(async (key: string) => { h.uploads.push(key); }),
  };
});
vi.mock("@/server/services/parse-engine/flags", async (orig) => {
  const m = await orig<typeof import("@/server/services/parse-engine/flags")>();
  return { ...m, readParseEngineFlags: async () => m.resolveParseEngineFlags(h.flags ?? undefined).flags };
});

import { POST } from "@/app/api/admin/classifiers/parse-preview/route";
import { db } from "@/lib/db";
import { pages } from "@/lib/db/schema";
import type { AuthSession } from "@/lib/api-utils";
import type { TextractWord } from "@/types";
import { asUser, createCompany, createPage, createProject, createUser, makeReq, publishDemoFixture, readJson, sessionState, signedOut } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;
const URL = "/api/admin/classifiers/parse-preview";
const call = async (body: unknown) => readJson(await POST(makeReq(URL, { body })));

const word = (text: string, x: number, y: number): TextractWord => ({ text, confidence: 99, bbox: [x, y, 0.04, 0.012] });

/** A 3-column grid of pseudo-tokens inside [0.2, 0.2, 0.6, 0.5]: a header row and five body rows. */
function gridWords(): TextractWord[] {
  const out: TextractWord[] = [];
  ["QA", "QB", "QC"].forEach((t, c) => out.push(word(t, 0.22 + c * 0.12, 0.22)));
  for (let r = 0; r < 5; r++) ["QX", "QY", "QZ"].forEach((t, c) => out.push(word(`${t}${r}`, 0.22 + c * 0.12, 0.26 + r * 0.04)));
  return out;
}
const BOX = [0.2, 0.2, 0.6, 0.5];

async function world(opts: { demo?: boolean } = {}) {
  const own = await createCompany();
  const other = await createCompany();
  const root = await createUser(own.id, { isRootAdmin: true });
  const companyAdmin = await createUser(other.id, { role: "admin" });
  const member = await createUser(other.id);
  // The project belongs to ANOTHER company than root's: the preview spans companies.
  const project = await createProject(other.id, companyAdmin.id);
  await createPage(project.id, 2, { drawingNumber: "Q-201", textractData: { words: gridWords(), tables: [] } as never, pageIntelligence: { keep: "me" } as never });
  if (opts.demo) await publishDemoFixture(project.id);
  return { root, companyAdmin, member, project };
}

beforeEach(() => {
  h.uploads.length = 0;
  h.downloads.length = 0;
  h.flags = null;
  signedOut();
});

describe.skipIf(!dbUp)("POST /api/admin/classifiers/parse-preview", () => {
  it("root only: signed-out 401, member 403, company admin 403 (even on its own project), gated root 401", async () => {
    const { member, companyAdmin, project } = await world();
    const body = { projectId: project.publicId, items: [{ page: 2, bbox: BOX, kind: "schedule" }] };
    expect((await call(body)).status).toBe(401);
    asUser(member);
    expect((await call(body)).status).toBe(403);
    asUser(companyAdmin);
    const r = await call(body);
    expect(r.status).toBe(403);
    expect(r.body.error.message).toBe("Root admin only");
    for (const gate of ["enroll", "verify"] as const) {
      sessionState.current = { twoFactorGate: gate } as unknown as AuthSession;
      expect((await call(body)).status).toBe(401);
    }
  });

  it("root parses another company's page with the real engine at instant; nothing is written or cached", async () => {
    const { root, project } = await world();
    const [before] = await db.select({ pi: pages.pageIntelligence }).from(pages).where(eq(pages.projectId, project.id));
    asUser(root);
    const r = await call({ projectId: project.publicId, items: [{ page: 2, bbox: BOX, kind: "schedule", proposalId: "schedules.v1:p2:x" }] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ projectId: project.publicId, budget: "instant" });
    expect(r.body.items).toHaveLength(1);
    const item = r.body.items[0];
    expect(item).toMatchObject({ proposalId: "schedules.v1:p2:x", page: 2, kind: "schedule", drawingNumber: "Q-201" });
    expect(item.error).toBeUndefined();
    expect(item.result.stamp.budget).toBe("instant");
    expect(item.result.model.kind).toBe("schedule");
    expect(item.result.model.rows.length).toBeGreaterThan(0);
    expect(item.result.model.cols.length).toBeGreaterThan(0);
    expect(item.result).not.toHaveProperty("sources");
    expect(h.uploads).toEqual([]);
    expect(h.downloads).toEqual([]);
    const [after] = await db.select({ pi: pages.pageIntelligence }).from(pages).where(eq(pages.projectId, project.id));
    expect(after.pi).toEqual(before.pi);
  });

  it("is deterministic (E-7): the same box twice gives the same model", async () => {
    const { root, project } = await world();
    asUser(root);
    const item = { page: 2, bbox: BOX, kind: "schedule" };
    const r = await call({ projectId: project.publicId, items: [item, item] });
    expect(r.status).toBe(200);
    expect(r.body.items[0].result.model).toEqual(r.body.items[1].result.model);
  });

  it("a missing page is an item error; the rest of the batch still parses", async () => {
    const { root, project } = await world();
    asUser(root);
    const r = await call({ projectId: project.publicId, items: [{ page: 9, bbox: BOX, kind: "notes" }, { page: 2, bbox: BOX, kind: "notes" }] });
    expect(r.status).toBe(200);
    expect(r.body.items[0]).toMatchObject({ page: 9, error: "page-not-found", drawingNumber: null });
    expect(r.body.items[0].result).toBeUndefined();
    expect(r.body.items[1].result.model.kind).toBe("notes");
  });

  it("refuses demo projects, unknown projects, a bad body and the kill switch", async () => {
    const { root, project } = await world({ demo: true });
    asUser(root);
    const item = { page: 2, bbox: BOX, kind: "schedule" };
    let r = await call({ projectId: project.publicId, items: [item] });
    expect(r.status).toBe(403);
    expect(r.body.error.message).toBe("Demo projects are read-only");
    expect((await call({ projectId: "00000000-0000-4000-8000-000000000000", items: [item] })).status).toBe(404);
    expect((await call({ projectId: "not-a-uuid", items: [item] })).status).toBe(404);
    expect((await call({ projectId: project.publicId, items: [] })).status).toBe(400);
    expect((await call({ projectId: project.publicId, items: Array.from({ length: 41 }, () => item) })).status).toBe(400);
    expect((await call({ projectId: project.publicId, items: [{ ...item, budget: "thorough" }] })).status).toBe(400);
    expect((await call({ projectId: project.publicId, items: [{ ...item, bbox: [0.5, 0.5, 0.2, 0.2] }] })).status).toBe(400);
    expect((await call({ projectId: project.publicId, items: [item], companyId: 1 })).status).toBe(400);
    expect((await call({ projectId: project.publicId, items: [{ ...item, bbox: [0.3, 0.3, 0.3, 0.6] }] })).status).toBe(400);
    h.flags = { killSwitch: true };
    r = await call({ projectId: project.publicId, items: [item] });
    expect(r.status).toBe(403);
    expect(r.body.error.message).toBe("The parse engine is switched off");
  });
});
