import type { ReactNode } from "react";

interface SubSectionProps {
  id?: string;
  title: string;
  children: ReactNode;
}

export function SubSection({ id, title, children }: SubSectionProps) {
  return (
    <div id={id} className="mt-8 scroll-mt-20">
      <h3 className="text-lg font-semibold text-[var(--fg)] mb-3">
        {title}
      </h3>
      <div className="space-y-3">{children}</div>
    </div>
  );
}
