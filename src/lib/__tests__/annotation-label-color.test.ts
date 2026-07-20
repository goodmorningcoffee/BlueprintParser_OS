import { describe, expect, it } from "vitest";

import { annotationLabelColor } from "@/lib/annotation-label-color";

describe("annotationLabelColor", () => {
  it("matches known positive, negative, and empty-string hash vectors", () => {
    expect(annotationLabelColor("")).toBe("#e6194b"); // hash 0
    expect(annotationLabelColor("abc")).toBe("#800000"); // hash 96,354
    expect(annotationLabelColor("Blueprint")).toBe("#fabebe"); // hash -325,727,629
  });

  it("hashes JavaScript UTF-16 code units, including surrogate halves", () => {
    expect(annotationLabelColor("\ud83d")).toBe("#ffd8b1");
    expect(annotationLabelColor("\ude00")).toBe("#aa6e28");
    expect(annotationLabelColor("\ud83d\ude00")).toBe("#808080");
    expect(annotationLabelColor("A\ud83d\ude00B")).toBe("#008080");
  });

  it("keeps whitespace, case, and Unicode normalization form significant", () => {
    expect(annotationLabelColor("Annotation")).toBe("#f032e6");
    expect(annotationLabelColor("annotation")).toBe("#ffd8b1");
    expect(annotationLabelColor(" Annotation")).toBe("#fffac8");
    expect(annotationLabelColor("Annotation ")).toBe("#3cb44b");
    expect(annotationLabelColor("é")).toBe("#fffac8");
    expect(annotationLabelColor("e\u0301")).toBe("#e6194b");
  });

  it("is repeatable and independent of encounter order", () => {
    const names = ["Alpha", "Beta", "Gamma"] as const;
    const expected = ["#46f0f0", "#e6194b", "#0082c8"];

    expect(names.map(annotationLabelColor)).toEqual(expected);
    expect([...names].reverse().map(annotationLabelColor).reverse()).toEqual(expected);
    expect(names.map(annotationLabelColor)).toEqual(expected);
  });

  it("applies signed 32-bit overflow on every code unit", () => {
    expect(annotationLabelColor("x".repeat(64))).toBe("#808000");
  });

  it("indexes negative hashes by signed magnitude rather than unsigned value", () => {
    // The unsigned form of Blueprint's hash selects #f032e6 instead.
    expect(annotationLabelColor("Blueprint")).toBe("#fabebe");
  });
});
