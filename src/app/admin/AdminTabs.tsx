"use client";

export type AdminTab = "overview" | "projects" | "ai-models" | "text-annotations" | "csi" | "heuristics" | "page-intelligence" | "users" | "settings";

const TABS: { id: AdminTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "projects", label: "Demo Projects" },
  { id: "ai-models", label: "AI Models" },
  { id: "text-annotations", label: "Text Annotations" },
  { id: "csi", label: "CSI Codes" },
  { id: "heuristics", label: "Heuristics" },
  { id: "page-intelligence", label: "Page Intelligence" },
  { id: "users", label: "Users" },
  { id: "settings", label: "Settings" },
];

interface AdminTabsProps {
  active: AdminTab;
  onChange: (tab: AdminTab) => void;
  badges?: Partial<Record<AdminTab, number>>;
}

export default function AdminTabs({ active, onChange, badges }: AdminTabsProps) {
  return (
    <div className="flex gap-1 border-b border-[var(--border)] mb-6">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={`px-4 py-2 text-sm font-medium transition-colors relative ${
            active === tab.id
              ? "text-[var(--accent)] border-b-2 border-[var(--accent)]"
              : "text-[var(--muted)] hover:text-[var(--fg)]"
          }`}
        >
          {tab.label}
          {badges?.[tab.id] ? (
            <span className="ml-1.5 px-1.5 py-0.5 text-[10px] rounded-full bg-[var(--accent)] text-white">
              {badges[tab.id]}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
