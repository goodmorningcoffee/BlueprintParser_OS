// [refactor jul9 P2.2①] CHAT MIGRATION FREEZE NET — backing-agnostic characterization suite.
//
// This suite drives ChatPanel through its OWN handlers + the DOM. It is written GREEN against the
// CURRENT (zustand-backed) code, and MUST stay green byte-for-byte after chat migrates to the
// TanStack Query cache. The single sanctioned point of pre/post divergence is `seedChat()` below:
// pre-migration it writes the zustand field; post-migration it writes the query cache. Every test
// body stays identical. See P2_DESIGN/CHAT_IMPL/SPEC.md §2.B.
//
// Harness gotchas baked in (SPEC §2): jsdom has no scrollIntoView (ChatPanel:53-55 effect throws);
// the stream path needs a REAL ReadableStream body (ChatPanel:105 getReader); jest-dom matchers are
// not auto-wired (imported here).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import ChatPanel from "../ChatPanel";
import {
  openProject as beginProjectLifecycle,
  type OpenProjectHandle,
  type ProjectResponse,
} from "@/lib/project-lifecycle";
import { queryKeys } from "@/queries/queryKeys";
import type { ChatMsg } from "@/types";
import { resetProjectData } from "@/stores/viewerCommands";
import { useSessionStore } from "@/stores/sessionStore";
import { useUiStore, type LlmHighlight } from "@/stores/uiStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";

// ── seedChat: THE sanctioned divergence point ────────────────────────────────
// POST-migration (chat lives in the query cache): seed the per-publicId cache entry the facade
// hook reads. (Pre-migration this wrote useViewerStore.setState({chatMessages: msgs}); flipping this
// ONE helper — nothing else in the file — is the entire test-side delta of the migration.)
let qc: QueryClient;
function seedChat(msgs: ChatMsg[]) {
  qc.setQueryData(queryKeys.chatMessages.all(useSessionStore.getState().publicId), msgs);
}

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
function renderChatPanel() {
  return render(<ChatPanel />, { wrapper });
}

