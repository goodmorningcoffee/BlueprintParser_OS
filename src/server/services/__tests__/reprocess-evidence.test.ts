// @vitest-environment node
// [evidence T4 2026-10-24] Reprocess scope=evidence, with the DB edges injected (the route-level
// reprocess tests are DB-backed and skip without postgres). Pins the counters, the unchanged-page
// skip, and the per-project guard the five reprocess.ts scopes carry.
import { describe, expect, it } from "vitest";
import { buildEvidenceSummary, type EvidenceSummary } from "@/lib/evidence";
import type { ProjectWriteCapability } from "@/server/api/project-write-capability";
import { reprocessEvidenceScope, type EvidenceScopeDeps } from "@/server/services/reprocess-evidence";
import type { TextractPageData } from "@/types";

const NOW = new Date("2026-10-24T12:00:00.000Z");
const OCR: TextractPageData = {
  lines: [],
  words: [{ text: "DOOR", confidence: 90, bbox: [0.1, 0.1, 0.04, 0.01] }],
};
const HOLE = { name: "text_box", modelName: "yolo_text", confidence: 0.7, minX: 0.6, minY: 0.6, maxX: 0.62, maxY: 0.61 };

function harness(pagesByProject: Record<number, Array<{ id: number; pageNumber: number; textractData: TextractPageData | null; pageIntelligence?: unknown }>>) {
  const writes: Array<{ projectId: number; pageId: number; summary: EvidenceSummary }> = [];
  const events: Array<Record<string, unknown>> = [];
  const all = Object.values(pagesByProject).flat();
  const deps: EvidenceScopeDeps = {
    listPages: async (projectId) => {
      if (!pagesByProject[projectId]) throw new Error(`project ${projectId} exploded`);
      return pagesByProject[projectId].map(({ id, pageNumber }) => ({ id, pageNumber }));
    },
    loadPage: async (pageId) => {
      const p = all.find((x) => x.id === pageId);
      if (p?.pageIntelligence === "throw") throw new Error("bad row");
      return p ? { textractData: p.textractData, pageIntelligence: p.pageIntelligence ?? null } : undefined;
    },
    loadDetections: async () => new Map([[1, [HOLE]]]),
    writeEvidence: async (_wc, projectId, pageId, summary) => { writes.push({ projectId, pageId, summary }); },
  };
  const leases: number[] = [];
  const withLease = <T,>(id: number, op: (wc: ProjectWriteCapability) => Promise<T>): Promise<T> => {
    leases.push(id);
    return op({} as ProjectWriteCapability);
  };
  const stream = { send: (e: Record<string, unknown>) => events.push(e), debug: () => {} };
  return { deps, withLease, leases, stream, writes, events };
}

describe("reprocessEvidenceScope", () => {
  it("writes changed pages, skips unchanged / no-OCR pages, and counts each", async () => {
    const current = buildEvidenceSummary({ textract: OCR, detections: [] }, NOW);
    const h = harness({
      10: [
        { id: 101, pageNumber: 1, textractData: OCR }, // YOLO hole → new summary
        { id: 102, pageNumber: 2, textractData: OCR, pageIntelligence: { evidence: { ...current, computedAt: "old" } } }, // unchanged
        { id: 103, pageNumber: 3, textractData: null }, // no OCR
      ],
    });
    const counts = await reprocessEvidenceScope({ projects: [{ id: 10, name: "P" }], withLease: h.withLease, stream: h.stream, deps: h.deps, now: () => NOW });
    expect(counts).toEqual({ updated: 1, skipped: 2, noOcr: 1, unchanged: 1, errors: 0, total: 3 });
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]).toMatchObject({ projectId: 10, pageId: 101 });
    expect(h.writes[0].summary.counts).toMatchObject({ ocrWords: 1, holes: 1 });
    expect(h.leases).toEqual([10]);
    expect(h.events[0]).toEqual({ type: "project", name: "P", pages: 3, yoloPages: 1 });
    // done-line safety: no `failed`/`empty` keys, which the console renders as shape-parse wording.
    expect(Object.keys(counts)).not.toContain("failed");
  });

  it("one bad page is a warning; one bad project is an error event; the run continues", async () => {
    const h = harness({
      20: [
        { id: 201, pageNumber: 1, textractData: OCR, pageIntelligence: "throw" },
        { id: 202, pageNumber: 2, textractData: OCR },
      ],
    });
    const counts = await reprocessEvidenceScope({
      projects: [{ id: 99, name: "Broken" }, { id: 20, name: "Good" }],
      withLease: h.withLease, stream: h.stream, deps: h.deps, now: () => NOW,
    });
    expect(h.events).toContainEqual({ type: "error", project: "Broken", error: "project 99 exploded" });
    expect(h.events).toContainEqual(expect.objectContaining({ type: "warning", project: "Good", message: expect.stringContaining("Page 1: evidence not saved") }));
    expect(counts).toMatchObject({ updated: 1, errors: 1, total: 2 });
  });
});
