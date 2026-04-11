"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    const result = await signIn("credentials", {
      email,
      password,
      redirect: false,
    });

    if (result?.error) {
      setError("Invalid email or password");
      setLoading(false);
    } else {
      router.push("/home");
    }
  }

  const [showInvite, setShowInvite] = useState(false);

  return (
    <div className="w-full max-w-sm space-y-4">
      <h1 className="text-2xl font-bold text-center mb-6">Sign In</h1>

      <button
        type="button"
        onClick={() => signIn("google", { callbackUrl: "/home" })}
        className="w-full py-3 bg-[var(--surface)] border border-[var(--border)] rounded-lg hover:bg-[var(--bg)] transition-colors font-medium flex items-center justify-center gap-2"
      >
        <svg width="18" height="18" viewBox="0 0 24 24">
          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
          <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
          <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
        </svg>
        Sign in with Google
      </button>

      <div className="flex items-center gap-3">
        <div className="flex-1 h-px bg-[var(--border)]" />
        <span className="text-xs text-[var(--muted)]">or</span>
        <div className="flex-1 h-px bg-[var(--border)]" />
      </div>

      {error && (
        <div className="p-3 bg-red-500/10 border border-red-500/30 rounded text-red-400 text-sm">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          className="w-full px-4 py-3 bg-[var(--surface)] border border-[var(--border)] rounded-lg focus:outline-none focus:border-[var(--accent)]"
        />

        <div>
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            className="w-full px-4 py-3 bg-[var(--surface)] border border-[var(--border)] rounded-lg focus:outline-none focus:border-[var(--accent)]"
          />
          <div className="mt-1 text-right">
            <Link href="/forgot-password" className="text-xs text-[var(--accent)] hover:underline">
              Forgot password?
            </Link>
          </div>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full py-3 bg-[var(--accent)] text-white rounded-lg hover:bg-[var(--accent-hover)] transition-colors font-medium disabled:opacity-50"
        >
          {loading ? "Signing in..." : "Sign In"}
        </button>
      </form>

      <InviteRequest />

      <div className="text-center pt-2">
        <Link href="/docs" className="text-xs text-[var(--muted)] hover:text-[var(--accent)]">
          Read the docs →
        </Link>
      </div>
    </div>
  );
}

function InviteRequest() {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [done, setDone] = useState(false);
  const [sending, setSending] = useState(false);

  async function submit() {
    if (!email.includes("@")) return;
    setSending(true);
    try {
      const res = await fetch("/api/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, name, company }),
      });
      if (res.ok) setDone(true);
    } catch { /* ignore */ }
    setSending(false);
  }

  if (done) {
    return <p className="text-center text-sm text-emerald-400">Invite requested! We'll be in touch.</p>;
  }

  if (!open) {
    return (
      <p className="text-center text-sm text-[var(--muted)]">
        No account?{" "}
        <button onClick={() => setOpen(true)} className="text-[var(--accent)] hover:underline">
          Request Invite
        </button>
      </p>
    );
  }

  return (
    <div className="space-y-2 pt-2 border-t border-[var(--border)]">
      <p className="text-xs text-[var(--muted)] text-center">Request an invite</p>
      <input
        type="email"
        placeholder="Email *"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="w-full px-3 py-2 text-sm bg-[var(--surface)] border border-[var(--border)] rounded focus:outline-none focus:border-[var(--accent)]"
      />
      <input
        type="text"
        placeholder="Name (optional)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="w-full px-3 py-2 text-sm bg-[var(--surface)] border border-[var(--border)] rounded focus:outline-none focus:border-[var(--accent)]"
      />
      <input
        type="text"
        placeholder="Company (optional)"
        value={company}
        onChange={(e) => setCompany(e.target.value)}
        className="w-full px-3 py-2 text-sm bg-[var(--surface)] border border-[var(--border)] rounded focus:outline-none focus:border-[var(--accent)]"
      />
      <div className="flex gap-2 justify-center">
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-[var(--muted)]">Cancel</button>
        <button type="button" onClick={submit} disabled={sending || !email.includes("@")} className="text-xs px-3 py-1 bg-[var(--accent)] text-white rounded disabled:opacity-50">
          {sending ? "..." : "Submit"}
        </button>
      </div>
    </div>
  );
}