// A real SSE Response whose body is a ReadableStream of `data: <chunk>\n\n` frames.
function mockSSE(chunks: string[]): Response {
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const ch of chunks) controller.enqueue(enc.encode(`data: ${ch}\n\n`));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function response(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function lifecycleProjectResponse(demo: boolean): ProjectResponse {
  return {
    id: "pid",
    dbId: 1,
    name: demo ? "Demo successor" : "Authenticated project",
    assetBaseUrl: "s3://private/project.json",
    pdfUrl: "s3://private/project.pdf",
    numPages: 3,
    status: "ready",
    summaries: null,
    projectIntelligence: null,
    pages: [{ pageNumber: 1, name: "Page 1", drawingNumber: null }],
    ...(demo ? { demoConfig: {} } : { chatMessages: [] }),
  };
}

async function activateLifecycle(demo = false): Promise<OpenProjectHandle> {
  const lifecycleFetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const prefix = demo ? "/api/demo" : "/api";
    if (url === `${prefix}/projects/pid`) {
      return response(lifecycleProjectResponse(demo));
    }
    if (url === `${prefix}/projects/pid/pages?from=1&to=15`) {
      return response({ from: 1, to: 3, pages: [], annotations: [] });
    }
    if (!demo && url === "/api/annotation-groups?projectId=pid") {
      return response({ groups: [], memberships: [] });
    }
    throw new Error(`unexpected lifecycle request: ${url}`);
  });
  vi.stubGlobal("fetch", lifecycleFetch);
  const handle = beginProjectLifecycle(qc, "pid", { demo });
  expect((await handle.result).status).toBe("opened");
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  return handle;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function controllableSSE() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  return {
    response: new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
    emit(data: string) {
      controller.enqueue(encoder.encode(`data: ${data}\n\n`));
    },
    close() {
      controller.close();
    },
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  resetProjectData();
  setViewerStoreStateForTest({ publicId: "pid", pageNames: {}, pageNumber: 1 });
  // jsdom lacks scrollIntoView — the auto-scroll effect (ChatPanel:53-55) would throw.
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Helper: the scrollable message container is the flex-1 overflow-y-auto region. We scope bubble
// queries to it so header/input text never pollutes assertions.
function messageRegion(): HTMLElement {
  // Bubbles carry the "whitespace-pre-wrap" content div; the nearest stable ancestor is the
  // flex-1 min-h-0 container. Grab it by walking up from the end-anchor.
  const anchor = document.querySelector(".flex-1.overflow-y-auto") as HTMLElement | null;
  if (!anchor) throw new Error("message region not found");
  return anchor;
}
function bubbleTexts(): string[] {
  // Each message bubble has a role label ("You"/"AI") followed by content. We read the content divs.
  return Array.from(messageRegion().querySelectorAll(".whitespace-pre-wrap")).map(
    (n) => (n.textContent || "").replace(/\|$/, ""), // strip the streaming caret if present
  );
}
async function sendMessage(text: string) {
  const textarea = screen.getByPlaceholderText(/Ask about this/i);
  fireEvent.change(textarea, { target: { value: text } });
  const sendBtn = screen.getByRole("button", { name: "Send" });
  fireEvent.click(sendBtn);
}
function lastPostBody(): any {
  const call = [...fetchMock.mock.calls].reverse().find((c) => c[1]?.method === "POST");
  return call ? JSON.parse(call[1].body as string) : undefined;
}

describe("ChatPanel — seeded history render (T-B1)", () => {
  it("renders seeded messages in order, hides model, no empty-state, Clear shown", () => {
    seedChat([
      { id: 1, role: "user", content: "Q1" },
      { id: 2, role: "assistant", content: "A1", model: "gpt-4" },
      { id: 3, role: "user", content: "Q2" },
    ]);
    renderChatPanel();

    expect(bubbleTexts()).toEqual(["Q1", "A1", "Q2"]);
    // model string appears nowhere
    expect(document.body.textContent).not.toContain("gpt-4");
    // empty-state + quick prompts absent
    expect(screen.queryByText(/Ask a question about this/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Summarize this page")).not.toBeInTheDocument();
    // Clear button present (gated on length>0)
    expect(screen.getByRole("button", { name: "Clear" })).toBeInTheDocument();
  });
});

describe("ChatPanel — send success (T-B2)", () => {
  it("appends user echo then the completed assistant message; POST body carries page scope", async () => {
    setViewerStoreStateForTest({ publicId: "p", chatScope: "page", pageNumber: 2 });
    fetchMock.mockResolvedValueOnce(mockSSE(['{"content":"Hel"}', '{"content":"lo"}', "[DONE]"]));
    renderChatPanel();

    await sendMessage("hi");

    await waitFor(() => expect(bubbleTexts()).toEqual(["hi", "Hello"]));
    // exactly one assistant bubble
    expect(screen.getAllByText("AI").length).toBe(1);
    // input cleared
    expect((screen.getByPlaceholderText(/Ask about this/i) as HTMLTextAreaElement).value).toBe("");
    expect(lastPostBody()).toEqual({ projectId: "p", pageNumber: 2, message: "hi", scope: "page" });
  });
});

describe("ChatPanel — send HTTP !ok (T-B3)", () => {
  it("appends user echo then an Error assistant via apiErrorMessage; skips the done-append", async () => {
    setViewerStoreStateForTest({ publicId: "p" });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: { code: "X", message: "nope" } }),
    });
    renderChatPanel();

    await sendMessage("boom");

    await waitFor(() => expect(bubbleTexts()).toEqual(["boom", "Error: nope"]));
    expect(screen.getAllByText("AI").length).toBe(1); // early return skips :168
  });
});

describe("ChatPanel — send fetch rejection, the 4th append site (T-B4)", () => {
  it("appends user echo then the network-catch Error message", async () => {
    setViewerStoreStateForTest({ publicId: "p" });
    fetchMock.mockRejectedValueOnce(new Error("down"));
    renderChatPanel();

    await sendMessage("x");

    await waitFor(() =>
      expect(bubbleTexts()).toEqual(["x", "Error: Failed to connect. Please try again."]),
    );
    expect(screen.getAllByText("AI").length).toBe(1);
  });
});

describe("ChatPanel — stream {error} chunk (T-B5)", () => {
  it("folds a stream error into a single assistant bubble", async () => {
    setViewerStoreStateForTest({ publicId: "p" });
    fetchMock.mockResolvedValueOnce(mockSSE(['{"error":"boom"}', "[DONE]"]));
    renderChatPanel();

    await sendMessage("q");

    await waitFor(() => expect(bubbleTexts()).toEqual(["q", "Error: boom"]));
    expect(screen.getAllByText("AI").length).toBe(1);
  });
});

describe("ChatPanel — Clear DELETE by scope (T-B6/T-B7)", () => {
  it("page scope: DELETE with pageNumber, then empties", async () => {
    seedChat([
      { id: 1, role: "user", content: "m1" },
      { id: 2, role: "assistant", content: "m2" },
    ]);
    setViewerStoreStateForTest({ chatScope: "page", pageNumber: 3 });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    renderChatPanel();

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    await waitFor(() => expect(bubbleTexts()).toEqual([]));
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe("/api/ai/chat?projectId=pid&scope=page&pageNumber=3");
    expect(fetchMock.mock.calls[0][1]?.method).toBe("DELETE");
    // empty-state returns
    expect(screen.getByText(/Ask a question about this/i)).toBeInTheDocument();
  });

  it("project scope: DELETE omits pageNumber", async () => {
    seedChat([{ id: 1, role: "user", content: "m1" }]);
    setViewerStoreStateForTest({ chatScope: "project" });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    renderChatPanel();

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    await waitFor(() =>
      expect(fetchMock.mock.calls[0][0]).toBe("/api/ai/chat?projectId=pid&scope=project"),
    );
  });
});

