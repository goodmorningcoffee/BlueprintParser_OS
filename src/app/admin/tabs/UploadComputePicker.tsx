"use client";

// [2026-10-23] Root-only "Upload compute" picker (admin › Pipeline). The Fargate size each uploaded
// project's processing task starts with: GET/PUT /api/admin/upload-compute (allowlist in
// src/lib/upload-compute.ts, validated again on the server, audited). Takes effect for uploads started
// after the save; the page concurrency follows the preset unless the company Page Concurrency below
// is set.

import { useEffect, useState } from "react";
import { apiErrorMessage, persistFetch } from "@/lib/client-persist";
import { uploadComputeLabel, type UploadComputePreset } from "@/lib/upload-compute";

interface UploadComputeSetting {
  preset: string;
  valid: boolean;
  defaultPreset: string;
  presets: UploadComputePreset[];
}

const btn = "px-2.5 py-1 rounded border border-[var(--border)] hover:border-[var(--accent)] disabled:opacity-40";

export default function UploadComputePicker() {
  const [data, setData] = useState<UploadComputeSetting | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    fetch("/api/admin/upload-compute")
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(apiErrorMessage(body) || `HTTP ${res.status}`);
        if (live) setData(body as UploadComputeSetting);
      })
      .catch((err: unknown) => {
        if (live) setMessage(`Could not load the upload compute size: ${err instanceof Error ? err.message : String(err)}`);
      });
    return () => {
      live = false;
    };
  }, []);

  const current = data?.preset ?? null;
  const selected = choice ?? current ?? "";

  async function save() {
    setSaving(true);
    setMessage("");
    try {
      await persistFetch("/api/admin/upload-compute", { preset: selected }, "PUT");
      setData((d) => (d ? { ...d, preset: selected, valid: true } : d));
      setChoice(null);
      setMessage(`Saved — new uploads process on ${selected.replace("x", " vCPU · ")} GB.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-1 px-3 py-2 mb-3 rounded border border-[var(--border)] bg-[var(--surface)] text-xs" data-testid="upload-compute-picker">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-[var(--fg)]">Upload compute (root)</span>
        <select
          aria-label="Upload compute"
          value={selected}
          disabled={!data}
          onChange={(e) => setChoice(e.target.value)}
          className="px-2 py-1 bg-[var(--bg)] border border-[var(--border)] rounded max-w-full"
        >
          {!data && <option value="">Loading…</option>}
          {data?.presets.map((p) => (
            <option key={p.id} value={p.id}>
              {uploadComputeLabel(p)}
            </option>
          ))}
        </select>
        <button type="button" onClick={save} disabled={saving || !data || selected === current} className={btn}>
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
      <div className="text-[10px] text-[var(--muted)]">
        Fargate size of each upload&apos;s processing task (all companies). Pages processed at once = the vCPU count,
        unless the company Page Concurrency below is set. Larger sizes cost more per minute; applies to uploads started
        after saving.
      </div>
      {message && <div className={message.startsWith("Saved") ? "text-green-400" : "text-red-400"}>{message}</div>}
    </div>
  );
}
