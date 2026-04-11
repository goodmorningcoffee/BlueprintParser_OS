import type { ReactNode } from "react";

interface SectionProps {
  id: string;
  eyebrow?: string;
  title: string;
  children: ReactNode;
}

export function Section({ id, eyebrow, title, children }: SectionProps) {
  return (
    <section id={id} className="scroll-mt-20 mb-20">
      {eyebrow && (
        <div className="text-[11px] tracking-[0.18em] uppercase text-[var(--muted)] mb-1">
          {eyebrow}
        </div>
      )}
      <h2 className="text-3xl font-bold text-[var(--fg)] border-b border-[var(--border)] pb-2 mb-6">
        {title}
      </h2>
      <div className="space-y-5 text-[15px] text-[var(--fg)]/95 leading-relaxed">
        {children}
      </div>
    </section>
  );
}
