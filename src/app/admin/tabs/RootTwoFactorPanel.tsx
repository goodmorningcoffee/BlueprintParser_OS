"use client";

// [2026-10-23] Root TOTP 2FA management (Settings tab, root only — the routes are auth:"root").
// Enroll: POST /enroll shows the base32 key + otpauth:// URI (copyable; paste into any
// authenticator app) → a valid code to POST /confirm activates it and shows the 10 backup codes
// ONCE, and session.update() re-issues the cookie with the enrolling login marked verified (the
// server-side marker is short-lived). Disable and "new backup codes" each need a current code. Break-glass if the device is
// lost: `./root_admin.sh 2fa-reset <email>` (deletes the enrollment row over ECS Exec).

import { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { apiErrorMessage } from "@/lib/client-persist";

interface Status {
  enrolled: boolean;
  enrolledAt: string | null;
  backupCodesRemaining: number;
  pendingEnrollment: boolean;
}

interface Enrollment {
  secret: string;
  otpauth: string;
  account: string;
}

type CodeResponse = { backupCodes?: string[] };

async function postCode(
  path: string,
  code: string,
): Promise<{ ok: true; body: CodeResponse } | { ok: false; error: string }> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code.trim() }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: apiErrorMessage(body) || `Request failed (${res.status})` };
    return { ok: true, body: (body ?? {}) as CodeResponse };
  } catch {
    return { ok: false, error: "Network error" };
  }
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1">
      <div className="text-[10px] uppercase tracking-wide text-[var(--muted)]">{label}</div>
      <div className="flex gap-2">
        <input
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          className="flex-1 px-2 py-1 rounded bg-[var(--bg)] border border-[var(--border)] font-mono text-xs"
        />
        <button
          type="button"
          onClick={() => {
            navigator.clipboard?.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }).catch(() => {});
          }}
          className="px-2 py-1 text-xs rounded border border-[var(--border)]"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

function BackupCodes({ codes }: { codes: string[] }) {
  return (
    <div className="p-3 rounded border border-yellow-500/40 bg-yellow-500/10 space-y-2">
      <div className="text-sm font-medium">Backup codes — shown once. Store them somewhere safe.</div>
      <div className="grid grid-cols-2 gap-1 font-mono text-sm">
        {codes.map((c) => (
          <div key={c}>{c}</div>
        ))}
      </div>
      <div className="text-[10px] text-[var(--muted)]">
        Each code works exactly once and replaces the authenticator app for that sign-in.
      </div>
    </div>
  );
}

export default function RootTwoFactorPanel() {
  const { update } = useSession();
  const [status, setStatus] = useState<Status | null>(null);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/2fa/status");
      if (res.ok) setStatus(await res.json());
    } catch {
      /* leave the last known status */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  const startEnrollment = () =>
    run(async () => {
      setBackupCodes(null);
      try {
        const res = await fetch("/api/auth/2fa/enroll", { method: "POST" });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          setError(apiErrorMessage(body) || `Request failed (${res.status})`);
          return;
        }
        setEnrollment(body);
        setCode("");
      } catch {
        setError("Network error");
      }
    });

  const confirmEnrollment = () =>
    run(async () => {
      const r = await postCode("/api/auth/2fa/confirm", code);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setEnrollment(null);
      setBackupCodes(r.body.backupCodes ?? []);
      setCode("");
      setMessage("Two-factor authentication is now active for your root account.");
      // Pick up the verified marker now, as RootTwoFactorGate does after verify; otherwise this
      // login would turn pending once the marker expires.
      await update().catch(() => {});
      await refresh();
    });

  const disable = () =>
    run(async () => {
      const r = await postCode("/api/auth/2fa/disable", code);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setCode("");
      setBackupCodes(null);
      setMessage("Two-factor authentication disabled.");
      await refresh();
    });

  const regenerate = () =>
    run(async () => {
      const r = await postCode("/api/auth/2fa/backup-codes", code);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setCode("");
      setBackupCodes(r.body.backupCodes ?? []);
      setMessage("Backup codes replaced. The old ones no longer work.");
      await refresh();
    });

  const codeInput = (
    <input
      value={code}
      onChange={(e) => setCode(e.target.value)}
      autoComplete="one-time-code"
      placeholder="6-digit code"
      className="px-3 py-1.5 rounded bg-[var(--bg)] border border-[var(--border)] font-mono text-sm w-48"
    />
  );

  return (
    <section>
      <h2 className="text-lg font-semibold mb-3">Root Two-Factor Authentication</h2>
      <div className="p-4 bg-[var(--surface)] border border-[var(--border)] rounded space-y-4">
        <p className="text-[10px] text-[var(--muted)]">
          Authenticator-app (TOTP) code required at every root sign-in. Applies to this root
          account only; company-admin access never needs it. Lost device: the owner runs
          <code className="mx-1">./root_admin.sh 2fa-reset &lt;email&gt;</code> from his machine.
        </p>

        {status === null ? (
          <div className="text-sm text-[var(--muted)]">Loading...</div>
        ) : status.enrolled ? (
          <div className="text-sm">
            <span className="text-green-400 font-medium">Enabled</span>
            {status.enrolledAt && (
              <span className="text-[var(--muted)]"> since {new Date(status.enrolledAt).toLocaleString()}</span>
            )}
            <span className="text-[var(--muted)]"> · {status.backupCodesRemaining} backup code(s) left</span>
          </div>
        ) : (
          <div className="text-sm">
            <span className="text-yellow-400 font-medium">Not enabled</span>
          </div>
        )}

        {message && <div className="text-sm text-green-400">{message}</div>}
        {error && <div className="text-sm text-red-400">{error}</div>}
        {backupCodes && <BackupCodes codes={backupCodes} />}

        {enrollment ? (
          <div className="space-y-3">
            <div className="text-sm">
              Add this key to your authenticator app, then enter the code it shows to activate.
            </div>
            <CopyField label="Key (base32)" value={enrollment.secret} />
            <CopyField label="otpauth:// URI" value={enrollment.otpauth} />
            <div className="flex gap-2 items-center">
              {codeInput}
              <button
                type="button"
                disabled={busy || code.trim().length === 0}
                onClick={confirmEnrollment}
                className="px-3 py-1.5 text-sm rounded bg-[var(--accent)] text-white disabled:opacity-50"
              >
                Activate
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setEnrollment(null);
                  setCode("");
                }}
                className="px-3 py-1.5 text-sm rounded border border-[var(--border)]"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : status?.enrolled ? (
          <div className="flex gap-2 items-center flex-wrap">
            {codeInput}
            <button
              type="button"
              disabled={busy || code.trim().length === 0}
              onClick={regenerate}
              className="px-3 py-1.5 text-sm rounded border border-[var(--border)] disabled:opacity-50"
            >
              New backup codes
            </button>
            <button
              type="button"
              disabled={busy || code.trim().length === 0}
              onClick={disable}
              className="px-3 py-1.5 text-sm rounded border border-red-500/50 text-red-400 disabled:opacity-50"
            >
              Disable
            </button>
          </div>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={startEnrollment}
            className="px-3 py-1.5 text-sm rounded bg-[var(--accent)] text-white disabled:opacity-50"
          >
            {status?.pendingEnrollment ? "Restart enrollment" : "Enable two-factor"}
          </button>
        )}
      </div>
    </section>
  );
}
