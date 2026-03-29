"use client";

import { useState, useCallback } from "react";
import { normalizeCsiCodes, CSI_INPUT_PLACEHOLDER } from "@/lib/csi-utils";
import LLMConfigSection from "../sections/LLMConfigSection";
import S3Browser from "../sections/S3Browser";
import type { ModelClassType } from "@/types";

interface ModelItem {
  id: number;
  name: string;
  type: string;
  config: any;
  isDefault: boolean;
}

interface ProjectItem {
  id: string;
  name: string;
  numPages: number | null;
  status: string;
  isDemo: boolean;
}

interface AiModelsTabProps {
  yoloModels: ModelItem[];
  projects: ProjectItem[];
  yoloJobs: Record<string, Record<string, string>>;
  yoloStatus: Record<string, Record<string, number>>;
  uploading: boolean;
  uploadProgress: number;
  onUploadModel: (e: React.FormEvent<HTMLFormElement>) => void;
  onDeleteModel: (id: number) => void;
  onRunYolo: (projectId: string, modelId: number) => void;
  onLoadResults: (projectId: string, modelId: number, modelName: string) => void;
  // Safety toggles (SageMaker/Quota)
  toggles: { sagemakerEnabled: boolean; quotaEnabled: boolean; hasPassword: boolean };
  togglePassword: string;
  setTogglePassword: (v: string) => void;
  toggleError: string;
  setToggleError: (v: string) => void;
  newTogglePass: string;
  setNewTogglePass: (v: string) => void;
  currentTogglePass: string;
  setCurrentTogglePass: (v: string) => void;
  onToggle: (toggle: "sagemaker" | "quota", enabled: boolean) => void;
  onSetTogglePassword: () => void;
}

