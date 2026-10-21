"use client";

import { useEffect, useState } from "react";
import { CsiChip } from "./CsiChipDemo";

/** One row of `POST /api/csi/detect` → `{ csiTags: [{ code, description }] }`. */
interface CsiTag {
  code: string;
  description: string;
}

const DEFAULT_TEXT = "PTD GWB on MTL STUD. ACT 2x4 lay-in ceiling. Hollow metal doors and frames by others.";

/** Hits the real /api/csi/detect endpoint (the v2 tagger) with a debounce and renders the
 *  returned `csiTags`. Falls back to a recorded example when the backend errors. */
export function CsiTierExplainer() {
  const [text, setText] = useState(DEFAULT_TEXT);
  const [tags, setTags] = useState<CsiTag[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<"idle" | "ok" | "error" | "unauth">("idle");

  useEffect(() => {
    if (!text.trim()) {
      setTags(null);
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
          setTags(FALLBACK_TAGS);
        } else if (!res.ok) {
          setStatus("error");
          setTags(FALLBACK_TAGS);
        } else {
          const data: unknown = await res.json();
          const rows = (data as { csiTags?: unknown })?.csiTags;
          setStatus("ok");
          setTags(Array.isArray(rows) ? (rows as CsiTag[]).slice(0, 8) : []);
        }
      } catch {
        if (ctrl.signal.aborted) return;
        setStatus("error");
        setTags(FALLBACK_TAGS);
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
        Type a line of drawing text — the backend runs the same CSI tagger the pipeline uses and returns
        the codes it would list. A single generic word (&quot;concrete&quot;) lists nothing; text ending
        in &quot;by others&quot; or &quot;N.I.C.&quot; is not tagged.
      </label>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        className="w-full px-3 py-2 text-sm bg-[var(--bg)] border border-[var(--border)] rounded font-mono focus:outline-none focus:border-[var(--accent)]"
        placeholder="e.g. PTD GWB on MTL STUD, ACT 2x4 lay-in ceiling, cast-in-place concrete slab on grade..."
      />
      <div className="flex items-center gap-2 min-h-5">
        {loading && <span className="text-[11px] text-[var(--muted)] animate-pulse">detecting…</span>}
        {!loading && status === "ok" && tags && (
          <span className="text-[11px] text-emerald-400">
            ✓ {tags.length} code{tags.length === 1 ? "" : "s"} from /api/csi/detect
          </span>
        )}
        {!loading && status === "unauth" && (
          <span className="text-[11px] text-amber-400">
            Not signed in — showing a recorded example.
          </span>
        )}
        {!loading && status === "error" && (
          <span className="text-[11px] text-red-400">Backend unavailable — showing a recorded example.</span>
        )}
      </div>
      {tags && tags.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {tags.map((t, i) => (
            <CsiChip key={`${t.code}-${i}`} code={t.code} description={t.description} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Recorded from the v2 tagger on DEFAULT_TEXT (2026-10-21): the door line is dropped by "by others". */
const FALLBACK_TAGS: CsiTag[] = [
  { code: "09 22 16", description: "Non-Structural Metal Framing" },
  { code: "09 51 13", description: "Acoustical Panel Ceilings" },
  { code: "09 29 00", description: "Gypsum Board" },
  { code: "09 91 00", description: "Painting" },
];
