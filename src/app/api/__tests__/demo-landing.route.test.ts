// @vitest-environment node
// [refactor jul8 S060] CHARACTERIZATION for the 3 DEMO LANDING-SURFACE shell-folds
// (demo/config GET · demo/domain-knowledge GET · demo/admin GET), written as THE FREEZE before
// the folds onto services/demo-landing.ts. Option-B (owner-LOCKED): public /api/demo/* STAY
// dedicated auth:"none" routes; only internals move. All three PUBLIC GETs (no auth, no body →
// NO E anywhere). Frozen quirk inventory:
//   • demo/config: appSettings "header_links" row spread over the 5 defaults; ensureProtocol
//     prefixes https:// onto protocol-less values; the WHOLE body is a swallow-catch → defaults
//     @200 (LOAD-BEARING control-flow — never a 500, DC-3). {headerLinks} shape.
//   • demo/domain-knowledge: serves src/data/domain-knowledge.md as a RAW text/plain Response
//     with Cache-Control "public, max-age=3600" (must survive the shell's
//     result-instanceof-Response passthrough — getPageTextract precedent); read failure → RAW
//     "" 404 (not JSON).
//   • demo/admin: the Reddit-launch SECURITY SCRUB is the load-bearing contract (route header
//     documents it): projects = isDemo-only 5-field shape · models = MINIMAL {id,name,type,
//     isDefault} (NO config/classes/keywords — DA-2 pins the key-set NEGATIVELY) + the 3
//     hardcoded MOCK_MODELS appended when names don't collide · users NEVER returned ·
//     yoloStatus demo-scoped SQL aggregate · toggles hardcoded {true,false,true} ·
//     pipelineConfig scrubbed to ONLY {demo:…}. No demo projects → 404 {error:"No demo
//     projects"} (the sole error path). The company = the FIRST isDemo project's companyId
//     (limit 1, unordered — DA tests PIN the company via a first-select spy because the shared
//     parallel test DB seeds demo projects from other files; the downstream queries are all
//     company-scoped and deterministic once pinned).
// Assertions tagged [S060 fold: … applied] were flipped in the fold commit.
import { describe, expect, inject, it, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

const fsm = vi.hoisted(() => ({ readFile: vi.fn() }));
vi.mock("fs/promises", async (importOriginal) => {
  const orig = await importOriginal<typeof import("fs/promises")>();
  return { ...orig, readFile: fsm.readFile, default: { ...orig, readFile: fsm.readFile } };
});

import { GET as dcGET } from "@/app/api/demo/config/route";
import { GET as dkGET } from "@/app/api/demo/domain-knowledge/route";
import { GET as daGET } from "@/app/api/demo/admin/route";
import { db } from "@/lib/db";
import { appSettings, annotations, companies, models, projects } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { createCompany, createProject, createUser, readJson, signedOut } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

const DEFAULTS = {
  home: "https://blueprintparser.com",
  hded: "https://hded.blueprintparser.com",
  modelExchange: "https://models.blueprintparser.com",
  planExchange: "https://planexchange.blueprintparser.com",
  labelFleet: "https://www.labelfleet.xyz",
};

/** Pin demo/admin's first-select (the company-picking query) to OUR company; everything
 *  downstream is company-scoped and hits the real DB. */
function pinDemoCompany(companyId: number) {
  const realSelect = db.select.bind(db);
  let first = true;
  return vi.spyOn(db, "select").mockImplementation(((...a: unknown[]) => {
    if (first) {
      first = false;
      return { from: () => ({ where: () => ({ limit: async () => [{ companyId }] }) }) };
    }
    return (realSelect as (...args: unknown[]) => unknown)(...a);
  }) as typeof db.select);
}

beforeEach(async () => {
  vi.clearAllMocks();
  signedOut();
  // real file content by default; per-test overrides below
  const { readFile } = (await vi.importActual<typeof import("fs/promises")>("fs/promises"));
  fsm.readFile.mockImplementation(readFile as never);
});

describe.skipIf(!dbUp)("demo landing surface (DC/DK/DA)", () => {
  // ── demo/config ─────────────────────────────────────────────────────────────
  it("DC-1 no header_links row → the 5 defaults", async () => {
    // the shared DB may carry a row from another test — delete OUR key first (app-global!)
    await db.delete(appSettings).where(eq(appSettings.key, "header_links"));
    const r = await readJson(await dcGET());
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ headerLinks: DEFAULTS });
  });

  it("DC-2 row spreads over defaults + ensureProtocol prefixes protocol-less values", async () => {
    await db.delete(appSettings).where(eq(appSettings.key, "header_links"));
    await db.insert(appSettings).values({
      key: "header_links",
      value: { home: "custom.example.com", labelFleet: "http://keep-http.example" } as never,
    });
    const r = await readJson(await dcGET());
    expect(r.status).toBe(200);
    expect(r.body.headerLinks).toEqual({
      ...DEFAULTS,
      home: "https://custom.example.com", // protocol added
      labelFleet: "http://keep-http.example", // existing protocol kept
    });
    await db.delete(appSettings).where(eq(appSettings.key, "header_links"));
  });

  it("DC-3 db throw → SWALLOWED to defaults @200 (never a 500)", async () => {
    const spy = vi.spyOn(db, "select").mockImplementationOnce(() => { throw new Error("db down"); });
    const r = await readJson(await dcGET());
    spy.mockRestore();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ headerLinks: DEFAULTS });
  });

  // ── demo/domain-knowledge ───────────────────────────────────────────────────
  it("DK-1 happy: RAW text/plain + Cache-Control public max-age=3600 + real file content", async () => {
    const res = await dkGET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600"); // must survive shell passthrough
    const text = await res.text();
    expect(text.length).toBeGreaterThan(100); // the real src/data/domain-knowledge.md
  });

  it("DK-2 read failure → RAW empty-body 404 (not JSON)", async () => {
    fsm.readFile.mockRejectedValueOnce(new Error("ENOENT"));
    const res = await dkGET();
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
  });

  // ── demo/admin ──────────────────────────────────────────────────────────────
  it("DA-1 no demo projects → 404 'No demo projects'", async () => {
    // pin the first select to EMPTY (the shared DB carries other tests' demo projects)
    const realSelect = db.select.bind(db);
    let first = true;
    const spy = vi.spyOn(db, "select").mockImplementation(((...a: unknown[]) => {
      if (first) { first = false; return { from: () => ({ where: () => ({ limit: async () => [] }) }) }; }
      return (realSelect as (...args: unknown[]) => unknown)(...a);
    }) as typeof db.select);
    const r = await readJson(await daGET());
    spy.mockRestore();
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "No demo projects" }); // [S060 fold: A applied]
  });

  it("DA-2 SECURITY SCRUB: isDemo-only projects · minimal model shape · mock-model dedup · demo-only pipelineConfig · hardcoded toggles", async () => {
    const company = await createCompany();
    const author = await createUser(company.id);
    const demoProj = await createProject(company.id, author.id, { isDemo: true });
    const privateProj = await createProject(company.id, author.id); // NOT demo → excluded
    // a real model whose name COLLIDES with a mock (dedup pin) + a private-config model
    const [realYolo] = await db.insert(models).values([
      { companyId: company.id, name: "yolo_doors", type: "yolo", s3Path: "models/yolo-doors", config: { classes: ["secret"], confidence: 0.9 } as never },
    ]).returning();
    // a yolo annotation for the aggregate
    await db.insert(annotations).values({
      projectId: demoProj.id, name: "d1", minX: 0, minY: 0, maxX: 0.5, maxY: 0.5, pageNumber: 1,
      source: "yolo", data: { modelId: realYolo.id, modelName: "yolo_doors" } as never,
    });
    // pipelineConfig with private keys that MUST be scrubbed
    await db.update(companies).set({
      pipelineConfig: { csi: { tier2Weight: 9 }, heuristics: [{ id: "h1" }], demo: { chatEnabled: true } } as never,
    }).where(eq(companies.id, company.id));

    const spy = pinDemoCompany(company.id);
    const r = await readJson(await daGET());
    spy.mockRestore();
    expect(r.status).toBe(200);
    // projects: isDemo only, 5-field public shape
    const projIds = r.body.projects.map((p: { id: string }) => p.id);
    expect(projIds).toContain(demoProj.publicId);
    expect(projIds).not.toContain(privateProj.publicId);
    expect(Object.keys(r.body.projects.find((p: { id: string }) => p.id === demoProj.publicId)).sort())
      .toEqual(["id", "isDemo", "name", "numPages", "status"]);
    // models: minimal shape — config/classes/keywords NEVER leak (negative key pin)
    const realRow = r.body.models.find((m: { id: number }) => m.id === realYolo.id);
    expect(realRow).toEqual({ id: realYolo.id, name: "yolo_doors", type: "yolo", isDefault: false });
    expect(realRow).not.toHaveProperty("config");
    // mock dedup: colliding "yolo_doors" mock (9001) dropped; the other two appended minimal
    expect(r.body.models.filter((m: { name: string }) => m.name === "yolo_doors")).toHaveLength(1);
    const mock = r.body.models.find((m: { id: number }) => m.id === 9002);
    expect(mock).toEqual({ id: 9002, name: "yolo_general", type: "yolo", isDefault: false });
    expect(mock).not.toHaveProperty("config");
    // users NEVER returned
    expect(r.body).not.toHaveProperty("users");
    // yoloStatus aggregate keyed by publicId → modelName → count
    expect(r.body.yoloStatus[demoProj.publicId]).toEqual({ yolo_doors: 1 });
    // toggles hardcoded
    expect(r.body.toggles).toEqual({ sagemakerEnabled: true, quotaEnabled: false, hasPassword: true });
    // pipelineConfig scrubbed to ONLY {demo}
    expect(r.body.pipelineConfig).toEqual({ demo: { chatEnabled: true } });
  });
});
