"use client";

import { useState, useRef, useEffect } from "react";
import { useNavigation } from "@/stores/viewerCoreStore";
import { navigateViewerPage } from "@/stores/viewerCommands";
import { useUiStore } from "@/stores/uiStore";
import { useProject } from "@/stores/sessionStore";
// [refactor jul9 P2.2①] chat message DATA now lives in the TanStack Query cache (facade hook);
// useChat() is shrunk to the chatScope UI knob. showChatPanel still comes from usePanels().
import { useChatMessages } from "@/queries/useChatMessages";
// [refactor jul5 S025] ai-chat fold flipped route-level errors to {error:{code,message}};
// apiErrorMessage reads both that and the still-flat delegated errors (503 no-LLM, demo 403).
import { apiErrorMessage } from "@/lib/client-persist";
import { useProjectLifecycleGuard } from "@/hooks/useProjectLifecycleGuard";

const DISCIPLINE_PROMPTS: Record<string, string[]> = {
  A: ["What rooms are shown?", "Door/window schedules?", "What finishes are specified?", "Any accessibility notes?"],
  S: ["What structural members?", "Concrete specs (f'c)?", "Foundation details?", "Any rebar callouts?"],
  M: ["List HVAC equipment", "What are the CFM values?", "Ductwork layout?", "Any mechanical schedules?"],
  E: ["Panel schedules on this page?", "Circuit assignments?", "What voltage is specified?", "Conduit routing?"],
  P: ["Plumbing fixtures?", "Pipe sizes mentioned?", "What GPM values?", "Drain locations?"],
  FP: ["Sprinkler layout?", "Fire alarm devices?", "What fire ratings?", "FDC location?"],
};

const DEFAULT_PAGE_PROMPTS = [
  "Summarize this page",
  "List all materials mentioned",
  "What trades are on this sheet?",
  "What are the key dimensions?",
  "Any notes or special instructions?",
];

const PROJECT_PROMPTS = [
  "Summarize this project",
  "List all trades across sheets",
  "How many pages per discipline?",
  "What CSI codes were detected?",
  "Any coordination issues?",
];

function getDisciplineFromPageName(pageName: string): string | null {
  const match = /^([A-Z]{1,2})-?\d/i.exec(pageName);
  return match ? match[1].toUpperCase() : null;
}

