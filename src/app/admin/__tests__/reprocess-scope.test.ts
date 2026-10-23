// [2026-10-23] Admin › Pipeline › Reprocess "All": the tab states the SERVER's scope and count
// (own company, non-demo, any status), not its own completed-across-companies list.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchReprocessScope, reprocessAllConfirmText, reprocessScopeNote } from "@/app/admin/tabs/reprocess-scope";

const SCOPE = {
  companyId: 3,
  companyName: "Acme",
  projects: 128,
  byStatus: { completed: 120, error: 6, processing: 2 },
  description: "every non-demo project of your own company, any status",
};

afterEach(() => vi.unstubAllGlobals());

describe("reprocess scope texts", () => {
  it("the note names the server count, its status mix and why it differs from the list", () => {
    const note = reprocessScopeNote(SCOPE, null, 216, true);
    expect(note).toBe(
      '"All" runs on 128 projects: every non-demo project of Acme, any status (120 completed, 6 error, 2 processing). ' +
        "The list below shows 216 completed projects across all companies; selected projects outside Acme are skipped.",
    );
    expect(reprocessScopeNote(SCOPE, null, 120, false)).toMatch(/shows 120 completed projects; selected/u);
    expect(reprocessScopeNote(null, null, 216, true)).toMatch(/^Counting the server's scope…/u);
    expect(reprocessScopeNote(null, "HTTP 500", 216, true)).toMatch(/Could not count the server's scope \(HTTP 500\)\. "All" runs on every non-demo project of your own company, any status/u);
  });

  it("the confirm states the exact count before a run", () => {
    expect(reprocessAllConfirmText("Page Names", SCOPE, null, 216, true)).toBe(
      "Run Page Names on 128 projects — every non-demo project of Acme, any status (120 completed, 6 error, 2 processing).\n\n" +
        "This is the server's scope, not the 216 completed projects listed here across all companies.",
    );
    expect(reprocessAllConfirmText("Full", null, "offline", 5, false)).toMatch(/could not be read: offline/u);
  });

  it("fetchReprocessScope returns the body, or the envelope error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => SCOPE })));
    expect(await fetchReprocessScope()).toEqual({ scope: SCOPE, error: null });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ error: { code: "FORBIDDEN", message: "Admin only" } }) })));
    expect(await fetchReprocessScope()).toEqual({ scope: null, error: "Admin only" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await fetchReprocessScope()).toEqual({ scope: null, error: "offline" });
  });
});
