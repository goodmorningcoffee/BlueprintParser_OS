"use client";

import { useState, useEffect } from "react";
import { useViewerStore } from "@/stores/viewerStore";

interface LabelingWizardProps {
  onClose: () => void;
  projectName: string;
  isDemo?: boolean;
}

export default function LabelingWizard({ onClose, projectName, isDemo }: LabelingWizardProps) {
  const publicId = useViewerStore((s) => s.publicId);
  const numPages = useViewerStore((s) => s.numPages);
  const pageNumber = useViewerStore((s) => s.pageNumber);

  // Persistent state in Zustand (survives tab switches)
  const wizardStep = useViewerStore((s) => s.labelingWizardStep);
  const setWizardStep = useViewerStore((s) => s.setLabelingWizardStep);
  const storedSessions = useViewerStore((s) => s.labelingSessions);
  const setStoredSessions = useViewerStore((s) => s.setLabelingSessions);
  const storedCreds = useViewerStore((s) => s.labelingCredentials);
  const setStoredCreds = useViewerStore((s) => s.setLabelingCredentials);

  // Local form state (OK to reset)
  const [pagesPerProject, setPagesPerProject] = useState(10);
  const [pageSelection, setPageSelection] = useState<"all" | "current" | "range">("all");
  const [rangeInput, setRangeInput] = useState(`1-${numPages}`);
  const [tiling, setTiling] = useState(false);

  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingSessions, setLoadingSessions] = useState(false);

  const selectedPages =
    pageSelection === "current" ? 1
    : pageSelection === "range" ? (() => {
        const [s, e] = rangeInput.split("-").map(Number);
        return Math.max(0, (e || numPages) - (s || 1) + 1);
      })()
    : numPages;

  const totalImages = tiling ? selectedPages * 9 : selectedPages;
  const projectCount = Math.ceil(totalImages / pagesPerProject);

  // Determine which step to show
  const step = isDemo ? 3 : wizardStep;

  // If we already have sessions in store (tab switch recovery), jump to done
  useEffect(() => {
    if (!isDemo && storedSessions.length > 0 && wizardStep < 3) {
      setWizardStep(3);
    }
  }, []);

  // For demo users: fetch existing sessions + credentials on mount
  useEffect(() => {
    if (!isDemo) return;
    setLoadingSessions(true);
    Promise.all([
      fetch(`/api/demo/labeling/sessions?projectId=${publicId}`).then((r) => r.ok ? r.json() : []),
      fetch("/api/demo/labeling/credentials").then((r) => r.ok ? r.json() : null),
    ]).then(([sessionsData, creds]) => {
      setStoredSessions(sessionsData);
      setStoredCreds(creds);
    }).catch(() => {}).finally(() => setLoadingSessions(false));
  }, [isDemo, publicId]);

  async function handleCreate() {
    setCreating(true);
    setError(null);
    setWizardStep(2);
    try {
      const res = await fetch("/api/labeling/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: publicId,
          pagesPerProject,
          pageSelection,
          pageRange: pageSelection === "current" ? String(pageNumber) : pageSelection === "range" ? rangeInput : undefined,
          tiling,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(data.error);
      }

      const data = await res.json();
      setStoredSessions(data.sessions);
      // Fetch LS credentials
      fetch("/api/labeling/credentials").then((r) => r.json()).then(setStoredCreds).catch(() => {});
      setWizardStep(3);
    } catch (err: any) {
      setError(err.message || "Failed to create labeling project");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center" onClick={step === 3 ? undefined : onClose}>
      <div
        className="bg-[var(--surface)] border border-[var(--border)] rounded-xl w-full max-w-lg p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold">
            {isDemo ? "Data Labeling" : step === 3 ? "Label Studio Projects" : `Create Label Studio Projects (${step}/2)`}
          </h2>
          <button onClick={onClose} className="text-[var(--muted)] hover:text-[var(--fg)]">x</button>
        </div>

        {/* Steps 1-2: Only for authenticated users */}
        {!isDemo && (
          <>
            {/* Step 1: Page Selection + Tiling */}
            {step === 1 && (
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-[var(--muted)] block mb-1">Pages</label>
                  <div className="flex gap-2">
                    {(["all", "current", "range"] as const).map((opt) => (
                      <button
                        key={opt}
                        onClick={() => setPageSelection(opt)}
                        className={`px-3 py-1 text-xs rounded border ${
                          pageSelection === opt
                            ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/10"
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

                {/* Tiling toggle */}
                <div
                  onClick={() => setTiling(!tiling)}
                  className={`flex items-center gap-3 p-3 rounded border cursor-pointer transition-colors ${
                    tiling ? "border-[var(--accent)] bg-[var(--accent)]/10" : "border-[var(--border)] hover:border-[var(--accent)]/50"
                  }`}
                >
                  <div className={`w-4 h-4 rounded border flex items-center justify-center ${
                    tiling ? "border-[var(--accent)] bg-[var(--accent)]" : "border-[var(--border)]"
                  }`}>
                    {tiling && <span className="text-white text-xs">&#10003;</span>}
                  </div>
                  <div>
                    <span className="text-sm font-medium">3x3 Tiling</span>
                    <span className="text-xs text-[var(--muted)] block">Split each page into 9 tiles for more training data</span>
                  </div>
                </div>

                {tiling && (
                  <div className="text-xs text-[var(--muted)] bg-[var(--bg)] p-2 rounded">
                    {selectedPages} pages x 9 tiles = <span className="text-[var(--fg)] font-medium">{totalImages}</span> images
                  </div>
                )}

                <div>
                  <label className="text-xs text-[var(--muted)] block mb-1">Images per Label Studio project: {pagesPerProject}</label>
                  <input
                    type="range" min="2" max="50" step="2" value={pagesPerProject}
                    onChange={(e) => setPagesPerProject(parseInt(e.target.value))}
                    className="w-full h-1 accent-[var(--accent)]"
                  />
                </div>

                <div className="text-xs text-[var(--muted)] bg-[var(--bg)] p-2 rounded">
                  <span className="text-[var(--fg)] font-medium">{totalImages}</span> images across <span className="text-[var(--fg)] font-medium">{projectCount}</span> Label Studio project{projectCount !== 1 ? "s" : ""} (<span className="text-[var(--fg)] font-medium">{pagesPerProject}</span> images per project)
                </div>

                <div className="flex justify-end mt-4">
                  <button
                    onClick={handleCreate}
                    className="px-4 py-2 text-sm bg-[var(--accent)] text-white rounded hover:bg-[var(--accent-hover)]"
                  >
                    Create
                  </button>
                </div>
              </div>
            )}

            {/* Step 2: Creating */}
            {step === 2 && (
              <div className="text-center py-8">
                {creating ? (
                  <>
                    <div className="text-sm text-[var(--muted)] animate-pulse">Creating Label Studio projects...</div>
                    <div className="text-xs text-[var(--muted)] mt-2">
                      {tiling ? "Generating tiles and importing images" : "Importing images"}
                    </div>
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
          </>
        )}

        {/* Step 3: Sessions view (authenticated after creation, demo on mount) */}
        {step === 3 && (
          <div className="space-y-3">
            {/* Loading state for demo */}
            {isDemo && loadingSessions && (
              <div className="text-center py-8">
                <div className="text-sm text-[var(--muted)] animate-pulse">Loading labeling sessions...</div>
              </div>
            )}

            {/* Success header (authenticated only) */}
            {!isDemo && storedSessions.length > 0 && (
              <div className="text-center mb-4">
                <span className="text-green-400 text-2xl">&#10003;</span>
                <p className="text-sm mt-2">Label Studio project{storedSessions.length > 1 ? "s" : ""} created!</p>
              </div>
            )}

            {/* No sessions message (demo) */}
            {isDemo && !loadingSessions && storedSessions.length === 0 && (
              <div className="text-center py-6">
                <p className="text-sm text-[var(--muted)]">No labeling sessions for this project yet.</p>
              </div>
            )}

            {/* Credentials section */}
            {storedCreds && storedSessions.length > 0 && (
              <div className="p-3 bg-[var(--bg)] rounded border border-[var(--border)] space-y-2">
                <p className="text-xs text-[var(--muted)] font-medium">Label Studio Login</p>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[var(--muted)]">Email:</span>
                  <span className="text-xs text-[var(--fg)] font-mono select-all">{storedCreds.email}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[var(--muted)]">Password:</span>
                  <span className="text-xs text-[var(--fg)] font-mono select-all">{storedCreds.password}</span>
                </div>
                <p className="text-xs text-[var(--muted)] italic">Log in once — your session will persist.</p>
              </div>
            )}

            {storedSessions.map((s, i) => (
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

            {/* New project button (authenticated only) */}
            {!isDemo && (
              <div className="flex justify-between mt-4">
                <button
                  onClick={() => { setStoredSessions([]); setStoredCreds(null); setWizardStep(1); }}
                  className="px-4 py-2 text-sm text-[var(--muted)] hover:text-[var(--fg)]"
                >
                  Create Another
                </button>
                <button onClick={onClose} className="px-4 py-2 text-sm text-[var(--muted)] hover:text-[var(--fg)]">Close</button>
              </div>
            )}
            {isDemo && (
              <div className="flex justify-end mt-4">
                <button onClick={onClose} className="px-4 py-2 text-sm text-[var(--muted)] hover:text-[var(--fg)]">Close</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
