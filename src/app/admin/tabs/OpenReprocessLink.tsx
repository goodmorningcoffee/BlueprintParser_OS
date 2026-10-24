"use client";

// [2026-10-24 master Reprocess tab] The small link that replaced each tab's own "Reprocess …" button.
// The button did the same work as a preset of the Reprocess tab (often with its own stream reader
// that dropped the server's error lines); the link opens that tab with the preset ticked, so there
// is one scope picker, one preview and one console. `onOpen` is the admin page's tab switch.

import { presetDef, type ReprocessPreset } from "./reprocess-plan";

interface OpenReprocessLinkProps {
  preset: ReprocessPreset;
  onOpen: (preset: ReprocessPreset) => void;
  /** Optional lead-in, e.g. "After saving, re-run detection:". */
  note?: string;
  className?: string;
}

export default function OpenReprocessLink({ preset, onOpen, note, className }: OpenReprocessLinkProps) {
  const def = presetDef(preset);
  return (
    <span className={`text-xs text-[var(--muted)] ${className ?? ""}`} data-testid={`open-reprocess-${preset}`}>
      {note ? `${note} ` : ""}
      <button type="button" onClick={() => onOpen(preset)} className="text-[var(--accent)] hover:underline">
        Reprocess &rarr; &ldquo;{def?.label ?? preset}&rdquo;
      </button>
      {def ? <span className="text-[10px]"> (replaces {def.replaces})</span> : null}
    </span>
  );
}
