// @vitest-environment node
// [refactor jul23 P5.4-A] FREEZE — locks the 50-entry ring-buffer semantics of
// parse-history.ts BEFORE P5.4 swaps the backend to Postgres (op_log). Contract:
// newest-first (unshift), hard cap at getMaxEntries()==50 dropping the oldest,
// getHistory() returns a defensive copy, clearHistory() empties. The admin
// "Recent Parses" view depends on this ordering/cap; the op_log swap must
// reproduce it (ORDER BY created_at DESC LIMIT 50).
import { beforeEach, describe, expect, it } from "vitest";
import {
  addToHistory,
  clearHistory,
  getHistory,
  getMaxEntries,
  type ParseHistoryEntry,
} from "@/lib/parse-history";

function entry(id: string): ParseHistoryEntry {
  return { id, timestamp: id, requestType: "table", methodResults: [] } as never;
}

beforeEach(() => {
  clearHistory();
});

describe("parse-history ring buffer (freeze)", () => {
  it("caps at exactly 50 entries", () => {
    expect(getMaxEntries()).toBe(50);
  });

  it("orders newest-first via unshift", () => {
    addToHistory(entry("a"));
    addToHistory(entry("b"));
    addToHistory(entry("c"));
    expect(getHistory().map((e) => e.id)).toEqual(["c", "b", "a"]);
  });

  it("drops the oldest once the 50 cap is exceeded", () => {
    for (let i = 1; i <= 60; i += 1) addToHistory(entry(`e${i}`));
    const ids = getHistory().map((e) => e.id);
    expect(ids).toHaveLength(50);
    // Newest first: e60 at the head, e11 at the tail; e1..e10 evicted.
    expect(ids[0]).toBe("e60");
    expect(ids[49]).toBe("e11");
    expect(ids).not.toContain("e10");
    expect(ids).not.toContain("e1");
  });

  it("returns a defensive copy that cannot mutate the buffer", () => {
    addToHistory(entry("x"));
    const snapshot = getHistory();
    snapshot.push(entry("y"));
    snapshot.length = 0;
    expect(getHistory().map((e) => e.id)).toEqual(["x"]);
  });

  it("clears the buffer", () => {
    addToHistory(entry("x"));
    addToHistory(entry("y"));
    clearHistory();
    expect(getHistory()).toHaveLength(0);
  });
});
