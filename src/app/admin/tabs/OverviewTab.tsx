"use client";

import { useState, useEffect } from "react";

interface InviteItem {
  id: number;
  email: string;
  name: string | null;
  company: string | null;
  seen: boolean;
  createdAt: string;
}

interface OverviewTabProps {
  invites: InviteItem[];
  unseenInvites: number;
  showInvites: boolean;
  onMarkSeen: () => void;
  isRootAdmin?: boolean;
}

interface HeaderLinks {
  home: string;
  hded: string;
  modelExchange: string;
  planExchange: string;
  labelFleet: string;
}

const HEADER_LINK_FIELDS: Array<{ key: keyof HeaderLinks; label: string }> = [
  { key: "home", label: "Home" },
  { key: "hded", label: "HDED" },
  { key: "modelExchange", label: "Model Exchange" },
  { key: "planExchange", label: "Plan Exchange" },
  { key: "labelFleet", label: "LabelFleet" },
];

interface ReprocessStage {
  label: string;
  url: string;
  description: string;
}

const STAGES: ReprocessStage[] = [
  {
    label: "Page Names",
    url: "/api/admin/reprocess?scope=page-names",
    description: "Re-extracting drawing numbers (label-anchored + regex + YOLO title block)",
  },
  {
    label: "Text Annotations + CSI",
    url: "/api/admin/reprocess",
    description: "Re-running CSI detection + text annotation detectors",
  },
  {
    label: "Intelligence",
    url: "/api/admin/reprocess?scope=intelligence",
    description: "Re-running page classification, heuristics, table classification, CSI spatial maps, project analysis",
  },
];

