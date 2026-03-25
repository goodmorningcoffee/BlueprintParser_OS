"use client";

import { useState } from "react";
import { useViewerStore } from "@/stores/viewerStore";
import type { LabelingTaskType } from "@/lib/labeling-config";

const TASK_TYPES: Array<{ id: LabelingTaskType; name: string; description: string; hint: string }> = [
  { id: "detection", name: "Object Detection", description: "Draw bounding boxes around objects", hint: "door, window, outlet, panel" },
  { id: "classification", name: "Classification", description: "Label entire images by category", hint: "electrical, plumbing, structural, mechanical" },
  { id: "segmentation", name: "Polygon Segmentation", description: "Draw polygon masks around regions", hint: "building footprint, road, parking" },
  { id: "text", name: "Text / LLM", description: "Annotate with free-text descriptions", hint: "" },
];

interface LabelingWizardProps {
  onClose: () => void;
  projectName: string;
}

export default function LabelingWizard({ onClose, projectName }: LabelingWizardProps) {
  const publicId = useViewerStore((s) => s.publicId);
  const numPages = useViewerStore((s) => s.numPages);
  const pageNumber = useViewerStore((s) => s.pageNumber);

  const [step, setStep] = useState(1);
  const [taskType, setTaskType] = useState<LabelingTaskType>("detection");
  const [labelsInput, setLabelsInput] = useState("");
  const [name, setName] = useState(`${projectName} - Detection`);
  const [pagesPerProject, setPagesPerProject] = useState(10);
  const [pageSelection, setPageSelection] = useState<"all" | "current" | "range">("all");
  const [rangeInput, setRangeInput] = useState(`1-${numPages}`);

  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Array<{ labelStudioUrl: string; pageRange: string; taskCount: number }>>([]);

  const labels = labelsInput.split(",").map((l) => l.trim()).filter(Boolean);

  const selectedPages =
    pageSelection === "current" ? 1
    : pageSelection === "range" ? (() => {
        const [s, e] = rangeInput.split("-").map(Number);
        return Math.max(0, (e || numPages) - (s || 1) + 1);
      })()
    : numPages;

  const projectCount = Math.ceil(selectedPages / pagesPerProject);

  async function handleCreate() {
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/labeling/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: publicId,
          taskType,
          labels,
          pagesPerProject,
          pageSelection,
          pageRange: pageSelection === "current" ? String(pageNumber) : pageSelection === "range" ? rangeInput : undefined,
          projectName: name,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(data.error);
      }

      const data = await res.json();
      setSessions(data.sessions);
      setStep(5);
    } catch (err: any) {
      setError(err.message || "Failed to create labeling project");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center" onClick={onClose}>
      <div
        className="bg-[var(--surface)] border border-[var(--border)] rounded-xl w-full max-w-lg p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold">
            {step <= 4 ? `Data Labeling Setup (${step}/4)` : "Ready"}
          </h2>
          <button onClick={onClose} className="text-[var(--muted)] hover:text-[var(--fg)]">x</button>
        </div>

        {/* Step 1: Task Type */}
        {step === 1 && (
          <div className="space-y-2">
            <p className="text-sm text-[var(--muted)] mb-3">What type of labeling task?</p>
            {TASK_TYPES.map((t) => (
              <button
                key={t.id}
                onClick={() => {
                  setTaskType(t.id);
                  setName(`${projectName} - ${t.name}`);
                }}
                className={`w-full text-left p-3 rounded border transition-colors ${
                  taskType === t.id
                    ? "border-[var(--accent)] bg-[var(--accent)]/10"
                    : "border-[var(--border)] hover:border-[var(--accent)]/50"
                }`}
              >
                <span className="text-sm font-medium">{t.name}</span>
                <span className="text-xs text-[var(--muted)] block">{t.description}</span>
              </button>
            ))}
            <div className="flex justify-end mt-4">
              <button
                onClick={() => setStep(2)}
                className="px-4 py-2 text-sm bg-[var(--accent)] text-white rounded hover:bg-[var(--accent-hover)]"
              >
                Next
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Labels */}
        {step === 2 && (
          <div className="space-y-3">
            <p className="text-sm text-[var(--muted)]">
              {taskType === "text" ? "No labels needed for text annotation." : "Enter the labels (comma-separated):"}
            </p>
            {taskType !== "text" && (
              <>
                <input
                  autoFocus
                  value={labelsInput}
                  onChange={(e) => setLabelsInput(e.target.value)}
                  placeholder={TASK_TYPES.find((t) => t.id === taskType)?.hint}
                  className="w-full px-3 py-2 text-sm bg-[var(--bg)] border border-[var(--border)] rounded focus:outline-none focus:border-[var(--accent)]"
                />
                {labels.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {labels.map((l, i) => (
                      <span key={i} className="text-xs px-2 py-0.5 rounded bg-[var(--accent)]/20 text-[var(--accent)]">{l}</span>
                    ))}
                  </div>
                )}
              </>
            )}
            <div className="flex justify-between mt-4">
              <button onClick={() => setStep(1)} className="px-4 py-2 text-sm text-[var(--muted)] hover:text-[var(--fg)]">Back</button>
              <button
                onClick={() => setStep(3)}
                disabled={taskType !== "text" && labels.length === 0}
                className="px-4 py-2 text-sm bg-[var(--accent)] text-white rounded hover:bg-[var(--accent-hover)] disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Project Setup */}
        {step === 3 && (
          <div className="space-y-3">
            <div>
              <label className="text-xs text-[var(--muted)] block mb-1">Project Name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-[var(--bg)] border border-[var(--border)] rounded focus:outline-none focus:border-[var(--accent)]"
              />
            </div>

            <div>
              <label className="text-xs text-[var(--muted)] block mb-1">Pages</label>
              <div className="flex gap-2">
                {(["all", "current", "range"] as const).map((opt) => (
                  <button
                    key={opt}
                    onClick={() => setPageSelection(opt)}
                    className={`px-3 py-1 text-xs rounded border ${
                      pageSelection === opt
                        ? "border-[var(--accent)] text-[var(--accent)]"
                        : "border-[var(--border)] text-[var(--muted)]"
                    }`}
                  >
                    {opt === "all" ? `All (${numPages})` : opt === "current" ? `Current (${pageNumber})` : "Range"}
                  </button>
                ))}
              </div>
              {pageSelection === "range" && (
                <input
                  value={rangeInput}
                  onChange={(e) => setRangeInput(e.target.value)}
                  placeholder="1-50"
                  className="mt-2 w-32 px-2 py-1 text-xs bg-[var(--bg)] border border-[var(--border)] rounded"
                />
              )}
            </div>

            <div>
              <label className="text-xs text-[var(--muted)] block mb-1">Pages per Label Studio project: {pagesPerProject}</label>
              <input
                type="range" min="5" max="50" step="5" value={pagesPerProject}
                onChange={(e) => setPagesPerProject(parseInt(e.target.value))}
                className="w-full h-1 accent-[var(--accent)]"
              />
            </div>

            <div className="text-xs text-[var(--muted)] bg-[var(--bg)] p-2 rounded">
              This will create <span className="text-[var(--fg)] font-medium">{projectCount}</span> project{projectCount !== 1 ? "s" : ""} with up to <span className="text-[var(--fg)] font-medium">{pagesPerProject}</span> images each ({selectedPages} pages total)
            </div>

            <div className="flex justify-between mt-4">
              <button onClick={() => setStep(2)} className="px-4 py-2 text-sm text-[var(--muted)] hover:text-[var(--fg)]">Back</button>
              <button
                onClick={() => { setStep(4); handleCreate(); }}
                className="px-4 py-2 text-sm bg-[var(--accent)] text-white rounded hover:bg-[var(--accent-hover)]"
              >
                Create
              </button>
            </div>
          </div>
        )}

        {/* Step 4: Creating */}
        {step === 4 && (
          <div className="text-center py-8">
            {creating ? (
              <>
                <div className="text-sm text-[var(--muted)] animate-pulse">Creating Label Studio project...</div>
                <div className="text-xs text-[var(--muted)] mt-2">Generating presigned URLs and importing tasks</div>
              </>
            ) : error ? (
              <>
                <div className="text-sm text-red-400 mb-3">{error}</div>
                <button
                  onClick={handleCreate}
                  className="px-4 py-2 text-sm border border-[var(--border)] rounded hover:border-[var(--accent)]"
                >
                  Retry
                </button>
              </>
            ) : null}
          </div>
        )}

        {/* Step 5: Success */}
        {step === 5 && (
          <div className="space-y-3">
            <div className="text-center mb-4">
              <span className="text-green-400 text-2xl">&#10003;</span>
              <p className="text-sm mt-2">Label Studio project{sessions.length > 1 ? "s" : ""} created successfully!</p>
            </div>
            {sessions.map((s, i) => (
              <div key={i} className="flex items-center justify-between p-3 bg-[var(--bg)] rounded border border-[var(--border)]">
                <div>
                  <span className="text-xs text-[var(--muted)]">Pages {s.pageRange}</span>
                  <span className="text-xs text-[var(--muted)] ml-2">({s.taskCount} images)</span>
                </div>
                <a
                  href={s.labelStudioUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3 py-1 text-xs bg-[var(--accent)] text-white rounded hover:bg-[var(--accent-hover)]"
                >
                  Open Label Studio
                </a>
              </div>
            ))}
            <div className="flex justify-end mt-4">
              <button onClick={onClose} className="px-4 py-2 text-sm text-[var(--muted)] hover:text-[var(--fg)]">Close</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
