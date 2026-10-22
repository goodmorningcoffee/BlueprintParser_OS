"use client";

// Root-only "Inference instance" picker for YOLO SageMaker jobs (owner 2026-10-21). Reads/writes
// /api/admin/yolo-instance (auth:"root"); the server validates against the same allowlist
// (src/lib/yolo-instances.ts). The change applies to jobs started after the save. Quota values
// are not shown here (no IAM for it on the web task): run `./deploy-aws.sh sagemaker-quotas`.

import { useEffect, useState } from "react";
import { apiErrorMessage, persistFetch } from "@/lib/client-persist";
import {
  DEFAULT_YOLO_INSTANCE_TYPE,
  YOLO_INSTANCE_OPTIONS,
  yoloInstanceLabel,
} from "@/lib/yolo-instances";

export default function YoloInstancePicker() {
  const [current, setCurrent] = useState<string | null>(null);
  const [choice, setChoice] = useState(DEFAULT_YOLO_INSTANCE_TYPE);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    fetch("/api/admin/yolo-instance")
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (!live) return;
        if (!r.ok) {
          setMessage(apiErrorMessage(body) || `Could not read the instance setting (HTTP ${r.status})`);
          return;
        }
        const type = (body as { instanceType?: unknown } | null)?.instanceType;
        if (typeof type === "string") {
          setCurrent(type);
          setChoice(type);
        }
      })
      .catch(() => live && setMessage("Could not read the instance setting"));
    return () => {
      live = false;
    };
  }, []);

  async function save() {
    setSaving(true);
    setMessage("");
    try {
      await persistFetch("/api/admin/yolo-instance", { instanceType: choice }, "PUT");
      setCurrent(choice);
      setMessage(`Saved — new YOLO jobs run on ${choice}.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mb-3 p-3 bg-[var(--surface)] border border-[var(--border)] rounded text-xs space-y-1" data-testid="yolo-instance-picker">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-sm">Inference instance</span>
        <select
          aria-label="Inference instance"
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
          className="px-2 py-1 bg-[var(--bg)] border border-[var(--border)] rounded max-w-full"
        >
          {YOLO_INSTANCE_OPTIONS.map((o) => (
            <option key={o.type} value={o.type}>{yoloInstanceLabel(o)}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={save}
          disabled={saving || current === null || choice === current}
          className="px-2.5 py-1 rounded border border-[var(--border)] hover:border-[var(--accent)] disabled:opacity-40"
        >
          {saving ? "Saving..." : "Save"}
        </button>
        {current && <span className="text-[var(--muted)]">current: {current}</span>}
      </div>
      <div className="text-[var(--muted)]">
        GPU types (T4/A10G/L4/L40S/V100) are fast; CPU types work but are slow. A job uses one GPU; prices
        are rough. The account needs a processing-job quota for the type — list them with{" "}
        <code>./deploy-aws.sh sagemaker-quotas</code>.
      </div>
      {message && <div className={message.startsWith("Saved") ? "text-green-400" : "text-red-400"}>{message}</div>}
    </div>
  );
}
