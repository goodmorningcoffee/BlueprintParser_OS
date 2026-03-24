"use client";

import { useMemo } from "react";
import { useViewerStore } from "@/stores/viewerStore";

/**
 * Right sidebar panel showing extracted text for the current page.
 * Highlights search matches with <mark> tags.
 */
export default function TextPanel() {
  const pageNumber = useViewerStore((s) => s.pageNumber);
  const textractData = useViewerStore((s) => s.textractData);
  const searchQuery = useViewerStore((s) => s.searchQuery);

  const pageData = textractData[pageNumber];

  // Build highlighted text lines
  const lines = useMemo(() => {
    if (!pageData?.lines) return [];

    const queryTerms = searchQuery
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length >= 2);

    return pageData.lines.map((line) => {
      if (queryTerms.length === 0) return { text: line.text, highlighted: false };

      // HTML-escape first to prevent XSS, then highlight matching terms
      let html = escapeHtml(line.text);
      for (const term of queryTerms) {
        const regex = new RegExp(`(${escapeRegex(term)})`, "gi");
        html = html.replace(regex, "<mark>$1</mark>");
      }

      return { text: html, highlighted: html !== line.text };
    });
  }, [pageData, searchQuery]);

  if (!pageData) {
    return (
      <div className="w-80 border-l border-[var(--border)] bg-[var(--surface)] flex items-center justify-center shrink-0">
        <span className="text-[var(--muted)] text-sm">
          No text extracted for this page
        </span>
      </div>
    );
  }

  return (
    <div className="w-80 border-l border-[var(--border)] bg-[var(--surface)] overflow-y-auto shrink-0">
      <div className="p-3 border-b border-[var(--border)]">
        <span className="text-xs text-[var(--muted)]">
          Extracted Text — Page {pageNumber}
        </span>
        <span className="text-xs text-[var(--muted)] ml-2">
          ({pageData.lines.length} lines, {pageData.words.length} words)
        </span>
      </div>
      <div className="p-3 text-sm leading-relaxed font-mono">
        {lines.map((line, i) => (
          <p
            key={i}
            className="mb-1 break-words"
            dangerouslySetInnerHTML={{ __html: line.text }}
          />
        ))}
      </div>
    </div>
  );
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
