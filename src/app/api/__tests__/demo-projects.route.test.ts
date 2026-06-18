// @vitest-environment node
// [refactor jun18 P1.4 demo fold] CHARACTERIZATION for GET /api/demo/projects — the public demo gallery
// LIST. No char file existed for it, so this file IS the freeze. Companion to demo-projects-id.route.test.ts
// (the [id] bootstrap, already folded in S017).
//
// FREEZE-FIRST discipline (S016 pilot recipe): the FREEZE commit asserts the CURRENT (legacy) behavior and
// runs GREEN against the legacy bare-async `GET()`. The FOLD commit makes the route a thin
// defineRoute({auth:"none"}) shell delegating to the NEW services/projects.ts `listDemoProjects`, and flips
// ONLY the assertion tagged `// [P1.4 fold]`: an unexpected DB error (legacy had NO try/catch → the handler
// threw/rejected) becomes the shell's leak-free INTERNAL 500. Everything else is preserved byte-for-byte:
//   • the response is a BARE ARRAY (no {data:[]} envelope) → there is NO success-envelope flip;
//   • EXACTLY 5 public fields per item (id, name, numPages, status, thumbnailUrl) — the projection must NEVER
//     leak listProjects's authed-only fields (companyId/companyName/pagesProcessed/dataUrl/isDemo/createdAt);
//   • numPages falsy-coalesces live page count → numPages column → 0 (the N+1 per-project COUNT loop);
//   • thumbnailUrl is non-null ONLY when status==="completed";
//   • the WHERE isDemo=true gate (non-demo rows never appear);
//   • oldest-first ordering (.orderBy(createdAt));
//   • the FULLY PUBLIC posture — no auth() lookup at all (signed-out, owner, cross-company → all 200).
// This route has NO path param and NO body, so the [id] fold's non-uuid→400 and body-shape diffs DO NOT apply.
//
// SHARED-DB NOTE: global-setup migrates ONE database per run and route-test files SHARE it, so other files'
// demo fixtures pollute this GLOBAL (no-tenancy) list. Every assertion is therefore scoped to THIS test's own
// publicIds (filter the response down to them) — never absolute array length, never "empty when none".
import { describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { GET as demoProjectsGET } from "@/app/api/demo/projects/route";
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
import { getS3Url } from "@/lib/s3";

const dbUp = inject("dbUp") as boolean;

const runList = () => demoProjectsGET(makeReq("/api/demo/projects", { method: "GET" }));

/** company + author + a demo project, with control over the project columns. */
async function makeDemoProject(projectOver: Partial<Parameters<typeof createProject>[2]> = {}) {
  const company = await createCompany();
  const author = await createUser(company.id);
  const project = await createProject(company.id, author.id, { isDemo: true, ...projectOver });
  return { company, author, project };
}

/** Filter a bare-array response down to a set of publicIds, preserving response order. */
function only(body: any[], ids: string[]): any[] {
  const set = new Set(ids);
  return body.filter((p) => set.has(p.id));
}

describe.skipIf(!dbUp)("GET /api/demo/projects (demo gallery list)", () => {
  it("200 bare array: each item has EXACTLY 5 fields; numPages = live page count; thumbnailUrl set when completed", async () => {
    // completed project, real page count (3) overrides the numPages column (99)
    const { project: completed } = await makeDemoProject({ status: "completed", numPages: 99 });
    await createPage(completed.id, 1);
    await createPage(completed.id, 2);
    await createPage(completed.id, 3);

    signedOut(); // public — no auth required
    const raw = await runList();
    expect(raw.status).toBe(200);
    expect(raw.headers.get("Cache-Control")).toBeNull(); // legacy sets none — do NOT couple to getProject's header
    const body = await raw.json();
    expect(Array.isArray(body)).toBe(true);

    const mine = only(body, [completed.publicId]);
    expect(mine).toHaveLength(1);
    const item = mine[0];
    // EXACTLY these 5 PUBLIC fields — pinned so the fold can never leak listProjects's authed-only fields.
    expect(Object.keys(item).sort()).toEqual(["id", "name", "numPages", "status", "thumbnailUrl"]);
    expect(item.id).toBe(completed.publicId);
    expect(item.name).toBe(completed.name);
    expect(item.numPages).toBe(3); // live count (3) wins over the numPages column (99)
    expect(item.status).toBe("completed");
    expect(item.thumbnailUrl).toBe(getS3Url(completed.dataUrl, "thumbnail.png"));
  });

  it("200 numPages fallback (no pages → numPages column) and thumbnailUrl null when not completed", async () => {
    const { project: pending } = await makeDemoProject({ status: "processing", numPages: 7 });
    // no pages seeded → pageCounts[id] = 0 (falsy) → falls back to the numPages column (7)
    signedOut();
    const { body } = await readJson(await runList());
    const item = only(body, [pending.publicId])[0];
    expect(item).toBeDefined();
    expect(item.numPages).toBe(7);
    expect(item.status).toBe("processing");
    expect(item.thumbnailUrl).toBeNull(); // non-completed → null
  });

  it("200 numPages terminal `|| 0` fallback: no pages AND numPages column 0 → 0", async () => {
    // DETECTOR completeness (F6): exercise the final `|| 0` — pageCounts[id]=0 (falsy) AND p.numPages=0 (falsy).
    const { project: zero } = await makeDemoProject({ status: "processing", numPages: 0 });
    signedOut();
    const { body } = await readJson(await runList());
    const item = only(body, [zero.publicId])[0];
    expect(item).toBeDefined();
    expect(item.numPages).toBe(0);
  });

  it("excludes non-demo projects (the WHERE isDemo=true gate)", async () => {
    const { project: real } = await createWorld(); // isDemo=false
    const { project: demo } = await makeDemoProject({ status: "completed" });
    signedOut();
    const { body } = await readJson(await runList());
    const ids = body.map((p: any) => p.id);
    expect(ids).toContain(demo.publicId);
    expect(ids).not.toContain(real.publicId); // a non-demo project NEVER appears
  });

  it("oldest-first ordering (.orderBy(createdAt)) — relative order among own projects", async () => {
    const older = (await makeDemoProject({ createdAt: new Date("2020-01-01T00:00:00Z") })).project;
    const newer = (await makeDemoProject({ createdAt: new Date("2020-06-01T00:00:00Z") })).project;
    signedOut();
    const { body } = await readJson(await runList());
    const mineIds = only(body, [older.publicId, newer.publicId]).map((p) => p.id);
    expect(mineIds).toEqual([older.publicId, newer.publicId]); // older precedes newer (ascending createdAt)
  });

  it("fully public: signed-out, the owner, and a cross-company authed user all 200 (no auth lookup at all)", async () => {
    const { author } = await makeDemoProject();
    signedOut();
    expect((await runList()).status).toBe(200);
    asUser(author);
    expect((await runList()).status).toBe(200);
    asUser(await createUser((await createCompany()).id)); // different company → still 200 (demo is public)
    expect((await runList()).status).toBe(200);
  });

  it("unexpected DB error → leak-free INTERNAL 500 (sanctioned diff; legacy had no try/catch → raw throw)", async () => {
    signedOut();
    // [P1.4 fold] was: legacy GET() had NO try/catch, so a throw on the main SELECT rejected the handler.
    // The fold routes it through the shell's outer catch → {code:INTERNAL,message:"Internal server error"}
    // at 500, with the cause logged server-side and NEVER in the response body.
    const spy = vi.spyOn(db, "select").mockImplementationOnce(() => {
      throw new Error("boom SECRET_LEAK_xyz");
    });
    const res = await readJson(await runList());
    expect(res.status).toBe(500);
    expect(res.body.error).toEqual({ code: "INTERNAL", message: "Internal server error" });
    expect(JSON.stringify(res.body)).not.toContain("SECRET_LEAK_xyz"); // underlying cause never leaks
    spy.mockRestore();
  });

  it("DB error in the N+1 COUNT loop ALSO → leak-free INTERNAL 500 (the sanctioned diff covers BOTH throw sites)", async () => {
    // DETECTOR completeness: legacy GET() had NO try/catch ANYWHERE, so a throw in the N+1 db.execute COUNT
    // loop (not just the main SELECT) was ALSO a raw 500. The fold routes BOTH sites through the same shell
    // outer catch → identical leak-free INTERNAL 500. Seed ≥1 demo row so the loop actually runs.
    await makeDemoProject({ status: "completed" });
    signedOut();
    const spy = vi.spyOn(db, "execute").mockImplementationOnce(() => {
      throw new Error("count loop SECRET_LEAK_abc");
    });
    const res = await readJson(await runList());
    expect(res.status).toBe(500);
    expect(res.body.error).toEqual({ code: "INTERNAL", message: "Internal server error" });
    expect(JSON.stringify(res.body)).not.toContain("SECRET_LEAK_abc");
    spy.mockRestore();
  });
});
