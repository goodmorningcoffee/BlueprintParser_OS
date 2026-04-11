import type { ReactNode } from "react";

export function InlineCode({ children }: { children: ReactNode }) {
  return (
    <code className="bg-[var(--surface)] border border-[var(--border)] rounded px-1.5 py-0.5 text-[0.85em] font-mono text-[var(--accent)]">
      {children}
    </code>
  );
}
