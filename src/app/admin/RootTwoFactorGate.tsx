"use client";

// [2026-10-23] Root TOTP 2FA — the code prompt /admin shows to a root user whose login is still
// PENDING (session.user.rootTwoFactorPending). POST /api/auth/2fa/verify stores the server-side
// marker; session.update() then makes the JWT callback re-check it and re-issue the cookie with
// twoFactorVerified=true, after which the page re-renders with full root.

import { useState } from "react";
import { useSession } from "next-auth/react";
import { apiErrorMessage } from "@/lib/client-persist";

export default function RootTwoFactorGate() {
  const { update } = useSession();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/2fa/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(apiErrorMessage(body) || `Verification failed (${res.status})`);
        return;
      }
      await update();
      setCode("");
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <form
        onSubmit={submit}
        className="w-full max-w-sm p-6 bg-[var(--surface)] border border-[var(--border)] rounded space-y-4"
      >
        <h1 className="text-lg font-semibold">Root admin verification</h1>
        <p className="text-sm text-[var(--muted)]">
          Enter the 6-digit code from your authenticator app, or one of your backup codes. Until
          then this account has ordinary admin access only.
        </p>
        <input
          autoFocus
          autoComplete="one-time-code"
          inputMode="text"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="123456 or ABCDE-FGHIJ"
          className="w-full px-3 py-2 rounded bg-[var(--bg)] border border-[var(--border)] font-mono tracking-widest"
        />
        {error && <div className="text-sm text-red-400">{error}</div>}
        <button
          type="submit"
          disabled={busy || code.trim().length === 0}
          className="w-full px-4 py-2 rounded bg-[var(--accent)] text-white text-sm font-medium disabled:opacity-50"
        >
          {busy ? "Verifying..." : "Verify"}
        </button>
      </form>
    </div>
  );
}
