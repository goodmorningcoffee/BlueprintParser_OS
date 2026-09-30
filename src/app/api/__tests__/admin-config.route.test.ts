// @vitest-environment node
// [refactor jul6 S037] CHARACTERIZATION for the ADMIN B1 config batch — the 6 company-jsonb
// config clones (demo/config · pipeline · llm/config · csi/config · text-annotations/config ·
// heuristics/config), written as THE FREEZE before the fold onto services/company-settings.ts.
// admin/toggles was EVICTED from B1 at STEP-0 recon (S3 app-global storage + independent
// password subsystem — not a pipelineConfig clone; solo fold later).
//
// Per DR003's B1 plan these are PER-ROUTE cases (never parameterized) — each route pins its
// auth gate, error literals byte-verbatim, read shape, write MERGE semantics, and jsonb key.
// Common skeleton (all 6): requireAdmin → select pipelineConfig by session companyId →
// GET returns a key slice / PUT spread-merges AT TOP LEVEL {...existing, <key>: <value>}.
// Frozen quirk inventory:
//   • AUTH: 401 flat {error:"Unauthorized"} / 403 flat {error:"Admin only"}; root-admin
//     (isRootAdmin, role member) passes. EXCEPTION — heuristics GET swallows BOTH error
//     classes and answers 200 with the built-in-rules fallback (deliberate demo-safe read).
//   • WRITE (H6/G3 hazard class, checked at recon): ALL 6 spread-merge at the top level —
//     sibling top-level keys ALWAYS survive; each route whole-replaces its OWN key.
//     text-annotations additionally REBUILDS its subkey ({enabledDetectors} only — sibling
//     SUBkeys dropped); heuristics writes TWO keys conditionally (heuristics if isArray,
//     pageNaming if TRUTHY — null/false skipped). updatedAt SPLIT: heuristics +
//     text-annotations touch companies.updatedAt; csi/demo/pipeline/llm do NOT.
//   • csi PUT has NO validation — the raw JSON body IS the csi value (scalars/null accepted
//     and WRITTEN). Empty/malformed bodies: req.json() throws and legacy PROPAGATES (Next
//     500). At fold csi keeps accept-anything via a z.unknown() body (NOT zLooseBody).
//   • Legacy PUT order = auth THEN body-parse: signed-out + malformed body → 401. The shell
//     parses the raw body FIRST → those flip to 400 BAD_REQUEST "Invalid JSON body" pre-auth
//     (PR-D5(a) systemic sanctioned trait); authed empty/non-object bodies on zLooseBody
//     routes flip legacy throw-500 / route-literal-400 → 400 VALIDATION (PR-D5(c), S032
//     precedent). csi GET stats + llm GET defaultDomainKnowledge are computed against the
//     repo data files with the same algorithm (independent oracle, pins fold parity).
// Assertions tagged [S037 fold: … applied] were flipped in the fold commit onto
// services/company-settings.ts (sanctioned A/E only; this batch had no B-class leaks).
import { describe, expect, inject, it, beforeEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { GET as demoGET, PUT as demoPUT } from "@/app/api/admin/demo/config/route";
import { GET as pipeGET, PUT as pipePUT } from "@/app/api/admin/pipeline/route";
import { GET as llmGET, PUT as llmPUT } from "@/app/api/admin/llm/config/route";
import { GET as csiGET, PUT as csiPUT } from "@/app/api/admin/csi/config/route";
import { GET as taGET, PUT as taPUT } from "@/app/api/admin/text-annotations/config/route";
import { GET as heuGET, PUT as heuPUT } from "@/app/api/admin/heuristics/config/route";
import { getAllDetectorMeta } from "@/lib/detectors/registry";
import { BUILT_IN_RULES } from "@/lib/heuristic-engine";
import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  asUser,
  createCompany,
  createUser,
  makeReq,
  readJson,
  signedOut,
  type FixtureUser,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

// Multi-key seed so every write test can prove sibling top-level keys survive the merge.
// __sentinel is an unknown key (outside the typed union) — the spread must carry it too.
const SEED = {
  csi: { matchingConfidenceThreshold: 0.42 },
  demo: { enabled: true, maxProjects: 2 },
  pipeline: { legacyKnob: "on" },
  llm: { context: "legacy ctx" },
  heuristics: [{ id: "h1", name: "Rule 1" }],
  pageNaming: { enabled: true, yoloSources: ["door"] },
  textAnnotation: { enabledDetectors: ["__seeded__"], futureKnob: true },
  __sentinel: { keep: "me" },
} as const;

async function makeWorld(pipelineConfig: unknown = SEED) {
  const company = await createCompany({ pipelineConfig: pipelineConfig as never });
  const admin = await createUser(company.id, { role: "admin" });
  const member = await createUser(company.id); // role defaults to "member"
  return { company, admin, member };
}

/** Raw row read-back: the merge-semantics oracle. */
async function rowOf(companyId: number) {
  const [row] = await db
    .select({ pc: companies.pipelineConfig, updatedAt: companies.updatedAt })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  return { pc: row.pc as Record<string, unknown> | null, updatedAt: row.updatedAt as Date };
}

/** Request with a RAW (possibly malformed / absent) body — bypasses makeReq's stringify. */
function rawPut(path: string, raw?: string): Request {
  return new Request(`http://test.local${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: raw,
  });
}

const get = async (fn: (req: Request) => Promise<Response>, path: string) =>
  readJson(await fn(makeReq(path, { method: "GET" })));
const put = async (fn: (req: Request) => Promise<Response>, path: string, body: unknown) =>
  readJson(await fn(makeReq(path, { method: "PUT", body })));

const UNAUTH = { error: { code: "UNAUTHORIZED", message: "Unauthorized" } }; // [S037 fold: A applied]
const ADMIN_ONLY = { error: { code: "FORBIDDEN", message: "Admin only" } }; // [S037 fold: A applied]

beforeEach(() => signedOut());

// ── demo/config — key `demo` ─────────────────────────────────────────────────
describe.skipIf(!dbUp)("admin/demo/config (DEMO)", () => {
  it("DEMO-1 auth gate: GET signed-out → flat 401; member → flat 403; root-admin passes", async () => {
    const { company, member } = await makeWorld();
    let r = await get(demoGET, "/api/admin/demo/config");
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S037 fold: A applied]
    asUser(member);
    r = await get(demoGET, "/api/admin/demo/config");
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ADMIN_ONLY); // [S037 fold: A applied]
    // isRootAdmin bypasses the role check (requireAdmin quirk shared by all 6)
    const root = await createUser(company.id, { isRootAdmin: true });
    asUser(root);
    r = await get(demoGET, "/api/admin/demo/config");
    expect(r.status).toBe(200);
  });

  it("DEMO-2 read shape: {demo: slice}; empty config → {demo:{}}", async () => {
    const { admin } = await makeWorld();
    asUser(admin);
    let r = await get(demoGET, "/api/admin/demo/config");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ demo: SEED.demo });
    const bare = await makeWorld(null);
    asUser(bare.admin);
    r = await get(demoGET, "/api/admin/demo/config");
    expect(r.body).toEqual({ demo: {} });
  });

  it("DEMO-3 write: whole-replaces `demo`, siblings survive, updatedAt UNTOUCHED", async () => {
    const { company, admin } = await makeWorld();
    const before = await rowOf(company.id);
    asUser(admin);
    const next = { enabled: false, banner: "hi" };
    const r = await put(demoPUT, "/api/admin/demo/config", { demo: next });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true });
    const after = await rowOf(company.id);
    expect(after.pc?.demo).toEqual(next); // replaced whole (maxProjects gone)
    expect(after.pc?.csi).toEqual(SEED.csi); // siblings intact
    expect(after.pc?.__sentinel).toEqual(SEED.__sentinel); // unknown key survives the spread
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime()); // NOT touched
  });

  it("DEMO-4 PUT validation literal: missing/non-object/null demo → flat 400", async () => {
    const { admin } = await makeWorld();
    asUser(admin);
    for (const body of [{}, { demo: "x" }, { demo: null }, { demo: 5 }]) {
      const r = await put(demoPUT, "/api/admin/demo/config", body);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: { code: "VALIDATION", message: "demo object required" } }); // [S037 fold: A applied]
    }
  });

  it("DEMO-5 PUT parse-before-auth ordering + body-shape edges (PR-D5 systemic pins)", async () => {
    const { company, admin } = await makeWorld();
    // signed-out + malformed body: legacy authed FIRST (401); the S037 shell parsed the raw
    // body first (400). // [hardening sep30] REVERSED on purpose: routes whose auth needs no body now authenticate
    // FIRST, so a signed-out caller never makes the server read or parse a body → 401 here.
    let r = await readJson(await demoPUT(rawPut("/api/admin/demo/config", "{oops")));
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } });
    asUser(admin);
    // authed + malformed / empty: legacy req.json() threw and PROPAGATED (Next-level 500)
    // [S037 fold: E applied — malformed → 400 BAD_REQUEST; empty → 400 VALIDATION generic]
    r = await readJson(await demoPUT(rawPut("/api/admin/demo/config", "{oops")));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: { code: "BAD_REQUEST", message: "Invalid JSON body" } });
    r = await readJson(await demoPUT(rawPut("/api/admin/demo/config", undefined)));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("VALIDATION");
    // authed + well-formed NON-OBJECT body: legacy destructured to undefined → route literal
    // 400. [S037 fold: E applied — zLooseBody rejects → 400 VALIDATION, generic zod message]
    for (const raw of ["5", "[1,2]"]) {
      r = await readJson(await demoPUT(rawPut("/api/admin/demo/config", raw)));
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("VALIDATION"); // [S037 fold: E applied — message drifted]
    }
    const after = await rowOf(company.id);
    expect(after.pc?.demo).toEqual(SEED.demo); // none of the above wrote
  });
});

// ── pipeline — key `pipeline` ────────────────────────────────────────────────
describe.skipIf(!dbUp)("admin/pipeline (PIPE)", () => {
  it("PIPE-1 auth gate: GET 401/403 flat; PUT signed-out 401", async () => {
    const { member } = await makeWorld();
    let r = await get(pipeGET, "/api/admin/pipeline");
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S037 fold: A applied]
    asUser(member);
    r = await get(pipeGET, "/api/admin/pipeline");
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ADMIN_ONLY); // [S037 fold: A applied]
    signedOut();
    r = await put(pipePUT, "/api/admin/pipeline", { pipeline: {} });
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S037 fold: A applied]
  });

  it("PIPE-2 read shape: {pipeline: slice}; empty config → {pipeline:{}}", async () => {
    const { admin } = await makeWorld();
    asUser(admin);
    let r = await get(pipeGET, "/api/admin/pipeline");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ pipeline: SEED.pipeline });
    const bare = await makeWorld(null);
    asUser(bare.admin);
    r = await get(pipeGET, "/api/admin/pipeline");
    expect(r.body).toEqual({ pipeline: {} });
  });

  it("PIPE-3 write: whole-replaces `pipeline`, siblings survive, updatedAt UNTOUCHED", async () => {
    const { company, admin } = await makeWorld();
    const before = await rowOf(company.id);
    asUser(admin);
    const r = await put(pipePUT, "/api/admin/pipeline", { pipeline: { ocr: false } });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true });
    const after = await rowOf(company.id);
    expect(after.pc?.pipeline).toEqual({ ocr: false });
    expect(after.pc?.demo).toEqual(SEED.demo);
    expect(after.pc?.__sentinel).toEqual(SEED.__sentinel);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it("PIPE-4 PUT validation literal", async () => {
    const { admin } = await makeWorld();
    asUser(admin);
    for (const body of [{}, { pipeline: "x" }, { pipeline: null }]) {
      const r = await put(pipePUT, "/api/admin/pipeline", body);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: { code: "VALIDATION", message: "pipeline object required" } }); // [S037 fold: A applied]
    }
  });
});

// ── llm/config — key `llm` ───────────────────────────────────────────────────
describe.skipIf(!dbUp)("admin/llm/config (LLM)", () => {
  it("LLM-1 auth gate: GET 401/403 flat", async () => {
    const { member } = await makeWorld();
    let r = await get(llmGET, "/api/admin/llm/config");
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S037 fold: A applied]
    asUser(member);
    r = await get(llmGET, "/api/admin/llm/config");
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ADMIN_ONLY); // [S037 fold: A applied]
  });

  it("LLM-2 read shape: {llm: slice, defaultDomainKnowledge: <file>} — byte-pinned to the repo file", async () => {
    const { admin } = await makeWorld();
    asUser(admin);
    const expected = readFileSync(join(process.cwd(), "src/data/domain-knowledge.md"), "utf-8");
    let r = await get(llmGET, "/api/admin/llm/config");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ llm: SEED.llm, defaultDomainKnowledge: expected });
    const bare = await makeWorld(null);
    asUser(bare.admin);
    r = await get(llmGET, "/api/admin/llm/config");
    expect(r.body.llm).toEqual({});
  });

  it("LLM-3 write: whole-replaces `llm`, siblings survive, updatedAt UNTOUCHED", async () => {
    const { company, admin } = await makeWorld();
    const before = await rowOf(company.id);
    asUser(admin);
    const r = await put(llmPUT, "/api/admin/llm/config", { llm: { context: "new" } });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true });
    const after = await rowOf(company.id);
    expect(after.pc?.llm).toEqual({ context: "new" });
    expect(after.pc?.heuristics).toEqual(SEED.heuristics);
    expect(after.pc?.__sentinel).toEqual(SEED.__sentinel);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it("LLM-4 PUT validation literal", async () => {
    const { admin } = await makeWorld();
    asUser(admin);
    for (const body of [{}, { llm: 7 }, { llm: null }]) {
      const r = await put(llmPUT, "/api/admin/llm/config", body);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: { code: "VALIDATION", message: "llm config object required" } }); // [S037 fold: A applied]
    }
  });
});

// ── csi/config — key `csi` (the NO-VALIDATION deviant) ───────────────────────
describe.skipIf(!dbUp)("admin/csi/config (CSI)", () => {
  it("CSI-1 auth gate: GET 401/403 flat; PUT signed-out 401", async () => {
    const { member } = await makeWorld();
    let r = await get(csiGET, "/api/admin/csi/config");
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S037 fold: A applied]
    asUser(member);
    r = await get(csiGET, "/api/admin/csi/config");
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ADMIN_ONLY); // [S037 fold: A applied]
    signedOut();
    r = await put(csiPUT, "/api/admin/csi/config", { any: 1 });
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S037 fold: A applied]
  });

  it("CSI-2 read shape: {config, stats} — TSV stats pinned by independent recomputation", async () => {
    const { admin } = await makeWorld();
    asUser(admin);
    // same algorithm as the route, computed against the SAME repo file — the fold must
    // reproduce these numbers exactly (independent oracle, not a tautology once folded)
    const lines = readFileSync(join(process.cwd(), "src/data/csi-masterformat.tsv"), "utf-8")
      .split("\n")
      .filter((l) => l.trim());
    const totalCodes = Math.max(0, lines.length - 1);
    const divisions = new Set(
      lines.slice(1).map((l) => (l.split("\t")[0] || "").substring(0, 2)).filter((c) => c.length >= 2),
    ).size;
    const r = await get(csiGET, "/api/admin/csi/config");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      config: SEED.csi,
      stats: { totalCodes, divisions, source: "Built-in MasterFormat 2018+2016" },
    });
    expect(totalCodes).toBeGreaterThan(0); // guard: the oracle actually read the file
  });

  it("CSI-3 read: customDatabaseName flips `source`; missing codes count → '?'", async () => {
    const w1 = await makeWorld({ csi: { customDatabaseName: "MyDB", customDatabaseCodes: 42 } });
    asUser(w1.admin);
    let r = await get(csiGET, "/api/admin/csi/config");
    expect(r.body.stats.source).toBe("Custom: MyDB (42 codes)");
    const w2 = await makeWorld({ csi: { customDatabaseName: "MyDB" } });
    asUser(w2.admin);
    r = await get(csiGET, "/api/admin/csi/config");
    expect(r.body.stats.source).toBe("Custom: MyDB (? codes)");
  });

  // [refactor jul9 P2-A C1] CSI-4/CSI-5 REWRITE — [C1 approval 2026-07-09; supersedes the
  // S037 keep-z.unknown accept-anything decision]. PUT is now zCsiConfigPut-validated at the
  // shell: known keys typed & stored, unknown keys STRIPPED, non-positive threshold rejected
  // (D-15/I-10), the custom-DB pointer triple server-preserved (D-5). Ledger D-3/D-4/D-5/D-15.
  it("CSI-4 write: zod-validated — object stored, scalar/null/array 400 (was stored), unknown keys stripped, threshold guarded; siblings survive; updatedAt UNTOUCHED [C1 approval 2026-07-09]", async () => {
    const { company, admin } = await makeWorld();
    const before = await rowOf(company.id);
    asUser(admin);
    // scalar / null / array bodies now 400 VALIDATION (reverses the S037 accept-anything, D-3); NO write
    for (const raw of ["5", "null", "[1,2]"]) {
      const r = await readJson(await csiPUT(rawPut("/api/admin/csi/config", raw)));
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("VALIDATION");
      expect((await rowOf(company.id)).pc?.csi).toEqual(SEED.csi); // untouched
    }
    // arbitrary UNKNOWN-keys object → 200 {success:true}; all keys stripped → stored csi = {}
    // (CsiTab.tsx:78-92 depends on the 200; replace semantics wipe the old SEED threshold)
    let r = await put(csiPUT, "/api/admin/csi/config", { anything: 1, nested: { a: [1] } });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true });
    expect((await rowOf(company.id)).pc?.csi).toEqual({});
    // valid partial → stored
    r = await put(csiPUT, "/api/admin/csi/config", { matchingConfidenceThreshold: 0.7 });
    expect(r.status).toBe(200);
    expect((await rowOf(company.id)).pc?.csi).toEqual({ matchingConfidenceThreshold: 0.7 });
    // non-positive threshold rejected (D-15): 0 and -1 → 400, no write (last valid value stands)
    for (const bad of [{ matchingConfidenceThreshold: 0 }, { matchingConfidenceThreshold: -1 }]) {
      r = await put(csiPUT, "/api/admin/csi/config", bad);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("VALIDATION");
    }
    expect((await rowOf(company.id)).pc?.csi).toEqual({ matchingConfidenceThreshold: 0.7 });
    // unknown key alongside nothing valid → stored WITHOUT the unknown key
    r = await put(csiPUT, "/api/admin/csi/config", { zzz: 1 });
    expect(r.status).toBe(200);
    expect((await rowOf(company.id)).pc?.csi).toEqual({});
    // client-sent customDatabaseS3Key is IGNORED (stripped — upload route owns it, I-7 belt, D-5)
    r = await put(csiPUT, "/api/admin/csi/config", {
      matchingConfidenceThreshold: 0.6,
      customDatabaseS3Key: "csi-databases/company-999/x.tsv",
    });
    expect(r.status).toBe(200);
    const stored = (await rowOf(company.id)).pc?.csi as Record<string, unknown>;
    expect(stored).toEqual({ matchingConfidenceThreshold: 0.6 }); // no injected pointer
    // siblings + updatedAt survive every write above (csi does NOT touch updatedAt)
    const after = await rowOf(company.id);
    expect(after.pc?.demo).toEqual(SEED.demo);
    expect(after.pc?.__sentinel).toEqual(SEED.__sentinel);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it("CSI-4b custom-DB pointer TRIPLE is server-preserved across a threshold save (client body cannot wipe or inject it) [C1 approval 2026-07-09]", async () => {
    const { company, admin } = await makeWorld({
      csi: { customDatabaseS3Key: "csi-databases/company-1/custom-csi.tsv", customDatabaseName: "MyDB", customDatabaseCodes: 99 },
      demo: SEED.demo,
      __sentinel: SEED.__sentinel,
    });
    asUser(admin);
    // client sends ONLY a threshold (the CsiTab send-everything contract minus the triple) →
    // triple re-attached verbatim by putCsiConfig; threshold applied
    const r = await put(csiPUT, "/api/admin/csi/config", { matchingConfidenceThreshold: 0.5 });
    expect(r.status).toBe(200);
    expect((await rowOf(company.id)).pc?.csi).toEqual({
      matchingConfidenceThreshold: 0.5,
      customDatabaseS3Key: "csi-databases/company-1/custom-csi.tsv",
      customDatabaseName: "MyDB",
      customDatabaseCodes: 99,
    });
    expect((await rowOf(company.id)).pc?.__sentinel).toEqual(SEED.__sentinel); // top-level sibling survives
  });

  it("CSI-5 write edges: malformed body → 400 BAD_REQUEST; empty body → 400 VALIDATION (was 500); nothing written [C1 approval 2026-07-09; supersedes S037]", async () => {
    const { company, admin } = await makeWorld();
    asUser(admin);
    // malformed JSON → shell BAD_REQUEST at parse (step 1, before/independent of auth)
    let r = await readJson(await csiPUT(rawPut("/api/admin/csi/config", "{oops")));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: { code: "BAD_REQUEST", message: "Invalid JSON body" } });
    // empty body → z.object rejects undefined → 400 VALIDATION (was in-service plain-Error 500)
    r = await readJson(await csiPUT(rawPut("/api/admin/csi/config", undefined)));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("VALIDATION");
    expect((await rowOf(company.id)).pc?.csi).toEqual(SEED.csi); // untouched
  });
});

// ── text-annotations/config — key `textAnnotation` (registry-validated) ──────
describe.skipIf(!dbUp)("admin/text-annotations/config (TA)", () => {
  const meta = getAllDetectorMeta();
  const validId = meta[0].id;
  const defaultIds = meta.filter((d) => d.defaultEnabled).map((d) => d.id);

  it("TA-1 auth gate: GET 401/403 flat", async () => {
    const { member } = await makeWorld();
    let r = await get(taGET, "/api/admin/text-annotations/config");
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S037 fold: A applied]
    asUser(member);
    r = await get(taGET, "/api/admin/text-annotations/config");
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ADMIN_ONLY); // [S037 fold: A applied]
  });

  it("TA-2 read shape: {detectors: full meta, enabled}; unconfigured → defaultEnabled ids; configured wins", async () => {
    const bare = await makeWorld(null);
    asUser(bare.admin);
    let r = await get(taGET, "/api/admin/text-annotations/config");
    expect(r.status).toBe(200);
    expect(r.body.detectors).toEqual(meta);
    expect(r.body.enabled).toEqual(defaultIds);
    const conf = await makeWorld({ textAnnotation: { enabledDetectors: [validId] } });
    asUser(conf.admin);
    r = await get(taGET, "/api/admin/text-annotations/config");
    expect(r.body.enabled).toEqual([validId]);
  });

  it("TA-3 PUT validation literals: non-array → flat 400; unknown ids → dynamic joined literal", async () => {
    const { admin } = await makeWorld();
    asUser(admin);
    for (const body of [{}, { enabledDetectors: "rooms" }, { enabledDetectors: null }]) {
      const r = await put(taPUT, "/api/admin/text-annotations/config", body);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: { code: "VALIDATION", message: "enabledDetectors must be an array" } }); // [S037 fold: A applied]
    }
    const r = await put(taPUT, "/api/admin/text-annotations/config", {
      enabledDetectors: [validId, "nope-1", "nope-2"],
    });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: { code: "VALIDATION", message: "Unknown detector IDs: nope-1, nope-2" } }); // [S037 fold: A applied]
  });

  it("TA-4 write: REBUILDS textAnnotation (sibling SUBkeys dropped), echo response, updatedAt TOUCHED, top-level siblings survive", async () => {
    const { company, admin } = await makeWorld(); // SEED.textAnnotation has futureKnob: true
    const before = await rowOf(company.id);
    await new Promise((res) => setTimeout(res, 5)); // updatedAt tick resolution
    asUser(admin);
    const r = await put(taPUT, "/api/admin/text-annotations/config", { enabledDetectors: [validId] });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true, enabledDetectors: [validId] }); // echo pinned
    const after = await rowOf(company.id);
    expect(after.pc?.textAnnotation).toEqual({ enabledDetectors: [validId] }); // futureKnob GONE (rebuild quirk)
    expect(after.pc?.csi).toEqual(SEED.csi);
    expect(after.pc?.__sentinel).toEqual(SEED.__sentinel);
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime()); // touched
  });

  it("TA-5 boundary: empty array is VALID and OVERRIDES defaults on the next GET", async () => {
    const { admin } = await makeWorld();
    asUser(admin);
    const r = await put(taPUT, "/api/admin/text-annotations/config", { enabledDetectors: [] });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true, enabledDetectors: [] });
    const g = await get(taGET, "/api/admin/text-annotations/config");
    expect(g.body.enabled).toEqual([]); // [] is truthy → configured-empty beats defaultEnabled
  });
});

// ── heuristics/config — DUAL keys `heuristics` + `pageNaming` (auth-fallback GET) ──
describe.skipIf(!dbUp)("admin/heuristics/config (HEU)", () => {
  const FALLBACK = {
    builtInRules: BUILT_IN_RULES.map((r) => ({ ...r, source: "built-in" })),
    companyOverrides: [],
    pageNaming: { enabled: false, yoloSources: [] },
  };

  it("HEU-1 GET AUTH DEVIATION: signed-out AND non-admin both get the 200 built-ins fallback (NOT 401/403)", async () => {
    const { member } = await makeWorld();
    // the ONE auth-shape deviation in B1 (recon-flagged): requireAdmin's error is SWALLOWED
    let r = await get(heuGET, "/api/admin/heuristics/config");
    expect(r.status).toBe(200);
    expect(r.body).toEqual(FALLBACK);
    asUser(member); // 403-class caller — same fallback
    r = await get(heuGET, "/api/admin/heuristics/config");
    expect(r.status).toBe(200);
    expect(r.body).toEqual(FALLBACK);
  });

  it("HEU-2 admin read: builtInRules + companyOverrides + pageNaming slices; defaults when unset", async () => {
    const { admin } = await makeWorld();
    asUser(admin);
    let r = await get(heuGET, "/api/admin/heuristics/config");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      builtInRules: FALLBACK.builtInRules,
      companyOverrides: SEED.heuristics,
      pageNaming: SEED.pageNaming,
    });
    const bare = await makeWorld(null);
    asUser(bare.admin);
    r = await get(heuGET, "/api/admin/heuristics/config");
    expect(r.body.companyOverrides).toEqual([]);
    expect(r.body.pageNaming).toEqual({ enabled: false, yoloSources: [] });
  });

  it("HEU-3 PUT auth gate (unlike GET, errors DO return): 401/403 flat", async () => {
    const { member } = await makeWorld();
    let r = await put(heuPUT, "/api/admin/heuristics/config", { heuristics: [] });
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S037 fold: A applied]
    asUser(member);
    r = await put(heuPUT, "/api/admin/heuristics/config", { heuristics: [] });
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ADMIN_ONLY); // [S037 fold: A applied]
  });

  it("HEU-4 PUT validation literal: neither field / non-array heuristics without pageNaming", async () => {
    const { admin } = await makeWorld();
    asUser(admin);
    for (const body of [{}, { heuristics: "x" }, { heuristics: 5, pageNaming: null }]) {
      const r = await put(heuPUT, "/api/admin/heuristics/config", body);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: { code: "VALIDATION", message: "heuristics array or pageNaming config required" } }); // [S037 fold: A applied]
    }
  });

  it("HEU-5 CONDITIONAL dual-key write: heuristics-only preserves pageNaming (and vice versa); updatedAt TOUCHED; siblings survive", async () => {
    const { company, admin } = await makeWorld();
    const before = await rowOf(company.id);
    await new Promise((res) => setTimeout(res, 5));
    asUser(admin);
    const newRules = [{ id: "h9", name: "Rule 9" }];
    let r = await put(heuPUT, "/api/admin/heuristics/config", { heuristics: newRules });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true });
    let row = await rowOf(company.id);
    expect(row.pc?.heuristics).toEqual(newRules);
    expect(row.pc?.pageNaming).toEqual(SEED.pageNaming); // untouched by heuristics-only PUT
    expect(row.pc?.__sentinel).toEqual(SEED.__sentinel);
    expect(row.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    // pageNaming-only
    const pn = { enabled: false, yoloSources: ["window"] };
    r = await put(heuPUT, "/api/admin/heuristics/config", { pageNaming: pn });
    expect(r.status).toBe(200);
    row = await rowOf(company.id);
    expect(row.pc?.pageNaming).toEqual(pn);
    expect(row.pc?.heuristics).toEqual(newRules); // untouched by pageNaming-only PUT
  });

  it("HEU-6 TRUTHY quirk: pageNaming:null alongside valid heuristics → heuristics written, pageNaming SKIPPED", async () => {
    const { company, admin } = await makeWorld();
    asUser(admin);
    const r = await put(heuPUT, "/api/admin/heuristics/config", { heuristics: [], pageNaming: null });
    expect(r.status).toBe(200);
    const row = await rowOf(company.id);
    expect(row.pc?.heuristics).toEqual([]);
    expect(row.pc?.pageNaming).toEqual(SEED.pageNaming); // null is falsy → conditional skip
  });

  // [S037 DETECTOR closers] The B1 shared-DETECTOR sample audit (heuristics = the P3 pick)
  // surfaced two coverage NOTEs (HEU-COV-1/2): the E-class body edges and the root-admin
  // path were pinned only on OTHER routes (DEMO-5, DEMO-1) on the reasoning that both are
  // shell/helper-shared mechanisms. Non-falsifying, but heuristics is the deviant member
  // (auth:"none" GET + in-service auth()), so its root path is genuinely NOT the shared
  // requireSession one on GET — pin both here directly.
  it("HEU-7 root-admin (isRootAdmin, role member) gets the FULL admin read on GET (not the fallback) and can PUT [closer HEU-COV-2]", async () => {
    const { company } = await makeWorld();
    const root = await createUser(company.id, { isRootAdmin: true });
    asUser(root);
    // GET: the in-service isAdmin gate must treat root as admin → full company read, NOT the built-ins fallback
    const g = await get(heuGET, "/api/admin/heuristics/config");
    expect(g.status).toBe(200);
    expect(g.body.companyOverrides).toEqual(SEED.heuristics); // full read (fallback would be [])
    expect(g.body.pageNaming).toEqual(SEED.pageNaming);
    // PUT: root passes requireSession("admin") (isRootAdmin bypass) and writes
    const r = await put(heuPUT, "/api/admin/heuristics/config", { heuristics: [{ id: "hR", name: "Root Rule" }] });
    expect(r.status).toBe(200);
    expect((await rowOf(company.id)).pc?.heuristics).toEqual([{ id: "hR", name: "Root Rule" }]);
  });

  it("HEU-8 PUT body-edge E-class + no-write (parse-before-auth systemic trait, pinned on the deviant member) [closer HEU-COV-1]", async () => {
    const { company, admin } = await makeWorld();
    // signed-out + malformed → 401. // [hardening sep30] REVERSED on purpose: routes whose auth needs no body now authenticate
    // FIRST, so a signed-out caller never makes the server read or parse a body → 401 here.
    let r = await readJson(await heuPUT(rawPut("/api/admin/heuristics/config", "{oops")));
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } });
    asUser(admin);
    // authed + malformed → same BAD_REQUEST; authed empty + JSON-null + scalar → VALIDATION generic
    r = await readJson(await heuPUT(rawPut("/api/admin/heuristics/config", "{oops")));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("BAD_REQUEST");
    for (const raw of [undefined, "null", "5"]) {
      r = await readJson(await heuPUT(rawPut("/api/admin/heuristics/config", raw)));
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("VALIDATION"); // generic zod message; legacy gave 500 / route literal
    }
    // none of the edges wrote
    const after = await rowOf(company.id);
    expect(after.pc?.heuristics).toEqual(SEED.heuristics);
    expect(after.pc?.pageNaming).toEqual(SEED.pageNaming);
  });
});
