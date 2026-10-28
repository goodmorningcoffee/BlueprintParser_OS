// @vitest-environment node
// [table pipeline WP-2.E] Parse-engine flags: the pure resolution (code defaults ⊕ stored document ⊕
// kill switch), GET /api/projects/[id]/parse-engine/flags (members and demo viewers; nobody else), and
// the viewer's textract GET dropping the compact LAYOUT blocks (`textract_data.layout`), and (TP-3
// WP-3.E) the validated root writer GET/PUT /api/admin/parse-engine.
import { afterEach, describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { and, desc, eq } from "drizzle-orm";
import { GET as flagsGET } from "@/app/api/projects/[id]/parse-engine/flags/route";
import { GET as textractGET } from "@/app/api/pages/textract/route";
import { GET as adminGET, PUT as adminPUT } from "@/app/api/admin/parse-engine/route";
import { PUT as settingsPUT } from "@/app/api/admin/app-settings/route";
import { db } from "@/lib/db";
import { appSettings, auditLog } from "@/lib/db/schema";
import { PARSE_ENGINE_FLAGS_AUDIT_ACTION } from "@/server/services/parse-engine/flags-admin";
import { logger } from "@/lib/logger";
import { PARSE_ENGINE_TOOL_IDS } from "@/lib/parse-engine/types";
import {
  PARSE_ENGINE_FLAG_DEFAULTS,
  PARSE_ENGINE_SETTING_KEY,
  parseEngineMode,
  readParseEngineFlags,
  resolveParseEngineFlags,
} from "@/server/services/parse-engine/flags";
import { asUser, createCompany, createPage, createUser, createWorld, makeReq, params, publishDemoFixture, readJson, signedOut } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

const DEFAULT_TOOLS = {
  tablesRoute: "legacy", keynoteRoute: "legacy", notesClassifier: "legacy", specClassifier: "legacy",
  notesAuto: "legacy", specAuto: "legacy", workspace: "engine",
};

describe("resolveParseEngineFlags (pure)", () => {
  it("no row → the code defaults: every tool legacy except the workspace, crop cache on", () => {
    expect(resolveParseEngineFlags(undefined)).toEqual({ flags: { killSwitch: false, tools: DEFAULT_TOOLS, cropCache: true }, invalid: [] });
    expect(PARSE_ENGINE_FLAG_DEFAULTS.tools).toEqual(DEFAULT_TOOLS);
    expect(Object.keys(DEFAULT_TOOLS).sort()).toEqual([...PARSE_ENGINE_TOOL_IDS].sort());
  });

  it("a stored document overrides field by field", () => {
    const { flags, invalid } = resolveParseEngineFlags({ tools: { tablesRoute: "engine", workspace: "legacy" }, cropCache: false });
    expect(invalid).toEqual([]);
    expect(flags).toEqual({ killSwitch: false, tools: { ...DEFAULT_TOOLS, tablesRoute: "engine", workspace: "legacy" }, cropCache: false });
    expect(parseEngineMode(flags, "tablesRoute")).toBe("engine");
  });

  it("unknown keys, unknown tools and bad values are ignored and reported, never turning anything on", () => {
    const { flags, invalid } = resolveParseEngineFlags({ tools: { tablesRoute: "shadow", bogus: "engine", keynoteRoute: true }, killSwitch: "yes", cropCache: 1, extra: 1 });
    expect(flags).toEqual({ killSwitch: false, tools: DEFAULT_TOOLS, cropCache: true });
    expect(invalid.sort()).toEqual(["cropCache", "extra", "killSwitch", "tools.bogus", "tools.keynoteRoute", "tools.tablesRoute"]);
    expect(resolveParseEngineFlags("on").invalid).toEqual(["(document)"]);
    expect(resolveParseEngineFlags({ tools: [] }).invalid).toEqual(["tools"]);
  });

  it("the kill switch wins: every tool legacy, the workspace off, crop cache off", () => {
    const { flags } = resolveParseEngineFlags({ killSwitch: true, tools: { tablesRoute: "engine", notesAuto: "engine" }, cropCache: true });
    expect(flags.killSwitch).toBe(true);
    expect(Object.values(flags.tools).every((m) => m === "legacy")).toBe(true);
    expect(flags.cropCache).toBe(false);
  });
});

describe.skipIf(!dbUp)("GET /api/projects/[id]/parse-engine/flags", () => {
  afterEach(async () => {
    await db.delete(appSettings).where(eq(appSettings.key, PARSE_ENGINE_SETTING_KEY));
  });
  const get = (publicId: string) => flagsGET(makeReq(`/api/projects/${publicId}/parse-engine/flags`, { method: "GET" }), params({ id: publicId }));

  it("a member reads the effective flags; a stored document and the kill switch are applied", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    let r = await readJson(await get(project.publicId));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ killSwitch: false, tools: DEFAULT_TOOLS, cropCache: true });

    await db.insert(appSettings).values({ key: PARSE_ENGINE_SETTING_KEY, value: { tools: { tablesRoute: "engine" }, junk: 1 } });
    r = await readJson(await get(project.publicId));
    expect(r.body).toEqual({ killSwitch: false, tools: { ...DEFAULT_TOOLS, tablesRoute: "engine" }, cropCache: true });
    expect(await readParseEngineFlags()).toEqual(r.body);

    await db.update(appSettings).set({ value: { killSwitch: true, tools: { tablesRoute: "engine" } } }).where(eq(appSettings.key, PARSE_ENGINE_SETTING_KEY));
    r = await readJson(await get(project.publicId));
    expect(r.body.killSwitch).toBe(true);
    expect(r.body.tools.workspace).toBe("legacy");
    expect(r.body.tools.tablesRoute).toBe("legacy");
    expect(r.body.cropCache).toBe(false);
  });

  it("a stored document with invalid fields is logged once, not on every read (VERIFY LOW-5)", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await db.insert(appSettings).values({ key: PARSE_ENGINE_SETTING_KEY, value: { junkA: 1 } });
      await readParseEngineFlags();
      await readParseEngineFlags();
      await readParseEngineFlags();
      const ours = () => warn.mock.calls.filter((c) => String(c[0]).includes("app_settings.parseEngine")).length;
      expect(ours()).toBe(1);
      await db.update(appSettings).set({ value: { junkB: 1 } }).where(eq(appSettings.key, PARSE_ENGINE_SETTING_KEY));
      await readParseEngineFlags();
      await readParseEngineFlags();
      expect(ours()).toBe(2); // a different bad document is logged again
    } finally {
      warn.mockRestore();
    }
  });

  it("demo: a signed-out viewer reads the same global flags", async () => {
    const { project } = await createWorld();
    await publishDemoFixture(project.id);
    signedOut();
    const r = await readJson(await get(project.publicId));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ killSwitch: false, tools: DEFAULT_TOOLS, cropCache: true });
  });

  it("a non-demo project: signed out → 401, another company → 404", async () => {
    const { project } = await createWorld();
    signedOut();
    expect((await get(project.publicId)).status).toBe(401);
    const other = await createUser((await createWorld()).company.id);
    asUser(other);
    const r = await readJson(await get(project.publicId));
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("NOT_FOUND");
  });
});

