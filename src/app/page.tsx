import Link from "next/link";

export default function LandingPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-8">
      <div className="text-center">
        <h1 className="text-5xl font-bold tracking-tight mb-4">
          BlueprintParser
        </h1>
        <p className="text-[var(--muted)] text-lg max-w-md">
          AI-powered blueprint analysis. Export tables as CSV, auto-QTO,
          and chat with your blueprints: self hostable and opensource.
        </p>
      </div>
      <div className="flex gap-4">
        <Link
          href="/login"
          className="px-6 py-3 bg-[var(--accent)] text-white rounded-lg hover:bg-[var(--accent-hover)] transition-colors font-medium"
        >
          Sign In
        </Link>
        <Link
          href="/demo"
          className="px-6 py-3 border border-[var(--border)] text-[var(--fg)] rounded-lg hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors font-medium"
        >
          Try Demo
        </Link>
      </div>
    </div>
  );
}
