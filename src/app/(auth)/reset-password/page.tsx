"use client";

import { useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

function ResetForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--bg)]">
        <div className="w-full max-w-sm p-8 rounded-lg border border-[var(--border)] bg-[var(--surface)]">
          <h1 className="text-xl font-bold mb-4 text-[var(--fg)]">Invalid link</h1>
          <p className="text-sm text-[var(--muted)] mb-4">This password reset link is invalid or has expired.</p>
          <Link href="/forgot-password" className="text-sm text-[var(--accent)] hover:underline">
            Request a new link
          </Link>
        </div>
      </div>
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) { setError("Passwords don't match"); return; }
    if (password.length < 10) { setError("Password must be at least 10 characters"); return; }
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (res.ok) {
        setSuccess(true);
      } else {
        setError(data.error || "Something went wrong");
      }
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--bg)]">
        <div className="w-full max-w-sm p-8 rounded-lg border border-[var(--border)] bg-[var(--surface)]">
          <h1 className="text-xl font-bold mb-4 text-green-400">Password updated!</h1>
          <p className="text-sm text-[var(--muted)] mb-4">Your password has been reset. You can now sign in.</p>
          <Link href="/login" className="text-sm text-[var(--accent)] hover:underline font-medium">
            Go to login
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--bg)]">
      <div className="w-full max-w-sm p-8 rounded-lg border border-[var(--border)] bg-[var(--surface)]">
        <h1 className="text-xl font-bold mb-2 text-[var(--fg)]">Set new password</h1>
        <p className="text-sm text-[var(--muted)] mb-6">Must be 10+ characters with 1 uppercase and 1 number.</p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="New password"
            required
            minLength={10}
            className="w-full px-3 py-2 rounded border border-[var(--border)] bg-[var(--bg)] text-[var(--fg)] focus:outline-none focus:border-[var(--accent)]"
          />
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Confirm password"
            required
            className="w-full px-3 py-2 rounded border border-[var(--border)] bg-[var(--bg)] text-[var(--fg)] focus:outline-none focus:border-[var(--accent)]"
          />
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={loading || !password || !confirm}
            className="w-full py-2 rounded bg-[var(--accent)] text-white font-medium disabled:opacity-50 hover:opacity-90"
          >
            {loading ? "Updating..." : "Update password"}
          </button>
        </form>
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-[var(--bg)]"><span className="text-[var(--muted)]">Loading...</span></div>}>
      <ResetForm />
    </Suspense>
  );
}
