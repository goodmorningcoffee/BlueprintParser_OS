"use client";

import { useEffect, useState, useRef } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import Header from "@/components/dashboard/Header";
import ProjectGrid from "@/components/dashboard/ProjectGrid";
import UploadWidget from "@/components/dashboard/UploadWidget";

interface ProjectData {
  id: string;
  name: string;
  numPages: number | null;
  status: string;
  pagesProcessed: number | null;
  createdAt: string | null;
  thumbnailUrl: string | null;
}

interface ContentMatch {
  matchCount: number;
  pageCount: number;
}

export default function HomePage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectData[]>([]);
  const [search, setSearch] = useState("");
  const [contentMatches, setContentMatches] = useState<Record<string, ContentMatch>>({});
  const [searchLoading, setSearchLoading] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [chatOpen, setChatOpen] = useState(true);
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<Array<{ role: string; content: string }>>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatStreaming, setChatStreaming] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
  }, [status, router]);

  useEffect(() => {
    if (session) loadProjects();
  }, [session]);

  // Poll for status updates when any project is uploading/processing
  useEffect(() => {
    const hasPending = projects.some(
      (p) => p.status === "uploading" || p.status === "processing"
    );
    if (!hasPending || !session) return;

    const interval = setInterval(loadProjects, 2000);
    return () => clearInterval(interval);
  }, [projects, session]);

  // Debounced cross-project content search
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);

    if (!search || search.trim().length < 2) {
      setContentMatches({});
      setSearchLoading(false);
      return;
    }

    setSearchLoading(true);

    searchTimerRef.current = setTimeout(async () => {
      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const params = new URLSearchParams({ q: search.trim() });
        const res = await fetch(`/api/search/global?${params}`, {
          signal: controller.signal,
        });

        if (!res.ok) {
          setContentMatches({});
          return;
        }

        const data = await res.json();
        const matches: Record<string, ContentMatch> = {};
        for (const r of data.results) {
          matches[r.projectId] = {
            matchCount: r.matchCount,
            pageCount: r.pageCount,
          };
        }
        setContentMatches(matches);
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setContentMatches({});
        }
      } finally {
        setSearchLoading(false);
      }
    }, 300);

    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [search]);

  async function loadProjects() {
    const res = await fetch("/api/projects");
    if (res.ok) setProjects(await res.json());
  }

  async function sendChat() {
    const msg = chatInput.trim();
    if (!msg || chatLoading) return;
    setChatInput("");
    setChatMessages((prev) => [...prev, { role: "user", content: msg }]);
    setChatLoading(true);
    setChatStreaming("");
    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg, scope: "global" }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Failed" }));
        setChatMessages((prev) => [...prev, { role: "assistant", content: `Error: ${err.error}` }]);
        setChatLoading(false);
        return;
      }
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let fullContent = "";
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          for (const line of text.split("\n")) {
            if (line.startsWith("data: ")) {
              const data = line.slice(6);
              if (data === "[DONE]") break;
              try {
                const parsed = JSON.parse(data);
                if (parsed.content) { fullContent += parsed.content; setChatStreaming(fullContent); }
              } catch { /* skip */ }
            }
          }
        }
      }
      setChatMessages((prev) => [...prev, { role: "assistant", content: fullContent || "No response" }]);
      setChatStreaming("");
    } catch {
      setChatMessages((prev) => [...prev, { role: "assistant", content: "Network error" }]);
    }
    setChatLoading(false);
  }

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages, chatStreaming]);

  // Filter: show projects matching by name OR by content
  const hasContentResults = Object.keys(contentMatches).length > 0;
  const filtered = projects.filter((p) => {
    if (!search) return true;
    const nameMatch = p.name.toLowerCase().includes(search.toLowerCase());
    const contentMatch = contentMatches[p.id] !== undefined;
    return nameMatch || contentMatch;
  });

  if (status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center text-[var(--muted)]">
        Loading...
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 p-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-4">
            <h2 className="text-xl font-semibold">Projects</h2>
            <div className="relative">
              <input
                type="text"
                placeholder="Keyword search across all projects..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="px-3 py-1.5 bg-[var(--surface)] border border-[var(--border)] rounded-lg text-sm focus:outline-none focus:border-[var(--accent)] w-72 pr-16"
              />
              <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                {searchLoading && (
                  <span className="text-xs text-[var(--muted)] animate-pulse">...</span>
                )}
                {!searchLoading && hasContentResults && (
                  <span className="text-xs text-[var(--accent)]">
                    {Object.keys(contentMatches).length} projects
                  </span>
                )}
                {search && (
                  <button
                    onClick={() => setSearch("")}
                    className="text-xs text-[var(--muted)] hover:text-[var(--fg)] ml-0.5"
                  >
                    x
                  </button>
                )}
              </div>
            </div>
          </div>
          <UploadWidget onUploadComplete={loadProjects} />
        </div>
        <ProjectGrid
          projects={filtered}
          onDelete={(id) => setProjects((prev) => prev.filter((p) => p.id !== id))}
          onRename={(id, newName) => setProjects((prev) => prev.map((p) => p.id === id ? { ...p, name: newName } : p))}
          contentMatches={hasContentResults ? contentMatches : undefined}
        />
      </main>

      {/* Floating LLM Chat widget */}
      <div className="fixed bottom-6 right-6 z-50">
        {chatOpen ? (
          <div className="w-96 h-[500px] bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-2xl flex flex-col">
            <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between shrink-0">
              <span className="text-sm font-medium">LLM Chat — All Projects</span>
              <button onClick={() => setChatOpen(false)} className="text-[var(--muted)] hover:text-[var(--fg)] text-xs">x</button>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-2 min-h-0">
              {chatMessages.length === 0 && !chatLoading && (
                <div className="text-[var(--muted)] text-xs text-center mt-8 space-y-2">
                  <div>LLM chat across all your projects (RAG)</div>
                  <div className="text-[10px] opacity-60">Try: &quot;What projects have electrical plans?&quot;</div>
                </div>
              )}
              {chatMessages.map((msg, i) => (
                <div key={i} className={`text-sm rounded-lg p-2 ${msg.role === "user" ? "ml-8 bg-[var(--accent)]/20" : "mr-4 bg-[var(--bg)]"}`}>
                  <div className="text-[10px] text-[var(--muted)] mb-1">{msg.role === "user" ? "You" : "AI"}</div>
                  <div className="whitespace-pre-wrap break-words leading-relaxed text-xs">{msg.content}</div>
                </div>
              ))}
              {chatStreaming && (
                <div className="text-sm rounded-lg p-2 mr-4 bg-[var(--bg)]">
                  <div className="text-[10px] text-[var(--muted)] mb-1">AI</div>
                  <div className="whitespace-pre-wrap break-words leading-relaxed text-xs">{chatStreaming}</div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>
            <div className="p-3 border-t border-[var(--border)] shrink-0">
              <div className="flex gap-2">
                <input
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } }}
                  placeholder="Ask about your blueprints..."
                  className="flex-1 px-3 py-2 text-sm bg-[var(--bg)] border border-[var(--border)] rounded focus:outline-none focus:border-[var(--accent)]"
                  disabled={chatLoading}
                />
                <button
                  onClick={sendChat}
                  disabled={chatLoading || !chatInput.trim()}
                  className="px-3 py-2 text-sm bg-[var(--accent)] text-white rounded hover:bg-[var(--accent-hover)] disabled:opacity-40"
                >
                  {chatLoading ? "..." : "Send"}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setChatOpen(true)}
            className="w-12 h-12 rounded-full bg-[var(--accent)] text-white shadow-lg hover:bg-[var(--accent-hover)] transition-colors flex items-center justify-center text-lg"
            title="LLM Chat across all projects"
          >
            LLM
          </button>
        )}
      </div>
    </div>
  );
}
