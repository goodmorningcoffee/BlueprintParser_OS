"use client";

import { useState, useEffect } from "react";

interface ProjectItem {
  id: string;
  name: string;
  numPages: number | null;
  status: string;
  isDemo: boolean;
}

interface ProjectsTabProps {
  projects: ProjectItem[];
  onToggleDemo: (projectId: string, isDemo: boolean) => void;
  onRefreshDemo: () => Promise<string>;
  reprocessing: boolean;
  reprocessLog: string[];
  onReprocess: () => void;
  setMessage: (msg: string) => void;
}

const DEMO_FEATURES = [
  { key: "autoQto", label: "Auto-QTO Workflow", description: "Door/finish/equipment schedule takeoff workflow", defaultOn: true },
  { key: "tableParse", label: "Table / Schedule Parse", description: "Draw BBs and parse tables with 3-method or guided parse", defaultOn: true },
  { key: "keynoteParse", label: "Keynote Parse", description: "Keynote guided parse with YOLO tag mapping", defaultOn: true },
  { key: "takeoff", label: "Quantity Takeoff", description: "Count markers, area polygons, calibration, CSV export", defaultOn: true },
  { key: "symbolSearch", label: "Symbol Search", description: "Template matching to find repeated symbols", defaultOn: true },
  { key: "chat", label: "LLM Chat", description: "AI chat with structured blueprint context (uses Groq quota)", defaultOn: true },
  { key: "yoloRun", label: "Run YOLO Models", description: "Trigger SageMaker GPU inference ($0.75/hr) — expensive", defaultOn: false },
  { key: "labeling", label: "Labeling Wizard", description: "Label Studio integration for training data", defaultOn: false },
];

export default function ProjectsTab({
  projects, onToggleDemo, onRefreshDemo, reprocessing, reprocessLog, onReprocess, setMessage,
}: ProjectsTabProps) {
  const [demoConfig, setDemoConfig] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);

  // Load demo config
  useEffect(() => {
    fetch("/api/admin/demo/config")
      .then((r) => r.ok ? r.json() : { demo: {} })
      .then((data) => setDemoConfig(data.demo || {}))
      .catch(() => {});
  }, []);

  const toggleFeature = async (key: string) => {
    const current = demoConfig[key] ?? DEMO_FEATURES.find((f) => f.key === key)?.defaultOn ?? true;
    const updated = { ...demoConfig, [key]: !current };
    setDemoConfig(updated);
    setSaving(true);
    try {
      await fetch("/api/admin/demo/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ demo: updated }),
      });
    } catch (err) {
      console.error("[demo-config] Save failed:", err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* Demo Projects */}
      <section>
        <div className="flex items-center gap-3 mb-3">
          <h2 className="text-lg font-semibold">Projects — Push to Demo</h2>
          <button
            onClick={async () => {
              const msg = await onRefreshDemo();
              setMessage(msg);
            }}
            className="px-3 py-1 text-xs border border-[var(--border)] rounded hover:border-[var(--accent)] text-[var(--muted)] hover:text-[var(--fg)]"
          >
            Refresh Demo
          </button>
        </div>
        <div className="space-y-2">
          {projects.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between p-3 bg-[var(--surface)] border border-[var(--border)] rounded"
            >
              <div>
                <span className="font-medium">{p.name}</span>
                <span className="text-xs text-[var(--muted)] ml-2">
                  {p.numPages || "?"} pages — {p.status}
                </span>
              </div>
              <button
                onClick={() => onToggleDemo(p.id, !p.isDemo)}
                className={`px-3 py-1 text-xs rounded ${
                  p.isDemo
                    ? "bg-green-600 text-white"
                    : "bg-[var(--bg)] text-[var(--muted)] border border-[var(--border)]"
                }`}
              >
                {p.isDemo ? "Live on Demo" : "Push to Demo"}
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* Demo Features */}
      <section>
        <h2 className="text-lg font-semibold mb-1">Demo Features</h2>
        <p className="text-xs text-[var(--muted)] mb-3">
          Control which features are available to demo visitors. Changes apply immediately.
          {saving && <span className="ml-2 text-[var(--accent)]">Saving...</span>}
        </p>
        <div className="space-y-1">
          {DEMO_FEATURES.map((feature) => {
            const enabled = demoConfig[feature.key] ?? feature.defaultOn;
            return (
              <div
                key={feature.key}
                className={`flex items-center gap-3 px-3 py-2 rounded border transition-colors ${
                  enabled
                    ? "border-emerald-500/20 bg-emerald-500/5"
                    : "border-[var(--border)] opacity-50"
                }`}
              >
                <button
                  onClick={() => toggleFeature(feature.key)}
                  className={`w-8 text-center text-[10px] font-medium rounded py-0.5 ${
                    enabled ? "bg-emerald-500/20 text-emerald-400" : "bg-[var(--border)] text-[var(--muted)]"
                  }`}
                >
                  {enabled ? "ON" : "OFF"}
                </button>
                <div className="flex-1">
                  <div className="text-xs font-medium text-[var(--fg)]">{feature.label}</div>
                  <div className="text-[10px] text-[var(--muted)]">{feature.description}</div>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
