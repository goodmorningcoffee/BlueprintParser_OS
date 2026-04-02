"use client";

import { useState } from "react";
import Link from "next/link";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (res.ok) {
        setSent(true);
      } else {
        const data = await res.json();
        setError(data.error || "Something went wrong");
      }
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  if (sent) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--bg)]">
        <div className="w-full max-w-sm p-8 rounded-lg border border-[var(--border)] bg-[var(--surface)]">
          <h1 className="text-xl font-bold mb-4 text-[var(--fg)]">Check your email</h1>
          <p className="text-sm text-[var(--muted)] mb-4">
            If an account exists with that email, we&apos;ve sent a password reset link. It expires in 1 hour.
          </p>
          <Link href="/login" className="text-sm text-[var(--accent)] hover:underline">
            Back to login
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--bg)]">
      <div className="w-full max-w-sm p-8 rounded-lg border border-[var(--border)] bg-[var(--surface)]">
        <h1 className="text-xl font-bold mb-2 text-[var(--fg)]">Reset password</h1>
        <p className="text-sm text-[var(--muted)] mb-6">Enter your email to receive a reset link.</p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email address"
            required
            className="w-full px-3 py-2 rounded border border-[var(--border)] bg-[var(--bg)] text-[var(--fg)] focus:outline-none focus:border-[var(--accent)]"
          />
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={loading || !email}
            className="w-full py-2 rounded bg-[var(--accent)] text-white font-medium disabled:opacity-50 hover:opacity-90"
          >
            {loading ? "Sending..." : "Send reset link"}
          </button>
        </form>
        <div className="mt-4 text-center">
          <Link href="/login" className="text-sm text-[var(--muted)] hover:text-[var(--fg)]">
            Back to login
          </Link>
        </div>
      </div>
    </div>
  );
}
