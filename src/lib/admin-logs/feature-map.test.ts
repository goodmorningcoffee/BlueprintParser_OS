import { describe, expect, it } from "vitest";
import { ALL_FEATURE_LABELS, labelFor } from "./feature-map";

describe("ParsedRegion deletion feature label", () => {
  it("maps only the exact DELETE /api/regions operation and exposes the label", () => {
    expect(labelFor("DELETE", "/api/regions")).toBe("Delete Parsed Region");
    expect(labelFor("POST", "/api/regions")).toBeNull();
    expect(labelFor("DELETE", "/api/regions/promote")).toBeNull();
    expect(ALL_FEATURE_LABELS.filter((label) => label === "Delete Parsed Region")).toHaveLength(1);
  });
});
