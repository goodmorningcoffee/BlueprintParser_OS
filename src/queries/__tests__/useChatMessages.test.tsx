// [refactor jul9 P2.2①] Tests for the chat query facade. This dir (src/queries/__tests__) is NEW —
// chat establishes it as the first migrated domain. Layer split (SPEC §2.A):
//   • mapChatRows tests are green from the EXTRACTION commit.
//   • the useChatMessages HOOK tests are green only once the hook lands (migration commit) — they
//     define the target backing and are added there.
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { mapChatRows, useChatMessages } from "@/queries/useChatMessages";
import { useViewerStore } from "@/stores/viewerStore";
import { queryKeys } from "@/queries/queryKeys";
import type { ChatMsg } from "@/types";

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

// ── useChatMessages hook — the cache-backed facade (SPEC §2.A T-A2..A6) ───────
function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}
function freshClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe("useChatMessages hook", () => {
  beforeEach(() => {
    useViewerStore.getState().resetProjectData();
  });

  it("T-A2: returns [] before any seed, without throwing / fetching", () => {
    useViewerStore.setState({ publicId: "p-A" });
    const { result } = renderHook(() => useChatMessages(), { wrapper: makeWrapper(freshClient()) });
    expect(result.current.chatMessages).toEqual([]);
  });

  it("T-A3: addChatMessage appends in order, producing a new array identity (no client id/model)", async () => {
    useViewerStore.setState({ publicId: "p-A" });
    const { result } = renderHook(() => useChatMessages(), { wrapper: makeWrapper(freshClient()) });

    // setQueryData notifies the observer asynchronously — poll via waitFor (the proven ChatPanel
    // pattern) rather than reading result.current synchronously after the mutation.
    const ref0 = result.current.chatMessages; // the initialData [] identity
    act(() => result.current.addChatMessage({ role: "user", content: "m1" }));
    act(() => result.current.addChatMessage({ role: "assistant", content: "m2" }));

    await waitFor(() =>
      expect(result.current.chatMessages).toEqual([
        { role: "user", content: "m1" },
        { role: "assistant", content: "m2" },
      ]),
    );
    // appends replaced the [] identity — pins the new-reference semantics the positional key={i}
    // + auto-scroll dep [chatMessages] rely on (also exercised end-to-end by T-B13).
    expect(result.current.chatMessages).not.toBe(ref0);
  });

  it("T-A4: clearChatMessages empties the list", async () => {
    useViewerStore.setState({ publicId: "p-A" });
    const { result } = renderHook(() => useChatMessages(), { wrapper: makeWrapper(freshClient()) });
    act(() => result.current.addChatMessage({ role: "user", content: "m1" }));
    act(() => result.current.addChatMessage({ role: "assistant", content: "m2" }));
    await waitFor(() => expect(result.current.chatMessages).toHaveLength(2)); // guard vs false-empty
    act(() => result.current.clearChatMessages());
    await waitFor(() => expect(result.current.chatMessages).toEqual([]));
  });

  it("T-A5: publicId-scoped isolation — switching publicId swaps the list; a write to A never touches B", async () => {
    const client = freshClient();
    const a1: ChatMsg = { id: 1, role: "user", content: "a1" };
    const b1: ChatMsg = { id: 2, role: "assistant", content: "b1" };
    client.setQueryData(queryKeys.chatMessages.all("A"), [a1]);
    client.setQueryData(queryKeys.chatMessages.all("B"), [b1]);
    // key shape is exactly the documented tuple
    expect(queryKeys.chatMessages.all("A")).toEqual(["project", "A", "chatMessages"]);

    useViewerStore.setState({ publicId: "A" });
    const { result } = renderHook(() => useChatMessages(), { wrapper: makeWrapper(client) });
    await waitFor(() => expect(result.current.chatMessages).toEqual([a1]));

    act(() => useViewerStore.setState({ publicId: "B" }));
    await waitFor(() => expect(result.current.chatMessages).toEqual([b1]));

    act(() => useViewerStore.setState({ publicId: "A" }));
    act(() => result.current.addChatMessage({ role: "user", content: "a2" }));
    await waitFor(() =>
      expect(result.current.chatMessages).toEqual([a1, { role: "user", content: "a2" }]),
    );
    // B's entry is untouched by the write to A
    expect(client.getQueryData(queryKeys.chatMessages.all("B"))).toEqual([b1]);
  });

  it("T-A6: survives an observer gap — unmount/remount against the same client keeps seeded msgs (gcTime guard)", () => {
    const client = freshClient();
    const seeded: ChatMsg[] = [
      { id: 1, role: "user", content: "s1" },
      { id: 2, role: "assistant", content: "s2" },
    ];
    client.setQueryData(queryKeys.chatMessages.all("A"), seeded);
    useViewerStore.setState({ publicId: "A" });

    const first = renderHook(() => useChatMessages(), { wrapper: makeWrapper(client) });
    expect(first.result.current.chatMessages).toEqual(seeded);
    first.unmount(); // sole observer gone — under a finite gcTime this entry would eventually GC

    const second = renderHook(() => useChatMessages(), { wrapper: makeWrapper(client) });
    expect(second.result.current.chatMessages).toEqual(seeded);
  });
});
