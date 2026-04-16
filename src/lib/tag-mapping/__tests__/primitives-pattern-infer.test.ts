import { describe, it, expect } from "vitest";
import { inferTagPattern } from "../primitives/pattern-infer";

describe("inferTagPattern", () => {
  it("returns null for fewer than 3 values", () => {
    expect(inferTagPattern([])).toBeNull();
    expect(inferTagPattern(["D-101"])).toBeNull();
    expect(inferTagPattern(["D-101", "D-102"])).toBeNull();
  });

  it("returns null for a single unique value even if repeated", () => {
    expect(inferTagPattern(["D-101", "D-101", "D-101", "D-101"])).toBeNull();
  });

  it("infers a strong pattern from uniform L-DDD values", () => {
    const result = inferTagPattern(["D-101", "D-102", "D-103", "D-104"]);
    expect(result).not.toBeNull();
    expect(result!.strength).toBe("strong");
    expect(result!.pattern.test("D-101")).toBe(true);
    expect(result!.pattern.test("D-999")).toBe(true);
    expect(result!.pattern.test("W-101")).toBe(false);
    expect(result!.pattern.test("D-1")).toBe(false);
  });

  it("infers a weak pattern from digit-only values", () => {
    const result = inferTagPattern(["01", "02", "03", "04", "05"]);
    expect(result).not.toBeNull();
    expect(result!.strength).toBe("weak");
    expect(result!.pattern.test("01")).toBe(true);
    expect(result!.pattern.test("99")).toBe(true);
  });

  it("infers character class when letter prefix diverges", () => {
    const result = inferTagPattern(["D-101", "W-101", "D-102", "W-102"]);
    expect(result).not.toBeNull();
    expect(result!.strength).toBe("strong");
    expect(result!.pattern.test("D-101")).toBe(true);
    expect(result!.pattern.test("W-101")).toBe(true);
    // The character class only includes observed letters
    expect(result!.pattern.test("D-999")).toBe(true);
    expect(result!.pattern.test("W-999")).toBe(true);
  });

  it("returns null for heterogeneous columns with no dominant shape", () => {
    const result = inferTagPattern([
      "D-101", "abc", "XYZ123", "5", "FIXTURE", "001",
    ]);
    expect(result).toBeNull();
  });

  it("handles 80/20 mix as strong pattern (ignoring minority)", () => {
    // 4 of 5 follow L-DDD; 1 outlier
    const result = inferTagPattern([
      "D-101", "D-102", "D-103", "D-104", "NOTE",
    ]);
    expect(result).not.toBeNull();
    expect(result!.strength).toBe("strong");
    expect(result!.pattern.test("D-101")).toBe(true);
  });

  it("handles trailing letter variants", () => {
    const result = inferTagPattern([
      "D-101A", "D-102A", "D-103B", "D-104B",
    ]);
    expect(result).not.toBeNull();
    expect(result!.strength).toBe("strong");
    expect(result!.pattern.test("D-101A")).toBe(true);
    expect(result!.pattern.test("D-101C")).toBe(false);  // C wasn't observed
  });

  it("treats numbers-only pattern as weak regardless of length", () => {
    const result = inferTagPattern(["001", "002", "003", "004"]);
    expect(result).not.toBeNull();
    expect(result!.strength).toBe("weak");
  });

  it("treats L-DDD with dash-pattern as strong", () => {
    const result = inferTagPattern([
      "E-01", "E-02", "E-03", "E-04", "E-05", "E-06",
    ]);
    expect(result).not.toBeNull();
    expect(result!.strength).toBe("strong");
    expect(result!.pattern.test("E-01")).toBe(true);
    expect(result!.pattern.test("01")).toBe(false);      // pattern mismatch
    expect(result!.pattern.test("E-123")).toBe(false);   // wrong digit count
  });

  it("handles two dominant shapes via split pattern (strong if combined ≥85%)", () => {
    const result = inferTagPattern([
      "D-101", "D-102", "D-103",
      "FA-1", "FA-2",
    ]);
    expect(result).not.toBeNull();
    // Either pattern alone is 60%/40% — combined 100% → strong split
    expect(result!.pattern.test("D-101")).toBe(true);
    expect(result!.pattern.test("FA-1")).toBe(true);
  });

  it("normalizes values to uppercase before inference", () => {
    const result = inferTagPattern(["d-101", "d-102", "d-103"]);
    expect(result).not.toBeNull();
    expect(result!.pattern.test("D-101")).toBe(true);
  });
});
