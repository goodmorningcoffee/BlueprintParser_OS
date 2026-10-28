// @vitest-environment node
// [table pipeline WP-3.P] The admin parse preview service with its deps injected (no DB): one evidence load
// per page, raw `sources` never reach the engine, every request is `instant` with only the proposal hint,
// per-item errors (missing page, engine stub, a throw) never fail the batch, the kill switch and demo refuse.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: async () => null }));

import { ParseEngineNotImplementedError, type ParseRequest, type ParseResult } from "@/lib/parse-engine/types";
import { resolveParseEngineFlags } from "@/server/services/parse-engine/flags";
import { adminParsePreview, previewRequest, type AdminParsePreviewDeps } from "@/server/services/parse-engine/admin-preview";
import type { LoadedPageEvidence } from "@/server/services/parse-engine/evidence";

const PID = "11111111-2222-4333-8444-555555555555";
const BOX = [0.1, 0.1, 0.5, 0.5] as [number, number, number, number];
const fakeResult = (req: ParseRequest) => ({ model: { v: 1, kind: req.kind }, stamp: { budget: req.budget } }) as unknown as ParseResult;

function deps(over: Partial<AdminParsePreviewDeps> = {}) {
  const loads: number[] = [];
  const calls: [Record<string, unknown>, ParseRequest][] = [];
  const d: AdminParsePreviewDeps = {
    readFlags: async () => resolveParseEngineFlags(undefined).flags,
    findProject: async () => ({ id: 7, isDemo: false }),
    loadEvidence: async (_projectId, page) => {
      loads.push(page);
      if (page === 9) return null;
      return { words: [], page, sources: { drawingNumber: `Q-${page}` } } as unknown as LoadedPageEvidence;
    },
    runEngine: async (ev, req) => { calls.push([ev as unknown as Record<string, unknown>, req]); return fakeResult(req); },
    ...over,
  };
  return { d, loads, calls };
}

describe("adminParsePreview", () => {
  it("loads each page once, strips sources, and sends instant requests with only the proposal hint", async () => {
    const { d, loads, calls } = deps();
    const out = await adminParsePreview({ projectId: PID, items: [
      { page: 2, bbox: BOX, kind: "schedule", proposalId: "r:p2:a" },
      { page: 2, bbox: BOX, kind: "notes" },
      { page: 3, bbox: BOX, kind: "legend", proposalId: "r:p3:b" },
    ] }, d);
    expect(loads).toEqual([2, 3]);
    expect(calls.map(([, r]) => r)).toEqual([
      { page: 2, bbox: BOX, kind: "schedule", budget: "instant", hints: { proposalId: "r:p2:a" } },
      { page: 2, bbox: BOX, kind: "notes", budget: "instant" },
      { page: 3, bbox: BOX, kind: "legend", budget: "instant", hints: { proposalId: "r:p3:b" } },
    ]);
    for (const [ev] of calls) expect(ev).not.toHaveProperty("sources");
    expect(out.items.map((i) => [i.proposalId, i.drawingNumber, i.result?.stamp.budget])).toEqual([
      ["r:p2:a", "Q-2", "instant"], [null, "Q-2", "instant"], ["r:p3:b", "Q-3", "instant"],
    ]);
  });

  it("reports a missing page, the engine stub and a throw per item", async () => {
    let n = 0;
    const { d } = deps({
      runEngine: async (_ev, req) => {
        n++;
        if (n === 1) throw new ParseEngineNotImplementedError("stub");
        if (n === 2) throw new Error("boom");
        return fakeResult(req);
      },
    });
    const out = await adminParsePreview({ projectId: PID, items: [
      { page: 9, bbox: BOX, kind: "schedule" },
      { page: 2, bbox: BOX, kind: "schedule" },
      { page: 2, bbox: BOX, kind: "keynote" },
      { page: 2, bbox: BOX, kind: "spec" },
    ] }, d);
    expect(out.items.map((i) => i.error ?? "ok")).toEqual(["page-not-found", "engine-unavailable", "failed", "ok"]);
  });

  it("refuses: kill switch, unknown / malformed project, demo, zero-area box (before any load)", async () => {
    const item = { page: 2, bbox: BOX, kind: "schedule" as const };
    const killed = deps({ readFlags: async () => resolveParseEngineFlags({ killSwitch: true }).flags });
    await expect(adminParsePreview({ projectId: PID, items: [item] }, killed.d)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(adminParsePreview({ projectId: "x", items: [item] }, deps().d)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(adminParsePreview({ projectId: PID, items: [item] }, deps({ findProject: async () => null }).d)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const demo = deps({ findProject: async () => ({ id: 7, isDemo: true }) });
    await expect(adminParsePreview({ projectId: PID, items: [item] }, demo.d)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(demo.loads).toEqual([]);
    const zero = deps();
    await expect(adminParsePreview({ projectId: PID, items: [{ ...item, bbox: [0.2, 0.2, 0.2, 0.4] }] }, zero.d)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(zero.loads).toEqual([]);
  });

  it("previewRequest is strict zParseRequest-shaped", () => {
    expect(previewRequest({ page: 1, bbox: BOX, kind: "spec" })).toEqual({ page: 1, bbox: BOX, kind: "spec", budget: "instant" });
  });
});
