import { describe, it, expect } from "vitest";
import { composeScore } from "../primitives/score-compose";
import { DEFAULT_SCORING_CONFIG } from "../types";
import type { ScoreSignals } from "../types";

function baseSignals(overrides: Partial<ScoreSignals> = {}): ScoreSignals {
  return {
    patternMatch: true,
    patternStrength: "none",
    windowMatch: true,
    regionType: "drawings",
    regionWeight: 1.0,
    shapeContainBoost: 0,
    objectAdjacencyBoost: 0,
    scopeMatch: true,
    fuzzy: false,
    ...overrides,
  };
}

describe("composeScore", () => {
  it("scope hard-zero returns score 0 and outside_scope reason", () => {
    const result = composeScore(baseSignals({ scopeMatch: false }), DEFAULT_SCORING_CONFIG, true);
    expect(result.score).toBe(0);
    expect(result.tier).toBe("low");
    expect(result.dropReason).toBe("outside_scope");
  });

  it("strong pattern miss hard-zeros with pattern_mismatch reason", () => {
    const result = composeScore(
      baseSignals({ patternStrength: "strong", patternMatch: false }),
      DEFAULT_SCORING_CONFIG,
      true,
    );
    expect(result.score).toBe(0);
    expect(result.tier).toBe("low");
    expect(result.dropReason).toBe("pattern_mismatch");
  });

  it("weak pattern miss attenuates but does not hard-zero", () => {
    const result = composeScore(
      baseSignals({ patternStrength: "weak", patternMatch: false }),
      DEFAULT_SCORING_CONFIG,
      true,
    );
    // 1.0 (drawings) × 0.7 (weak attenuation) = 0.7 → tier=high
    expect(result.score).toBeCloseTo(0.7, 2);
    expect(result.tier).toBe("high");
    expect(result.dropReason).toBeUndefined();
  });

  it("no-pattern + drawings + window + non-fuzzy gives perfect score", () => {
    const result = composeScore(baseSignals(), DEFAULT_SCORING_CONFIG, true);
    expect(result.score).toBe(1.0);
    expect(result.tier).toBe("high");
  });

  it("tables region drops to tier=low with inside_table reason", () => {
    const result = composeScore(
      baseSignals({ regionType: "tables", regionWeight: 0.3 }),
      DEFAULT_SCORING_CONFIG,
      true,
    );
    // Score 0.3 < tierThresholds.medium (0.35)
    expect(result.score).toBeCloseTo(0.3, 2);
    expect(result.tier).toBe("low");
    expect(result.dropReason).toBe("inside_table");
  });

  it("title_block region drops with inside_title_block reason", () => {
    const result = composeScore(
      baseSignals({ regionType: "title_block", regionWeight: 0.05 }),
      DEFAULT_SCORING_CONFIG,
      true,
    );
    expect(result.score).toBeCloseTo(0.05, 2);
    expect(result.tier).toBe("low");
    expect(result.dropReason).toBe("inside_title_block");
  });

  it("unclassified region on page with drawings → dropReason outside_drawings (audit info)", () => {
    const result = composeScore(
      baseSignals({ regionType: "unclassified", regionWeight: 0.5 }),
      DEFAULT_SCORING_CONFIG,
      true,
    );
    // Score 0.5 → tier=medium (>=0.35). The dropReason is populated
    // regardless of tier so that "strict mode" filters downstream can
    // surface WHY a medium-tier match was dropped.
    expect(result.score).toBeCloseTo(0.5, 2);
    expect(result.tier).toBe("medium");
    expect(result.dropReason).toBe("outside_drawings");
  });

  it("unclassified region tier=low on page with drawings → outside_drawings", () => {
    // Force tier=low by stacking penalties
    const result = composeScore(
      baseSignals({
        regionType: "unclassified",
        regionWeight: 0.5,
        windowMatch: false,      // ×0.85
        fuzzy: true,             // ×0.9
        patternStrength: "weak",
        patternMatch: false,     // ×0.7
      }),
      DEFAULT_SCORING_CONFIG,
      true,   // page has drawings
    );
    // 0.5 × 0.85 × 0.9 × 0.7 = 0.268 → tier=low
    expect(result.tier).toBe("low");
    expect(result.dropReason).toBe("outside_drawings");
  });

  it("unclassified region tier=low on page WITHOUT drawings → no outside_drawings reason", () => {
    const result = composeScore(
      baseSignals({
        regionType: "unclassified",
        regionWeight: 0.5,
        windowMatch: false,
        fuzzy: true,
        patternStrength: "weak",
        patternMatch: false,
      }),
      DEFAULT_SCORING_CONFIG,
      false,  // no drawings on page
    );
    expect(result.tier).toBe("low");
    expect(result.dropReason).toBeUndefined();
  });

  it("fuzzy-OCR match attenuates by 0.9", () => {
    const result = composeScore(baseSignals({ fuzzy: true }), DEFAULT_SCORING_CONFIG, true);
    expect(result.score).toBeCloseTo(0.9, 2);
    expect(result.tier).toBe("high");
  });

  it("window-miss attenuates by 0.85", () => {
    const result = composeScore(baseSignals({ windowMatch: false }), DEFAULT_SCORING_CONFIG, true);
    expect(result.score).toBeCloseTo(0.85, 2);
    expect(result.tier).toBe("high");
  });

  it("shape containment boost lifts an otherwise-medium match to high", () => {
    const result = composeScore(
      baseSignals({
        regionType: "unclassified",
        regionWeight: 0.5,
        shapeContainBoost: 0.2,
      }),
      DEFAULT_SCORING_CONFIG,
      true,
    );
    // 0.5 + 0.2 = 0.7 → exactly at high threshold
    expect(result.score).toBeCloseTo(0.7, 2);
    expect(result.tier).toBe("high");
  });

  it("object adjacency boost stacks with shape containment", () => {
    const result = composeScore(
      baseSignals({
        regionType: "unclassified",
        regionWeight: 0.5,
        shapeContainBoost: 0.1,
        objectAdjacencyBoost: 0.1,
      }),
      DEFAULT_SCORING_CONFIG,
      true,
    );
    expect(result.score).toBeCloseTo(0.7, 2);
    expect(result.tier).toBe("high");
  });

  it("tier thresholds at exact boundaries", () => {
    // Exactly 0.7 → high
    let result = composeScore(
      baseSignals({ regionType: "unclassified", regionWeight: 0.7 }),
      DEFAULT_SCORING_CONFIG,
      true,
    );
    expect(result.tier).toBe("high");
    // Exactly 0.35 → medium
    result = composeScore(
      baseSignals({ regionType: "unclassified", regionWeight: 0.35 }),
      DEFAULT_SCORING_CONFIG,
      true,
    );
    expect(result.tier).toBe("medium");
    // Just below 0.35 → low
    result = composeScore(
      baseSignals({ regionType: "unclassified", regionWeight: 0.349 }),
      DEFAULT_SCORING_CONFIG,
      true,
    );
    expect(result.tier).toBe("low");
  });

  it("clamps score to 0..1 range when boosts overflow", () => {
    const result = composeScore(
      baseSignals({
        regionWeight: 1.0,
        shapeContainBoost: 0.5,       // out-of-spec, but verify clamp
        objectAdjacencyBoost: 0.5,
      }),
      DEFAULT_SCORING_CONFIG,
      true,
    );
    expect(result.score).toBe(1.0);
  });
});
