// @vitest-environment node
// [refactor jun17 P1.3 family 6/7] CHARACTERIZATION for /api/search (project-scoped) + /api/search/global
// (cross-project), written WITH the migration onto services/search.ts. No P0.3 char file existed for
// search, so this file IS the freeze. Frozen behavior:
//   • /api/search = auth:"none" validate-before-auth: the combined "projectId and q (min 2 chars)
//     required" 400 fires BEFORE the access check (signed-out + bad query → 400, not 401). Access via
//     resolveProjectAccess WITHOUT allowDemo: signed-out demo → 401 (NOT a public read); root admin
//     cross-company → 200 (the engine root-bypasses — the INVERSE of the qto/takeoff-LIST manual lookup).
//   • /api/search/global = auth:"session" auth-FIRST: signed-out → 401 even with missing/valid q; no
//     project resolution, no 404 (cross-company pages just don't match the company_id filter → 200 []).
//   • Sanctioned diffs only: envelope {error:{code,message}} (400 message strings byte-identical);
//     non-uuid projectId → clean 400 (was a pg-uuid-cast 500, /api/search only); no per-route catch.
// tsvector NOTE: pages.search_vector has NO db trigger — every searchable page MUST be populated with
// `UPDATE pages SET search_vector = to_tsvector('english', raw_text)` after insert (see seed() below).
// REVIEW: the cases tagged TG-1/TG-2/TG-3/TG-5, diff-C and TG-root close every finding from the
// adversarial review (wf_206c84fa-b91 = SHIP_WITH_FIXES / 0 code defects — port faithful, gaps only).
import { describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { GET as searchGET } from "@/app/api/search/route";
import { GET as globalGET } from "@/app/api/search/global/route";
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
import { pages } from "@/lib/db/schema";
import { sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import type { TextractPageData } from "@/types";

const dbUp = inject("dbUp") as boolean;

const runSearch = (qs: string) => searchGET(makeReq(`/api/search?${qs}`, { method: "GET" }));
const runGlobal = (qs: string) => globalGET(makeReq(`/api/search/global?${qs}`, { method: "GET" }));

/** Insert a page with raw_text, then populate search_vector (no db trigger exists — see header). */
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

describe.skipIf(!dbUp)("/api/search (project-scoped)", () => {
  it("200 plain mode: happy path w/ stemMatch wordMatches; empty results; null textractData → no matches", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    await seed(project.id, 1, "door schedule concrete wall", {
      textractData: td([
        { text: "DOOR", bbox: [0.1, 0.1, 0.05, 0.02] },
        { text: "SCHEDULE", bbox: [0.2, 0.1, 0.08, 0.02] },
      ]),
    });

    const hit = await readJson(await runSearch(`projectId=${project.publicId}&q=doors`));
    expect(hit.status).toBe(200);
    expect(hit.body.query).toBe("doors");
    expect(hit.body.results).toHaveLength(1);
    const r = hit.body.results[0];
    expect(r.pageNumber).toBe(1);
    expect(r.pageName).toBe("Page 1"); // default stored name
    expect(typeof r.snippet).toBe("string");
    expect(r.snippet).toContain("<mark>"); // ts_headline StartSel preserved
    expect(typeof r.rank).toBe("number");
    // "DOOR" stem-matches "doors" (term.startsWith(w)); "SCHEDULE" does not.
    expect(r.wordMatches).toEqual([{ text: "DOOR", bbox: [0.1, 0.1, 0.05, 0.02] }]);
    expect(r.matchCount).toBe(1); // matchCount === wordMatches.length

    // valid query, no page matches → 200 with empty results
    const { user: u2, project: p2 } = await createWorld();
    asUser(u2);
    await seed(p2.id, 1, "concrete wall");
    const empty = await readJson(await runSearch(`projectId=${p2.publicId}&q=elevator`));
    expect(empty.status).toBe(200);
    expect(empty.body.results).toEqual([]);

    // null textractData → wordMatches [] even though the SQL row matched
    const { user: u3, project: p3 } = await createWorld();
    asUser(u3);
    await seed(p3.id, 1, "door schedule"); // no textractData
    const noTd = await readJson(await runSearch(`projectId=${p3.publicId}&q=door`));
    expect(noTd.status).toBe(200);
    expect(noTd.body.results).toHaveLength(1);
    expect(noTd.body.results[0].wordMatches).toEqual([]);
    expect(noTd.body.results[0].matchCount).toBe(0);
  });

  it("200 multi-page same project: ORDER BY rank DESC + independent per-row mapping (TG-1)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    // page 1 mentions the term once; page 2 many times → higher ts_rank → must sort first under rank DESC
    await seed(project.id, 1, "door window", { textractData: td([{ text: "door", bbox: [0, 0, 0.1, 0.05] }]) });
    await seed(project.id, 2, "door door door door door", {
      textractData: td([{ text: "door", bbox: [0.5, 0, 0.1, 0.05] }]),
    });
    const res = await readJson(await runSearch(`projectId=${project.publicId}&q=door`));
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
    // ORDER BY rank DESC (a removed/altered ORDER BY would put the lower-rank page-1 first → fail)
    expect(res.body.results[0].rank).toBeGreaterThanOrEqual(res.body.results[1].rank);
    expect(res.body.results[0].pageNumber).toBe(2); // higher-frequency page ranks first
    expect(res.body.results[1].pageNumber).toBe(1);
    // each row mapped independently
    expect(res.body.results[0].wordMatches).toEqual([{ text: "door", bbox: [0.5, 0, 0.1, 0.05] }]);
    expect(res.body.results[1].wordMatches).toEqual([{ text: "door", bbox: [0, 0, 0.1, 0.05] }]);
  });

  it("200 plain multi-term: plainto_tsquery AND (one-term page excluded) + any-term highlight over >1 term (TG-2)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    // page 1 has BOTH terms; page 2 only one → plainto_tsquery AND-semantics excludes page 2
    await seed(project.id, 1, "door schedule overview", {
      textractData: td([
        { text: "DOOR", bbox: [0, 0, 0.1, 0.05] },
        { text: "SCHEDULE", bbox: [0.1, 0, 0.1, 0.05] },
        { text: "OVERVIEW", bbox: [0.2, 0, 0.1, 0.05] },
      ]),
    });
    await seed(project.id, 2, "door only");
    const res = await readJson(await runSearch(`projectId=${project.publicId}&q=${encodeURIComponent("door schedule")}`));
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1); // AND: only the page with both terms matches
    expect(res.body.results[0].pageNumber).toBe(1);
    // default branch highlights words matching ANY term (door OR schedule), but NOT OVERVIEW
    const matched = res.body.results[0].wordMatches.map((w: { text: string }) => w.text).sort();
    expect(matched).toEqual(["DOOR", "SCHEDULE"]);
  });

  it("200 exact-phrase mode: quotes preserved in echo (FQ-1); consecutive runs both pushed (FQ-4); out-of-order → zero matches; single-word-quoted falls to default branch (FQ-2)", async () => {
    // consecutive: two in-order runs → 4 pushed words (no dedup)
    const { user, project } = await createWorld();
    asUser(user);
    await seed(project.id, 1, "door schedule and door schedule again", {
      textractData: td([
        { text: "door", bbox: [0, 0, 0.1, 0.05] },
        { text: "schedule", bbox: [0.1, 0, 0.1, 0.05] },
        { text: "door", bbox: [0.2, 0, 0.1, 0.05] },
        { text: "schedule", bbox: [0.3, 0, 0.1, 0.05] },
      ]),
    });
    const phrase = await readJson(await runSearch(`projectId=${project.publicId}&q=${encodeURIComponent('"door schedule"')}`));
    expect(phrase.status).toBe(200);
    expect(phrase.body.query).toBe('"door schedule"'); // FQ-1: surrounding quotes kept
    expect(phrase.body.results[0].wordMatches).toHaveLength(4); // FQ-4: two runs, 4 pushes
    expect(phrase.body.results[0].matchCount).toBe(4);

    // out-of-order: SQL row matches (raw_text has the phrase) but textract words are reversed → no run
    const { user: u2, project: p2 } = await createWorld();
    asUser(u2);
    await seed(p2.id, 1, "door schedule", {
      textractData: td([
        { text: "schedule", bbox: [0, 0, 0.1, 0.05] },
        { text: "door", bbox: [0.1, 0, 0.1, 0.05] },
      ]),
    });
    const ooo = await readJson(await runSearch(`projectId=${p2.publicId}&q=${encodeURIComponent('"door schedule"')}`));
    expect(ooo.status).toBe(200);
    expect(ooo.body.results).toHaveLength(1); // SQL phraseto matched
    expect(ooo.body.results[0].wordMatches).toEqual([]); // no consecutive in-order run
    expect(ooo.body.results[0].matchCount).toBe(0);

    // single-word quoted: isExactPhrase but queryTerms.length===1 → DEFAULT any-term highlight branch
    const { user: u3, project: p3 } = await createWorld();
    asUser(u3);
    await seed(p3.id, 1, "door", { textractData: td([{ text: "DOOR", bbox: [0, 0, 0.1, 0.05] }]) });
    const single = await readJson(await runSearch(`projectId=${p3.publicId}&q=${encodeURIComponent('"door"')}`));
    expect(single.status).toBe(200);
    expect(single.body.query).toBe('"door"');
    expect(single.body.results[0].wordMatches).toEqual([{ text: "DOOR", bbox: [0, 0, 0.1, 0.05] }]);
  });

  it("200 stemMatch quirks: hyphen strip + ORIGINAL text echoed (FQ-3); ≤2-char exact equality; pure-punctuation word (strips to '') excluded (TG-5)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    await seed(project.id, 1, "door-frame", { textractData: td([{ text: "door-frame", bbox: [0, 0, 0.1, 0.05] }]) });
    const hyphen = await readJson(await runSearch(`projectId=${project.publicId}&q=door`));
    expect(hyphen.status).toBe(200);
    // "door-frame" → strip → "doorframe" → startsWith("door") → match; pushed text is the ORIGINAL hyphenated form
    expect(hyphen.body.results[0].wordMatches).toEqual([{ text: "door-frame", bbox: [0, 0, 0.1, 0.05] }]);

    // ≤2-char rule: word "ab" (len 2) requires exact equality with term → excluded; "abcd" prefix-matches "abc"
    const { user: u2, project: p2 } = await createWorld();
    asUser(u2);
    await seed(p2.id, 1, "abc", {
      textractData: td([
        { text: "ab", bbox: [0, 0, 0.1, 0.05] }, // len 2 → exact-equality only → "ab" !== "abc" → excluded
        { text: "abcd", bbox: [0.1, 0, 0.1, 0.05] }, // prefix-matches "abc"
        { text: "---", bbox: [0.2, 0, 0.1, 0.05] }, // strips to "" → stemMatch w.length===0 guard → excluded (TG-5)
      ]),
    });
    const short = await readJson(await runSearch(`projectId=${p2.publicId}&q=abc`));
    expect(short.status).toBe(200);
    // only "abcd" survives — "ab" (≤2-char exact rule) and "---" (empty after strip) are both excluded
    expect(short.body.results[0].wordMatches).toEqual([{ text: "abcd", bbox: [0.1, 0, 0.1, 0.05] }]);
  });

  it("200 pageName fallback: stored name '' → `Page N` template (FQ-6)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    await seed(project.id, 7, "door", { name: "" }); // notNull column → seed '' explicitly
    const res = await readJson(await runSearch(`projectId=${project.publicId}&q=door`));
    expect(res.status).toBe(200);
    expect(res.body.results[0].pageName).toBe("Page 7");
  });

  it("400 validation (combined message, byte-identical): missing q, single-char q, whitespace-only q", async () => {
    const { user, project } = await createWorld();
    asUser(user);

    const missing = await readJson(await runSearch(`projectId=${project.publicId}`));
    expect(missing.status).toBe(400);
    expect(missing.body.error).toEqual({ code: "VALIDATION", message: "projectId and q (min 2 chars) required" });

    const oneChar = await readJson(await runSearch(`projectId=${project.publicId}&q=a`));
    expect(oneChar.status).toBe(400);
    expect(oneChar.body.error.message).toBe("projectId and q (min 2 chars) required");

    const ws = await readJson(await runSearch(`projectId=${project.publicId}&q=${encodeURIComponent("  ")}`));
    expect(ws.status).toBe(400); // trims to "" → !query
    expect(ws.body.error.message).toBe("projectId and q (min 2 chars) required");
  });

  it("validate-before-auth: signed-out + missing q → 400 (NOT 401); non-uuid projectId (fields present) → 400 diff B", async () => {
    const { project } = await createWorld();

    // signed out + missing q: the field 400 fires before resolveProjectOrThrow (would be 401 if access ran first)
    signedOut();
    const sf = await readJson(await runSearch(`projectId=${project.publicId}`));
    expect(sf.status).toBe(400);
    expect(sf.body.error.code).toBe("VALIDATION");

    // non-uuid projectId, valid q → clean 400 (zPublicId; legacy was a pg-uuid-cast 500)
    const { user } = await createWorld();
    asUser(user);
    const bad = await readJson(await runSearch(`projectId=not-a-uuid&q=door`));
    expect(bad.status).toBe(400);
    expect(bad.body.error).toEqual({ code: "VALIDATION", message: "Invalid project id" });

    // diff-B PRECEDENCE (TG-3): non-uuid projectId BUT missing q → the COMBINED field 400 STILL wins,
    // NOT "Invalid project id" — zPublicId sits AFTER the field guard (frozen legacy order, where the
    // combined guard short-circuited before pg ever saw the bad uuid). A reorder would silently flip this.
    const badNoQ = await readJson(await runSearch(`projectId=not-a-uuid`));
    expect(badNoQ.status).toBe(400);
    expect(badNoQ.body.error.message).toBe("projectId and q (min 2 chars) required");
  });

  it("access (no allowDemo): 401 signed-out real; 401 signed-out DEMO (FQ-S5); 404 missing; 404 cross-tenant; 200 root cross-company bypass", async () => {
    const { project } = await createWorld();

    // signed out on a real project (valid uuid) → 401
    signedOut();
    const out = await readJson(await runSearch(`projectId=${project.publicId}&q=door`));
    expect(out.status).toBe(401);
    expect(out.body.error).toEqual({ code: "UNAUTHORIZED", message: "Unauthorized" });

    // signed out on a DEMO project → STILL 401 (allowDemo is NOT passed — demo search is /api/demo/search)
    const company = await createCompany();
    const author = await createUser(company.id);
    const demo = await createProject(company.id, author.id, { isDemo: true, status: "completed" });
    signedOut();
    const demoOut = await readJson(await runSearch(`projectId=${demo.publicId}&q=door`));
    expect(demoOut.status).toBe(401);
    expect(demoOut.body.error.code).toBe("UNAUTHORIZED");

    // missing project (valid uuid, no such row) → 404
    const { user } = await createWorld();
    asUser(user);
    const ghost = await readJson(await runSearch(`projectId=${randomUUID()}&q=door`));
    expect(ghost.status).toBe(404);
    expect(ghost.body.error).toEqual({ code: "NOT_FOUND", message: "Not found" });

    // authed non-root user from a DIFFERENT company → 404 (cross-tenant, no existence leak)
    asUser(await createUser((await createCompany()).id));
    const cross = await readJson(await runSearch(`projectId=${project.publicId}&q=door`));
    expect(cross.status).toBe(404);
    expect(cross.body.error.code).toBe("NOT_FOUND");

    // ROOT admin from a DIFFERENT company → 200 (resolveProjectAccess root-bypasses — INVERSE of qto LIST)
    const { user: owner, project: rootProj } = await createWorld();
    void owner;
    await seed(rootProj.id, 1, "door");
    asUser(await createUser((await createCompany()).id, { isRootAdmin: true, role: "admin" }));
    const rootCross = await readJson(await runSearch(`projectId=${rootProj.publicId}&q=door`));
    expect(rootCross.status).toBe(200);
    expect(rootCross.body.query).toBe("door");
    expect(rootCross.body.results).toHaveLength(1);
  });

  it("sanctioned diff C: an unexpected db error becomes the shell's generic INTERNAL 500 — no leak (both routes)", async () => {
    const { user, project } = await createWorld();
    asUser(user);

    // resolveProjectAccess uses db.select (unaffected); the search query is the next db.execute call.
    const spy = vi.spyOn(db, "execute").mockRejectedValueOnce(new Error("boom SECRET_LEAK_xyz"));
    const proj = await readJson(await runSearch(`projectId=${project.publicId}&q=door`));
    expect(proj.status).toBe(500);
    expect(proj.body.error).toEqual({ code: "INTERNAL", message: "Internal server error" });
    expect(JSON.stringify(proj.body)).not.toContain("SECRET_LEAK_xyz"); // underlying cause never leaks

    spy.mockRejectedValueOnce(new Error("boom SECRET_LEAK_xyz"));
    const glob = await readJson(await runGlobal("q=door"));
    expect(glob.status).toBe(500);
    expect(glob.body.error.code).toBe("INTERNAL");
    expect(JSON.stringify(glob.body)).not.toContain("SECRET_LEAK_xyz");

    spy.mockRestore();
  });
});

