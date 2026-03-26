"use client";

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

export default function ProjectsTab({
  projects, onToggleDemo, onRefreshDemo, reprocessing, reprocessLog, onReprocess, setMessage,
}: ProjectsTabProps) {
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

      {/* Reprocess Text Annotations */}
      <section>
        <h2 className="text-lg font-semibold mb-3">Reprocess Text Annotations</h2>
        <div className="p-3 bg-[var(--surface)] border border-[var(--border)] rounded space-y-3">
          <p className="text-xs text-[var(--muted)]">
            Re-run text annotation detectors (abbreviations, equipment tags, phone numbers, etc.) on all existing projects.
            Uses existing OCR data — no re-upload needed. User notes are preserved.
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
