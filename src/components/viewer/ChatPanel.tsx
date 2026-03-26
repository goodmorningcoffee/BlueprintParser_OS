"use client";

import { useState, useRef, useEffect } from "react";
import { useViewerStore } from "@/stores/viewerStore";

export default function ChatPanel() {
  const {
    chatMessages,
    addChatMessage,
    clearChatMessages,
    chatScope,
    setChatScope,
    publicId,
    pageNumber,
  } = useViewerStore();

  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages, streamingContent]);

  async function handleClear() {
    if (chatMessages.length === 0 || clearing) return;
    setClearing(true);
    try {
      const params = new URLSearchParams({ projectId: publicId, scope: chatScope });
      if (chatScope === "page") params.set("pageNumber", String(pageNumber));
      await fetch(`/api/ai/chat?${params}`, { method: "DELETE" });
      clearChatMessages();
    } catch {
      // silently fail — messages stay in UI
    } finally {
      setClearing(false);
    }
  }

  async function handleSend() {
    const msg = input.trim();
    if (!msg || loading) return;

    setInput("");
    setLoading(true);
    setStreamingContent("");

    // Add user message to store immediately
    addChatMessage({ role: "user", content: msg });

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

      if (!res.ok) {
        const err = await res.json();
        addChatMessage({
          role: "assistant",
          content: `Error: ${err.error || "Chat failed"}`,
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
      if (fullContent) {
        addChatMessage({
          role: "assistant",
          content: fullContent,
          model: "llama-3.3-70b-versatile",
        });
      }
    } catch (err) {
      addChatMessage({
        role: "assistant",
        content: "Error: Failed to connect. Please try again.",
      });
    } finally {
      setLoading(false);
      setStreamingContent("");
      inputRef.current?.focus();
    }
  }

  return (
    <div className="w-80 border-l border-[var(--border)] bg-[var(--surface)] flex flex-col shrink-0">
      {/* Header with scope toggle */}
      <div className="p-3 border-b border-[var(--border)] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs text-[var(--muted)]">Chat</span>
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
              {chatScope === "page" ? "page" : "project"}...
            </div>
            <div className="text-[10px] opacity-60">
              Hint: try &quot;How do I use BlueprintParser?&quot;
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

        {loading && !streamingContent && (
          <div className="mr-4 bg-[var(--bg)] rounded-lg p-2 text-sm">
            <div className="text-[10px] text-[var(--muted)] mb-1">AI</div>
            <div className="text-[var(--muted)] animate-pulse">Thinking...</div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

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
