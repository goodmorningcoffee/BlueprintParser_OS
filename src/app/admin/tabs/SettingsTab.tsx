"use client";

import { useState, useEffect } from "react";

interface HeaderLinks {
  home: string;
  hded: string;
  modelExchange: string;
  planExchange: string;
  labelFleet: string;
}

const HEADER_LINK_FIELDS: Array<{ key: keyof HeaderLinks; label: string }> = [
  { key: "home", label: "Home" },
  { key: "hded", label: "HDED" },
  { key: "modelExchange", label: "Model Exchange" },
  { key: "planExchange", label: "Plan Exchange" },
  { key: "labelFleet", label: "LabelFleet" },
];

export default function SettingsTab() {
  const [headerLinks, setHeaderLinks] = useState<HeaderLinks>({
    home: "", hded: "", modelExchange: "", planExchange: "", labelFleet: "",
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    fetch("/api/admin/app-settings")
      .then((r) => r.ok ? r.json() : null)
      .then((data: { header_links?: Partial<HeaderLinks> } | null) => {
        if (data?.header_links) setHeaderLinks((prev) => ({ ...prev, ...data.header_links }));
      })
      .catch(() => {});
  }, []);

  async function saveHeaderLinks() {
    setSaving(true);
    setMessage("");
    try {
      const res = await fetch("/api/admin/app-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "header_links", value: headerLinks }),
      });
      setMessage(res.ok ? "Saved" : "Failed to save");
    } catch {
      setMessage("Network error");
    }
    setSaving(false);
    setTimeout(() => setMessage(""), 3000);
  }

  return (
    <div className="space-y-8">
      {/* Demo Page Header Links */}
      <section>
        <h2 className="text-lg font-semibold mb-3">Demo Page Header Links</h2>
        <div className="p-4 bg-[var(--surface)] border border-[var(--border)] rounded space-y-3">
          <p className="text-[10px] text-[var(--muted)]">
            URLs for the nav buttons shown next to &ldquo;BlueprintParser Demo&rdquo; on the public demo page.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {HEADER_LINK_FIELDS.map((field) => (
              <div key={field.key}>
                <label className="block text-[10px] text-[var(--muted)] uppercase tracking-wide mb-1">{field.label}</label>
                <input
                  type="url"
                  value={headerLinks[field.key]}
                  onChange={(e) => setHeaderLinks({ ...headerLinks, [field.key]: e.target.value })}
                  placeholder="https://..."
                  className="w-full px-2 py-1.5 text-xs bg-[var(--bg)] border border-[var(--border)] rounded focus:outline-none focus:border-[var(--accent)]"
                />
              </div>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={saveHeaderLinks}
              disabled={saving}
              className="px-4 py-1.5 text-xs bg-[var(--accent)] text-white rounded hover:bg-[var(--accent-hover)] disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save Links"}
            </button>
            {message && (
              <span className={`text-xs ${message === "Saved" ? "text-emerald-400" : "text-red-400"}`}>
                {message}
              </span>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
