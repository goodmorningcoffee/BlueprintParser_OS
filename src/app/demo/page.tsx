"use client";

import { useEffect, useState } from "react";
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

  useEffect(() => {
    fetch("/api/demo/projects")
      .then((r) => r.json())
      .then(setProjects)
      .finally(() => setLoading(false));
  }, []);

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
        <p className="text-[var(--muted)] max-w-xl mx-auto">
          Upload construction blueprints, search text across all pages, detect
          keynotes and CSI codes, chat with AI about your drawings, and annotate
          directly on the PDF.
        </p>
      </div>

      {/* Projects */}
      <main className="flex-1 px-6 pb-12">
        {loading ? (
          <div className="text-center text-[var(--muted)]">Loading demo projects...</div>
        ) : projects.length === 0 ? (
          <div className="text-center text-[var(--muted)]">
            No demo projects available. Ask an admin to push projects to demo.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 max-w-5xl mx-auto">
            {projects.map((p) => (
              <Link
                key={p.id}
                href={`/demo/project/${p.id}`}
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
                <span className="text-xs text-[var(--muted)]">
                  {p.numPages} pages
                </span>
              </Link>
            ))}
          </div>
        )}
      </main>

      {/* CTA */}
      <div className="px-6 py-8 text-center border-t border-[var(--border)] bg-[var(--surface)]">
        <p className="text-[var(--muted)] mb-3">
          Want full access? Upload your own blueprints, save annotations, and more.
        </p>
        <Link
          href="/register"
          className="px-6 py-2 bg-[var(--accent)] text-white rounded-lg hover:bg-[var(--accent-hover)] transition-colors"
        >
          Sign Up for Full Access
        </Link>
      </div>
    </div>
  );
}
