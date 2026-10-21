"use client";

export type AdminTab = "overview" | "projects" | "ai-models" | "ai-rbac" | "pipeline" | "llm-context" | "text-annotations" | "csi" | "heuristics" | "page-intelligence" | "table-parse" | "companies" | "usage" | "users" | "data-tools" | "settings" | "logs";

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
  { id: "table-parse", label: "Table Parsing" },
  { id: "companies", label: "Companies / Users", rootOnly: true },
  { id: "usage", label: "Usage", rootOnly: true },
  { id: "users", label: "Users", hideForRoot: true },
  { id: "data-tools", label: "Data tools" },
  { id: "settings", label: "Settings" },
  { id: "logs", label: "Logs", rootOnly: true },
];

/**
 * The canonical tab-id list, DERIVED from TABS so it cannot drift from it.
 * Consumed by admin/page.tsx to validate the `?tab=` deep-link parameter. Before this
 * existed that check carried a hand-written third copy of all 16 ids, so adding a tab
 * without updating it sent the deep link silently to Overview.
 */
export const TAB_IDS: readonly AdminTab[] = TABS.map((tab) => tab.id);

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
