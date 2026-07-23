// @vitest-environment node
// [refactor jul23 P5.4-A] FREEZE — locks the 50-entry ring-buffer semantics of
// parse-history.ts. [P5.4-C] The backend is now Postgres (op_log); per RD-P5e
// the freeze ADAPTS to async by adding `await` ONLY — every assertion is
// unchanged. Contract: newest-first, hard cap at getMaxEntries()==50 keeping the
// newest, getHistory() returns a fresh (defensive) array, clearHistory() empties.
// The op_log swap reproduces the ring via ORDER BY created_at DESC, id DESC
// LIMIT 50 (the serial id is the same-instant tiebreak). Isolation is the async
// clearHistory() in beforeEach (DELETE FROM op_log); global-setup migrates the
// DB fresh per run so this file's op_log rows never leak across runs.
import { beforeEach, describe, expect, inject, it } from "vitest";
import {
  addToHistory,
  clearHistory,
  getHistory,
  getMaxEntries,
  type ParseHistoryEntry,
} from "@/lib/parse-history";

const dbUp = inject("dbUp") as boolean;

function entry(id: string): ParseHistoryEntry {
  return { id, timestamp: id, requestType: "table", methodResults: [] } as never;
}

beforeEach(async () => {
  await clearHistory();
});

describe.skipIf(!dbUp)("parse-history ring buffer (freeze)", () => {
  it("caps at exactly 50 entries", () => {
    expect(getMaxEntries()).toBe(50);
  });

  it("orders newest-first via unshift", async () => {
    await addToHistory(entry("a"));
    await addToHistory(entry("b"));
    await addToHistory(entry("c"));
    expect((await getHistory()).map((e) => e.id)).toEqual(["c", "b", "a"]);
  });

  it("drops the oldest once the 50 cap is exceeded", async () => {
    for (let i = 1; i <= 60; i += 1) await addToHistory(entry(`e${i}`));
    const ids = (await getHistory()).map((e) => e.id);
    expect(ids).toHaveLength(50);
    // Newest first: e60 at the head, e11 at the tail; e1..e10 evicted.
    expect(ids[0]).toBe("e60");
    expect(ids[49]).toBe("e11");
    expect(ids).not.toContain("e10");
    expect(ids).not.toContain("e1");
  });

  it("returns a defensive copy that cannot mutate the buffer", async () => {
    await addToHistory(entry("x"));
    const snapshot = await getHistory();
    snapshot.push(entry("y"));
    snapshot.length = 0;
    expect((await getHistory()).map((e) => e.id)).toEqual(["x"]);
  });

  it("clears the buffer", async () => {
    await addToHistory(entry("x"));
    await addToHistory(entry("y"));
    await clearHistory();
    expect(await getHistory()).toHaveLength(0);
  });
});
