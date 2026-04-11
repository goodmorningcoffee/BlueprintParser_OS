import Link from "next/link";
import { ArchitectureSvgDiagram } from "./demos/ArchitectureSvgDiagram";

interface FeatureCard {
  title: string;
  href: string;
  desc: string;
  icon: React.ReactNode;
}

const CARDS: FeatureCard[] = [
  {
    title: "The Viewer",
    href: "#viewer",
    desc: "Canvas, toolbar, panels, modes, markup, scale calibration, and the 20-color palette.",
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <circle cx="11" cy="12" r="3" />
        <line x1="14" y1="15" x2="17" y2="18" />
      </svg>
    ),
  },
  {
    title: "CSI Engine",
    href: "#csi-engine",
    desc: "3-tier detection, 9×9 spatial heatmap, and the project-wide CSI network graph.",
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="12" cy="6" r="2.5" />
        <circle cx="5" cy="17" r="2.5" />
        <circle cx="19" cy="17" r="2.5" />
        <line x1="12" y1="9" x2="6" y2="15" />
        <line x1="12" y1="9" x2="18" y2="15" />
        <line x1="7" y1="18" x2="17" y2="18" />
      </svg>
    ),
  },
  {
    title: "YOLO Pipeline",
    href: "#yolo-pipeline",
    desc: "SageMaker-backed object detection, Detection Panel, confidence, CSI auto-tagging.",
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="4" y="4" width="16" height="16" rx="1.5" strokeDasharray="3 2" />
        <rect x="8" y="8" width="8" height="8" />
        <circle cx="12" cy="12" r="1" fill="currentColor" />
      </svg>
    ),
  },
  {
    title: "Auto-QTO",
    href: "#auto-qto",
    desc: "Schedule-driven takeoff. 5-step state machine from material pick to CSV export.",
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="4" y="3" width="16" height="18" rx="2" />
        <line x1="8" y1="8" x2="16" y2="8" />
        <line x1="8" y1="12" x2="16" y2="12" />
        <line x1="8" y1="16" x2="13" y2="16" />
      </svg>
    ),
  },
  {
    title: "LLM & Tools",
    href: "#llm-and-tools",
    desc: "20 tools, agentic round loop, context budgets, per-company presets and priority overrides.",
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M12 3 L21 8 L21 16 L12 21 L3 16 L3 8 Z" />
        <path d="M12 3 L12 21" />
        <path d="M3 8 L21 16" />
        <path d="M21 8 L3 16" />
      </svg>
    ),
  },
  {
    title: "Architecture",
    href: "#architecture",
    desc: "AWS: ECS, RDS, S3, CloudFront, Step Functions, SageMaker, Terraform stack.",
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M6 19 A6 4 0 0 1 6 11 A5 5 0 0 1 16 9 A4 4 0 0 1 20 15 A4 4 0 0 1 16 19 Z" />
      </svg>
    ),
  },
];

export function Landing() {
  return (
    <div className="mb-16">
      {/* Hero */}
      <div className="mb-10">
        <div className="text-[10px] tracking-[0.2em] uppercase text-[var(--muted)] mb-2">
          Documentation
        </div>
        <h1 className="text-3xl md:text-4xl font-bold text-[var(--fg)] leading-tight mb-3">
          BlueprintParser &mdash; Construction Blueprint Intelligence
        </h1>
        <p className="text-[15px] text-[var(--fg)]/80 leading-relaxed max-w-3xl">
          An open-source pipeline that turns construction PDFs into structured,
          LLM-queryable data &mdash; with a human-in-the-loop viewer, automated
          takeoff, and on-demand YOLO object detection on top.
        </p>
        <div className="flex flex-wrap gap-2 mt-5">
          <a
            href="#overview"
            className="px-3 py-1.5 text-sm rounded border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent)]/10"
          >
            Jump to Overview →
          </a>
          <Link
            href="/demo"
            className="px-3 py-1.5 text-sm rounded border border-[var(--border)] text-[var(--fg)] hover:bg-[var(--surface)]"
          >
            Try the Demo
          </Link>
          <a
            href="https://github.com/anthropics/blueprintparser"
            className="px-3 py-1.5 text-sm rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]"
            target="_blank"
            rel="noreferrer noopener"
          >
            GitHub ↗
          </a>
        </div>
      </div>

      {/* Architecture diagram */}
      <div className="mb-10 border border-[var(--border)] rounded-lg bg-[var(--surface)]/30 p-4">
        <ArchitectureSvgDiagram />
      </div>

      {/* Feature highlight cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-10">
        {CARDS.map((card) => (
          <a
            key={card.title}
            href={card.href}
            className="group block rounded-lg border border-[var(--border)] bg-[var(--surface)]/30 hover:bg-[var(--surface)] hover:border-[var(--accent)]/60 p-4 transition-colors"
          >
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-md border border-[var(--border)] flex items-center justify-center text-[var(--accent)] group-hover:border-[var(--accent)]/60 shrink-0">
                {card.icon}
              </div>
              <div className="min-w-0">
                <div className="text-[var(--fg)] font-semibold text-[14px] mb-1">
                  {card.title}
                </div>
                <div className="text-[12px] text-[var(--fg)]/75 leading-snug">
                  {card.desc}
                </div>
              </div>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
