import { describe, expect, it } from "vitest";
import { createYoloJobName } from "@/lib/yolo";

describe("createYoloJobName", () => {
  it("retains unique entropy when a long model name is truncated", () => {
    const modelName = "model-".repeat(30);
    const first = createYoloJobName(
      modelName,
      "11111111-1111-4111-8111-111111111111",
    );
    const second = createYoloJobName(
      modelName,
      "22222222-2222-4222-8222-222222222222",
    );

    expect(first).not.toBe(second);
    expect(first).toHaveLength(63);
    expect(second).toHaveLength(63);
    expect(first).toMatch(/-11111111111141118111$/);
    expect(second).toMatch(/-22222222222242228222$/);
  });

  it("allocates distinct provider identities for repeated calls", () => {
    const first = createYoloJobName("same model");
    const second = createYoloJobName("same model");
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[a-zA-Z0-9-]{1,63}$/);
    expect(second).toMatch(/^[a-zA-Z0-9-]{1,63}$/);
  });
});
