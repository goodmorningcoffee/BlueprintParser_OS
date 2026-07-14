import { describe, expect, it } from "vitest";
import {
  canonicalModelStoragePath,
  isCanonicalModelStoragePath,
} from "@/lib/model-storage-authority";

describe("model storage authority", () => {
  it("derives the only accepted model namespace from the model name", () => {
    expect(canonicalModelStoragePath("Door Detector!")).toBe(
      "models/door-detector-",
    );
    expect(
      isCanonicalModelStoragePath("Door Detector", "models/door-detector"),
    ).toBe(true);
  });

  it("rejects project-like, nested, and mismatched model paths", () => {
    expect(
      isCanonicalModelStoragePath("demo", "company/0123456789abcdefabcd"),
    ).toBe(false);
    expect(isCanonicalModelStoragePath("demo", "models/demo/nested")).toBe(
      false,
    );
    expect(isCanonicalModelStoragePath("demo", "models/other")).toBe(false);
  });
});
