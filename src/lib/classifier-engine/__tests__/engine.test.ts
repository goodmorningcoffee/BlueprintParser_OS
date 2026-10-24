// The engine end to end over synthetic pages with the built-in recipes: candidates (regions-v2 +
// uncovered Textract tables, dedupe, scope), detect gate, naming, fallback with the derived
// name, stable ids, the stored-shape guard, and never throwing out of a page.
import { describe, expect, it } from "vitest";
import type { TextractWord } from "@/types";
import { classifyRegionsV2 } from "@/lib/region-classifier-v2";
import { BUILT_IN_RECIPES, isPageClassifierProposals, proposalId, runClassifierEngine, storedClassifierProposals } from "..";
import type { ClassifierPageInput } from "../evidence";
import type { ClassifierRecipe } from "../types";

const word = (text: string, x: number, y: number, h = 0.012): TextractWord => ({ text, confidence: 99, bbox: [x, y, text.length * 0.007, h] });

/** A door schedule inside a detector table box on an A sheet, title just above the box. */
function doorPage(): ClassifierPageInput {
  const words: TextractWord[] = [word("DOOR", 0.52, 0.19, 0.018), word("SCHEDULE", 0.57, 0.19, 0.018)];
  ["DOOR", "NO", "FRAME", "HDWR", "RATING", "SIZE"].forEach((t, i) => words.push(word(t, 0.51 + i * 0.07, 0.22)));
  for (let r = 0; r < 8; r++) {
    words.push(word(`10${r}`, 0.51, 0.25 + r * 0.02), word("HM", 0.58, 0.25 + r * 0.02), word("WD", 0.65, 0.25 + r * 0.02), word("PR", 0.72, 0.25 + r * 0.02), word("90 MIN", 0.8, 0.25 + r * 0.02));
  }
  const detections = [
    { name: "tables", modelName: "yolo_medium", confidence: 0.9, minX: 0.5, minY: 0.21, maxX: 0.9, maxY: 0.45 },
    { name: "title_block", modelName: "yolo_medium", confidence: 0.9, minX: 0.92, minY: 0.0, maxX: 1, maxY: 1 },
  ];
  const regionsV2 = classifyRegionsV2({ pageNumber: 3, detections, textractData: { words }, csiCodes: [] });
  return { pageNumber: 3, detections, textractData: { words }, csiCodes: [], regionsV2, drawingNumber: "A-601", tagger: () => [{ code: "08 11 13", division: "08 00 00" }, { code: "08 14 16", division: "08 00 00" }] };
}

