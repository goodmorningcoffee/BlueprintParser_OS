"use client";

import { useState, useEffect } from "react";
import OpenReprocessLink from "./OpenReprocessLink";
import type { ReprocessPreset } from "./reprocess-plan";

interface InviteItem {
  id: number;
  email: string;
  name: string | null;
  company: string | null;
  seen: boolean;
  createdAt: string;
}

interface OverviewTabProps {
  invites: InviteItem[];
  unseenInvites: number;
  showInvites: boolean;
  onMarkSeen: () => void;
  isRootAdmin?: boolean;
  /** [2026-10-24] "Re-run All Processes" became a link into the Reprocess tab ("Full refresh" preset). */
  onOpenReprocess: (preset: ReprocessPreset) => void;
}

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

export default function OverviewTab({ invites, unseenInvites, showInvites, onMarkSeen, isRootAdmin, onOpenReprocess }: OverviewTabProps) {
  // Header links editor state (root admin only)
  const [headerLinks, setHeaderLinks] = useState<HeaderLinks>({
    home: "", hded: "", modelExchange: "", planExchange: "", labelFleet: "",
  });
  const [linksSaving, setLinksSaving] = useState(false);
  const [linksMessage, setLinksMessage] = useState("");

  useEffect(() => {
    if (!isRootAdmin) return;
    fetch("/api/admin/app-settings")
      .then((r) => r.ok ? r.json() : null)
      .then((data: { header_links?: Partial<HeaderLinks> } | null) => {
        if (data?.header_links) setHeaderLinks((prev) => ({ ...prev, ...data.header_links }));
      })
      .catch(() => {});
  }, [isRootAdmin]);

  async function saveHeaderLinks() {
    setLinksSaving(true);
    setLinksMessage("");
    try {
      const res = await fetch("/api/admin/app-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "header_links", value: headerLinks }),
      });
      setLinksMessage(res.ok ? "Saved" : "Failed");
    } catch {
      setLinksMessage("Network error");
    }
    setLinksSaving(false);
    setTimeout(() => setLinksMessage(""), 2000);
  }

  return (
    <section className="space-y-6">
      {/* Re-runs live in the Reprocess tab now (one scope, one plan, one console) */}
      <div className="border border-[var(--border)] rounded-lg p-4 space-y-3 bg-[var(--surface)]">
        <div>
          <h3 className="text-sm font-semibold text-[var(--fg)]">Re-run All Processes</h3>
          <p className="text-[10px] text-[var(--muted)] mt-1">
            Page naming, text annotations + CSI detection, shape parse and intelligence analysis re-run on existing data from the
            Reprocess tab, which previews the scope first and shows every error line. Existing YOLO annotations are picked up by the
            intelligence stage; to refresh YOLO detections themselves, run the model from the AI Models tab.
          </p>
        </div>
        <OpenReprocessLink preset="full-refresh" onOpen={onOpenReprocess} />
      </div>

      {/* Invites */}
      <div>
        <button
          onClick={onMarkSeen}
          className={`px-3 py-1.5 text-sm rounded border ${
            unseenInvites > 0
              ? "chat-pulse"
              : showInvites
                ? "border-[var(--accent)] text-[var(--accent)]"
                : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]"
          }`}
        >
          Invites{unseenInvites > 0 ? ` (${unseenInvites})` : ""}
        </button>
        {showInvites && (
          <div className="mt-4 border border-[var(--border)] rounded-lg overflow-hidden">
            {invites.length === 0 ? (
              <div className="p-4 text-sm text-[var(--muted)] text-center">No invite requests yet.</div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--border)] text-left text-[var(--muted)]">
                    <th className="px-3 py-2">Email</th>
                    <th className="px-3 py-2">Name</th>
                    <th className="px-3 py-2">Company</th>
                    <th className="px-3 py-2">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {invites.map((inv) => (
                    <tr key={inv.id} className="border-b border-[var(--border)] last:border-0">
                      <td className="px-3 py-2">{inv.email}</td>
                      <td className="px-3 py-2 text-[var(--muted)]">{inv.name || "\u2014"}</td>
                      <td className="px-3 py-2 text-[var(--muted)]">{inv.company || "\u2014"}</td>
                      <td className="px-3 py-2 text-[var(--muted)]">{new Date(inv.createdAt).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
