// [refactor jul9 P2.2①] Tests for the chat query facade. This dir (src/queries/__tests__) is NEW —
// chat establishes it as the first migrated domain. Layer split (SPEC §2.A):
//   • mapChatRows tests are green from the EXTRACTION commit.
//   • the useChatMessages HOOK tests are green only once the hook lands (migration commit) — they
//     define the target backing and are added there.
import { describe, it, expect } from "vitest";
import { mapChatRows } from "@/queries/useChatMessages";

describe("mapChatRows (T-A1)", () => {
  it("coerces model null AND '' -> undefined, preserves order/id/content, role is an unchecked cast", () => {
    const out = mapChatRows([
      { id: 5, role: "assistant", content: "hi", model: null },
      { id: 6, role: "user", content: "q", model: "" },
      { id: 7, role: "assistant", content: "yo", model: "gpt-4" },
    ]);
    expect(out).toEqual([
      { id: 5, role: "assistant", content: "hi", model: undefined },
      { id: 6, role: "user", content: "q", model: undefined },
      { id: 7, role: "assistant", content: "yo", model: "gpt-4" },
    ]);
  });

  it("passes a stray role through verbatim (frozen: no validation)", () => {
    const out = mapChatRows([{ id: 1, role: "system", content: "x", model: null }]);
    // role is a bare `as` cast — 'system' survives (renders as a non-user "AI" bubble downstream)
    expect(out[0].role as string).toBe("system");
  });

  it("empty input -> empty array", () => {
    expect(mapChatRows([])).toEqual([]);
  });
});
