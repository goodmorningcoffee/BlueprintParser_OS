import { describe, expect, it } from "vitest";
import { ALL_FEATURE_LABELS, labelFor } from "./feature-map";

describe("ParsedRegion deletion feature label", () => {
  it("maps only the exact DELETE /api/regions operation and exposes the label", () => {
    expect(labelFor("DELETE", "/api/regions")).toBe("Delete Parsed Region");
    expect(labelFor("POST", "/api/regions")).toBeNull();
    expect(labelFor("DELETE", "/api/regions/promote")).toBeNull();
    expect(
      ALL_FEATURE_LABELS.filter((label) => label === "Delete Parsed Region"),
    ).toHaveLength(1);
  });
});

describe("atomic annotation split feature label", () => {
  it("maps only the exact POST endpoint and exposes one stable label", () => {
    expect(labelFor("POST", "/api/annotations/split")).toBe("Split Annotation");
    expect(labelFor("GET", "/api/annotations/split")).toBeNull();
    expect(labelFor("DELETE", "/api/annotations/split")).toBeNull();
    expect(labelFor("POST", "/api/annotations/split/extra")).toBeNull();
    expect(labelFor("DELETE", "/api/annotations/123")).toBe(
      "Delete Annotation",
    );
    expect(
      ALL_FEATURE_LABELS.filter((label) => label === "Split Annotation"),
    ).toHaveLength(1);
  });
});