export default function AiModelsTab({
  yoloModels, projects, yoloJobs, yoloStatus,
  uploading, uploadProgress, onUploadModel, onDeleteModel, onRunYolo, onLoadResults,
  toggles, togglePassword, setTogglePassword, toggleError, setToggleError,
  newTogglePass, setNewTogglePass, currentTogglePass, setCurrentTogglePass,
  onToggle, onSetTogglePassword,
}: AiModelsTabProps) {
  // SageMaker job details state
  const [jobDetails, setJobDetails] = useState<Record<string, any>>({});
  const [expandedJob, setExpandedJob] = useState<string | null>(null);

  // Class config editor state
  const [editingModelId, setEditingModelId] = useState<number | null>(null);
  const [classTypeEdits, setClassTypeEdits] = useState<Record<string, ModelClassType>>({});
  const [classCsiEdits, setClassCsiEdits] = useState<Record<string, string>>({});
  const [classKeywordEdits, setClassKeywordEdits] = useState<Record<string, string>>({});
  const [savingClassTypes, setSavingClassTypes] = useState(false);

  function startEditingClassTypes(model: ModelItem) {
    if (editingModelId === model.id) {
      setEditingModelId(null);
      return;
    }
    setEditingModelId(model.id);
    setClassTypeEdits((model.config as any)?.classTypes || {});
    // Load CSI codes and keywords as comma-separated strings for editing
    const csiMap = (model.config as any)?.classCsiCodes || {};
    const kwMap = (model.config as any)?.classKeywords || {};
    const csiStrings: Record<string, string> = {};
    const kwStrings: Record<string, string> = {};
    for (const [cls, codes] of Object.entries(csiMap)) {
      csiStrings[cls] = (codes as string[]).join(", ");
    }
    for (const [cls, kws] of Object.entries(kwMap)) {
      kwStrings[cls] = (kws as string[]).join(", ");
    }
    setClassCsiEdits(csiStrings);
    setClassKeywordEdits(kwStrings);
  }

  async function saveClassConfig(modelId: number) {
    setSavingClassTypes(true);
    try {
      // Parse comma-separated CSI codes and keywords into arrays
      const classCsiCodes: Record<string, string[]> = {};
      const classKeywords: Record<string, string[]> = {};
      for (const [cls, val] of Object.entries(classCsiEdits)) {
        const codes = normalizeCsiCodes(val);
        if (codes.length > 0) classCsiCodes[cls] = codes;
      }
      for (const [cls, val] of Object.entries(classKeywordEdits)) {
        const kws = val.split(",").map((s) => s.trim()).filter(Boolean);
        if (kws.length > 0) classKeywords[cls] = kws;
      }

      const res = await fetch("/api/admin/models", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: modelId, classTypes: classTypeEdits, classCsiCodes, classKeywords }),
      });
      if (res.ok) {
        const model = yoloModels.find((m) => m.id === modelId);
        if (model) {
          model.config = { ...model.config, classTypes: classTypeEdits, classCsiCodes, classKeywords };
        }
        setEditingModelId(null);
      }
    } catch { /* ignore */ }
    setSavingClassTypes(false);
  }

  const fetchJobDetails = useCallback(async (jobName: string) => {
    if (jobDetails[jobName]) {
      setExpandedJob(expandedJob === jobName ? null : jobName);
      return;
    }
    try {
      const res = await fetch(`/api/admin/sagemaker-details?jobName=${encodeURIComponent(jobName)}`);
      if (res.ok) {
        const data = await res.json();
        setJobDetails((prev) => ({ ...prev, [jobName]: data }));
        setExpandedJob(jobName);
      }
    } catch { /* ignore */ }
  }, [jobDetails, expandedJob]);

  const formatDuration = (secs: number | null) => {
    if (!secs) return "—";
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  };

  return (
    <div className="space-y-8">
      {/* YOLO Models */}
      <section>
        <h2 className="text-lg font-semibold mb-3">YOLO Models</h2>

        {/* Existing models */}
        <div className="space-y-2 mb-4">
          {yoloModels.map((m) => {
            const classes: string[] = (m.config as any)?.classes || [];
            const classTypes: Record<string, ModelClassType> = (m.config as any)?.classTypes || {};
            const classCsiCodes: Record<string, string[]> = (m.config as any)?.classCsiCodes || {};
            const taggedCount = Object.keys(classTypes).length;
            const csiTaggedCount = Object.keys(classCsiCodes).length;
            const spatialCount = Object.values(classTypes).filter((t) => t === "spatial" || t === "both").length;
            return (
            <div key={m.id} className="bg-[var(--surface)] border border-[var(--border)] rounded">
              <div className="flex items-center justify-between p-3">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{m.name}</span>
                  <span className="text-xs text-[var(--muted)]">
                    {classes.length} classes — conf {(m.config as any)?.confidence || 0.25}
                  </span>
                  {taggedCount > 0 && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/10 border border-purple-400/20 text-purple-300">
                      {spatialCount} spatial
                    </span>
                  )}
                  {csiTaggedCount > 0 && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 border border-blue-400/20 text-blue-300">
                      {csiTaggedCount} CSI tagged
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {classes.length > 0 && (
                    <button
                      onClick={() => startEditingClassTypes(m)}
                      className={`text-xs px-2 py-0.5 rounded border ${
                        editingModelId === m.id
                          ? "border-purple-400/40 text-purple-300 bg-purple-500/10"
                          : "text-[var(--muted)] border-[var(--border)] hover:text-purple-300 hover:border-purple-400/30"
                      }`}
                    >
                      {editingModelId === m.id ? "Close" : "Edit Classes"}
                    </button>
                  )}
                  <button
                    onClick={() => onDeleteModel(m.id)}
                    className="text-xs text-[var(--muted)] hover:text-red-400"
                  >
                    Delete
                  </button>
                </div>
              </div>

              {/* Class type editor */}
              {editingModelId === m.id && classes.length > 0 && (
                <div className="px-3 pb-3 border-t border-[var(--border)]">
                  <p className="text-[10px] text-[var(--muted)] mt-2 mb-2">
                    Tag classes as <strong>Spatial</strong> (regions like title blocks, tables — enriches LLM context)
                    or <strong>Countable</strong> (objects like doors — for QTO workflows).
                    Add <strong>CSI codes</strong> and <strong>keywords</strong> per class for trade tagging.
                  </p>
                  <div className="space-y-2">
                    {classes.map((cls) => (
                      <div key={cls} className="py-1.5 border-b border-[var(--border)]/50 last:border-0">
                        <div className="flex items-center gap-3">
                          <span className="text-xs font-mono w-36 truncate shrink-0" title={cls}>{cls}</span>
                          <div className="flex gap-1">
                            {(["spatial", "countable", "both"] as ModelClassType[]).map((type) => (
                              <button
                                key={type}
                                onClick={() => {
                                  setClassTypeEdits((prev) => {
                                    const next = { ...prev };
                                    if (next[cls] === type) {
                                      delete next[cls];
                                    } else {
                                      next[cls] = type;
                                    }
                                    return next;
                                  });
                                }}
                                className={`px-2 py-0.5 text-[10px] rounded border ${
                                  classTypeEdits[cls] === type
                                    ? type === "spatial"
                                      ? "border-purple-400/50 text-purple-300 bg-purple-500/15"
                                      : type === "countable"
                                        ? "border-green-400/50 text-green-300 bg-green-500/15"
                                        : "border-amber-400/50 text-amber-300 bg-amber-500/15"
                                    : "border-[var(--border)] text-[var(--muted)] hover:border-[var(--accent)]/30"
                                }`}
                              >
                                {type}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 mt-1 ml-[9.5rem]">
                          <label className="text-[10px] text-[var(--muted)] w-8 shrink-0">CSI</label>
                          <input
                            type="text"
                            value={classCsiEdits[cls] || ""}
                            onChange={(e) => setClassCsiEdits((prev) => ({ ...prev, [cls]: e.target.value }))}
                            placeholder={CSI_INPUT_PLACEHOLDER}
                            className="flex-1 px-2 py-0.5 text-[10px] bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--fg)] outline-none focus:border-blue-400/50 font-mono"
                          />
                        </div>
                        <div className="flex items-center gap-2 mt-0.5 ml-[9.5rem]">
                          <label className="text-[10px] text-[var(--muted)] w-8 shrink-0">Keys</label>
                          <input
                            type="text"
                            value={classKeywordEdits[cls] || ""}
                            onChange={(e) => setClassKeywordEdits((prev) => ({ ...prev, [cls]: e.target.value }))}
                            placeholder="e.g. door, opening, frame"
                            className="flex-1 px-2 py-0.5 text-[10px] bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--fg)] outline-none focus:border-emerald-400/50"
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center gap-2 mt-3">
                    <button
                      onClick={() => saveClassConfig(m.id)}
                      disabled={savingClassTypes}
                      className="px-3 py-1 text-xs bg-purple-600 text-white rounded hover:bg-purple-500 disabled:opacity-40"
                    >
                      {savingClassTypes ? "Saving..." : "Save Class Config"}
                    </button>
                    <span className="text-[10px] text-[var(--muted)]">
                      {Object.keys(classTypeEdits).length} typed, {Object.values(classCsiEdits).filter(Boolean).length} CSI tagged
                    </span>
                  </div>
                </div>
              )}
            </div>
            );
          })}
          {yoloModels.length === 0 && (
            <p className="text-sm text-[var(--muted)]">No models uploaded yet.</p>
          )}
        </div>

        {/* Upload model form */}
        <form
          onSubmit={onUploadModel}
          className="p-4 bg-[var(--surface)] border border-[var(--border)] rounded space-y-3"
        >
          <h3 className="text-sm font-medium">Upload Model</h3>
          <div className="grid grid-cols-2 gap-2">
            <input
              name="name"
              placeholder="Model name"
              required
              className="px-3 py-1.5 text-sm bg-[var(--bg)] border border-[var(--border)] rounded"
            />
            <input
              name="confidence"
              type="number"
              step="any"
              min="0"
              max="1"
              defaultValue="0.25"
              placeholder="Confidence"
              className="px-3 py-1.5 text-sm bg-[var(--bg)] border border-[var(--border)] rounded"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-[var(--muted)] block mb-1">Model file (.pt)</label>
              <input name="model" type="file" accept=".pt" required className="text-xs" />
            </div>
            <div>
              <label className="text-xs text-[var(--muted)] block mb-1">Classes file (.txt)</label>
              <input name="classes" type="file" accept=".txt" className="text-xs" />
            </div>
          </div>
          {uploading && uploadProgress > 0 && (
            <div className="w-full bg-[var(--bg)] rounded h-2 overflow-hidden">
              <div
                className="h-full bg-[var(--accent)] transition-all duration-300"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
          )}
          <button
            type="submit"
            disabled={uploading}
            className="px-4 py-1.5 text-sm bg-[var(--accent)] text-white rounded hover:bg-[var(--accent-hover)] disabled:opacity-40"
          >
            {uploading ? (uploadProgress > 0 ? `Uploading ${uploadProgress}%` : "Preparing...") : "Upload Model"}
          </button>
        </form>
      </section>

      {/* LLM Configuration — self-contained component */}
      <LLMConfigSection />

      {/* Safety Toggles */}
      <section>
        <h2 className="text-lg font-semibold mb-3">Safety Toggles</h2>
        <div className="p-3 bg-[var(--surface)] border border-[var(--border)] rounded space-y-3">
          {!toggles.hasPassword ? (
            <div className="space-y-2">
              <p className="text-xs text-amber-400">Set a toggle password first. This is independent of your login — a separate secret for controlling SageMaker and quotas.</p>
              <input type="password" placeholder="New toggle password (min 6 chars)" value={newTogglePass}
                onChange={(e) => { setNewTogglePass(e.target.value); setToggleError(""); }}
                className="w-full px-3 py-1.5 text-sm bg-[var(--bg)] border border-[var(--border)] rounded focus:outline-none focus:border-[var(--accent)]" />
              <button onClick={onSetTogglePassword} disabled={newTogglePass.length < 6}
                className="px-3 py-1.5 text-xs bg-amber-600 text-white rounded disabled:opacity-40 hover:bg-amber-500">
                Set Toggle Password
              </button>
              {toggleError && <span className="text-xs text-red-400 block">{toggleError}</span>}
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <span className="font-medium">SageMaker</span>
                  <span className={`text-xs ml-2 ${toggles.sagemakerEnabled ? "text-green-400" : "text-red-400"}`}>
                    {toggles.sagemakerEnabled ? "ENABLED" : "DISABLED"}
                  </span>
                </div>
                <button onClick={() => onToggle("sagemaker", !toggles.sagemakerEnabled)} disabled={!togglePassword}
                  className={`px-3 py-1 text-xs rounded border disabled:opacity-40 ${toggles.sagemakerEnabled ? "border-red-400/30 text-red-400 hover:bg-red-400/10" : "border-green-400/30 text-green-400 hover:bg-green-400/10"}`}>
                  {toggles.sagemakerEnabled ? "Disable" : "Enable"}
                </button>
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <span className="font-medium">Quota Limits</span>
                  <span className={`text-xs ml-2 ${toggles.quotaEnabled ? "text-green-400" : "text-amber-400"}`}>
                    {toggles.quotaEnabled ? "ENFORCED" : "BYPASSED"}
                  </span>
                </div>
                <button onClick={() => onToggle("quota", !toggles.quotaEnabled)} disabled={!togglePassword}
                  className={`px-3 py-1 text-xs rounded border disabled:opacity-40 ${toggles.quotaEnabled ? "border-amber-400/30 text-amber-400 hover:bg-amber-400/10" : "border-green-400/30 text-green-400 hover:bg-green-400/10"}`}>
                  {toggles.quotaEnabled ? "Bypass" : "Enforce"}
                </button>
              </div>
              <div className="flex items-center gap-2 pt-2 border-t border-[var(--border)]">
                <input type="password" placeholder="Toggle password" value={togglePassword}
                  onChange={(e) => { setTogglePassword(e.target.value); setToggleError(""); }}
                  className="flex-1 px-3 py-1.5 text-sm bg-[var(--bg)] border border-[var(--border)] rounded focus:outline-none focus:border-[var(--accent)]" />
                {toggleError && <span className="text-xs text-red-400">{toggleError}</span>}
              </div>
            </>
          )}
        </div>
      </section>

      {/* Run YOLO */}
      {yoloModels.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold mb-3">Run YOLO Inference</h2>
          <div className="space-y-2">
            {projects
              .filter((p) => p.status === "completed")
              .map((p) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between p-3 bg-[var(--surface)] border border-[var(--border)] rounded"
                >
                  <div>
                    <span className="font-medium">{p.name}</span>
                    {yoloStatus[p.id] && Object.values(yoloStatus[p.id]).some(c => c > 0) && !(yoloJobs[p.id] && Object.values(yoloJobs[p.id]).some(Boolean)) && (
                      <span className="text-xs ml-2 text-emerald-400/70">
                        {Object.values(yoloStatus[p.id]).reduce((a, b) => a + b, 0)} detections loaded
                      </span>
                    )}
                  </div>
                  <div className="flex gap-2">
                    {yoloModels.map((m) => {
                      const mk = String(m.id);
                      const mStatus = (yoloStatus[p.id] || {})[mk] || 0;
                      const mJob = (yoloJobs[p.id] || {})[mk] || "";
                      return (
                      <div key={m.id}>
                      <div className="flex gap-1 items-center">
                        <button
                          onClick={() => onRunYolo(p.id, m.id)}
                          disabled={!!mJob && /^(Running|Rasterizing|InProgress|Loading|Waiting|starting)/.test(mJob)}
                          className={`px-3 py-1 text-xs rounded border disabled:opacity-40 ${
                            mStatus > 0
                              ? "bg-purple-500/10 border-purple-400/30 text-purple-300 hover:border-purple-400/60"
                              : "bg-[var(--bg)] border-[var(--border)] hover:border-[var(--accent)]"
                          }`}
                        >
                          Run {m.name}
                        </button>
                        <button
                          onClick={() => onLoadResults(p.id, m.id, m.name)}
                          disabled={!!mJob && /^(Loading|Waiting)/.test(mJob)}
                          className={`px-2 py-1 text-xs rounded border disabled:opacity-40 ${
                            mStatus > 0
                              ? "bg-emerald-500/10 border-emerald-400/30 text-emerald-300 hover:border-emerald-400/60"
                              : "text-[var(--muted)] border-[var(--border)] hover:border-green-500 hover:text-green-400"
                          }`}
                        >
                          {mStatus > 0 ? "Loaded" : "Load"}
                        </button>
                        {mJob && (
                          <>
                            <span className={`text-xs ${
                              mJob.startsWith("Error") || mJob.startsWith("Failed") || mJob.startsWith("Load failed")
                                ? "text-red-400"
                                : mJob.startsWith("Completed")
                                  ? "text-green-400"
                                  : "text-[var(--accent)]"
                            }`}>
                              {mJob}
                            </span>
                            {mJob.startsWith("Running:") && (
                              <button
                                onClick={() => fetchJobDetails(mJob.replace("Running: ", ""))}
                                className="text-[10px] text-[var(--muted)] hover:text-[var(--accent)] underline"
                              >
                                {expandedJob === mJob.replace("Running: ", "") ? "Hide" : "Details"}
                              </button>
                            )}
                          </>
                        )}
                      </div>
                      {/* SageMaker job details panel */}
                      {mJob.startsWith("Running:") && (() => {
                        const jn = mJob.replace("Running: ", "");
                        return expandedJob === jn && jobDetails[jn] ? (
                          <div className="mt-1 p-2 bg-[#0d0d0d] border border-[var(--border)] rounded font-mono text-[10px] text-[var(--muted)] leading-relaxed">
                            <div>Job: <span className="text-[var(--fg)]">{jobDetails[jn].jobName}</span></div>
                            <div>Status: <span className={jobDetails[jn].status === "InProgress" || jobDetails[jn].status === "Completed" ? "text-green-400" : jobDetails[jn].status === "Failed" ? "text-red-400" : "text-[var(--accent)]"}>{jobDetails[jn].status}</span></div>
                            <div>Instance: <span className="text-[var(--fg)]">{jobDetails[jn].instanceType} ({jobDetails[jn].instanceCount}x)</span></div>
                            <div>Volume: <span className="text-[var(--fg)]">{jobDetails[jn].volumeSizeGB} GB</span></div>
                            <div>Started: <span className="text-[var(--fg)]">{jobDetails[jn].startTime ? new Date(jobDetails[jn].startTime).toLocaleString() : "Pending"}</span></div>
                            <div>Duration: <span className="text-[var(--fg)]">{formatDuration(jobDetails[jn].durationSeconds)}</span></div>
                            {jobDetails[jn].inputs?.map((i: any, idx: number) => (
                              <div key={idx}>Input: <span className="text-sky-400/70 break-all">{i.s3Uri}</span></div>
                            ))}
                            {jobDetails[jn].outputs?.map((o: any, idx: number) => (
                              <div key={idx}>Output: <span className="text-sky-400/70 break-all">{o.s3Uri}</span></div>
                            ))}
                            {jobDetails[jn].failureReason && <div>Error: <span className="text-red-400">{jobDetails[jn].failureReason}</span></div>}
                          </div>
                        ) : null;
                      })()}
                      </div>
                      );
                    })}
                  </div>
                </div>
              ))}
          </div>
        </section>
      )}

      {/* S3 Storage Browser */}
      <S3Browser />
    </div>
  );
}
