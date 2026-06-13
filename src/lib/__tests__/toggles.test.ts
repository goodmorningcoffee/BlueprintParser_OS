// @vitest-environment node
// [refactor jun13 P0.5-G11] Toggle fail-closed semantics. sagemakerEnabled
// gates paid GPU inference: a transient S3 read error used to fall back to
// DEFAULTS (sagemakerEnabled: true) and silently re-enable spend the owner
// had turned off. Freezes: read error → sagemaker OFF (quota stays on, its
// safe direction is "keep enforcing"); NoSuchKey → genuine defaults.
import { describe, expect, it, vi } from "vitest";

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = sendMock;
  },
  GetObjectCommand: class {
    constructor(public input: unknown) {}
  },
  PutObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));

import { getToggles } from "@/lib/toggles";

describe("getToggles — G11 fail-closed spend gate", () => {
  it("S3 read error → sagemakerEnabled false, quotaEnabled stays true", async () => {
    sendMock.mockRejectedValueOnce(new Error("connect ETIMEDOUT"));
    const t = await getToggles(true);
    expect(t.sagemakerEnabled).toBe(false);
    expect(t.quotaEnabled).toBe(true);
  });

  it("NoSuchKey (never configured) → genuine defaults, sagemaker on", async () => {
    sendMock.mockRejectedValueOnce(Object.assign(new Error("no key"), { name: "NoSuchKey" }));
    const t = await getToggles(true);
    expect(t.sagemakerEnabled).toBe(true);
    expect(t.quotaEnabled).toBe(true);
  });

  it("stored state wins when the read succeeds", async () => {
    sendMock.mockResolvedValueOnce({
      Body: { transformToString: async () => JSON.stringify({ sagemakerEnabled: false }) },
    });
    const t = await getToggles(true);
    expect(t.sagemakerEnabled).toBe(false);
    expect(t.quotaEnabled).toBe(true); // missing keys fill from defaults
  });
});
