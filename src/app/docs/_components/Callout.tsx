import type { ReactNode } from "react";

type CalloutVariant = "note" | "warn" | "tip" | "info";

interface CalloutProps {
  variant?: CalloutVariant;
  title?: string;
  children: ReactNode;
}

const STYLES: Record<CalloutVariant, { border: string; bg: string; fg: string; label: string }> = {
  note: {
    border: "border-[var(--border)]",
    bg: "bg-[var(--surface)]/60",
    fg: "text-[var(--fg)]/85",
    label: "text-[var(--muted)]",
  },
  warn: {
    border: "border-amber-400/60",
    bg: "bg-amber-500/10",
    fg: "text-amber-100",
    label: "text-amber-300",
  },
  tip: {
    border: "border-emerald-400/50",
    bg: "bg-emerald-500/10",
    fg: "text-emerald-100",
    label: "text-emerald-300",
  },
  info: {
    border: "border-sky-400/50",
    bg: "bg-sky-500/10",
    fg: "text-sky-100",
    label: "text-sky-300",
  },
};

const ICONS: Record<CalloutVariant, string> = {
  note: "▪",
  warn: "⚠",
  tip: "✓",
  info: "ℹ",
};

export function Callout({ variant = "note", title, children }: CalloutProps) {
  const s = STYLES[variant];
  return (
    <div
      className={`border-l-4 ${s.border} ${s.bg} rounded-r px-4 py-3 my-4`}
      role="note"
    >
      {title && (
        <div className={`flex items-center gap-2 text-xs font-semibold uppercase tracking-wider ${s.label} mb-1.5`}>
          <span aria-hidden="true">{ICONS[variant]}</span>
          <span>{title}</span>
        </div>
      )}
      <div className={`text-sm ${s.fg} leading-relaxed`}>{children}</div>
    </div>
  );
}