describe("ChatPanel — Clear guards (T-B8/T-B9)", () => {
  it("empty list: no Clear button, DELETE not fired (T-B8)", () => {
    seedChat([]);
    renderChatPanel();
    expect(screen.queryByRole("button", { name: "Clear" })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/Ask a question about this/i)).toBeInTheDocument();
  });

  it("DELETE failure keeps messages in the UI (T-B9)", async () => {
    seedChat([
      { id: 1, role: "user", content: "m1" },
      { id: 2, role: "assistant", content: "m2" },
    ]);
    fetchMock.mockRejectedValueOnce(new Error("net"));
    renderChatPanel();

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    // messages survive a failed DELETE (clearChatMessages runs only after a resolved fetch)
    await waitFor(() => expect(screen.getByRole("button", { name: "Clear" })).not.toBeDisabled());
    expect(bubbleTexts()).toEqual(["m1", "m2"]);
  });

  it("demo clear is local-only and makes zero write requests", async () => {
    setViewerStoreStateForTest({ isDemo: true });
    seedChat([
      { id: -1, role: "user", content: "demo question" },
      { id: -2, role: "assistant", content: "demo answer" },
    ]);
    renderChatPanel();

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    await waitFor(() => expect(bubbleTexts()).toEqual([]));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("ChatPanel — exact same-publicId project lifecycle authority", () => {
  it("does not publish authenticated stream chunks after a demo lifecycle succeeds", async () => {
    await activateLifecycle(false);
    const stream = controllableSSE();
    fetchMock.mockResolvedValueOnce(stream.response);
    renderChatPanel();

    await sendMessage("authenticated question");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      await activateLifecycle(true);
    });
    expect(bubbleTexts()).toEqual([]);
    fireEvent.change(screen.getByPlaceholderText(/Ask about this/i), {
      target: { value: "demo successor draft" },
    });

    await act(async () => {
      stream.emit('{"content":"stale private answer"}');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect.soft(bubbleTexts()).toEqual([]);
    expect.soft(qc.getQueryData(queryKeys.chatMessages.all("pid"))).toEqual([]);

    await act(async () => {
      stream.emit("[DONE]");
      stream.close();
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());
    expect(bubbleTexts()).toEqual([]);
    expect(qc.getQueryData(queryKeys.chatMessages.all("pid"))).toEqual([]);
  });

  it("does not execute an authenticated stream action after a demo lifecycle succeeds", async () => {
    await activateLifecycle(false);
    const stream = controllableSSE();
    fetchMock.mockResolvedValueOnce(stream.response);
    renderChatPanel();

    await sendMessage("authenticated action request");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      await activateLifecycle(true);
    });
    const successorHighlight: LlmHighlight = {
      pageNumber: 1,
      bbox: [0.1, 0.1, 0.2, 0.2],
      label: "demo successor highlight",
    };
    act(() => {
      useViewerCoreStore.getState().setPage(1);
      useUiStore.getState().setLlmHighlight(successorHighlight);
    });
    fireEvent.change(screen.getByPlaceholderText(/Ask about this/i), {
      target: { value: "demo successor draft" },
    });

    await act(async () => {
      stream.emit(
        '{"action":{"action":"highlight","pageNumber":3,"bbox":[0.3,0.3,0.4,0.4],"label":"stale private highlight"}}',
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect.soft(useViewerCoreStore.getState().pageNumber).toBe(1);
    expect.soft(useUiStore.getState().llmHighlight).toEqual(successorHighlight);

    await act(async () => {
      stream.emit("[DONE]");
      stream.close();
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());
    expect.soft(useViewerCoreStore.getState().pageNumber).toBe(1);
    expect.soft(useUiStore.getState().llmHighlight).toEqual(successorHighlight);
    expect.soft(qc.getQueryData(queryKeys.chatMessages.all("pid"))).toEqual([]);
  });

  it("suppresses an authenticated error and its stale finally focus after demo activation", async () => {
    await activateLifecycle(false);
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    renderChatPanel();

    await sendMessage("authenticated request that will reject");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      await activateLifecycle(true);
      seedChat([{ id: -1, role: "assistant", content: "demo successor message" }]);
    });
    await waitFor(() => expect(bubbleTexts()).toEqual(["demo successor message"]));
    const successorControl = screen.getByRole("button", { name: "Project" });
    const staleInputFocus = vi.spyOn(
      screen.getByPlaceholderText(/Ask about this/i) as HTMLTextAreaElement,
      "focus",
    );
    successorControl.focus();
    expect(document.activeElement).toBe(successorControl);

    await act(async () => {
      pending.reject(new Error("stale authenticated transport"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect.soft(bubbleTexts()).toEqual(["demo successor message"]);
    expect.soft(qc.getQueryData(queryKeys.chatMessages.all("pid"))).toEqual([
      { id: -1, role: "assistant", content: "demo successor message" },
    ]);
    expect.soft(staleInputFocus).not.toHaveBeenCalled();
    expect.soft(document.activeElement).toBe(successorControl);
  });

  it("does not let an authenticated clear completion erase demo successor messages", async () => {
    await activateLifecycle(false);
    seedChat([{ id: 1, role: "user", content: "authenticated history" }]);
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    renderChatPanel();

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      await activateLifecycle(true);
      seedChat([{ id: -1, role: "assistant", content: "demo successor message" }]);
    });
    await waitFor(() => expect(bubbleTexts()).toEqual(["demo successor message"]));

    await act(async () => {
      pending.resolve(response({}));
      await Promise.resolve();
    });

    await waitFor(() => {
      const clear = screen.queryByRole("button", { name: "Clear" });
      expect(clear === null || !clear.hasAttribute("disabled")).toBe(true);
    });
    expect(bubbleTexts()).toEqual(["demo successor message"]);
    expect(qc.getQueryData(queryKeys.chatMessages.all("pid"))).toEqual([
      { id: -1, role: "assistant", content: "demo successor message" },
    ]);
  });
});

describe("ChatPanel — scope is display UI, NOT a message filter (T-B10/T-B11)", () => {
  it("toggling scope does NOT refilter the message list (T-B10)", () => {
    seedChat([
      { id: 1, role: "user", content: "m1" },
      { id: 2, role: "assistant", content: "m2" },
    ]);
    setViewerStoreStateForTest({ chatScope: "page", pageNumber: 5 });
    renderChatPanel();

    expect(bubbleTexts()).toEqual(["m1", "m2"]);
    fireEvent.click(screen.getByRole("button", { name: "Project" }));
    expect(bubbleTexts()).toEqual(["m1", "m2"]); // MESSAGE LIST invariant only
    fireEvent.click(screen.getByRole("button", { name: /Page 5/ }));
    expect(bubbleTexts()).toEqual(["m1", "m2"]);
  });

  it("project scope flows into POST body as pageNumber:null (T-B11)", async () => {
    setViewerStoreStateForTest({ publicId: "p", chatScope: "project", pageNumber: 5 });
    fetchMock.mockResolvedValueOnce(mockSSE(['{"content":"ok"}', "[DONE]"]));
    renderChatPanel();

    await sendMessage("hello");

    await waitFor(() => expect(bubbleTexts()).toEqual(["hello", "ok"]));
    expect(lastPostBody()).toEqual({ projectId: "p", pageNumber: null, message: "hello", scope: "project" });
  });
});

describe("ChatPanel — navigation between projects swaps the visible list (T-B12)", () => {
  // This characterization helper reproduces the final reset → identity → seed state used by
  // both backings. Production now reaches that state through the generation-aware shared
  // openProject lifecycle; lifecycle ordering/atomicity is pinned in its target suite.
  function openProject(publicId: string, msgs: ChatMsg[]) {
    resetProjectData();
    setViewerStoreStateForTest({ publicId });
    seedChat(msgs); // reads the just-set publicId when it becomes cache-backed
  }

  it("open A → shows A; navigate to B → shows B; navigate back to A → shows A", () => {
    openProject("A", [{ id: 1, role: "user", content: "a-only" }]);
    const view = renderChatPanel();
    expect(bubbleTexts()).toEqual(["a-only"]);

    openProject("B", [{ id: 9, role: "assistant", content: "b-only" }]);
    view.rerender(<QueryClientProvider client={qc}><ChatPanel /></QueryClientProvider>);
    expect(bubbleTexts()).toEqual(["b-only"]);

    openProject("A", [{ id: 1, role: "user", content: "a-only" }]);
    view.rerender(<QueryClientProvider client={qc}><ChatPanel /></QueryClientProvider>);
    expect(bubbleTexts()).toEqual(["a-only"]);
  });
});

describe("ChatPanel — auto-scroll fires on message append (T-B13)", () => {
  it("scrollIntoView called for the user echo and the final assistant append", async () => {
    setViewerStoreStateForTest({ publicId: "p" });
    const spy = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(mockSSE(['{"content":"a"}', '{"content":"b"}', "[DONE]"]));
    renderChatPanel();
    spy.mockClear();

    await sendMessage("hi");

    await waitFor(() => expect(bubbleTexts()).toEqual(["hi", "ab"]));
    // at minimum the two message-driven appends triggered a smooth scroll
    expect(spy).toHaveBeenCalledWith({ behavior: "smooth" });
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