describe.skipIf(!dbUp)("/api/search/global (cross-project)", () => {
  it("200 happy: own-company matchCount===pageCount (no DISTINCT); multi-project ordered by match_count DESC; non-matching/zero-page projects absent", async () => {
    const company = await createCompany();
    const user = await createUser(company.id);
    asUser(user);

    // project X: 2 matching pages → match_count 2
    const projX = await createProject(company.id, user.id, { status: "completed" });
    await seed(projX.id, 1, "door schedule");
    await seed(projX.id, 2, "door frame door");
    // project Y: 1 matching page → match_count 1
    const projY = await createProject(company.id, user.id, { status: "completed" });
    await seed(projY.id, 1, "interior door");
    // project Z: completed but NO matching page → must be ABSENT (inner join + filter)
    const projZ = await createProject(company.id, user.id, { status: "completed" });
    await seed(projZ.id, 1, "concrete wall only");

    const res = await readJson(await runGlobal("q=door"));
    expect(res.status).toBe(200);
    expect(res.body.query).toBe("door");
    expect(res.body.results).toHaveLength(2); // Z absent
    // ordered by match_count DESC → X (2) before Y (1)
    expect(res.body.results[0].projectId).toBe(projX.publicId); // public_id uuid STRING, not numeric id
    expect(res.body.results[0].projectName).toBe(projX.name);
    expect(res.body.results[0].matchCount).toBe(2);
    expect(res.body.results[0].pageCount).toBe(2);
    expect(res.body.results[1].projectId).toBe(projY.publicId);
    expect(res.body.results[1].matchCount).toBe(1);
    // QUIRK-G2: matchCount === pageCount for every row (both COUNT(pg.id), no DISTINCT)
    for (const row of res.body.results) expect(row.matchCount).toBe(row.pageCount);
    expect(res.body.results.map((r: { projectId: string }) => r.projectId)).not.toContain(projZ.publicId);
  });

  it("200 filters: status='completed' only; cross-company pages invisible (→ empty, NOT 404); no-match → 200 []", async () => {
    const company = await createCompany();
    const user = await createUser(company.id);
    asUser(user);
    const done = await createProject(company.id, user.id, { status: "completed" });
    const proc = await createProject(company.id, user.id, { status: "processing" });
    await seed(done.id, 1, "door");
    await seed(proc.id, 1, "door"); // matching page but project not completed → excluded
    const filtered = await readJson(await runGlobal("q=door"));
    expect(filtered.status).toBe(200);
    expect(filtered.body.results).toHaveLength(1);
    expect(filtered.body.results[0].projectId).toBe(done.publicId);

    // cross-company isolation: another company's matching page is invisible (empty, no 404)
    const { project: otherProj } = await createWorld();
    await seed(otherProj.id, 1, "door");
    const myCo = await createCompany();
    asUser(await createUser(myCo.id));
    const isolated = await readJson(await runGlobal("q=door"));
    expect(isolated.status).toBe(200);
    expect(isolated.body.results).toEqual([]);

    // authed, company has no matching pages → 200 [] (no tenancy 404 path in global search)
    const none = await readJson(await runGlobal("q=nonexistentterm"));
    expect(none.status).toBe(200);
    expect(none.body.results).toEqual([]);
  });

  it("auth-FIRST: 401 signed-out (even valid q); 401 signed-out + missing q (auth precedes validation)", async () => {
    signedOut();
    const validQ = await readJson(await runGlobal("q=door"));
    expect(validQ.status).toBe(401);
    expect(validQ.body.error).toEqual({ code: "UNAUTHORIZED", message: "Unauthorized" });

    signedOut();
    const missingQ = await readJson(await runGlobal(""));
    expect(missingQ.status).toBe(401); // NOT 400 — auth runs before the q validation
    expect(missingQ.body.error.code).toBe("UNAUTHORIZED");
  });

  it("400 validation (byte-identical message): authed missing q; single-char q; query echo trimmed (QUIRK-G4)", async () => {
    const { user, project } = await createWorld();
    asUser(user);

    const missing = await readJson(await runGlobal(""));
    expect(missing.status).toBe(400);
    expect(missing.body.error).toEqual({ code: "VALIDATION", message: "q (min 2 chars) required" });

    const oneChar = await readJson(await runGlobal("q=a"));
    expect(oneChar.status).toBe(400);
    expect(oneChar.body.error.message).toBe("q (min 2 chars) required");

    // query echo is the TRIMMED value
    await seed(project.id, 1, "door");
    const trimmed = await readJson(await runGlobal(`q=${encodeURIComponent("  door  ")}`));
    expect(trimmed.status).toBe(200);
    expect(trimmed.body.query).toBe("door");
    expect(trimmed.body.results[0].projectId).toBe(project.publicId);
  });

  it("root admin does NOT bypass company scope on global search — inverse of /api/search (TG-root)", async () => {
    // company A has a completed, matching project; the requester is a ROOT admin in company B
    const { project: projA } = await createWorld();
    await seed(projA.id, 1, "door");
    const coB = await createCompany();
    asUser(await createUser(coB.id, { isRootAdmin: true, role: "admin" }));
    const res = await readJson(await runGlobal("q=door"));
    expect(res.status).toBe(200);
    // global binds session.user.companyId with NO root carve-out → company B (no matches) → A absent
    expect(res.body.results).toEqual([]);
  });
});