export default function OverviewTab({ invites, unseenInvites, showInvites, onMarkSeen, isRootAdmin }: OverviewTabProps) {
  const [running, setRunning] = useState(false);
  const [currentStage, setCurrentStage] = useState(-1);
  const [log, setLog] = useState<string[]>([]);

  // Header links editor state (root admin only)
  const [headerLinks, setHeaderLinks] = useState<HeaderLinks>({
    home: "", hded: "", modelExchange: "", planExchange: "", labelFleet: "",
  });
  const [linksSaving, setLinksSaving] = useState(false);
  const [linksMessage, setLinksMessage] = useState("");

  useEffect(() => {
    if (!isRootAdmin) return;
    fetch("/api/admin/app-settings")
      .then((r) => r.ok ? r.json() : null)
      .then((data: { header_links?: Partial<HeaderLinks> } | null) => {
        if (data?.header_links) setHeaderLinks((prev) => ({ ...prev, ...data.header_links }));
      })
      .catch(() => {});
  }, [isRootAdmin]);

  async function saveHeaderLinks() {
    setLinksSaving(true);
    setLinksMessage("");
    try {
      const res = await fetch("/api/admin/app-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "header_links", value: headerLinks }),
      });
      setLinksMessage(res.ok ? "Saved" : "Failed");
    } catch {
      setLinksMessage("Network error");
    }
    setLinksSaving(false);
    setTimeout(() => setLinksMessage(""), 2000);
  }

  async function runStreamingStage(stage: ReprocessStage, stageIdx: number): Promise<boolean> {
    setCurrentStage(stageIdx);
    setLog(prev => [...prev, "", `--- Stage ${stageIdx + 1}/${STAGES.length}: ${stage.label} ---`, stage.description]);

    try {
      const res = await fetch(stage.url, { method: "POST" });
      if (!res.ok || !res.body) {
        setLog(prev => [...prev, `Error: ${res.status}`]);
        return false;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.type === "config") {
              const classes = (msg.targetClasses || []).join(", ");
              setLog(prev => [...prev,
                msg.yoloEnabled
                  ? `  YOLO: [${classes}] from ${msg.sources} source(s)`
                  : "  YOLO: using default title_block fallback",
              ]);
            } else if (msg.type === "start") {
              setLog(prev => [...prev, `  ${msg.projects} project(s)`]);
            } else if (msg.type === "project") {
              const extra = msg.yoloTitleBlocks !== undefined ? ` (${msg.yoloTitleBlocks} YOLO title blocks)` : "";
              setLog(prev => [...prev, `  ${msg.name}: ${msg.pages} pages${extra}`]);
            } else if (msg.type === "progress") {
              setLog(prev => [...prev, `    ${msg.updated} updated, ${msg.skipped || 0} skipped`]);
            } else if (msg.type === "project-analysis") {
              setLog(prev => [...prev, `    Project analysis: ${msg.project}`]);
            } else if (msg.type === "done") {
              setLog(prev => [...prev, `  Done: ${msg.updated} updated, ${msg.skipped} skipped`]);
            }
          } catch { /* skip non-JSON */ }
        }
      }
      return true;
    } catch (err) {
      setLog(prev => [...prev, `  Failed: ${err instanceof Error ? err.message : "unknown"}`]);
      return false;
    }
  }

  async function runAll() {
    setRunning(true);
    setLog(["Starting full pipeline reprocess..."]);

    for (let i = 0; i < STAGES.length; i++) {
      const ok = await runStreamingStage(STAGES[i], i);
      if (!ok) {
        setLog(prev => [...prev, "", `Pipeline stopped at stage ${i + 1} due to error.`]);
        break;
      }
    }

    setLog(prev => [...prev, "", "All stages complete."]);
    setCurrentStage(-1);
    setRunning(false);
  }

  return (
    <section className="space-y-6">
      {/* Header Links Editor (root admin only) */}
      {isRootAdmin && (
        <div className="border border-[var(--border)] rounded-lg p-4 space-y-3 bg-[var(--surface)]">
          <div>
            <h3 className="text-sm font-semibold text-[var(--fg)]">Demo Page Header Links</h3>
            <p className="text-[10px] text-[var(--muted)] mt-1">
              URLs for the nav buttons shown next to &ldquo;BlueprintParser Demo&rdquo; on the public demo page.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {HEADER_LINK_FIELDS.map((field) => (
              <div key={field.key}>
                <label className="block text-[10px] text-[var(--muted)] uppercase tracking-wide mb-1">{field.label}</label>
                <input
                  type="url"
                  value={headerLinks[field.key]}
                  onChange={(e) => setHeaderLinks({ ...headerLinks, [field.key]: e.target.value })}
                  placeholder="https://..."
                  className="w-full px-2 py-1.5 text-xs bg-[var(--bg)] border border-[var(--border)] rounded focus:outline-none focus:border-[var(--accent)]"
                />
              </div>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={saveHeaderLinks}
              disabled={linksSaving}
              className="px-4 py-1.5 text-xs bg-[var(--accent)] text-white rounded hover:bg-[var(--accent-hover)] disabled:opacity-50"
            >
              {linksSaving ? "Saving..." : "Save Links"}
            </button>
            {linksMessage && (
              <span className={`text-xs ${linksMessage === "Saved" ? "text-emerald-400" : "text-red-400"}`}>
                {linksMessage}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Master Reprocess */}
      <div className="border border-[var(--border)] rounded-lg p-4 space-y-3 bg-[var(--surface)]">
        <div>
          <h3 className="text-sm font-semibold text-[var(--fg)]">Re-run All Processes</h3>
          <p className="text-[10px] text-[var(--muted)] mt-1">
            Sequentially re-runs all processing pipelines on existing data: page naming, text annotations + CSI detection, and intelligence analysis.
            Does not re-run YOLO models — run those separately from the AI Models tab.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={runAll}
            disabled={running}
            className="px-5 py-2 text-sm rounded bg-gradient-to-r from-emerald-600 to-cyan-600 text-white hover:from-emerald-500 hover:to-cyan-500 disabled:opacity-50 font-medium"
          >
            {running ? `Running Stage ${currentStage + 1}/${STAGES.length}...` : "Re-run All Processes"}
          </button>
          {running && (
            <span className="text-xs text-[var(--muted)] animate-pulse">
              {STAGES[currentStage]?.label || "Preparing..."}
            </span>
          )}
        </div>

        {/* Progress stages indicator */}
        {(running || log.length > 0) && (
          <div className="flex gap-1 items-center">
            {STAGES.map((stage, i) => (
              <div key={i} className="flex items-center gap-1">
                <div className={`w-2 h-2 rounded-full ${
                  i < currentStage ? "bg-emerald-400" :
                  i === currentStage ? "bg-cyan-400 animate-pulse" :
                  currentStage === -1 && log.length > 1 ? "bg-emerald-400" :
                  "bg-[var(--border)]"
                }`} />
                <span className={`text-[9px] ${
                  i === currentStage ? "text-cyan-400" : "text-[var(--muted)]"
                }`}>
                  {stage.label}
                </span>
                {i < STAGES.length - 1 && <span className="text-[var(--border)] text-[9px] mx-0.5">&rarr;</span>}
              </div>
            ))}
          </div>
        )}

        {/* Log */}
        {log.length > 0 && (
          <div className="max-h-60 overflow-y-auto bg-[var(--bg)] rounded p-2 text-xs font-mono text-[var(--muted)] border border-[var(--border)]">
            {log.map((line, i) => (
              <div key={i} className={line.startsWith("---") ? "text-cyan-400 font-semibold" : ""}>{line}</div>
            ))}
          </div>
        )}
      </div>

      {/* Invites */}
      <div>
        <button
          onClick={onMarkSeen}
          className={`px-3 py-1.5 text-sm rounded border ${
            unseenInvites > 0
              ? "chat-pulse"
              : showInvites
                ? "border-[var(--accent)] text-[var(--accent)]"
                : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]"
          }`}
        >
          Invites{unseenInvites > 0 ? ` (${unseenInvites})` : ""}
        </button>
        {showInvites && (
          <div className="mt-4 border border-[var(--border)] rounded-lg overflow-hidden">
            {invites.length === 0 ? (
              <div className="p-4 text-sm text-[var(--muted)] text-center">No invite requests yet.</div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--border)] text-left text-[var(--muted)]">
                    <th className="px-3 py-2">Email</th>
                    <th className="px-3 py-2">Name</th>
                    <th className="px-3 py-2">Company</th>
                    <th className="px-3 py-2">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {invites.map((inv) => (
                    <tr key={inv.id} className="border-b border-[var(--border)] last:border-0">
                      <td className="px-3 py-2">{inv.email}</td>
                      <td className="px-3 py-2 text-[var(--muted)]">{inv.name || "\u2014"}</td>
                      <td className="px-3 py-2 text-[var(--muted)]">{inv.company || "\u2014"}</td>
                      <td className="px-3 py-2 text-[var(--muted)]">{new Date(inv.createdAt).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