describe("runClassifierEngine — built-in schedules recipe", () => {
  it("names a door schedule, explains it, stores every feature and carries the region id", () => {
    const input = doorPage();
    const run = runClassifierEngine(input, BUILT_IN_RECIPES);
    expect(run.errors).toEqual([]);
    expect(run.result.engineVersion).toBe("clf/0.1");
    expect(run.result.recipes).toEqual({ "schedules.v1": 1, "regions.v1": 1 });
    const [p] = run.result.proposals;
    expect(run.result.proposals).toHaveLength(1);
    expect(p.recipeId).toBe("schedules.v1");
    expect(p.target).toBe("schedule");
    expect(p.p).toBeGreaterThanOrEqual(0.5);
    expect(p.classId).toBe("door");
    expect(p.group).toBe("arch");
    expect(p.displayName).toBe("Door schedule");
    expect(p.legacyCategory).toBeUndefined();
    expect(p.derivedName).toMatchObject({ text: "DOOR SCHEDULE", source: "above" });
    expect(p.margin).toBeGreaterThanOrEqual(0.1);
    expect(p.source).toBe("regions-v2");
    expect(p.regionId).toBe(input.regionsV2!.regions[0].id);
    expect(p.id).toBe(proposalId("schedules.v1", 3, input.regionsV2!.regions[0].anchorBbox));
    expect(p.detectWhy[0].signalId).toBe("detect.structure");
    expect(p.nameWhy.length).toBeLessThanOrEqual(8);
    expect(p.features["door.columns"]).toBeGreaterThan(0.5);
    expect(p.features["door.csiSec"]).toBe(1);
    expect(p.features["detect.structure"]).toBe(input.regionsV2!.regions[0].structureScore);
    // every class evaluated its signals, so a refit has the full row
    expect(Object.keys(p.features).filter((k) => k.startsWith("panel."))).not.toHaveLength(0);
    // the record is byte-stable across reruns (so an unchanged page is not rewritten)
    expect(JSON.stringify(runClassifierEngine(input, BUILT_IN_RECIPES).result)).toBe(JSON.stringify(run.result));
    expect(isPageClassifierProposals(run.result)).toBe(true);
    expect(storedClassifierProposals({ classifierProposals: run.result })).toEqual(run.result);
    expect(storedClassifierProposals({ classifierProposals: { proposals: "no" } })).toBeUndefined();
  });

  it("falls back to 'Other schedule' with the derived header name when no kind is confident", () => {
    const words: TextractWord[] = [word("WIDGET", 0.52, 0.19, 0.018), word("SCHEDULE", 0.6, 0.19, 0.018)];
    ["MARK", "QTY", "REMARKS"].forEach((t, i) => words.push(word(t, 0.51 + i * 0.1, 0.22)));
    for (let r = 0; r < 6; r++) words.push(word(`W${r}`, 0.51, 0.25 + r * 0.02), word(`${r + 1}`, 0.61, 0.25 + r * 0.02), word("TBD", 0.71, 0.25 + r * 0.02));
    const detections = [{ name: "tables", modelName: "yolo_medium", confidence: 0.9, minX: 0.5, minY: 0.21, maxX: 0.9, maxY: 0.4 }];
    const regionsV2 = classifyRegionsV2({ pageNumber: 1, detections, textractData: { words }, csiCodes: [] });
    const run = runClassifierEngine({ pageNumber: 1, detections, textractData: { words }, csiCodes: [], regionsV2, drawingNumber: "A-601", tagger: () => [] }, BUILT_IN_RECIPES);
    const [p] = run.result.proposals;
    expect(p.classId).toBeNull();
    expect(p.className).toBe("Other schedule");
    expect(p.group).toBeNull();
    expect(p.displayName).toBe("WIDGET SCHEDULE");
    expect(p.derivedName?.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it("drops candidates that fail the detect gate, dedupes a Textract table under a region, and respects scope", () => {
    const input = doorPage();
    const withTextract: ClassifierPageInput = { ...input, textractData: { words: input.textractData!.words, tables: [{ bbox: [0.5, 0.21, 0.4, 0.24], cells: [], rowCount: 9, colCount: 6 }, { bbox: [0.05, 0.6, 0.3, 0.2], cells: [], rowCount: 4, colCount: 2 }] } };
    const run = runClassifierEngine(withTextract, BUILT_IN_RECIPES);
    // the Textract table over the region is the same candidate (IoU ≥ .6); the bare one has no words → gated out
    expect(run.result.proposals.map((p) => p.source)).toEqual(["regions-v2"]);
    const scoped: ClassifierRecipe = { ...BUILT_IN_RECIPES[0], id: "e-only", scope: { disciplines: ["E"] } };
    expect(runClassifierEngine(input, [scoped]).result.proposals).toEqual([]);
    const disabled: ClassifierRecipe = { ...BUILT_IN_RECIPES[0], enabled: false };
    expect(runClassifierEngine(input, [disabled]).result).toEqual({ engineVersion: "clf/0.1", recipes: {}, proposals: [] });
  });

  it("a page-unit recipe scores the whole page once; a recipe that throws is reported, not fatal", () => {
    const input = doorPage();
    const pageRecipe: ClassifierRecipe = {
      ...BUILT_IN_RECIPES[0], id: "page.v1", unit: "page", target: "has-door-schedule", candidates: [], scope: {}, classes: [],
      detect: { bias: -1, threshold: 0.5, signals: [{ id: "w", label: "door words", spec: { type: "words", where: "page", terms: { "DOOR SCHEDULE": 2 } }, weight: 4, role: "score", enabled: true }] },
    };
    const bad: ClassifierRecipe = { ...pageRecipe, id: "bad.v1", scope: { sheetNumberPattern: "(" } };
    const run = runClassifierEngine(input, [pageRecipe, bad, BUILT_IN_RECIPES[0]]);
    const page = run.result.proposals.find((p) => p.recipeId === "page.v1");
    expect(page).toMatchObject({ bbox: [0, 0, 1, 1], classId: null, className: "Other schedule", target: "has-door-schedule" });
    expect(run.result.proposals.some((p) => p.recipeId === "schedules.v1")).toBe(true);
    expect(run.result.proposals.some((p) => p.recipeId === "bad.v1")).toBe(false);
  });

  it("the regions recipe names a general-notes box from region v2 text regions", () => {
    const words: TextractWord[] = [word("GENERAL", 0.1, 0.1, 0.016), word("NOTES", 0.16, 0.1, 0.016)];
    const body = "THE CONTRACTOR SHALL VERIFY ALL DIMENSIONS PRIOR TO CONSTRUCTION AND SHALL COMPLY WITH ALL APPLICABLE CODES DO NOT SCALE DRAWINGS SUBMIT SHOP DRAWINGS".split(" ");
    body.forEach((t, i) => words.push(word(t, 0.1 + (i % 6) * 0.06, 0.13 + Math.floor(i / 6) * 0.02)));
    const detections = [{ name: "text_box", modelName: "yolo_medium", confidence: 0.85, minX: 0.08, minY: 0.08, maxX: 0.5, maxY: 0.25 }];
    const regionsV2 = classifyRegionsV2({ pageNumber: 1, detections, textractData: { words }, csiCodes: [] });
    expect(regionsV2.regions[0]?.className).toBe("general notes");
    const run = runClassifierEngine({ pageNumber: 1, detections, textractData: { words }, csiCodes: [], regionsV2, tagger: () => [] }, BUILT_IN_RECIPES);
    const p = run.result.proposals.find((x) => x.recipeId === "regions.v1");
    expect(p).toMatchObject({ classId: "general-notes", legacyCategory: "general-notes", target: "text-region" });
  });
});
