"use client";

// [2026-10-21] Root-only editor for per-user / per-company daily quota overrides
// (owner ruling: "i want ability to modify the limit for a user"). Talks to the root-only
// /api/admin/quota-overrides route; render it only for root admins — the route 403s everyone else.

import { useEffect, useState } from "react";
import { apiErrorMessage } from "@/lib/client-persist";

type QuotaField = "uploadsPerDay" | "yoloJobsPerDay" | "chatMessagesPerDay";
type QuotaEntry = Partial<Record<QuotaField, number | null>>;

export interface QuotaOverridesDoc {
  users: Record<string, QuotaEntry>;
  companies: Record<string, QuotaEntry>;
}

export interface QuotaDefaults {
  uploadsPerDay: { member: number; admin: number };
  yoloJobsPerDay: number;
  chatMessagesPerDay: number;
}

const FIELDS: { field: QuotaField; label: string }[] = [
  { field: "uploadsPerDay", label: "PDF uploads / day" },
  { field: "yoloJobsPerDay", label: "YOLO jobs / day" },
  { field: "chatMessagesPerDay", label: "Chat messages / day" },
];

const MAX_LIMIT = 1_000_000;

/** Loads the overrides document once when `enabled` (root only); `setDoc` takes a save's result. */
export function useQuotaOverrides(enabled: boolean) {
  const [doc, setDoc] = useState<QuotaOverridesDoc | null>(null);
  const [defaults, setDefaults] = useState<QuotaDefaults | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetch("/api/admin/quota-overrides")
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok) {
          setError(apiErrorMessage(body) || "Failed to load quota overrides");
          return;
        }
        setDoc(body.overrides as QuotaOverridesDoc);
        setDefaults(body.defaults as QuotaDefaults);
        setError("");
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load quota overrides");
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return { doc, defaults, error, setDoc };
}

export function hasQuotaOverride(doc: QuotaOverridesDoc | null, target: "user" | "company", id: number): boolean {
  const section = target === "user" ? doc?.users : doc?.companies;
  return !!section && Object.prototype.hasOwnProperty.call(section, String(id));
}

function defaultText(field: QuotaField, defaults: QuotaDefaults | null, role?: string): string {
  if (!defaults) return "default";
  if (field === "uploadsPerDay") {
    if (role === "admin") return `default ${defaults.uploadsPerDay.admin}`;
    if (role) return `default ${defaults.uploadsPerDay.member}`;
    return `default ${defaults.uploadsPerDay.member} member / ${defaults.uploadsPerDay.admin} admin`;
  }
  return `default ${defaults[field]}`;
}

interface FieldState {
  text: string;
  unlimited: boolean;
}

function initialState(entry: QuotaEntry | undefined): Record<QuotaField, FieldState> {
  const state = {} as Record<QuotaField, FieldState>;
  for (const { field } of FIELDS) {
    const value = entry && Object.prototype.hasOwnProperty.call(entry, field) ? entry[field] : undefined;
    state[field] = { text: typeof value === "number" ? String(value) : "", unlimited: value === null };
  }
  return state;
}

interface EditorProps {
  target: "user" | "company";
  id: number;
  label: string;
  /** user role, so the upload default shown is the one that applies */
  role?: string;
  isRootAdmin?: boolean;
  doc: QuotaOverridesDoc | null;
  defaults: QuotaDefaults | null;
  onSaved: (doc: QuotaOverridesDoc) => void;
  onClose: () => void;
}

export default function QuotaOverrideEditor(props: EditorProps) {
  if (!props.doc) {
    return <div className="p-2 text-[10px] text-[var(--muted)]">Loading quotas...</div>;
  }
  // Mount the form only once the document is loaded, so its fields start from the saved entry.
  return <QuotaOverrideForm {...props} doc={props.doc} />;
}

function QuotaOverrideForm({
  target, id, label, role, isRootAdmin, doc, defaults, onSaved, onClose,
}: EditorProps & { doc: QuotaOverridesDoc }) {
  const entry = (target === "user" ? doc.users : doc.companies)[String(id)];
  const [fields, setFields] = useState(() => initialState(entry));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const save = async (clear: boolean) => {
    const limits: QuotaEntry = {};
    if (!clear) {
      for (const { field, label: fieldLabel } of FIELDS) {
        const state = fields[field];
        if (state.unlimited) {
          limits[field] = null;
        } else if (state.text.trim() !== "") {
          const n = Number(state.text.trim());
          if (!Number.isInteger(n) || n < 0 || n > MAX_LIMIT) {
            setMessage(`${fieldLabel}: whole number 0 to ${MAX_LIMIT.toLocaleString()}, or blank for default`);
            return;
          }
          limits[field] = n;
        }
      }
    }
    setBusy(true);
    setMessage("");
    try {
      const res = await fetch("/api/admin/quota-overrides", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target, id, limits }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setMessage(apiErrorMessage(body) || "Save failed");
      } else {
        onSaved(body.overrides as QuotaOverridesDoc);
        if (clear) setFields(initialState(undefined));
        setMessage(clear ? "Back to defaults" : "Saved");
      }
    } catch {
      setMessage("Save failed");
    }
    setBusy(false);
  };

  return (
    <div className="p-2 border border-sky-500/30 rounded bg-sky-500/5 space-y-1.5 text-[10px]">
      <div className="flex items-center justify-between">
        <span className="text-sky-400 font-medium">Daily quotas for {label}</span>
        <button onClick={onClose} className="text-[var(--muted)] hover:text-[var(--fg)]">Close</button>
      </div>
      {isRootAdmin && (
        <div className="text-amber-400">Root admin: exempt from every quota. Overrides here have no effect while root.</div>
      )}
      {FIELDS.map(({ field, label: fieldLabel }) => (
        <div key={field} className="flex items-center gap-2">
          <span className="w-32 text-[var(--fg)]">{fieldLabel}</span>
          <input
            value={fields[field].text}
            disabled={fields[field].unlimited}
            inputMode="numeric"
            onChange={(e) => { setMessage(""); setFields((p) => ({ ...p, [field]: { ...p[field], text: e.target.value } })); }}
            placeholder={defaultText(field, defaults, target === "user" ? role : undefined)}
            className="w-40 px-2 py-1 bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--fg)] outline-none disabled:opacity-40"
          />
          <label className="flex items-center gap-1 text-[var(--muted)]">
            <input
              type="checkbox"
              checked={fields[field].unlimited}
              onChange={(e) => { setMessage(""); setFields((p) => ({ ...p, [field]: { ...p[field], unlimited: e.target.checked } })); }}
            />
            Unlimited
          </label>
        </div>
      ))}
      <div className="text-[var(--muted)]">
        Blank = default. 0 blocks the action. {target === "user"
          ? "A user override replaces the company's; uploads and chat then count this user's own activity, YOLO still counts the company's jobs."
          : "Applies to every user in the company without a user override."}{" "}
        Hourly request limits (e.g. 10 new projects / hour) still apply to non-root users.
      </div>
      {message && <div className={message === "Saved" || message === "Back to defaults" ? "text-green-400" : "text-red-400"}>{message}</div>}
      <div className="flex gap-1">
        <button onClick={() => save(false)} disabled={busy} className="px-3 py-1 rounded bg-[var(--accent)] text-white disabled:opacity-40">
          {busy ? "Saving..." : "Save"}
        </button>
        <button onClick={() => save(true)} disabled={busy} className="px-3 py-1 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] disabled:opacity-40">
          Reset to defaults
        </button>
      </div>
    </div>
  );
}
