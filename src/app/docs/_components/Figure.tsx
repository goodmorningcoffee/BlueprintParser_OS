"use client";

import { useState, type ReactNode } from "react";

type FigureKind = "live" | "shot";
type FigureFrame = "viewer" | "panel" | "page" | "none";
type FigureSize = "sm" | "md" | "lg" | "full";

interface FigureBaseProps {
  caption: string;
  frame?: FigureFrame;
  size?: FigureSize;
}

interface FigureLiveProps extends FigureBaseProps {
  kind: "live";
  children: ReactNode;
  src?: never;
  alt?: never;
}

interface FigureShotProps extends FigureBaseProps {
  kind: "shot";
  src: string;
  alt: string;
  children?: never;
}

type FigureProps = FigureLiveProps | FigureShotProps;

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

export function Figure(props: FigureProps) {
  const { caption, frame = "none", size = "md" } = props;
  const [lightbox, setLightbox] = useState(false);

  const inner =
    props.kind === "live" ? (
      <div className="p-4 bg-[var(--bg)]/30">{props.children}</div>
    ) : (
      <button
        type="button"
        onClick={() => setLightbox(true)}
        className="block w-full cursor-zoom-in"
        aria-label={`Open full-size: ${props.alt}`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={props.src}
          alt={props.alt}
          loading="lazy"
          className="block w-full h-auto"
        />
      </button>
    );

  return (
    <figure className={`my-6 ${SIZE_CLASS[size]}`}>
      <FrameChrome variant={frame}>{inner}</FrameChrome>
      <figcaption className="mt-2 text-xs text-[var(--muted)] italic leading-relaxed">
        {caption}
      </figcaption>

      {lightbox && props.kind === "shot" && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-[100] bg-black/90 flex items-center justify-center p-6 cursor-zoom-out"
          onClick={() => setLightbox(false)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={props.src}
            alt={props.alt}
            className="max-w-full max-h-full object-contain"
          />
        </div>
      )}
    </figure>
  );
}
