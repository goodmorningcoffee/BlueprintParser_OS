"use client";

import { useState } from "react";
import type { ClientTakeoffItem, TakeoffGroup, TakeoffGroupKind } from "@/types";

export interface TakeoffGroupSectionProps {
  /** null = "Ungrouped" virtual section */
  group: TakeoffGroup | null;
  kind: TakeoffGroupKind;
  items: ClientTakeoffItem[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onRename?: (newName: string) => void;
  onDelete?: () => void;
  /** Called with (itemId, targetGroupId | null) when user picks a group from the dropdown. */
  onMoveItem: (itemId: number, targetGroupId: number | null) => void;
  /** Tab-specific item row renderer (receives item + a "Move to..." dropdown element). */
  renderItem: (item: ClientTakeoffItem, moveDropdown: React.ReactNode) => React.ReactNode;
  /** All groups of this kind, for the "Move to" dropdown options. */
  availableGroups: TakeoffGroup[];
}

export default function TakeoffGroupSection({
  group,
  items,
  collapsed,
  onToggleCollapsed,
  onRename,
  onDelete,
  onMoveItem,
  renderItem,
  availableGroups,
}: TakeoffGroupSectionProps) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [openMenuItemId, setOpenMenuItemId] = useState<number | null>(null);

  // Hide empty "Ungrouped" section
  if (!group && items.length === 0) return null;

  const headerName = group?.name ?? "Ungrouped";
  const canEdit = !!group && !!onRename;
  const canDelete = !!group && !!onDelete;

  const commitRename = () => {
    const next = editName.trim();
    if (next && next !== group?.name && onRename) onRename(next);
    setEditing(false);
  };

  const renderMoveDropdown = (item: ClientTakeoffItem) => {
    const isOpen = openMenuItemId === item.id;
    return (
      <div className="relative inline-block">
        <button
          onClick={(e) => {
            e.stopPropagation();
            setOpenMenuItemId(isOpen ? null : item.id);
          }}
          className="text-[10px] text-[var(--fg)]/40 opacity-50 group-hover:opacity-100 hover:text-[var(--accent)] px-0.5"
          title="Move to group..."
        >
          &#128193;
        </button>
        {isOpen && (
          <>
            {/* Backdrop to close */}
            <div className="fixed inset-0 z-10" onClick={() => setOpenMenuItemId(null)} />
            <div className="absolute right-0 top-full mt-1 z-20 bg-[var(--surface)] border border-[var(--border)] rounded shadow-lg py-0.5 min-w-[120px]">
              <div className="text-[9px] text-[var(--muted)] uppercase tracking-wide px-2 py-0.5">Move to</div>
              {item.groupId !== null && item.groupId !== undefined && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onMoveItem(item.id, null);
                    setOpenMenuItemId(null);
                  }}
                  className="w-full text-left text-[10px] px-2 py-1 hover:bg-[var(--surface-hover)] text-[var(--muted)]"
                >
                  Ungrouped
                </button>
              )}
              {availableGroups
                .filter((g) => g.id !== item.groupId)
                .map((g) => (
                  <button
                    key={g.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      onMoveItem(item.id, g.id);
                      setOpenMenuItemId(null);
                    }}
                    className="w-full text-left text-[10px] px-2 py-1 hover:bg-[var(--surface-hover)] text-[var(--fg)]"
                  >
                    {g.name}
                  </button>
                ))}
              {availableGroups.length === 0 && item.groupId == null && (
                <div className="text-[9px] text-[var(--muted)] italic px-2 py-1">No other groups yet</div>
              )}
            </div>
          </>
        )}
      </div>
    );
  };

  return (
    <div className="border-b border-[var(--border)]/30 last:border-b-0">
      {/* Group header */}
      <div
        className="flex items-center gap-1.5 px-2 py-1 bg-[var(--surface)]/30 hover:bg-[var(--surface-hover)] cursor-pointer group"
        onClick={onToggleCollapsed}
      >
        <span className="text-[10px] text-[var(--muted)] w-3">{collapsed ? "\u25B6" : "\u25BC"}</span>
        {group?.color && <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: group.color }} />}
        {editing && canEdit ? (
          <input
            autoFocus
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") setEditing(false);
            }}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 bg-transparent border-b border-[var(--accent)] text-[11px] outline-none text-[var(--fg)] px-0.5"
          />
        ) : (
          <span
            className="flex-1 text-[11px] font-medium text-[var(--fg)] truncate"
            onDoubleClick={(e) => {
              if (!canEdit) return;
              e.stopPropagation();
              setEditName(headerName);
              setEditing(true);
            }}
            title={canEdit ? "Double-click to rename" : undefined}
          >
            {headerName}
          </span>
        )}
        <span className="text-[9px] text-[var(--muted)]">{items.length}</span>
        {group?.csiCode && (
          <span className="text-[8px] px-1 py-0.5 rounded bg-cyan-500/10 text-cyan-400">{group.csiCode}</span>
        )}
        {canDelete && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (confirm(`Delete group "${headerName}"? Items will be moved to Ungrouped.`)) {
                onDelete?.();
              }
            }}
            className="text-[10px] text-red-400/40 opacity-0 group-hover:opacity-100 hover:text-red-400 px-0.5"
            title="Delete group"
          >
            &times;
          </button>
        )}
      </div>

      {/* Items */}
      {!collapsed && (
        <div className="pl-2">
          {items.map((item) => (
            <div key={item.id}>{renderItem(item, renderMoveDropdown(item))}</div>
          ))}
          {items.length === 0 && (
            <div className="text-[9px] text-[var(--muted)] italic px-3 py-1.5">No items in this group</div>
          )}
        </div>
      )}
    </div>
  );
}
