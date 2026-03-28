"use client";

import { useEffect, useState } from "react";

interface DetectorMeta {
  id: string;
  name: string;
  category: "heuristic" | "yolo-augmented" | "csi";
  description: string;
  defaultEnabled: boolean;
  produces: string[];
}

interface TextAnnotationsTabProps {
  reprocessing: boolean;
  reprocessLog: string[];
  onReprocess: () => void;
}

const CATEGORY_STYLES: Record<string, { bg: string; text: string }> = {
  heuristic: { bg: "bg-blue-500/15", text: "text-blue-400" },
  "yolo-augmented": { bg: "bg-purple-500/15", text: "text-purple-400" },
  csi: { bg: "bg-orange-500/15", text: "text-orange-400" },
};

export default function TextAnnotationsTab({
  reprocessing,
  reprocessLog,
  onReprocess,
}: TextAnnotationsTabProps) {
  const [detectors, setDetectors] = useState<DetectorMeta[]>([]);
  const [enabledIds, setEnabledIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");

  useEffect(() => {
    fetchConfig();
  }, []);

  async function fetchConfig() {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/text-annotations/config");
      if (res.ok) {
        const data = await res.json();
        setDetectors(data.detectors);
        setEnabledIds(new Set(data.enabled));
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }

  function toggleDetector(id: string) {
    setEnabledIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
    setSaveMessage("");
  }

  async function saveConfig() {
    setSaving(true);
    setSaveMessage("");
    try {
      const res = await fetch("/api/admin/text-annotations/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabledDetectors: Array.from(enabledIds) }),
      });
      if (res.ok) {
        setSaveMessage("Configuration saved successfully.");
      } else {
        const err = await res.json().catch(() => ({ error: "Failed" }));
        setSaveMessage(`Error: ${err.error || "Save failed"}`);
      }
    } catch {
      setSaveMessage("Error: Network request failed");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="text-[var(--muted)] text-sm py-8 text-center">
        Loading detector configuration...
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Pipeline Config */}
      <section>
        <h2 className="text-lg font-semibold mb-1">
          Text Annotation Pipeline
        </h2>
        <p className="text-sm text-[var(--muted)] mb-4">
          Configure which text annotation detectors run during processing.
        </p>

        <div className="space-y-2">
          {detectors.map((detector) => {
            const enabled = enabledIds.has(detector.id);
            const catStyle = CATEGORY_STYLES[detector.category] || {
              bg: "bg-gray-500/15",
              text: "text-gray-400",
            };

            return (
              <div
                key={detector.id}
                className="flex items-start gap-3 p-3 bg-[var(--surface)] border border-[var(--border)] rounded"
              >
                {/* Toggle */}
                <button
                  onClick={() => toggleDetector(detector.id)}
                  className={`mt-0.5 relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full transition-colors ${
                    enabled ? "bg-[var(--accent)]" : "bg-[var(--border)]"
                  }`}
                  role="switch"
                  aria-checked={enabled}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform mt-0.5 ${
                      enabled ? "translate-x-4 ml-0.5" : "translate-x-0.5"
                    }`}
                  />
                </button>

                {/* Details */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-sm text-[var(--fg)]">
                      {detector.name}
                    </span>
                    <span
                      className={`px-1.5 py-0.5 text-[10px] font-medium rounded ${catStyle.bg} ${catStyle.text}`}
                    >
                      {detector.category}
                    </span>
                  </div>
                  <p className="text-xs text-[var(--muted)] mt-0.5">
                    {detector.description}
                  </p>
                  {detector.produces.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {detector.produces.map((type) => (
                        <span
                          key={type}
                          className="px-1.5 py-0.5 text-[10px] rounded bg-[var(--bg)] border border-[var(--border)] text-[var(--muted)]"
                        >
                          {type}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Save */}
        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={saveConfig}
            disabled={saving}
            className="px-4 py-1.5 text-sm bg-[var(--accent)] text-white rounded hover:bg-[var(--accent-hover)] disabled:opacity-40"
          >
            {saving ? "Saving..." : "Save Configuration"}
          </button>
          {saveMessage && (
            <span
              className={`text-xs ${
                saveMessage.startsWith("Error")
                  ? "text-red-400"
                  : "text-green-400"
              }`}
            >
              {saveMessage}
            </span>
          )}
        </div>
      </section>

      {/* Reprocess Text Annotations */}
      <section>
        <h2 className="text-lg font-semibold mb-3">
          Reprocess Text Annotations
        </h2>
        <div className="p-3 bg-[var(--surface)] border border-[var(--border)] rounded space-y-3">
          <p className="text-xs text-[var(--muted)]">
            Re-run text annotation detectors on all existing projects using the
            current configuration above. Uses existing OCR data — no re-upload
            needed. User notes are preserved.
          </p>
          <button
            onClick={onReprocess}
            disabled={reprocessing}
            className="px-4 py-1.5 text-sm bg-[var(--accent)] text-white rounded hover:bg-[var(--accent-hover)] disabled:opacity-40"
          >
            {reprocessing ? "Reprocessing..." : "Reprocess All Projects"}
          </button>
          {reprocessLog.length > 0 && (
            <div className="mt-2 max-h-40 overflow-y-auto bg-[var(--bg)] rounded p-2 text-xs font-mono text-[var(--muted)]">
              {reprocessLog.map((line, i) => (
                <div key={i}>{line}</div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
