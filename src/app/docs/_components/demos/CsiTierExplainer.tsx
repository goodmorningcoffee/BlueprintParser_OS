"use client";

import { useEffect, useState } from "react";
import { CsiChip } from "./CsiChipDemo";

interface CsiMatch {
  code: string;
  description: string;
  division: string;
  trade: string;
  confidence?: number;
  tier?: number;
}

/** Hits the real /api/csi/detect endpoint with a debounce. Falls back to a
 *  static example when the user is unauthenticated or the backend errors. */
export function CsiTierExplainer() {
  const [text, setText] = useState("hot water heater installation per section 22 34 13");
  const [matches, setMatches] = useState<CsiMatch[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<"idle" | "ok" | "error" | "unauth">("idle");

  useEffect(() => {
    if (!text.trim()) {
      setMatches(null);
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/csi/detect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
          signal: ctrl.signal,
        });
        if (res.status === 401 || res.status === 403) {
          setStatus("unauth");
          setMatches(FALLBACK_MATCHES);
        } else if (!res.ok) {
          setStatus("error");
          setMatches(FALLBACK_MATCHES);
        } else {
          const data = await res.json();
          const rows: CsiMatch[] = Array.isArray(data) ? data : data?.codes ?? data?.matches ?? [];
          setStatus("ok");
          setMatches(rows.slice(0, 6));
        }
      } catch {
        setStatus("error");
        setMatches(FALLBACK_MATCHES);
      } finally {
        setLoading(false);
      }
    }, 400);
    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [text]);

  return (
    <div className="space-y-3 max-w-2xl">
      <label className="block text-[11px] text-[var(--muted)]">
        Type any construction phrase — the backend runs the 3-tier matcher and returns detected divisions.
      </label>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        className="w-full px-3 py-2 text-sm bg-[var(--bg)] border border-[var(--border)] rounded font-mono focus:outline-none focus:border-[var(--accent)]"
        placeholder="e.g. concrete slab on grade, hydronic heating, GWB partition..."
      />
      <div className="flex items-center gap-2 min-h-5">
        {loading && <span className="text-[11px] text-[var(--muted)] animate-pulse">detecting…</span>}
        {!loading && status === "ok" && matches && (
          <span className="text-[11px] text-emerald-400">✓ {matches.length} match{matches.length === 1 ? "" : "es"} from /api/csi/detect</span>
        )}
        {!loading && status === "unauth" && (
          <span className="text-[11px] text-amber-400">
            Not signed in — showing cached example. Sign in to exercise the live endpoint.
          </span>
        )}
        {!loading && status === "error" && (
          <span className="text-[11px] text-red-400">Backend unavailable — showing cached example.</span>
        )}
      </div>
      {matches && matches.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {matches.map((m, i) => (
            <CsiChip
              key={`${m.code}-${i}`}
              code={m.code}
              description={m.description}
              confidence={m.confidence}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const FALLBACK_MATCHES: CsiMatch[] = [
  { code: "22 34 13", description: "Instantaneous, Gas, Domestic Water Heaters", division: "22", trade: "Plumbing", confidence: 0.95 },
  { code: "22 33 00", description: "Electric Domestic Water Heaters", division: "22", trade: "Plumbing", confidence: 0.74 },
  { code: "22 00 00", description: "Plumbing", division: "22", trade: "Plumbing", confidence: 0.52 },
];
