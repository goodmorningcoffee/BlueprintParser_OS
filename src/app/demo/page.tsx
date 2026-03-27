"use client";

import { useEffect, useState, useRef } from "react";
import Link from "next/link";

interface DemoProject {
  id: string;
  name: string;
  numPages: number | null;
  status: string;
  thumbnailUrl: string | null;
}

export default function DemoPage() {
  const [projects, setProjects] = useState<DemoProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [contentMatches, setContentMatches] = useState<Record<string, { matchCount: number; pageCount: number }>>({});
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [csiCodes, setCsiCodes] = useState<Array<{ code: string; description: string; trade: string; division: string; projectCount: number; pageCount: number; projectIds: string[]; projectSheetCounts: Record<string, number> }>>([]);
  const [activeCsiFilter, setActiveCsiFilter] = useState<string | null>(null);
  const [showCsi, setShowCsi] = useState(false);

  const [chatOpen, setChatOpen] = useState(true);
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<Array<{ role: string; content: string }>>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatStreaming, setChatStreaming] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/demo/projects")
      .then((r) => r.json())
      .then(setProjects)
      .finally(() => setLoading(false));
  }, []);

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
      try {
        const res = await fetch(`/api/demo/search?q=${encodeURIComponent(search.trim())}`);
        if (res.ok) {
          const data = await res.json();
          const matches: Record<string, { matchCount: number; pageCount: number }> = {};
          for (const r of data.results) {
            matches[r.projectId] = { matchCount: r.matchCount, pageCount: r.pageCount };
          }
          setContentMatches(matches);
        }
      } catch { /* ignore */ }
      setSearchLoading(false);
    }, 300);
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
  }, [search]);

  useEffect(() => {
    fetch("/api/demo/csi")
      .then((r) => r.ok ? r.json() : [])
      .then(setCsiCodes)
      .catch(() => {});
  }, []);

  async function sendChat() {
    const msg = chatInput.trim();
    if (!msg || chatLoading) return;
    setChatInput("");
    setChatMessages((prev) => [...prev, { role: "user", content: msg }]);
    setChatLoading(true);
    setChatStreaming("");

    try {
      const res = await fetch("/api/demo/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg }),
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
          const lines = text.split("\n");
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const data = line.slice(6);
              if (data === "[DONE]") break;
              try {
                const parsed = JSON.parse(data);
                if (parsed.content) {
                  fullContent += parsed.content;
                  setChatStreaming(fullContent);
                }
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

  const hasContentResults = Object.keys(contentMatches).length > 0;
  const filtered = projects.filter((p) => {
    if (activeCsiFilter) {
      const csi = csiCodes.find((c) => c.code === activeCsiFilter);
      if (csi && !csi.projectIds.includes(p.id)) return false;
    }
    if (!search) return true;
    const nameMatch = p.name.toLowerCase().includes(search.toLowerCase());
    const contentMatch = contentMatches[p.id] !== undefined;
    return nameMatch || contentMatch;
  });

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <div className="h-14 border-b border-[var(--border)] bg-[var(--surface)] flex items-center justify-between px-6">
        <div className="flex items-center gap-3">
          <span className="text-lg font-bold">BlueprintParser</span>
          <span className="text-xs px-2 py-0.5 rounded bg-[var(--accent)]/20 text-[var(--accent)]">
            Demo
          </span>
        </div>
        <Link
          href="/login"
          className="px-4 py-1.5 text-sm bg-[var(--accent)] text-white rounded hover:bg-[var(--accent-hover)] transition-colors"
        >
          Sign In
        </Link>
      </div>

      {/* Hero */}
      <div className="px-6 py-12 text-center">
        <h1 className="text-3xl font-bold mb-3">
          AI-Powered Blueprint Analysis
        </h1>
        <p className="text-[var(--muted)] max-w-2xl mx-auto">
          Upload construction blueprints and instantly search text across all
          pages, detect CSI codes, and chat with AI about your
          drawings via self-hosted LLMs or your own subscription. 
          Run your own models for parsing the plans,
          connect to{" "}
          <a
            href="https://github.com/HumanSignal/label-studio"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--accent)] hover:underline"
          >
            Label Studio
          </a>{" "}
          for data labeling your blueprints, and build your own custom
          Ai-assisted takeoff workflows: all open source and self-hostable.
        </p>
      </div>

      {/* Search + Projects */}
      <main className="flex-1 px-6 pb-12">
        {projects.length > 0 && (
          <div className="max-w-5xl mx-auto mb-4 flex items-center gap-3">
            <div className="relative flex-1 max-w-sm">
              <input
                type="text"
                placeholder="Keyword search across all projects..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-[var(--surface)] border border-sky-400/20 rounded-lg focus:outline-none focus:border-sky-400/50 pr-16"
              />
              <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1">
                {searchLoading && <span className="text-xs text-[var(--muted)] animate-pulse">...</span>}
                {!searchLoading && hasContentResults && (
                  <span className="text-xs text-[var(--accent)]">{Object.keys(contentMatches).length} projects</span>
                )}
                {search && (
                  <button onClick={() => setSearch("")} className="text-xs text-[var(--muted)] hover:text-[var(--fg)] ml-1">x</button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* CSI Codes */}
        {csiCodes.length > 0 && (
          <div className="max-w-5xl mx-auto mb-4">
            <button
              onClick={() => setShowCsi(!showCsi)}
              className="text-xs text-sky-400/70 hover:text-sky-300 flex items-center gap-1"
            >
              {showCsi ? "Hide" : "Show"} CSI Codes ({csiCodes.length})
              {activeCsiFilter && (
                <span className="ml-2 text-[var(--accent)]">
                  Filtering: {activeCsiFilter}
                  <button
                    onClick={(e) => { e.stopPropagation(); setActiveCsiFilter(null); }}
                    className="ml-1 text-[var(--muted)] hover:text-[var(--fg)]"
                  >
                    x
                  </button>
                </span>
              )}
            </button>
            {showCsi && (
              <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-1.5 max-h-48 overflow-y-auto">
                {csiCodes.slice(0, 40).map((c) => (
                  <button
                    key={c.code}
                    onClick={() => setActiveCsiFilter(activeCsiFilter === c.code ? null : c.code)}
                    className={`text-left text-[11px] px-2 py-1 rounded border transition-colors ${
                      activeCsiFilter === c.code
                        ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--fg)]"
                        : "border-[var(--border)] text-[var(--muted)] hover:border-[var(--accent)]/50 hover:text-[var(--fg)]"
                    }`}
                  >
                    <span className="font-medium">{c.code}</span>
                    <span className="block truncate opacity-70">{c.description}</span>
                    <span className="text-[10px] opacity-50">{c.projectCount} proj, {c.pageCount} pg</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {loading ? (
          <div className="text-center text-[var(--muted)]">Loading demo projects...</div>
        ) : projects.length === 0 ? (
          <div className="text-center text-[var(--muted)]">
            No demo projects available. Ask an admin to push projects to demo.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 max-w-5xl mx-auto">
            {filtered.map((p) => {
              const activeCsi = activeCsiFilter ? csiCodes.find((c) => c.code === activeCsiFilter) : null;
              const sheetCount = activeCsi?.projectSheetCounts?.[p.id];
              return (
              <Link
                key={p.id}
                href={activeCsiFilter ? `/demo/project/${p.id}?csi=${encodeURIComponent(activeCsiFilter)}` : `/demo/project/${p.id}`}
                className="block p-4 bg-[var(--surface)] border border-[var(--border)] rounded-lg hover:border-[var(--accent)] transition-colors"
              >
                <div className="aspect-[4/3] bg-[var(--bg)] rounded mb-3 overflow-hidden flex items-center justify-center">
                  {p.thumbnailUrl ? (
                    <img
                      src={p.thumbnailUrl}
                      alt={p.name}
                      className="w-full h-full object-contain"
                    />
                  ) : (
                    <span className="text-[var(--muted)] text-sm">
                      {p.numPages || "?"} pages
                    </span>
                  )}
                </div>
                <h3 className="font-medium truncate">{p.name}</h3>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-[var(--muted)]">
                    {p.numPages} pages
                  </span>
                  {sheetCount ? (
                    <span className="text-xs text-sky-400">
                      {sheetCount} sheet{sheetCount !== 1 ? "s" : ""}
                    </span>
                  ) : contentMatches[p.id] ? (
                    <span className="text-xs text-[var(--accent)]">
                      {contentMatches[p.id].matchCount} matches
                    </span>
                  ) : null}
                </div>
              </Link>
              );
            })}
          </div>
        )}
      </main>

      {/* CTA */}
      <InviteCTA />

      {/* Floating chat widget */}
      <div className="fixed bottom-6 right-6 z-50">
        {chatOpen ? (
          <div className="w-96 h-[500px] bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-2xl flex flex-col">
            {/* Header */}
            <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between shrink-0">
              <span className="text-sm font-medium">LLM Chat — All Projects</span>
              <button onClick={() => setChatOpen(false)} className="text-[var(--muted)] hover:text-[var(--fg)] text-xs">x</button>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-3 space-y-2 min-h-0">
              {chatMessages.length === 0 && !chatLoading && (
                <div className="text-[var(--muted)] text-xs text-center mt-8 space-y-2">
                  <div>LLM chat across all demo blueprints (RAG)</div>
                  <div className="text-[10px] opacity-60">Try: &quot;What projects have electrical plans?&quot;</div>
                </div>
              )}
              {chatMessages.map((msg, i) => (
                <div key={i} className={`text-sm rounded-lg p-2 ${
                  msg.role === "user" ? "ml-8 bg-[var(--accent)]/20" : "mr-4 bg-[var(--bg)]"
                }`}>
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

            {/* Input */}
            <div className="p-3 border-t border-[var(--border)] shrink-0">
              <div className="flex gap-2">
                <input
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } }}
                  placeholder="Ask about blueprints..."
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

function InviteCTA() {
  const [showForm, setShowForm] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.includes("@")) { setError("Valid email required"); return; }
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, name, company }),
      });
      if (res.ok) {
        setSubmitted(true);
      } else {
        setError("Failed to submit. Try again.");
      }
    } catch {
      setError("Network error.");
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <div className="px-6 py-8 text-center border-t border-[var(--border)] bg-[var(--surface)]">
        <p className="text-emerald-400">Invite requested! We'll be in touch.</p>
      </div>
    );
  }

  return (
    <div className="px-6 py-8 text-center border-t border-[var(--border)] bg-[var(--surface)]">
      {!showForm ? (
        <>
          <p className="text-[var(--muted)] mb-3">
            Want full access? Upload your own blueprints, run custom models, and more.
          </p>
          <button
            onClick={() => setShowForm(true)}
            className="px-6 py-2 bg-[var(--accent)] text-white rounded-lg hover:bg-[var(--accent-hover)] transition-colors"
          >
            Request Invite
          </button>
        </>
      ) : (
        <form onSubmit={handleSubmit} className="max-w-sm mx-auto space-y-2">
          <p className="text-sm text-[var(--muted)] mb-2">Request an invite to get full access.</p>
          <input
            type="email"
            placeholder="Email *"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="w-full px-3 py-2 text-sm bg-[var(--bg)] border border-[var(--border)] rounded focus:outline-none focus:border-[var(--accent)]"
          />
          <input
            type="text"
            placeholder="Name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2 text-sm bg-[var(--bg)] border border-[var(--border)] rounded focus:outline-none focus:border-[var(--accent)]"
          />
          <input
            type="text"
            placeholder="Company (optional)"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            className="w-full px-3 py-2 text-sm bg-[var(--bg)] border border-[var(--border)] rounded focus:outline-none focus:border-[var(--accent)]"
          />
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex gap-2 justify-center pt-1">
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="px-4 py-1.5 text-sm text-[var(--muted)] hover:text-[var(--fg)]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-1.5 text-sm bg-[var(--accent)] text-white rounded hover:bg-[var(--accent-hover)] disabled:opacity-50"
            >
              {submitting ? "Submitting..." : "Submit"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
