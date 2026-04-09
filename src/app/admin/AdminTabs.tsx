"use client";

export type AdminTab = "overview" | "projects" | "ai-models" | "ai-rbac" | "pipeline" | "llm-context" | "text-annotations" | "csi" | "heuristics" | "page-intelligence" | "companies" | "users" | "settings";

const TABS: { id: AdminTab; label: string; rootOnly?: boolean; hideForRoot?: boolean }[] = [
  { id: "overview", label: "Overview" },
  { id: "projects", label: "Demo Projects" },
  { id: "ai-models", label: "AI Models" },
  { id: "ai-rbac", label: "AI RBAC", rootOnly: true },
  { id: "pipeline", label: "Pipeline" },
  { id: "llm-context", label: "LLM / Context" },
  { id: "text-annotations", label: "Text Annotations" },
  { id: "csi", label: "CSI Codes" },
  { id: "heuristics", label: "Heuristics" },
  { id: "page-intelligence", label: "Page Intelligence" },
  { id: "companies", label: "Companies / Users", rootOnly: true },
  { id: "users", label: "Users", hideForRoot: true },
  { id: "settings", label: "Settings" },
];

interface AdminTabsProps {
  active: AdminTab;
  onChange: (tab: AdminTab) => void;
  badges?: Partial<Record<AdminTab, number>>;
  isRootAdmin?: boolean;
}

export default function AdminTabs({ active, onChange, badges, isRootAdmin }: AdminTabsProps) {
  return (
    <div className="flex gap-1 border-b border-[var(--border)] mb-6 overflow-x-auto">
      {TABS.filter((tab) => (!tab.rootOnly || isRootAdmin) && (!tab.hideForRoot || !isRootAdmin)).map((tab) => (
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
