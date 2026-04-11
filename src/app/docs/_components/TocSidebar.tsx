"use client";

import { useScrollSpy } from "./useScrollSpy";

export interface TocEntry {
  id: string;
  label: string;
  group: string;
}

interface TocSidebarProps {
  toc: TocEntry[];
  open: boolean;
  onClose: () => void;
}

export function TocSidebar({ toc, open, onClose }: TocSidebarProps) {
  const activeId = useScrollSpy(toc.map((t) => t.id));
  const groups = Array.from(new Set(toc.map((t) => t.group)));

  function scrollTo(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    onClose();
  }

  return (
    <>
      {/* Mobile backdrop */}
      {open && (
        <div
          className="lg:hidden fixed inset-0 z-30 bg-black/50"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      <aside
        className={`
          fixed lg:sticky lg:top-14 left-0 top-14
          h-[calc(100vh-3.5rem)]
          w-64 z-40 lg:z-auto
          overflow-y-auto
          bg-[var(--bg)] lg:bg-transparent
          border-r lg:border-r border-[var(--border)]
          p-4 lg:pl-6 lg:pr-3
          transform transition-transform
          ${open ? "translate-x-0" : "-translate-x-full lg:translate-x-0"}
        `}
      >
        <nav aria-label="Documentation table of contents">
          {groups.map((group) => (
            <div key={group} className="mb-5">
              <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--muted)] mb-1.5 font-semibold">
                {group}
              </div>
              <ul className="space-y-0.5">
                {toc
                  .filter((t) => t.group === group)
                  .map((t) => (
                    <li key={t.id}>
                      <button
                        onClick={() => scrollTo(t.id)}
                        className={`
                          w-full text-left text-[13px] px-2 py-1 rounded
                          transition-colors
                          ${activeId === t.id
                            ? "text-[var(--accent)] bg-[var(--accent)]/10 font-medium"
                            : "text-[var(--fg)]/70 hover:text-[var(--fg)] hover:bg-[var(--surface)]"}
                        `}
                      >
                        {t.label}
                      </button>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </nav>

        <button
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          className="mt-6 w-full text-[11px] text-[var(--muted)] hover:text-[var(--fg)] border-t border-[var(--border)] pt-3 text-left"
        >
          ↑ Back to top
        </button>
      </aside>
    </>
  );
}