export default function ChatPanel() {
  // [refactor jul9 P2.2①] message data from the query-cache facade; scope stays zustand UI state.
  const { chatMessages, addChatMessage, clearChatMessages } = useChatMessages();
  const chatScope = useUiStore((s) => s.chatScope);
  const setChatScope = useUiStore((s) => s.setChatScope);
  const { publicId, isDemo, pageNames } = useProject();
  const canAdoptProjectLifecycle = useProjectLifecycleGuard(publicId, isDemo);
  const { pageNumber } = useNavigation();

  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [activeToolCall, setActiveToolCall] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sendRevisionRef = useRef(0);
  const clearRevisionRef = useRef(0);
  const highlightRevisionRef = useRef(0);

  useEffect(() => {
    // Retire every local tail when the exact render generation changes. Resetting here gives the
    // successor usable controls without allowing an obsolete catch/finally to publish into it.
    sendRevisionRef.current += 1;
    clearRevisionRef.current += 1;
    highlightRevisionRef.current += 1;
    setLoading(false);
    setClearing(false);
    setStreamingContent("");
    setActiveToolCall(null);
  }, [canAdoptProjectLifecycle]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages, streamingContent]);

  async function handleClear() {
    if (!canAdoptProjectLifecycle()) return;
    if (chatMessages.length === 0 || clearing) return;
    if (isDemo) {
      // Demo messages are intentionally transient. Clear the keyed client cache without issuing
      // a write request that the server must reject at the immutable demo boundary.
      clearChatMessages();
      return;
    }
    const revision = ++clearRevisionRef.current;
    const canAdoptClear = () =>
      clearRevisionRef.current === revision && canAdoptProjectLifecycle();
    setClearing(true);
    if (!canAdoptClear()) return;
    try {
      const params = new URLSearchParams({ projectId: publicId, scope: chatScope });
      if (chatScope === "page") params.set("pageNumber", String(pageNumber));
      const res = await fetch(`/api/ai/chat?${params}`, { method: "DELETE" });
      if (!canAdoptClear() || !res.ok) return;
      clearChatMessages();
    } catch {
      // silently fail — messages stay in UI
    } finally {
      if (canAdoptClear()) setClearing(false);
    }
  }

  async function handleSend() {
    if (!canAdoptProjectLifecycle()) return;
    const msg = input.trim();
    if (!msg || loading) return;
    const revision = ++sendRevisionRef.current;
    const canAdoptSend = () =>
      sendRevisionRef.current === revision && canAdoptProjectLifecycle();

    setInput("");
    if (!canAdoptSend()) return;
    setLoading(true);
    if (!canAdoptSend()) return;
    setStreamingContent("");
    if (!canAdoptSend()) return;

    // Add user message to store immediately
    addChatMessage({ role: "user", content: msg });
    if (!canAdoptSend()) return;

    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: publicId,
          pageNumber: chatScope === "page" ? pageNumber : null,
          message: msg,
          scope: chatScope,
        }),
      });
      if (!canAdoptSend()) return;

      if (!res.ok) {
        const err = await res.json().catch(() => undefined);
        if (!canAdoptSend()) return;
        addChatMessage({
          role: "assistant",
          content: `Error: ${apiErrorMessage(err) || "Chat failed"}`,
        });
        return;
      }

      // Read streaming response with proper SSE buffering
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let fullContent = "";
      let buffer = "";

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (!canAdoptSend()) return;
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // SSE messages are separated by double newlines
          const messages = buffer.split("\n\n");
          // Keep the last segment as buffer (may be incomplete)
          buffer = messages.pop() || "";

          for (const message of messages) {
            for (const line of message.split("\n")) {
              if (line.startsWith("data: ")) {
                const data = line.slice(6);
                if (data === "[DONE]") continue;
                try {
                  const parsed = JSON.parse(data);
                  if (parsed.content) {
                    fullContent += parsed.content;
                    if (!canAdoptSend()) return;
                    setStreamingContent(fullContent);
                  } else if (parsed.tool_call) {
                    // Tool use progress
                    if (!canAdoptSend()) return;
                    if (parsed.status === "start") {
                      setActiveToolCall(parsed.tool_call);
                    } else {
                      setActiveToolCall(null);
                    }
                  } else if (parsed.action) {
                    // LLM action: navigate, highlight, createMarkup
                    const act = parsed.action;
                    if (act.action === "navigate" && act.pageNumber) {
                      if (!canAdoptSend()) return;
                      navigateViewerPage(act.pageNumber);
                    } else if (act.action === "highlight" && act.bbox) {
                      if (!canAdoptSend()) return;
                      navigateViewerPage(act.pageNumber);
                      if (!canAdoptSend()) return;
                      const highlight = {
                        pageNumber: act.pageNumber,
                        bbox: act.bbox,
                        label: act.label,
                      };
                      const highlightRevision = ++highlightRevisionRef.current;
                      useUiStore.getState().setLlmHighlight(highlight);
                      setTimeout(() => {
                        if (
                          highlightRevisionRef.current !== highlightRevision ||
                          !canAdoptSend() ||
                          useUiStore.getState().llmHighlight !== highlight
                        ) return;
                        highlightRevisionRef.current += 1;
                        useUiStore.getState().setLlmHighlight(null);
                      }, 8000);
                    }
                  } else if (parsed.error) {
                    fullContent = `Error: ${parsed.error}`;
                    if (!canAdoptSend()) return;
                    setStreamingContent(fullContent);
                  }
                } catch {
                  // skip malformed chunks
                }
              }
            }
          }
        }
      }

      // Add complete assistant message to store
      if (!canAdoptSend()) return;
      addChatMessage({
        role: "assistant",
        content: fullContent || "No response received. Check LLM configuration in admin panel.",
      });
    } catch {
      if (!canAdoptSend()) return;
      addChatMessage({
        role: "assistant",
        content: "Error: Failed to connect. Please try again.",
      });
    } finally {
      if (canAdoptSend()) {
        setLoading(false);
        if (canAdoptSend()) {
          setStreamingContent("");
          if (canAdoptSend()) {
            setActiveToolCall(null);
            if (canAdoptSend()) inputRef.current?.focus();
          }
        }
      }
    }
  }

  return (
    <div className="w-80 border border-[var(--border)] bg-[var(--surface)] flex flex-col shrink-0 shadow-lg">
      {/* Header with scope toggle */}
      <div className="p-3 border-b border-[var(--border)] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs text-[var(--muted)]">LLM Chat</span>
          {chatMessages.length > 0 && (
            <button
              onClick={handleClear}
              disabled={clearing}
              className="text-[10px] text-red-400/60 hover:text-red-400 disabled:opacity-40"
              title="Clear chat history"
            >
              Clear
            </button>
          )}
        </div>
        <div className="flex border border-[var(--border)] rounded overflow-hidden">
          <button
            onClick={() => setChatScope("page")}
            className={`px-2 py-0.5 text-[10px] ${
              chatScope === "page"
                ? "bg-[var(--accent)] text-white"
                : "text-[var(--muted)] hover:text-[var(--fg)]"
            }`}
          >
            Page {pageNumber}
          </button>
          <button
            onClick={() => setChatScope("project")}
            className={`px-2 py-0.5 text-[10px] ${
              chatScope === "project"
                ? "bg-[var(--accent)] text-white"
                : "text-[var(--muted)] hover:text-[var(--fg)]"
            }`}
          >
            Project
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3 min-h-0">
        {chatMessages.length === 0 && !loading && (
          <div className="text-[var(--muted)] text-xs text-center mt-8 space-y-2">
            <div>
              Ask a question about this{" "}
              {chatScope === "page" ? "page" : "project"}
            </div>
            <div className="text-[10px] opacity-60">
              Try a quick prompt below, or type your own question
            </div>
          </div>
        )}

        {chatMessages.map((msg, i) => (
          <div
            key={i}
            className={`text-sm ${
              msg.role === "user"
                ? "ml-8 bg-[var(--accent)]/20 rounded-lg p-2"
                : "mr-4 bg-[var(--bg)] rounded-lg p-2"
            }`}
          >
            <div className="text-[10px] text-[var(--muted)] mb-1">
              {msg.role === "user" ? "You" : "AI"}
            </div>
            <div className="whitespace-pre-wrap break-words leading-relaxed">
              {msg.content}
            </div>
          </div>
        ))}

        {/* Streaming response */}
        {loading && streamingContent && (
          <div className="mr-4 bg-[var(--bg)] rounded-lg p-2 text-sm">
            <div className="text-[10px] text-[var(--muted)] mb-1">AI</div>
            <div className="whitespace-pre-wrap break-words leading-relaxed">
              {streamingContent}
              <span className="animate-pulse">|</span>
            </div>
          </div>
        )}

        {loading && !streamingContent && !activeToolCall && (
          <div className="mr-4 bg-[var(--bg)] rounded-lg p-2 text-sm">
            <div className="text-[10px] text-[var(--muted)] mb-1">AI</div>
            <div className="text-[var(--muted)] animate-pulse">Thinking...</div>
          </div>
        )}
        {loading && activeToolCall && (
          <div className="mr-4 bg-[var(--bg)]/50 rounded-lg px-2 py-1">
            <div className="text-cyan-400 text-[10px] animate-pulse flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-ping" />
              {activeToolCall.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase()).replace(/\bCsi\b/g, "CSI").replace(/\bOcr\b/g, "OCR").replace(/\bYolo\b/g, "YOLO")}...
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Quick prompts — discipline-aware for page scope */}
      {chatMessages.length === 0 && !loading && (
        <div className="px-3 pb-2 flex flex-wrap gap-1.5">
          {(chatScope === "page"
            ? (() => {
                const pageName = pageNames[pageNumber] || "";
                const disc = getDisciplineFromPageName(pageName);
                const specific = disc ? DISCIPLINE_PROMPTS[disc] : null;
                return specific
                  ? ["Summarize this page", ...specific.slice(0, 3)]
                  : DEFAULT_PAGE_PROMPTS;
              })()
            : PROJECT_PROMPTS
          ).map((prompt) => (
            <button
              key={prompt}
              onClick={() => { setInput(prompt); inputRef.current?.focus(); }}
              className="px-2 py-1 text-[10px] rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--accent)] hover:border-[var(--accent)]/50 transition-colors"
            >
              {prompt}
            </button>
          ))}
        </div>
      )}

      {/* Input */}
      <div className="p-3 border-t border-[var(--border)]">
        <div className="flex gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={`Ask about this ${chatScope === "page" ? "page" : "project"}...`}
            rows={2}
            className="flex-1 px-2 py-1.5 text-sm bg-[var(--bg)] border border-[var(--border)] rounded resize-none focus:outline-none focus:border-[var(--accent)]"
            disabled={loading}
          />
          <button
            onClick={handleSend}
            disabled={loading || !input.trim()}
            className="px-3 self-end py-1.5 bg-[var(--accent)] text-white text-sm rounded hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
