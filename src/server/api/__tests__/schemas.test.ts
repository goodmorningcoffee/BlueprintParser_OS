// @vitest-environment node
// [refactor jun16 P1.1] Shared schema-primitive tests.
import { describe, it, expect } from "vitest";
import {
  zPublicId,
  zPageNumber,
  zName255,
  zBboxMinMax,
  zPageRange,
  MAX_PAGE_RANGE,
} from "@/server/api/schemas";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("schemas — zPublicId", () => {
  it("accepts a uuid", () => expect(zPublicId.safeParse(UUID).success).toBe(true));
  it("rejects a non-uuid (the S003 non-uuid→pg-cast-500 quirk)", () => {
    expect(zPublicId.safeParse("123").success).toBe(false);
    expect(zPublicId.safeParse("").success).toBe(false);
    expect(zPublicId.safeParse(42).success).toBe(false);
  });
});

describe("schemas — zBboxMinMax (mirrors api-utils.parseBboxMinMax)", () => {
  it("accepts [minX,minY,maxX,maxY] in [0,1] with minX<maxX, minY<maxY", () => {
    expect(zBboxMinMax.safeParse([0.1, 0.2, 0.5, 0.6]).success).toBe(true);
  });
  it("rejects out-of-range values", () => {
    expect(zBboxMinMax.safeParse([0, 0, 1.5, 1]).success).toBe(false);
    expect(zBboxMinMax.safeParse([-0.1, 0, 0.5, 0.5]).success).toBe(false);
  });
  it("rejects reversed / degenerate corners", () => {
    expect(zBboxMinMax.safeParse([0.6, 0.2, 0.5, 0.6]).success).toBe(false); // minX>=maxX
    expect(zBboxMinMax.safeParse([0.1, 0.6, 0.5, 0.6]).success).toBe(false); // minY>=maxY
  });
  it("rejects wrong arity / non-numbers", () => {
    expect(zBboxMinMax.safeParse([0.1, 0.2, 0.5]).success).toBe(false);
    expect(zBboxMinMax.safeParse([0.1, 0.2, 0.5, "x"]).success).toBe(false);
  });
});

describe("schemas — zPageNumber / zName255", () => {
  it("zPageNumber requires int >= 1", () => {
    expect(zPageNumber.safeParse(1).success).toBe(true);
    expect(zPageNumber.safeParse(0).success).toBe(false);
    expect(zPageNumber.safeParse(2.5).success).toBe(false);
  });
  it("zName255 trims, requires non-empty, caps at 255", () => {
    expect(zName255.safeParse("  hi  ").success).toBe(true);
    expect(zName255.parse("  hi  ")).toBe("hi");
    expect(zName255.safeParse("").success).toBe(false);
    expect(zName255.safeParse("a".repeat(256)).success).toBe(false);
  });
});

describe("schemas — zPageRange (with export-DoS cap)", () => {
  it("accepts a range within the cap", () => {
    expect(zPageRange.safeParse({ from: 1, to: 10 }).success).toBe(true);
    expect(zPageRange.safeParse({ from: 5, to: 5 }).success).toBe(true);
  });
  it("rejects to<from", () => expect(zPageRange.safeParse({ from: 10, to: 1 }).success).toBe(false));
  it("rejects a range exceeding the cap", () => {
    expect(zPageRange.safeParse({ from: 1, to: MAX_PAGE_RANGE + 1 }).success).toBe(false);
    expect(zPageRange.safeParse({ from: 1, to: MAX_PAGE_RANGE }).success).toBe(true);
  });
});
