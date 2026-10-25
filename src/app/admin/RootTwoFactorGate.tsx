"use client";

// [2026-10-25] Root TOTP 2FA is MANDATORY — the gate /admin shows to a root login that still owes
// its second factor (session.twoFactorGate, set by lib/auth.ts on a session WITHOUT a user):
//   "enroll"  no active enrollment → "Set up your authenticator app to use root tools" + the
//             enrollment panel (password → key/QR → code → backup codes shown once);
//   "verify"  enrolled, this login unverified → the code prompt. POST /api/auth/2fa/verify stores
//             the server-side marker; session.update() makes the JWT callback re-check it and
//             re-issue the cookie, after which the page re-renders with full root.
// Until then this account has NO access at all (not even member): only these routes, sign-out and
// this page work. Sign-out is offered here because the header renders nothing without a user.

import { useState } from "react";
import { signOut, useSession } from "next-auth/react";
import { apiErrorMessage } from "@/lib/client-persist";
import RootTwoFactorPanel from "./tabs/RootTwoFactorPanel";

export default function RootTwoFactorGate({ gate }: { gate: "enroll" | "verify" }) {
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

  const signOutButton = (
    <button
      type="button"
      onClick={() => signOut({ callbackUrl: "/" })}
      className="text-sm text-[var(--muted)] hover:text-[var(--fg)] underline"
    >
      Sign out
    </button>
  );

  if (gate === "enroll") {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="w-full max-w-lg space-y-4">
          <div className="p-6 bg-[var(--surface)] border border-yellow-500/40 rounded space-y-2">
            <h1 className="text-lg font-semibold">Set up your authenticator app to use root tools</h1>
            <p className="text-sm text-[var(--muted)]">
              Two-factor authentication is required for every root admin. This account has no
              access — not even ordinary member access — until an authenticator app is enrolled and
              a code has been entered. Enrolling asks for your account password first.
            </p>
            {signOutButton}
          </div>
          <RootTwoFactorPanel onEnrolled={() => update()} />
        </div>
      </div>
    );
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
          then this account has no access.
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
        {signOutButton}
      </form>
    </div>
  );
}