describe.skipIf(!dbUp)("GET /api/pages/textract drops the compact LAYOUT (WP-2.E)", () => {
  it("returns the stored page without `layout`, every other key verbatim, header unchanged", async () => {
    const { user, project } = await createWorld();
    const stored = {
      words: [{ text: "QX", confidence: 99, bbox: [0.1, 0.1, 0.02, 0.01] }], lines: [],
      tables: [{ bbox: [0.1, 0.1, 0.2, 0.1], rowCount: 1, colCount: 1, cells: [{ row: 1, col: 1, rowSpan: 1, colSpan: 1, text: "QX", bbox: [0.1, 0.1, 0.2, 0.1], confidence: 90, hdr: true }], merged: [{ r: 1, c: 1, rs: 1, cs: 1 }] }],
      layout: [{ k: "table", b: [0.1, 0.1, 0.3, 0.2] }],
    };
    await createPage(project.id, 1, { textractData: stored as never });
    asUser(user);
    const res = await textractGET(makeReq(`/api/pages/textract?projectId=${project.id}&pageNumber=1`, { method: "GET" }));
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=3600");
    const { status, body } = await readJson(res);
    expect(status).toBe(200);
    const { layout: _layout, ...rest } = stored;
    expect(body).toEqual({ textractData: rest });
    expect(body.textractData).not.toHaveProperty("layout");
  });
});

