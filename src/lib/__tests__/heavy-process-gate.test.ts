// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HEAVY_PROCESS_BUSY_MESSAGE,
  heavyProcessGateStateForTest,
  withHeavyProcessSlot,
} from "@/lib/heavy-process-gate";

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("heavy-process gate", () => {
  it("runs at most 2 at once, queues the next 6, and refuses the 9th immediately", async () => {
    const gates = Array.from({ length: 8 }, deferred);
    let running = 0;
    let peak = 0;
    const tasks = gates.map((g) =>
      withHeavyProcessSlot(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await g.promise;
        running -= 1;
      }),
    );
    await Promise.resolve();
    expect(heavyProcessGateStateForTest()).toEqual({ active: 2, queued: 6 });

    // Refused as a 503 the route shell can render, not a bare Error that becomes a generic 500.
    await expect(withHeavyProcessSlot(async () => "never")).rejects.toMatchObject({
      code: "RATE_LIMITED",
      status: 503,
      message: HEAVY_PROCESS_BUSY_MESSAGE,
    });

    gates.forEach((g) => g.release());
    await Promise.all(tasks);
    expect(peak).toBe(2);
    expect(heavyProcessGateStateForTest()).toEqual({ active: 0, queued: 0 });
  });

  it("releases the slot when the task throws", async () => {
    await expect(
      withHeavyProcessSlot(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(heavyProcessGateStateForTest()).toEqual({ active: 0, queued: 0 });
  });

  it("a queued caller gives up after the wait limit and leaves the queue", async () => {
    vi.useFakeTimers();
    const holders = [deferred(), deferred()];
    const held = holders.map((g) => withHeavyProcessSlot(() => g.promise));
    const waiting = withHeavyProcessSlot(async () => "late");
    const assertion = expect(waiting).rejects.toThrow(HEAVY_PROCESS_BUSY_MESSAGE);
    await vi.advanceTimersByTimeAsync(20_001);
    await assertion;
    expect(heavyProcessGateStateForTest()).toEqual({ active: 2, queued: 0 });
    holders.forEach((g) => g.release());
    await Promise.all(held);
    expect(heavyProcessGateStateForTest()).toEqual({ active: 0, queued: 0 });
  });

  it("gives the slot back after the hold ceiling even if the task never settles", async () => {
    vi.useFakeTimers();
    const never = [
      withHeavyProcessSlot(() => new Promise<void>(() => {})),
      withHeavyProcessSlot(() => new Promise<void>(() => {})),
    ];
    void never;
    await Promise.resolve();
    expect(heavyProcessGateStateForTest()).toEqual({ active: 2, queued: 0 });
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    expect(heavyProcessGateStateForTest()).toEqual({ active: 0, queued: 0 });
    await expect(withHeavyProcessSlot(async () => "next")).resolves.toBe("next");
  });
});
