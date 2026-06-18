// @vitest-environment node
// [refactor jun17 P1.4 demo fold] CHARACTERIZATION for /api/demo/search — the public demo full-text
// search mirror. No char file existed for it, so this file IS the freeze. P1.4 folds the IN-PROJECT
// branch (projectId present) onto the migrated services/search.ts searchProjectPages (with allowDemo);
// the CROSS-PROJECT gallery branch (no projectId) has no authed twin and is deferred to a later session.
//
// This file now asserts the POST-FOLD behavior. The freeze commit captured the legacy behavior first
// (OLD {error:string} envelope, the in-project 404 for a non-demo/missing project, the non-uuid throw);
// the fold then changed exactly the assertions tagged `// [P1.4 fold]` (each notes its pre-fold value):
// the NEW {error:{code,message}} envelope; the non-uuid uuid-cast throw → clean 400; and the one
// sanctioned STATUS change — signed-out on a NON-DEMO project goes 404 → 401 under allowDemo, because
// resolveProjectAccess's `isDemo && allowDemo` branch is false for a non-demo row → require-auth → 401.
// The demo-specific `q must be 2-200 chars` validation (incl. the >200 cap searchProjectPages lacks) and
// every in-project search quirk (stemMatch, exact-phrase, pageName fallback) are preserved byte-for-byte.
//
// tsvector NOTE (same as search.route.test.ts): pages.search_vector has NO db trigger — every searchable
// page MUST be populated with `UPDATE pages SET search_vector = to_tsvector('english', raw_text)` after
// insert. The demo e2e global-setup does NOT seed search_vector, so these DB-backed cases seed it here.
import { describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { GET as demoSearchGET } from "@/app/api/demo/search/route";
import { GET as searchGET } from "@/app/api/search/route";
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
import { pages, projects } from "@/lib/db/schema";
import { sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import type { TextractPageData } from "@/types";

const dbUp = inject("dbUp") as boolean;

const runDemo = (qs: string) => demoSearchGET(makeReq(`/api/demo/search?${qs}`, { method: "GET" }));

/** Insert a page with raw_text, then populate search_vector (no db trigger — see header). */
async function seed(
  projectId: number,
  pageNumber: number,
  rawText: string,
  over: Partial<typeof pages.$inferInsert> = {},
) {
  const pg = await createPage(projectId, pageNumber, { rawText, ...over });
  await db.execute(sql`UPDATE pages SET search_vector = to_tsvector('english', raw_text) WHERE id = ${pg.id}`);
  return pg;
}

/** Build a minimal valid TextractPageData (the route only ever reads .words). */
function td(words: Array<{ text: string; bbox: [number, number, number, number] }>): TextractPageData {
  return { lines: [], words: words.map((w) => ({ text: w.text, bbox: w.bbox, confidence: 1 })) };
}

/** A completed, isDemo project (the only kind /api/demo/search serves). */
async function createDemoProject(over: Partial<typeof projects.$inferInsert> = {}) {
  const company = await createCompany();
  const author = await createUser(company.id);
  const project = await createProject(company.id, author.id, { isDemo: true, status: "completed", ...over });
  return { company, author, project };
}

// ── IN-PROJECT branch (projectId present) ──────────────────────────────────────────────
describe.skipIf(!dbUp)("/api/demo/search — in-project (projectId)", () => {
  it("200 happy: stemMatch wordMatches + identical body for signed-out / owner / root (no demo-slim fields)", async () => {
    const { author, project } = await createDemoProject();
    await seed(project.id, 1, "door schedule concrete wall", {
      textractData: td([
        { text: "DOOR", bbox: [0.1, 0.1, 0.05, 0.02] },
        { text: "SCHEDULE", bbox: [0.2, 0.1, 0.08, 0.02] },
      ]),
    });

    // signed-out (the typical public-demo caller)
    signedOut();
    const hit = await readJson(await runDemo(`projectId=${project.publicId}&q=doors`));
    expect(hit.status).toBe(200);
    expect(hit.body.query).toBe("doors");
    expect(hit.body.results).toHaveLength(1);
    const r = hit.body.results[0];
    expect(r.pageNumber).toBe(1);
    expect(r.pageName).toBe("Page 1");
    expect(typeof r.snippet).toBe("string");
    expect(r.snippet).toContain("<mark>");
    expect(typeof r.rank).toBe("number");
    expect(r.wordMatches).toEqual([{ text: "DOOR", bbox: [0.1, 0.1, 0.05, 0.02] }]); // "DOOR" stems "doors"
    expect(r.matchCount).toBe(1);

    // owning-company member: legacy did NO auth lookup (200 to anyone); post-fold scope==="member" →
    // IDENTICAL body (search has no demo-slim fields, so scope never alters the payload).
    asUser(author);
    const owner = await readJson(await runDemo(`projectId=${project.publicId}&q=doors`));
    expect(owner.status).toBe(200);
    expect(owner.body.results).toEqual(hit.body.results);

    // root admin from a DIFFERENT company: post-fold scope==="root" → still identical body.
    asUser(await createUser((await createCompany()).id, { isRootAdmin: true, role: "admin" }));
    const root = await readJson(await runDemo(`projectId=${project.publicId}&q=doors`));
    expect(root.status).toBe(200);
    expect(root.body.results).toEqual(hit.body.results);

    // cross-company NON-root authed user on a DEMO project: demo is public → resolveProjectAccess returns
    // their role-scope (member), 200 with the identical body (demo projects have no demo-slim fields).
    asUser(await createUser((await createCompany()).id));
    const crossDemo = await readJson(await runDemo(`projectId=${project.publicId}&q=doors`));
    expect(crossDemo.status).toBe(200);
    expect(crossDemo.body.results).toEqual(hit.body.results);
  });

  it("200 exact-phrase: quotes preserved in echo + consecutive run pushes; single-word-quoted → default branch", async () => {
    const { project } = await createDemoProject();
    signedOut();
    await seed(project.id, 1, "door schedule and door schedule again", {
      textractData: td([
        { text: "door", bbox: [0, 0, 0.1, 0.05] },
        { text: "schedule", bbox: [0.1, 0, 0.1, 0.05] },
        { text: "door", bbox: [0.2, 0, 0.1, 0.05] },
        { text: "schedule", bbox: [0.3, 0, 0.1, 0.05] },
      ]),
    });
    const phrase = await readJson(await runDemo(`projectId=${project.publicId}&q=${encodeURIComponent('"door schedule"')}`));
    expect(phrase.status).toBe(200);
    expect(phrase.body.query).toBe('"door schedule"'); // surrounding quotes kept in echo
    expect(phrase.body.results[0].wordMatches).toHaveLength(4); // two consecutive runs, 4 pushes (no dedup)
    expect(phrase.body.results[0].matchCount).toBe(4);

    const { project: p2 } = await createDemoProject();
    await seed(p2.id, 1, "door", { textractData: td([{ text: "DOOR", bbox: [0, 0, 0.1, 0.05] }]) });
    const single = await readJson(await runDemo(`projectId=${p2.publicId}&q=${encodeURIComponent('"door"')}`));
    expect(single.status).toBe(200);
    expect(single.body.query).toBe('"door"');
    expect(single.body.results[0].wordMatches).toEqual([{ text: "DOOR", bbox: [0, 0, 0.1, 0.05] }]); // default branch
  });

  it("200 stemMatch quirks (proves the local copy == the exported one after the fold): hyphen strip + ORIGINAL echo; ≤2-char exact; empty-strip excluded", async () => {
    const { project } = await createDemoProject();
    signedOut();
    await seed(project.id, 1, "door-frame", { textractData: td([{ text: "door-frame", bbox: [0, 0, 0.1, 0.05] }]) });
    const hyphen = await readJson(await runDemo(`projectId=${project.publicId}&q=door`));
    expect(hyphen.status).toBe(200);
    expect(hyphen.body.results[0].wordMatches).toEqual([{ text: "door-frame", bbox: [0, 0, 0.1, 0.05] }]);

    const { project: p2 } = await createDemoProject();
    await seed(p2.id, 1, "abc", {
      textractData: td([
        { text: "ab", bbox: [0, 0, 0.1, 0.05] }, // len 2 → exact-equality only → excluded
        { text: "abcd", bbox: [0.1, 0, 0.1, 0.05] }, // prefix-matches "abc"
        { text: "---", bbox: [0.2, 0, 0.1, 0.05] }, // strips to "" → excluded
      ]),
    });
    const short = await readJson(await runDemo(`projectId=${p2.publicId}&q=abc`));
    expect(short.status).toBe(200);
    expect(short.body.results[0].wordMatches).toEqual([{ text: "abcd", bbox: [0.1, 0, 0.1, 0.05] }]);
  });

  it("200 pageName fallback: stored name '' → `Page N`; empty results when no SQL match", async () => {
    const { project } = await createDemoProject();
    signedOut();
    await seed(project.id, 7, "door", { name: "" });
    const named = await readJson(await runDemo(`projectId=${project.publicId}&q=door`));
    expect(named.status).toBe(200);
    expect(named.body.results[0].pageName).toBe("Page 7");

    const { project: p2 } = await createDemoProject();
    await seed(p2.id, 1, "concrete wall");
    const empty = await readJson(await runDemo(`projectId=${p2.publicId}&q=elevator`));
    expect(empty.status).toBe(200);
    expect(empty.body.results).toEqual([]);
  });

  it("400 validation `q must be 2-200 chars` (demo-specific, incl. the >200 cap searchProjectPages lacks)", async () => {
    const { project } = await createDemoProject();
    signedOut();

    const missing = await readJson(await runDemo(`projectId=${project.publicId}`));
    expect(missing.status).toBe(400);
    expect(missing.body.error).toEqual({ code: "VALIDATION", message: "q must be 2-200 chars" }); // [P1.4 fold] was: "q must be 2-200 chars" (string envelope)

    const oneChar = await readJson(await runDemo(`projectId=${project.publicId}&q=a`));
    expect(oneChar.status).toBe(400);

    const ws = await readJson(await runDemo(`projectId=${project.publicId}&q=${encodeURIComponent("  ")}`));
    expect(ws.status).toBe(400); // trims to "" → falsy

    // the >200 cap is UNIQUE to demo (searchProjectPages has no upper bound) — must survive the fold
    const tooLong = await readJson(await runDemo(`projectId=${project.publicId}&q=${"a".repeat(201)}`));
    expect(tooLong.status).toBe(400);
  });

  it("404 missing row (stable across fold); 404 NON-DEMO project signed-out [P1.4 fold → 401]", async () => {
    signedOut();

    // valid uuid, no such project → 404 both pre- and post-fold (resolveProjectAccess 404s before isDemo)
    const ghost = await readJson(await runDemo(`projectId=${randomUUID()}&q=door`));
    expect(ghost.status).toBe(404);
    expect(ghost.body.error).toEqual({ code: "NOT_FOUND", message: "Not found" }); // [P1.4 fold] was: "Not found" (string envelope)

    // a NON-DEMO project: legacy `WHERE isDemo=true` → no row → 404. [P1.4 fold] under allowDemo a
    // non-demo row falls through resolveProjectAccess's require-auth branch → signed-out → 401. (Demo
    // projects are unaffected: they 200. This is the demo fold's lone sanctioned status change.)
    const { project: realProj } = await createWorld(); // isDemo=false
    const nonDemo = await readJson(await runDemo(`projectId=${realProj.publicId}&q=door`));
    expect(nonDemo.status).toBe(401); // [P1.4 fold] was 404 (legacy WHERE isDemo=true → no row)
    expect(nonDemo.body.error).toEqual({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  it("NON-DEMO project, AUTHED: owner/root 404→200 [P1.4 fold benign divergence] = byte-identical to /api/search; cross-company non-root still 404", async () => {
    // legacy `WHERE isDemo=true` → 404 for EVERY caller on a non-demo project (no auth() lookup at all).
    // Post-fold, allowDemo only rescues isDemo rows, so a non-demo row falls through resolveProjectAccess's
    // standard require-auth path: signed-out → 401 (above), but an authed OWNER / ROOT resolves their real
    // access → 200. Benign + UNREACHABLE in practice (useSearch only sends a projectId when isDemo===true),
    // locked here so the sanctioned-diff set is provably complete: the demo route delegates to the SAME
    // searchProjectPages, so its body is byte-identical to /api/search for these callers.
    const { user: owner, project: realProj } = await createWorld(); // isDemo=false
    await seed(realProj.id, 1, "door schedule", { textractData: td([{ text: "DOOR", bbox: [0, 0, 0.1, 0.05] }]) });

    asUser(owner);
    const viaDemo = await readJson(await runDemo(`projectId=${realProj.publicId}&q=door`));
    const viaMain = await readJson(await searchGET(makeReq(`/api/search?projectId=${realProj.publicId}&q=door`, { method: "GET" })));
    expect(viaDemo.status).toBe(200); // [P1.4 fold] was 404 (legacy isDemo=true filter)
    expect(viaMain.status).toBe(200);
    expect(viaDemo.body).toEqual(viaMain.body); // delegates to the same service → identical body

    // root admin from a DIFFERENT company → also 200 (resolveProjectAccess root-bypass)
    asUser(await createUser((await createCompany()).id, { isRootAdmin: true, role: "admin" }));
    const root = await readJson(await runDemo(`projectId=${realProj.publicId}&q=door`));
    expect(root.status).toBe(200);

    // cross-company NON-root authed → STILL 404 (tenancy invariant preserved on the mirror; no leak)
    asUser(await createUser((await createCompany()).id));
    const cross = await readJson(await runDemo(`projectId=${realProj.publicId}&q=door`));
    expect(cross.status).toBe(404);
    expect(cross.body.error).toEqual({ code: "NOT_FOUND", message: "Not found" });
  });

  it("non-uuid projectId → clean 400 (sanctioned diff B; legacy was an unhandled pg uuid-cast throw)", async () => {
    signedOut();
    const bad = await readJson(await runDemo(`projectId=not-a-uuid&q=door`));
    expect(bad.status).toBe(400);
    expect(bad.body.error).toEqual({ code: "VALIDATION", message: "Invalid project id" });
    // [P1.4 fold] was: an unhandled throw (raw non-uuid fed to the pg uuid column, no try/catch)

    // diff-B precedence: non-uuid projectId BUT missing q → the demo q-400 STILL wins (q validated first,
    // before the projectId branch → searchProjectPages' zPublicId is never reached)
    const badNoQ = await readJson(await runDemo(`projectId=not-a-uuid`));
    expect(badNoQ.status).toBe(400);
    expect(badNoQ.body.error).toEqual({ code: "VALIDATION", message: "q must be 2-200 chars" });
  });
});

// ── CROSS-PROJECT gallery branch (no projectId) — frozen now; folds in a later session ─────────
describe.skipIf(!dbUp)("/api/demo/search — cross-project gallery (no projectId)", () => {
  it("200 aggregates demo+completed projects; ordered by match_count DESC; pageCount vs matchCount", async () => {
    // NOTE: a UNIQUE tag in the query term keeps this test isolated from other demo projects in the
    // shared DB (the gallery query is cross-project over ALL is_demo+completed rows).
    const term = `zql${randomUUID().slice(0, 6)}`;
    const { project: projX } = await createDemoProject();
    await seed(projX.id, 1, `alpha ${term} one`);
    await seed(projX.id, 2, `beta ${term} ${term} two`);
    const { project: projY } = await createDemoProject();
    await seed(projY.id, 1, `gamma ${term} three`);

    signedOut();
    const res = await readJson(await runDemo(`q=${term}`));
    expect(res.status).toBe(200);
    expect(res.body.query).toBe(term);
    const byId: Record<string, any> = {};
    for (const row of res.body.results) byId[row.projectId] = row;
    expect(byId[projX.publicId]).toBeDefined();
    expect(byId[projY.publicId]).toBeDefined();
    // projX has 2 matching pages, projY 1 → X ordered before Y (match_count DESC)
    const xi = res.body.results.findIndex((r: any) => r.projectId === projX.publicId);
    const yi = res.body.results.findIndex((r: any) => r.projectId === projY.publicId);
    expect(xi).toBeLessThan(yi);
    expect(byId[projX.publicId].matchCount).toBe(2);
    expect(byId[projX.publicId].pageCount).toBe(2);
    expect(byId[projY.publicId].matchCount).toBe(1);
    expect(byId[projX.publicId].projectName).toBe(projX.name);
    // COUNT(DISTINCT pg.id) vs COUNT(pg.id): pg.id is unique per joined row → equal (DISTINCT a no-op here)
    for (const row of res.body.results) expect(row.pageCount).toBe(row.matchCount);
  });

  it("excludes non-demo and non-completed projects", async () => {
    const term = `zql${randomUUID().slice(0, 6)}`;
    // a non-demo project with a matching page
    const { project: realProj } = await createWorld();
    await seed(realProj.id, 1, `wall ${term} real`);
    // a demo-but-processing project with a matching page
    const { project: procProj } = await createDemoProject({ status: "processing" });
    await seed(procProj.id, 1, `wall ${term} processing`);
    // a demo+completed project with a matching page (the only one that should appear)
    const { project: okProj } = await createDemoProject();
    await seed(okProj.id, 1, `wall ${term} ok`);

    signedOut();
    const res = await readJson(await runDemo(`q=${term}`));
    expect(res.status).toBe(200);
    const ids = res.body.results.map((r: any) => r.projectId);
    expect(ids).toContain(okProj.publicId);
    expect(ids).not.toContain(realProj.publicId);
    expect(ids).not.toContain(procProj.publicId);
  });

  it("400 validation also fires for the gallery branch (q checked before the projectId branch)", async () => {
    signedOut();
    const missing = await readJson(await runDemo(``));
    expect(missing.status).toBe(400);
    expect(missing.body.error).toEqual({ code: "VALIDATION", message: "q must be 2-200 chars" }); // [P1.4 fold] was: string envelope

    const noMatch = await readJson(await runDemo(`q=${randomUUID().slice(0, 8)}zznomatch`));
    expect(noMatch.status).toBe(200);
    expect(noMatch.body.results).toEqual([]);
  });
});
