"use client";

/**
 * ToolbarDemo — a static rendition of the real viewer toolbar that mirrors
 * src/components/viewer/ViewerToolbar.tsx as of 2026-04-11.
 *
 * WHY COPIED JSX: the real ViewerToolbar reads ~20 Zustand slices and wires
 * into LabelingWizard + SettingsModal + HelpTooltip context providers. Mounting
 * it directly in the docs page would require a minimal fake viewer store,
 * which is a bigger engineering cost than maintaining a hand-synced snapshot.
 *
 * KEEP IN SYNC: whenever ViewerToolbar.tsx gets a new button, panel toggle,
 * or restyle, mirror the change here. Classes and ordering must match so
 * readers see the same layout they'll see in the real app.
 */
import { useState } from "react";

type Mode = "pointer" | "move" | "markup";

export function ToolbarDemo() {
  const [mode, setMode] = useState<Mode>("pointer");
  const [showText, setShowText] = useState(true);
  const [showCsi, setShowCsi] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [showTakeoff, setShowTakeoff] = useState(false);
  const [showTable, setShowTable] = useState(false);
  const [showKeynote, setShowKeynote] = useState(false);
  const [yoloOn, setYoloOn] = useState(true);

  return (
    <div className="viewer-scalable h-12 border border-[var(--border)] bg-[var(--surface)] flex items-center px-3 gap-2 rounded text-[var(--fg)] overflow-x-auto">
      {/* Back */}
      <a href="#" className="text-[var(--muted)] hover:text-[var(--fg)] mr-2 text-sm select-none">
        ←
      </a>

      {/* Project name */}
      <span className="text-sm font-medium truncate max-w-48 cursor-pointer hover:text-[var(--accent)]">
        Demo Project
      </span>

      <div className="w-px h-6 bg-[var(--border)] mx-2" />

      {/* Zoom controls */}
      <button className="px-2 py-1 text-sm text-[var(--muted)] hover:text-[var(--fg)]">-</button>
      <span className="text-xs tabular-nums min-w-12 text-center text-[var(--muted)]">100%</span>
      <button className="px-2 py-1 text-sm text-[var(--muted)] hover:text-[var(--fg)]">+</button>
      <button className="px-2 py-1 text-xs text-[var(--muted)] hover:text-[var(--fg)] border border-[var(--border)] rounded">
        Fit
      </button>

      <div className="w-px h-6 bg-[var(--border)] mx-2" />

      {/* Mode toggle */}
      <div className="flex border border-[var(--border)] rounded">
        <button
          onClick={() => setMode("pointer")}
          className={`px-2 py-0.5 text-[10px] leading-tight text-center rounded-l ${
            mode === "pointer" ? "bg-[var(--accent)] text-white" : "text-[var(--muted)] hover:text-[var(--fg)]"
          }`}
        >
          <span className="block">Pointer</span>
          <span className="block">Select</span>
        </button>
        <button
          onClick={() => setMode("move")}
          className={`px-2 py-0.5 text-[10px] leading-tight text-center ${
            mode === "move" ? "bg-[var(--accent)] text-white" : "text-[var(--muted)] hover:text-[var(--fg)]"
          }`}
        >
          <span className="block">Pan</span>
          <span className="block">Zoom</span>
        </button>
        <button
          onClick={() => setMode("markup")}
          className={`px-2 py-0.5 text-[10px] leading-tight text-center rounded-r ${
            mode === "markup" ? "bg-[var(--accent)] text-white" : "text-[var(--muted)] hover:text-[var(--fg)]"
          }`}
        >
          Markup
        </button>
      </div>

      {/* Symbol Search */}
      <button className="px-2 py-1 text-xs rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] flex items-center gap-1">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="6.5" cy="6.5" r="4.5" />
          <line x1="10" y1="10" x2="14" y2="14" />
          <rect x="3.5" y="3.5" width="6" height="6" rx="0.5" strokeDasharray="2 1" strokeWidth="1" />
        </svg>
        Symbol
      </button>

      <div className="flex-1" />

      {/* Menu */}
      <button className="px-2 py-1 text-xs rounded border border-[var(--fg)]/30 text-[var(--fg)]/70 hover:text-[var(--fg)]">
        Menu
      </button>

      {/* Search bar */}
      <div className="relative flex items-center">
        <input
          type="text"
          placeholder="Search text..."
          className="px-3 py-1 text-sm bg-sky-950/30 border border-sky-400/30 rounded focus:outline-none focus:border-sky-400/60 w-36"
          readOnly
        />
      </div>

      {/* Trade filter */}
      <select className="px-2 py-1 text-xs bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--fg)] max-w-32">
        <option>All Trades</option>
      </select>

      {/* CSI filter */}
      <button className="px-2 py-1 text-xs rounded border border-[var(--border)] text-[var(--fg)] max-w-32 truncate">
        CSI Codes (24)
      </button>

      <div className="flex-1" />

      {/* YOLO */}
      <button
        onClick={() => setYoloOn((v) => !v)}
        className={`px-2 py-1 text-xs rounded border ${
          yoloOn
            ? "border-green-400/45 text-green-400/70 bg-green-400/8"
            : "border-red-400/30 text-red-400/50"
        }`}
      >
        YOLO
      </button>

      {/* Panel toggles */}
      <PanelBtn label="Text" on={showText} onClick={() => setShowText((v) => !v)} />
      <PanelBtn label="CSI" on={showCsi} onClick={() => setShowCsi((v) => !v)} />
      <PanelBtn label="LLM Chat" on={showChat} onClick={() => setShowChat((v) => !v)} />
      <PanelBtn label="QTO" on={showTakeoff} onClick={() => setShowTakeoff((v) => !v)} />
      <button
        onClick={() => setShowTable((v) => !v)}
        className={`px-2 py-0.5 text-[10px] leading-tight text-center rounded border ${
          showTable
            ? "border-pink-400/60 text-pink-300 bg-pink-400/12"
            : "border-[var(--muted)]/30 text-[var(--muted)] hover:text-[var(--fg)]"
        }`}
      >
        <span className="block">Schedules</span>
        <span className="block">Tables</span>
      </button>
      <button
        onClick={() => setShowKeynote((v) => !v)}
        className={`px-2 py-1 text-xs rounded border ${
          showKeynote
            ? "border-amber-400/60 text-amber-300 bg-amber-400/12"
            : "border-[var(--muted)]/30 text-[var(--muted)] hover:text-[var(--fg)]"
        }`}
      >
        Keynotes
      </button>
    </div>
  );
}

function PanelBtn({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-2 py-1 text-xs rounded border whitespace-nowrap ${
        on
          ? "border-green-400/60 text-green-300 bg-green-400/12"
          : "border-[var(--muted)]/30 text-[var(--muted)] hover:text-[var(--fg)]"
      }`}
    >
      {label}
    </button>
  );
}
