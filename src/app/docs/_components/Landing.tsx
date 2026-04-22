import Link from "next/link";
import { ArchitectureSvgDiagram } from "./demos/ArchitectureSvgDiagram";

interface FeatureCard {
  title: string;
  href: string;
  desc: string;
  accent?: string;
  icon: React.ReactNode;
}

const QUICKSTART: FeatureCard = {
  title: "New here? Start with the Walkthrough",
  href: "#walkthrough",
  desc: "Five steps from upload to exported numbers. No jargon, no code. ~3 minutes to read.",
  accent: "emerald",
  icon: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="9" />
      <path d="M 9 8 L 16 12 L 9 16 Z" fill="currentColor" />
    </svg>
  ),
};

const LLM_CARD: FeatureCard = {
  title: "Using an LLM to read this code?",
  href: "#for-llms",
  desc: "Dedicated section packs the mental model, glossary, file:line landmarks, selection heuristics, and the signal-valve state into one place.",
  accent: "sky",
  icon: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="8.5" cy="12" r="1.2" fill="currentColor" />
      <circle cx="15.5" cy="12" r="1.2" fill="currentColor" />
      <path d="M 8 16 Q 12 18 16 16" />
    </svg>
  ),
};

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
        <div className="text-[11px] tracking-[0.2em] uppercase text-[var(--muted)] mb-2">
          Documentation
        </div>
        <h1 className="text-4xl md:text-5xl font-bold text-[var(--fg)] leading-tight mb-4">
          BlueprintParser &mdash; Construction Blueprint Intelligence
        </h1>
        <p className="text-[17px] text-[var(--fg)]/95 leading-relaxed max-w-3xl">
          An open-source pipeline that turns construction PDFs into structured,
          LLM-queryable data &mdash; with a human-in-the-loop viewer, automated
          takeoff, and on-demand YOLO object detection on top.
        </p>

        {/* Plain-English lead — short paragraph for non-tech readers */}
        <div className="mt-4 max-w-3xl text-[15px] text-[var(--fg)]/80 leading-relaxed border-l-2 border-[var(--accent)]/40 pl-4 py-1">
          In plain English: drop in a drawing set, BP reads every page, finds the
          schedules and callouts, lets a YOLO model locate doors / windows / tags
          on the floor plans, and a chat-enabled LLM answers questions like
          &quot;how many doors on the second floor&quot; by looking at the
          structured data it just built. You stay in the loop: every number
          clicks back to the pixels it came from.
        </div>

        <div className="flex flex-wrap gap-2 mt-5">
          <a
            href="#walkthrough"
            className="px-3 py-1.5 text-sm rounded border border-emerald-400/60 text-emerald-300 hover:bg-emerald-500/10"
          >
            5-minute walkthrough →
          </a>
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

      {/* Prominent entry-point cards — Walkthrough for humans, For-LLMs for machines */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-10">
        {[QUICKSTART, LLM_CARD].map((card) => {
          const accentBorder =
            card.accent === "emerald"
              ? "border-emerald-400/50 hover:border-emerald-400/80 hover:bg-emerald-500/10"
              : "border-sky-400/50 hover:border-sky-400/80 hover:bg-sky-500/10";
          const accentIconBox =
            card.accent === "emerald"
              ? "border-emerald-400/40 text-emerald-300"
              : "border-sky-400/40 text-sky-300";
          return (
            <a
              key={card.title}
              href={card.href}
              className={`group block rounded-lg border bg-[var(--surface)]/30 p-5 transition-colors ${accentBorder}`}
            >
              <div className="flex items-start gap-4">
                <div className={`w-11 h-11 rounded-md border flex items-center justify-center shrink-0 ${accentIconBox}`}>
                  {card.icon}
                </div>
                <div className="min-w-0">
                  <div className="text-[var(--fg)] font-semibold text-[16px] mb-1">
                    {card.title}
                  </div>
                  <div className="text-[13px] text-[var(--fg)]/85 leading-snug">
                    {card.desc}
                  </div>
                </div>
              </div>
            </a>
          );
        })}
      </div>

      {/* Architecture diagram */}
      <div className="mb-10 border border-[var(--border)] rounded-lg bg-[var(--surface)]/30 p-4">
        <ArchitectureSvgDiagram />
        <div className="mt-3 text-[12px] text-[var(--muted)] italic leading-relaxed">
          The BP runtime on AWS. ECS Fargate serves the Next.js app and runs the
          preprocessing worker; SageMaker runs YOLO on-demand; S3 + CloudFront
          store and serve page images; RDS PostgreSQL holds structured results.
          Local / development uses the same code with AWS services disabled.
        </div>
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
                <div className="text-[var(--fg)] font-semibold text-[15px] mb-1">
                  {card.title}
                </div>
                <div className="text-[13px] text-[var(--fg)]/85 leading-snug">
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
