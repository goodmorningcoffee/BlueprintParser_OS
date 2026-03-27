"use client";

import { useState } from "react";
import LLMConfigSection from "../sections/LLMConfigSection";

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
  return (
    <div className="space-y-8">
      {/* YOLO Models */}
      <section>
        <h2 className="text-lg font-semibold mb-3">YOLO Models</h2>

        {/* Existing models */}
        <div className="space-y-2 mb-4">
          {yoloModels.map((m) => (
            <div
              key={m.id}
              className="flex items-center justify-between p-3 bg-[var(--surface)] border border-[var(--border)] rounded"
            >
              <div>
                <span className="font-medium">{m.name}</span>
                <span className="text-xs text-[var(--muted)] ml-2">
                  {(m.config as any)?.classes?.length || 0} classes — conf {(m.config as any)?.confidence || 0.25}
                </span>
              </div>
              <button
                onClick={() => onDeleteModel(m.id)}
                className="text-xs text-[var(--muted)] hover:text-red-400"
              >
                Delete
              </button>
            </div>
          ))}
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
                      <div key={m.id} className="flex gap-1 items-center">
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
                          <span className={`text-xs ${
                            mJob.startsWith("Error") || mJob.startsWith("Failed") || mJob.startsWith("Load failed")
                              ? "text-red-400"
                              : mJob.startsWith("Completed")
                                ? "text-green-400"
                                : "text-[var(--accent)]"
                          }`}>
                            {mJob}
                          </span>
                        )}
                      </div>
                      );
                    })}
                  </div>
                </div>
              ))}
          </div>
        </section>
      )}
    </div>
  );
}
