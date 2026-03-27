"use client";

import { useState, useCallback } from "react";

interface S3Item {
  key: string;
  name: string;
  isFolder: boolean;
  size: string | null;
  sizeBytes?: number;
  lastModified: string | null;
}

export default function S3Browser() {
  const [prefix, setPrefix] = useState("");
  const [items, setItems] = useState<S3Item[]>([]);
  const [bucket, setBucket] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const browse = useCallback(async (newPrefix: string) => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/s3-browser?prefix=${encodeURIComponent(newPrefix)}`);
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to browse");
        return;
      }
      const data = await res.json();
      setPrefix(data.prefix);
      setBucket(data.bucket);
      setItems([...data.folders, ...data.files]);
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }, []);

  const download = useCallback(async (key: string) => {
    try {
      const res = await fetch(`/api/admin/s3-browser?download=${encodeURIComponent(key)}`);
      if (res.ok) {
        const { url } = await res.json();
        window.open(url, "_blank");
      }
    } catch { /* ignore */ }
  }, []);

  const goUp = () => {
    const parts = prefix.replace(/\/$/, "").split("/");
    parts.pop();
    browse(parts.length > 0 ? parts.join("/") + "/" : "");
  };

  return (
    <section>
      <h2 className="text-lg font-semibold mb-3">S3 Storage Browser</h2>
      <div className="p-3 bg-[var(--surface)] border border-[var(--border)] rounded space-y-3">
        {/* Path bar */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-[var(--muted)] shrink-0">
            {bucket ? `s3://${bucket}/` : "S3"}
          </span>
          <input
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") browse(prefix); }}
            placeholder="Enter prefix to browse (e.g., companyKey/projectHash/)"
            className="flex-1 px-2 py-1 text-xs bg-[var(--bg)] border border-[var(--border)] rounded font-mono"
          />
          <button
            onClick={() => browse(prefix)}
            disabled={loading}
            className="px-3 py-1 text-xs border border-[var(--border)] rounded text-[var(--accent)] hover:border-[var(--accent)] disabled:opacity-40"
          >
            {loading ? "..." : "Browse"}
          </button>
        </div>

        {error && <div className="text-xs text-red-400">{error}</div>}

        {/* File listing */}
        {items.length > 0 && (
          <div className="border border-[var(--border)] rounded overflow-hidden">
            {/* Go up */}
            {prefix && (
              <button
                onClick={goUp}
                className="w-full text-left px-3 py-1.5 text-xs text-[var(--accent)] hover:bg-[var(--bg)] border-b border-[var(--border)]"
              >
                .. (up)
              </button>
            )}
            {items.map((item) => (
              <div
                key={item.key}
                className="flex items-center justify-between px-3 py-1.5 text-xs hover:bg-[var(--bg)] border-b border-[var(--border)] last:border-0 cursor-pointer"
                onClick={() => item.isFolder ? browse(item.key) : download(item.key)}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className={item.isFolder ? "text-amber-400" : "text-[var(--muted)]"}>
                    {item.isFolder ? "\uD83D\uDCC1" : "\uD83D\uDCC4"}
                  </span>
                  <span className="text-[var(--fg)] truncate font-mono">{item.name}</span>
                </div>
                <div className="flex items-center gap-3 shrink-0 ml-3">
                  {item.size && <span className="text-[var(--muted)]">{item.size}</span>}
                  {item.lastModified && (
                    <span className="text-[var(--muted)]">
                      {new Date(item.lastModified).toLocaleDateString()}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {items.length === 0 && !loading && !error && bucket && (
          <div className="text-xs text-[var(--muted)] text-center py-4">
            No objects found at this prefix
          </div>
        )}

        {!bucket && !loading && (
          <div className="text-xs text-[var(--muted)]">
            Enter a prefix above and click Browse to explore your S3 bucket.
          </div>
        )}
      </div>
    </section>
  );
}
