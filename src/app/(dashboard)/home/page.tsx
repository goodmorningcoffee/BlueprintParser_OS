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
                placeholder="Search projects & content..."
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
    </div>
  );
}
