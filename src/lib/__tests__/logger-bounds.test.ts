// @vitest-environment node
// [hardening sep30] A driver error quotes the offending value, and the stack repeats the message.
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "@/lib/logger";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logger — error fields are bounded", () => {
  it("clips a caller-inflated message and stack, and says how much was dropped", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error(`invalid input syntax for type integer: "${"9".repeat(200_000)}"`);
    logger.error("route failed", { err: error, requestId: "r1" });
    const line = spy.mock.calls[0][0] as string;
    expect(line.length).toBeLessThan(5_000);
    const entry = JSON.parse(line) as { err: { message: string; stack: string }; requestId: string };
    expect(entry.err.message).toMatch(/… \[\+\d+ chars\]$/);
    expect(entry.err.stack.length).toBeLessThanOrEqual(2_000 + 40);
    expect(entry.requestId).toBe("r1");
  });

  it("leaves an ordinary error untouched", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logger.error("boom", new Error("short"));
    const entry = JSON.parse(spy.mock.calls[0][0] as string) as { error: { message: string } };
    expect(entry.error.message).toBe("short");
  });
});
