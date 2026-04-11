"use client";

import { useState } from "react";

type Mode = "pointer" | "move" | "markup";

export function ModeToggleDemo() {
  const [mode, setMode] = useState<Mode>("pointer");

  return (
    <div className="flex items-center gap-3">
      <div className="flex border border-[var(--border)] rounded">
        <button
          onClick={() => setMode("pointer")}
          className={`px-2 py-0.5 text-[10px] leading-tight text-center rounded-l ${
            mode === "pointer"
              ? "bg-[var(--accent)] text-white"
              : "text-[var(--muted)] hover:text-[var(--fg)]"
          }`}
        >
          <span className="block">Pointer</span>
          <span className="block">Select</span>
        </button>
        <button
          onClick={() => setMode("move")}
          className={`px-2 py-0.5 text-[10px] leading-tight text-center ${
            mode === "move"
              ? "bg-[var(--accent)] text-white"
              : "text-[var(--muted)] hover:text-[var(--fg)]"
          }`}
        >
          <span className="block">Pan</span>
          <span className="block">Zoom</span>
        </button>
        <button
          onClick={() => setMode("markup")}
          className={`px-2 py-0.5 text-[10px] leading-tight text-center rounded-r ${
            mode === "markup"
              ? "bg-[var(--accent)] text-white"
              : "text-[var(--muted)] hover:text-[var(--fg)]"
          }`}
        >
          Markup
        </button>
      </div>
      <span className="text-[11px] font-mono text-[var(--muted)]">
        mode = &quot;{mode}&quot;
      </span>
    </div>
  );
}
