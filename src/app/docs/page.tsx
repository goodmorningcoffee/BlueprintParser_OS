"use client";

import Link from "next/link";
import { useState } from "react";
import { Landing } from "./_components/Landing";
import { TocSidebar, type TocEntry } from "./_components/TocSidebar";
import {
  Section01Overview,
  Section02Viewer,
  Section03Preprocessing,
  Section04CsiEngine,
  Section05YoloPipeline,
  Section06TablesAndTags,
  Section07AutoQto,
  Section08BucketFill,
  Section09LlmAndTools,
  Section10Admin,
  Section11Architecture,
  Section12ApiReference,
} from "./sections";

const TOC: TocEntry[] = [
  { id: "overview", label: "Overview", group: "Intro" },
  { id: "viewer", label: "The Viewer", group: "User Guide" },
  { id: "preprocessing", label: "Pre-Processing", group: "Engines" },
  { id: "csi-engine", label: "CSI Engine", group: "Engines" },
  { id: "yolo-pipeline", label: "YOLO Pipeline", group: "Engines" },
  { id: "tables-and-tags", label: "Tables & Tags", group: "Engines" },
  { id: "auto-qto", label: "Auto-QTO", group: "Engines" },
  { id: "bucket-fill", label: "Bucket Fill", group: "Engines" },
  { id: "llm-and-tools", label: "LLM & Tools", group: "Engines" },
  { id: "admin", label: "Admin Dashboard", group: "Operations" },
  { id: "architecture", label: "Architecture", group: "Operations" },
  { id: "api-reference", label: "API Reference", group: "Operations" },
];

export default function DocsPage() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--fg)]">
      {/* Sticky header */}
      <header className="fixed top-0 left-0 right-0 z-50 bg-[var(--bg)]/95 backdrop-blur border-b border-[var(--border)] h-14 px-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            className="lg:hidden p-1.5 rounded hover:bg-[var(--surface)]"
            onClick={() => setSidebarOpen((o) => !o)}
            aria-label="Toggle sidebar"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <Link href="/" className="text-lg font-bold text-[var(--accent)] hover:opacity-80">
            BlueprintParser
          </Link>
          <span className="text-sm text-[var(--muted)] hidden sm:inline">
            Documentation
          </span>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/demo"
            className="text-xs text-[var(--muted)] hover:text-[var(--fg)]"
          >
            Demo
          </Link>
          <a
            href="https://github.com/anthropics/blueprintparser"
            target="_blank"
            rel="noreferrer noopener"
            className="text-xs text-[var(--muted)] hover:text-[var(--fg)]"
          >
            GitHub ↗
          </a>
        </div>
      </header>

      <div className="pt-14 flex">
        {/* TOC sidebar */}
        <TocSidebar toc={TOC} open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

        {/* Main content */}
        <main className="flex-1 min-w-0 px-6 lg:px-10 py-8 max-w-4xl mx-auto lg:mx-0">
          <Landing />
          <Section01Overview />
          <Section02Viewer />
          <Section03Preprocessing />
          <Section04CsiEngine />
          <Section05YoloPipeline />
          <Section06TablesAndTags />
          <Section07AutoQto />
          <Section08BucketFill />
          <Section09LlmAndTools />
          <Section10Admin />
          <Section11Architecture />
          <Section12ApiReference />

          <footer className="mt-16 pt-8 border-t border-[var(--border)] text-[11px] text-[var(--muted)]">
            <p>
              BlueprintParser is open source. Found an error in these docs? Edit{" "}
              <code className="font-mono">src/app/docs/sections/</code> &mdash;
              every section is a standalone TSX file, and every visual either
              mounts a real React component or is a committed screenshot under{" "}
              <code className="font-mono">public/docs/shots/</code>.
            </p>
          </footer>
        </main>
      </div>
    </div>
  );
}