// [TP-3 WP-3.E] The validated root writer. In THIS file because it is the other writer of the same
// app_settings key: tests in one file run in order, so the two never race on the shared test DB.
describe.skipIf(!dbUp)("GET/PUT /api/admin/parse-engine (root)", () => {
  afterEach(async () => {
    await db.delete(appSettings).where(eq(appSettings.key, PARSE_ENGINE_SETTING_KEY));
  });
  const PATH = "/api/admin/parse-engine";
  const get = () => adminGET(makeReq(PATH, { method: "GET" }));
  const put = (body: unknown) => adminPUT(makeReq(PATH, { method: "PUT", body }));
  async function people() {
    const company = await createCompany();
    return {
      admin: await createUser(company.id, { role: "admin" }),
      member: await createUser(company.id),
      root: await createUser(company.id, { isRootAdmin: true }),
    };
  }

  it("auth: signed out 401; member and company admin 403 on read and write", async () => {
    const { admin, member } = await people();
    signedOut();
    expect((await get()).status).toBe(401);
    expect((await put({ killSwitch: true, tools: {} })).status).toBe(401);
    for (const actor of [member, admin]) {
      asUser(actor);
      expect((await get()).status).toBe(403);
      expect((await put({ killSwitch: true, tools: {} })).status).toBe(403);
    }
  });

  it("GET shows the defaults; PUT stores only the overrides, with an audit row, and the run-path reader sees them", async () => {
    const { root } = await people();
    asUser(root);
    let r = await readJson(await get());
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ stored: null, effective: { killSwitch: false, tools: DEFAULT_TOOLS, cropCache: true }, defaults: { killSwitch: false, tools: DEFAULT_TOOLS, cropCache: true }, invalid: [] });

    r = await readJson(await put({ killSwitch: false, cropCache: false, tools: { tablesRoute: "engine" } }));
    expect(r.status).toBe(200);
    expect(r.body.stored).toEqual({ killSwitch: false, cropCache: false, tools: { tablesRoute: "engine" } });
    expect(r.body.effective).toEqual({ killSwitch: false, tools: { ...DEFAULT_TOOLS, tablesRoute: "engine" }, cropCache: false });
    expect(await readParseEngineFlags()).toEqual(r.body.effective);
    const [row] = await db.select().from(auditLog)
      .where(and(eq(auditLog.action, PARSE_ENGINE_FLAGS_AUDIT_ACTION), eq(auditLog.userId, root.id)))
      .orderBy(desc(auditLog.id)).limit(1);
    expect(row?.details).toEqual({ before: null, after: { killSwitch: false, cropCache: false, tools: { tablesRoute: "engine" } } });

    // a whole-document replace: the tool no longer pinned follows its default again; the kill switch wins
    r = await readJson(await put({ killSwitch: true, tools: {} }));
    expect(r.body.stored).toEqual({ killSwitch: true, tools: {} });
    expect(r.body.effective.tools.workspace).toBe("legacy");
    expect(r.body.effective.cropCache).toBe(false);
    r = await readJson(await get());
    expect(r.body.stored).toEqual({ killSwitch: true, tools: {} });
  });

  it("PUT is strict: an unknown mode, an unknown tool, an unknown key or a missing killSwitch → 400, nothing stored", async () => {
    const { root } = await people();
    asUser(root);
    for (const bad of [
      { killSwitch: false, tools: { tablesRoute: "shadow" } },
      { killSwitch: false, tools: { bogus: "engine" } },
      { killSwitch: false, tools: {}, extra: 1 },
      { tools: {} },
      { killSwitch: "no", tools: {} },
    ]) {
      const r = await readJson(await put(bad));
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("VALIDATION");
    }
    expect((await readJson(await get())).body.stored).toBeNull();
  });

  it("the generic app-settings route refuses the key, so every write is validated", async () => {
    const { root } = await people();
    asUser(root);
    const r = await readJson(await settingsPUT(makeReq("/api/admin/app-settings", { method: "PUT", body: { key: PARSE_ENGINE_SETTING_KEY, value: { killSwitch: true } } })));
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/\/api\/admin\/parse-engine/);
    expect((await readJson(await get())).body.stored).toBeNull();
  });
});
