"use client";

import { useState, useEffect } from "react";

type ThemeId = "midnight" | "slate" | "graphite";
type UiScale = "compact" | "default" | "large" | "xlarge";

const THEMES: { id: ThemeId; label: string; description: string }[] = [
  { id: "midnight", label: "Midnight", description: "Darkest — low light" },
  { id: "slate", label: "Slate", description: "Brighter dark" },
  { id: "graphite", label: "Graphite", description: "Highest contrast" },
];

const SCALES: { id: UiScale; label: string }[] = [
  { id: "compact", label: "Compact" },
  { id: "default", label: "Default" },
  { id: "large", label: "Large" },
  { id: "xlarge", label: "X-Large" },
];

function getStoredTheme(): ThemeId {
  if (typeof window === "undefined") return "midnight";
  return (localStorage.getItem("bp-theme") as ThemeId) || "midnight";
}

function getStoredScale(): UiScale {
  if (typeof window === "undefined") return "default";
  return (localStorage.getItem("bp-ui-scale") as UiScale) || "default";
}

interface SettingsModalProps {
  onClose: () => void;
}

export default function SettingsModal({ onClose }: SettingsModalProps) {
  const [theme, setTheme] = useState<ThemeId>(getStoredTheme());
  const [scale, setScale] = useState<UiScale>(getStoredScale());

  useEffect(() => {
    localStorage.setItem("bp-theme", theme);
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("bp-ui-scale", scale);
    document.documentElement.setAttribute("data-ui-scale", scale);
  }, [scale]);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative bg-[var(--surface)] border border-[var(--border)] rounded-lg shadow-2xl w-[380px] max-h-[80vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)]">
          <h2 className="text-sm font-semibold">Settings</h2>
          <button
            onClick={onClose}
            className="text-[var(--muted)] hover:text-[var(--fg)] text-lg leading-none"
          >
            &times;
          </button>
        </div>

        <div className="p-5 space-y-6">
          {/* Theme */}
          <div>
            <label className="text-xs font-medium text-[var(--muted)] uppercase tracking-wide mb-3 block">
              Theme
            </label>
            <div className="space-y-2">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTheme(t.id)}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors text-left ${
                    theme === t.id
                      ? "border-[var(--accent)] bg-[var(--accent)]/10"
                      : "border-[var(--border)] hover:border-[var(--muted)]/40"
                  }`}
                >
                  <ThemePreview themeId={t.id} active={theme === t.id} />
                  <div>
                    <div className="text-sm font-medium">{t.label}</div>
                    <div className="text-[11px] text-[var(--muted)]">{t.description}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* UI Scale */}
          <div>
            <label className="text-xs font-medium text-[var(--muted)] uppercase tracking-wide mb-3 block">
              UI Scale
            </label>
            <div className="flex gap-2">
              {SCALES.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setScale(s.id)}
                  className={`flex-1 px-3 py-2 rounded-lg border text-xs font-medium transition-colors ${
                    scale === s.id
                      ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]"
                      : "border-[var(--border)] text-[var(--muted)] hover:border-[var(--muted)]/40"
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-[var(--muted)] mt-2">
              Scales toolbar and panel text. Does not affect the blueprint canvas.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Small color swatch showing the theme's palette */
function ThemePreview({ themeId, active }: { themeId: ThemeId; active: boolean }) {
  const palettes: Record<ThemeId, { bg: string; surface: string; accent: string; fg: string }> = {
    midnight:  { bg: "#111114", surface: "#1a1a20", accent: "#5b9cf6", fg: "#f0f0f2" },
    slate:     { bg: "#1a1a22", surface: "#24242e", accent: "#6aabff", fg: "#f4f4f6" },
    graphite:  { bg: "#232330", surface: "#2e2e3a", accent: "#7ab8ff", fg: "#f8f8fa" },
  };
  const p = palettes[themeId];
  return (
    <div
      className="w-8 h-8 rounded-md overflow-hidden border shrink-0"
      style={{ borderColor: active ? p.accent : "#444", background: p.bg }}
    >
      <div className="flex h-full">
        <div style={{ width: "50%", background: p.surface }} />
        <div className="flex flex-col justify-center items-center" style={{ width: "50%" }}>
          <div style={{ width: 6, height: 2, background: p.fg, borderRadius: 1, marginBottom: 2 }} />
          <div style={{ width: 8, height: 2, background: p.accent, borderRadius: 1 }} />
        </div>
      </div>
    </div>
  );
}
