"use client";

// Root-only "Inference instance" picker + job timeout for YOLO SageMaker jobs (owner 2026-10-21/22:
// "select any gpu that we have a quota for, with its price shown … ability to modify timeout time").
//   • Choices: the YOLO-compatible allowlist (src/lib/yolo-instances.ts) narrowed to the types with a
//     LIVE processing-job quota > 0, each with its live on-demand $/h. Quotas unreachable → the whole
//     allowlist + a "quota could not be checked" warning; prices unreachable → the code table, marked
//     approximate. Data: GET /api/admin/yolo-instance/options (./yolo-options-store).
//   • Save → PUT /api/admin/yolo-instance; timeout → PUT /api/admin/yolo-runtime (15 min – 24 h).
// Both are validated again on the server and take effect for jobs started after the save.

import { useEffect, useState } from "react";
import { persistFetch } from "@/lib/client-persist";
import { formatMinutes, formatUsd, selectableYoloOptions, type YoloCatalogOption } from "@/lib/yolo-cost";
import { yoloProcessingQuotaName } from "@/lib/yolo-instances";
import { loadYoloOptions, patchYoloOptions, useYoloOptions } from "./yolo-options-store";

export function catalogOptionLabel(o: YoloCatalogOption): string {
  const hw = o.gpu ? `${o.gpus > 1 ? `${o.gpus}× ` : ""}${o.gpu}` : "CPU only (slow)";
  const price = `${formatUsd(o.usdPerHour)}/h${o.priceSource === "live" ? "" : " approx."}`;
  const quota = o.quota === null ? "" : ` · quota ${o.quota}`;
  return `${o.type} — ${hw} · ${o.vcpu} vCPU · ${o.memoryGiB} GiB · ${price}${quota}`;
}

const btn = "px-2.5 py-1 rounded border border-[var(--border)] hover:border-[var(--accent)] disabled:opacity-40";

export default function YoloInstancePicker() {
  const { data, loading, error } = useYoloOptions();
  const [choice, setChoice] = useState<string | null>(null);
  const [minutes, setMinutes] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void loadYoloOptions();
  }, []);

  const current = data?.instanceType ?? null;
  const selected = choice ?? current ?? "";
  const savedMinutes = data ? Math.round(data.maxRuntimeSeconds / 60) : null;
  const minutesText = minutes ?? (savedMinutes === null ? "" : String(savedMinutes));
  const { options, zeroQuota } = data ? selectableYoloOptions(data.catalog, data.instanceType) : { options: [], zeroQuota: [] };
  const bounds = data?.runtimeBounds ?? { min: 900, max: 86400, default: 3600 };

  async function saveInstance() {
    setSaving(true);
    setMessage("");
    try {
      await persistFetch("/api/admin/yolo-instance", { instanceType: selected }, "PUT");
      patchYoloOptions({ instanceType: selected, valid: true });
      setChoice(null);
      setMessage(`Saved — new YOLO jobs run on ${selected}.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function saveTimeout() {
    const seconds = Math.round(Number(minutesText) * 60);
    if (!Number.isFinite(seconds) || seconds < bounds.min || seconds > bounds.max) {
      setMessage(`Timeout must be between ${bounds.min / 60} and ${bounds.max / 60} minutes`);
      return;
    }
    setSaving(true);
    setMessage("");
    try {
      await persistFetch("/api/admin/yolo-runtime", { maxRuntimeSeconds: seconds }, "PUT");
      patchYoloOptions({ maxRuntimeSeconds: seconds });
      setMinutes(null);
      setMessage(`Saved — new YOLO jobs stop after ${formatMinutes(seconds)}.`);
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
          value={selected}
          disabled={!data}
          onChange={(e) => setChoice(e.target.value)}
          className="px-2 py-1 bg-[var(--bg)] border border-[var(--border)] rounded max-w-full"
        >
          {!data && <option value="">{loading ? "Loading…" : "Unavailable"}</option>}
          {options.map((o) => (
            <option key={o.type} value={o.type}>
              {catalogOptionLabel(o)}
              {o.type === current && (o.quota ?? 1) <= 0 ? " — NO QUOTA" : ""}
            </option>
          ))}
        </select>
        <button type="button" onClick={saveInstance} disabled={saving || !data || selected === current} className={btn}>
          {saving ? "Saving..." : "Save"}
        </button>
        {current && <span className="text-[var(--muted)]">current: {current}</span>}
        <button type="button" onClick={() => void loadYoloOptions(true)} disabled={loading} className={btn} title="Re-read quotas and prices from AWS">
          {loading ? "Checking…" : "Re-check AWS"}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1">
          Job timeout (minutes)
          <input
            aria-label="Job timeout (minutes)"
            type="number"
            min={bounds.min / 60}
            max={bounds.max / 60}
            step={1}
            value={minutesText}
            disabled={!data}
            onChange={(e) => setMinutes(e.target.value)}
            className="w-20 px-2 py-1 bg-[var(--bg)] border border-[var(--border)] rounded"
          />
        </label>
        <button
          type="button"
          onClick={saveTimeout}
          disabled={saving || !data || minutes === null || Number(minutesText) === savedMinutes}
          className={btn}
        >
          Save timeout
        </button>
        <span className="text-[var(--muted)]">
          SageMaker stops a job at this limit ({bounds.min / 60}–{bounds.max / 60} min; default {bounds.default / 60}). Billed time
          never exceeds it.
        </span>
      </div>
      {data && data.catalog.quotaStatus !== "live" && (
        <div className="text-amber-300" data-testid="yolo-quota-warning">
          Processing-job quotas could not be checked — showing every compatible type. A type without quota is refused when a
          job starts (list them with <code>./deploy-aws.sh sagemaker-quotas</code>).
        </div>
      )}
      {data && data.catalog.priceStatus !== "live" && (
        <div className="text-[var(--muted)]">
          {data.catalog.priceStatus === "partial" ? "Some prices" : "Prices"} are approximate, as of {data.catalog.priceTableAsOf}{" "}
          (the AWS Price List was unreachable for them).
        </div>
      )}
      {zeroQuota.length > 0 && (
        <details className="text-[var(--muted)]">
          <summary>{zeroQuota.length} more compatible GPU types have no processing-job quota — request an increase</summary>
          <div className="mt-1">
            In Service Quotas (SageMaker), request e.g. “{yoloProcessingQuotaName(zeroQuota[0].type)}”. Without quota:{" "}
            {zeroQuota.map((o) => o.type).join(", ")}.
          </div>
        </details>
      )}
      <div className="text-[var(--muted)]">
        GPU types are fast; CPU types work but are slow. A job runs one worker per GPU and shares every page across them,
        so a 4-GPU size finishes a job about 4× faster; bulk runs pack up to 9 projects into each job.
      </div>
      {(message || error) && (
        <div className={message.startsWith("Saved") ? "text-green-400" : "text-red-400"}>{message || error}</div>
      )}
    </div>
  );
}
