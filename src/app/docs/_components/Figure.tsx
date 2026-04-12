import type { ReactNode } from "react";

type FigureFrame = "viewer" | "panel" | "page" | "none";
type FigureSize = "sm" | "md" | "lg" | "full";

interface FigureProps {
  kind: "live";
  caption: string;
  children: ReactNode;
  frame?: FigureFrame;
  size?: FigureSize;
}

const SIZE_CLASS: Record<FigureSize, string> = {
  sm: "max-w-md",
  md: "max-w-2xl",
  lg: "max-w-4xl",
  full: "w-full",
};

function FrameChrome({ variant, children }: { variant: FigureFrame; children: ReactNode }) {
  if (variant === "none") return <>{children}</>;

  const label = variant === "viewer" ? "blueprint viewer" : variant === "panel" ? "panel" : "page";
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]/60">
      <div className="flex items-center gap-1.5 border-b border-[var(--border)] px-3 py-1.5 bg-[var(--bg)]/50">
        <span className="w-2.5 h-2.5 rounded-full bg-red-400/50" aria-hidden="true" />
        <span className="w-2.5 h-2.5 rounded-full bg-amber-400/50" aria-hidden="true" />
        <span className="w-2.5 h-2.5 rounded-full bg-emerald-400/50" aria-hidden="true" />
        <span className="ml-2 text-[10px] uppercase tracking-wider text-[var(--muted)]">{label}</span>
      </div>
      <div className="relative">{children}</div>
    </div>
  );
}

export function Figure({ caption, frame = "none", size = "md", children }: FigureProps) {
  return (
    <figure className={`my-6 ${SIZE_CLASS[size]}`}>
      <FrameChrome variant={frame}>
        <div className="p-4 bg-[var(--bg)]/30">{children}</div>
      </FrameChrome>
      <figcaption className="mt-2 text-xs text-[var(--muted)] italic leading-relaxed">
        {caption}
      </figcaption>
    </figure>
  );
}
