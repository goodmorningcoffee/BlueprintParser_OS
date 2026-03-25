"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";

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
    <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4">
      <h1 className="text-2xl font-bold text-center mb-6">Sign In</h1>

      {error && (
        <div className="p-3 bg-red-500/10 border border-red-500/30 rounded text-red-400 text-sm">
          {error}
        </div>
      )}

      <input
        type="email"
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        className="w-full px-4 py-3 bg-[var(--surface)] border border-[var(--border)] rounded-lg focus:outline-none focus:border-[var(--accent)]"
      />

      <input
        type="password"
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
        className="w-full px-4 py-3 bg-[var(--surface)] border border-[var(--border)] rounded-lg focus:outline-none focus:border-[var(--accent)]"
      />

      <button
        type="submit"
        disabled={loading}
        className="w-full py-3 bg-[var(--accent)] text-white rounded-lg hover:bg-[var(--accent-hover)] transition-colors font-medium disabled:opacity-50"
      >
        {loading ? "Signing in..." : "Sign In"}
      </button>

      <InviteRequest />
    </form>
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
