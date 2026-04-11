"use client";

import { useState, type ReactNode } from "react";

interface CodeBlockProps {
  children: ReactNode;
  lang?: string;
  caption?: string;
  copyable?: boolean;
}

export function CodeBlock({ children, lang, caption, copyable }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const text = typeof children === "string" ? children : String(children);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="my-4">
      {caption && (
        <div className="text-xs text-[var(--muted)] mb-1 font-mono">{caption}</div>
      )}
      <div className="relative group">
        <pre className="bg-[var(--surface)] border border-[var(--border)] rounded-lg p-4 overflow-x-auto text-[13px] font-mono text-[var(--fg)] leading-relaxed">
          <code>{children}</code>
        </pre>
        {lang && (
          <div className="absolute top-2 right-2 text-[10px] uppercase tracking-wider text-[var(--muted)] bg-[var(--bg)]/60 px-1.5 py-0.5 rounded pointer-events-none">
            {lang}
          </div>
        )}
        {copyable && (
          <button
            onClick={handleCopy}
            className="absolute top-2 right-2 text-[10px] uppercase tracking-wider text-[var(--muted)] bg-[var(--bg)]/80 hover:text-[var(--fg)] border border-[var(--border)] px-2 py-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity"
            aria-label="Copy code to clipboard"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>
    </div>
  );
}
