"use client";

import { useState } from "react";
import { useViewerStore, useSelection, useAnnotationGroups } from "@/stores/viewerStore";
import MarkupDialog from "./MarkupDialog";
import type { AnnotationGroup } from "@/types";

/**
 * Floating action bar that appears when ≥2 annotations are multi-selected.
 * Offers Group (create new), Add to existing, Delete (mass-delete), and a
 * small "N selected" status. Positioned as a pinned bottom-center toolbar
 * so it doesn't clash with the side panels.
 *
 * Lives outside AnnotationOverlay so overlay doesn't accumulate more tool
 * logic. Reads selection + groups state from Zustand.
 */
export default function GroupActionsBar() {
  const {
    selectedAnnotationIds,
    clearSelection,
  } = useSelection();
  const {
    annotationGroups,
    upsertAnnotationGroup,
    hydrateGroupMemberships,
    annotationGroupMemberships,
  } = useAnnotationGroups();
  const publicId = useViewerStore((s) => s.publicId);
  const isDemo = useViewerStore((s) => s.isDemo);
  const removeAnnotation = useViewerStore((s) => s.removeAnnotation);

  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showAddPicker, setShowAddPicker] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [groupNote, setGroupNote] = useState("");
  const [groupCsi, setGroupCsi] = useState("");
  const [groupColor, setGroupColor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Edit-group state. The picker modal doubles as a lightweight group
  // manager until the View All panel ships a dedicated one.
  const [editingGroup, setEditingGroup] = useState<AnnotationGroup | null>(null);
  const [editName, setEditName] = useState("");
  const [editNote, setEditNote] = useState("");
  const [editCsi, setEditCsi] = useState("");
  const [editColor, setEditColor] = useState<string | null>(null);
  const [editActive, setEditActive] = useState(true);

  const count = selectedAnnotationIds.size;
  if (count < 2) return null;

  const selectedIds = [...selectedAnnotationIds];

  async function handleCreateGroup() {
    if (!publicId || isDemo || !groupName.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/annotation-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: publicId,
          name: groupName.trim(),
          notes: groupNote.trim() || null,
          csiCode: groupCsi.trim() || null,
          color: groupColor,
          annotationIds: selectedIds,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      if (data.group) {
        upsertAnnotationGroup(data.group as AnnotationGroup);
        // Append the new memberships to the existing ones. hydrateGroupMemberships
        // rebuilds from scratch — build the full pair list first.
        const pairs: { annotationId: number; groupId: number }[] = [];
        for (const [aidStr, groupSet] of Object.entries(annotationGroupMemberships)) {
          const aid = Number(aidStr);
          for (const gid of groupSet) pairs.push({ annotationId: aid, groupId: gid });
        }
        for (const aid of selectedIds) pairs.push({ annotationId: aid, groupId: data.group.id });
        hydrateGroupMemberships(pairs);
      }
      setShowCreateDialog(false);
      setGroupName("");
      setGroupNote("");
      setGroupCsi("");
      setGroupColor(null);
      clearSelection();
    } catch (err) {
      console.error("[GroupActionsBar] Create group failed:", err);
    } finally {
      setBusy(false);
    }
  }

  async function handleAddToExisting(groupId: number) {
    if (!publicId || isDemo) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/annotation-groups/${groupId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ annotationIds: selectedIds }),
      });
      if (!res.ok) throw new Error(await res.text());
      // Rebuild membership indexes
      const pairs: { annotationId: number; groupId: number }[] = [];
      for (const [aidStr, groupSet] of Object.entries(annotationGroupMemberships)) {
        const aid = Number(aidStr);
        for (const gid of groupSet) pairs.push({ annotationId: aid, groupId: gid });
      }
      for (const aid of selectedIds) {
        if (!annotationGroupMemberships[aid]?.has(groupId)) {
          pairs.push({ annotationId: aid, groupId });
        }
      }
      hydrateGroupMemberships(pairs);
      setShowAddPicker(false);
      clearSelection();
    } catch (err) {
      console.error("[GroupActionsBar] Add to existing failed:", err);
    } finally {
      setBusy(false);
    }
  }

  function openEdit(group: AnnotationGroup) {
    setEditingGroup(group);
    setEditName(group.name);
    setEditNote(group.notes ?? "");
    setEditCsi(group.csiCode ?? "");
    setEditColor(group.color);
    setEditActive(group.isActive !== false);
    setShowAddPicker(false);
  }

  async function handleEditSave() {
    if (!editingGroup || !editName.trim()) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/annotation-groups/${editingGroup.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editName.trim(),
          notes: editNote.trim() || null,
          csiCode: editCsi.trim() || null,
          color: editColor,
          isActive: editActive,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      if (data.group) {
        upsertAnnotationGroup(data.group as AnnotationGroup);
      }
      setEditingGroup(null);
    } catch (err) {
      console.error("[GroupActionsBar] Edit group failed:", err);
    } finally {
      setBusy(false);
    }
  }

  async function handleMassDelete() {
    if (!publicId || isDemo) return;
    setBusy(true);
    try {
      const res = await fetch("/api/annotations/batch-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: publicId, annotationIds: selectedIds }),
      });
      if (!res.ok) throw new Error(await res.text());
      for (const id of selectedIds) removeAnnotation(id);
      clearSelection();
      setShowDeleteConfirm(false);
    } catch (err) {
      console.error("[GroupActionsBar] Mass delete failed:", err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* Floating bar — pinned bottom-center, high z-index above the canvas */}
      <div
        style={{
          position: "fixed",
          bottom: 24,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 1000,
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: "var(--surface, #161616)",
          border: "1px solid var(--border, #3a3a3a)",
          borderRadius: 8,
          padding: "8px 12px",
          boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
        }}
      >
        <span style={{ fontSize: 13, color: "var(--fg, #ededed)", marginRight: 4 }}>
          {count} selected
        </span>
        <button
          onClick={() => setShowCreateDialog(true)}
          disabled={busy}
          style={{ padding: "6px 12px", background: "var(--accent, #3b82f6)", border: "none", borderRadius: 4, color: "#fff", fontSize: 12, fontWeight: 500, cursor: busy ? "wait" : "pointer" }}
        >
          Group
        </button>
        <button
          onClick={() => setShowAddPicker(true)}
          disabled={busy || annotationGroups.length === 0}
          title={annotationGroups.length === 0 ? "No existing groups in this project yet" : "Add to an existing group"}
          style={{ padding: "6px 12px", background: "transparent", border: "1px solid var(--border, #3a3a3a)", borderRadius: 4, color: annotationGroups.length === 0 ? "#666" : "var(--fg, #ededed)", fontSize: 12, cursor: busy || annotationGroups.length === 0 ? "default" : "pointer" }}
        >
          Add to…
        </button>
        <button
          onClick={() => setShowDeleteConfirm(true)}
          disabled={busy}
          style={{ padding: "6px 12px", background: "transparent", border: "1px solid #dc262655", borderRadius: 4, color: "#f87171", fontSize: 12, cursor: busy ? "wait" : "pointer" }}
        >
          Delete
        </button>
        <button
          onClick={clearSelection}
          disabled={busy}
          style={{ padding: "6px 10px", background: "transparent", border: "none", color: "var(--muted, #aaa)", fontSize: 12, cursor: busy ? "default" : "pointer" }}
        >
          Clear
        </button>
      </div>

      {/* Create group dialog — reuses MarkupDialog in group mode */}
      {showCreateDialog && (
        <MarkupDialog
          isEditing={false}
          mode="group"
          name={groupName}
          note={groupNote}
          csiCode={groupCsi}
          color={groupColor}
          annotationCount={count}
          onNameChange={setGroupName}
          onNoteChange={setGroupNote}
          onCsiChange={setGroupCsi}
          onColorChange={setGroupColor}
          onSave={handleCreateGroup}
          onCancel={() => {
            setShowCreateDialog(false);
            setGroupName("");
            setGroupNote("");
            setGroupCsi("");
            setGroupColor(null);
          }}
        />
      )}

      {/* Edit group dialog — same MarkupDialog in edit mode */}
      {editingGroup && (
        <MarkupDialog
          isEditing={true}
          mode="group"
          name={editName}
          note={editNote}
          csiCode={editCsi}
          color={editColor}
          isActive={editActive}
          onNameChange={setEditName}
          onNoteChange={setEditNote}
          onCsiChange={setEditCsi}
          onColorChange={setEditColor}
          onActiveChange={setEditActive}
          onSave={handleEditSave}
          onCancel={() => setEditingGroup(null)}
        />
      )}

      {/* Add-to-existing picker — simple dropdown modal */}
      {showAddPicker && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.5)" }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowAddPicker(false); }}
        >
          <div
            style={{ background: "var(--surface, #161616)", border: "1px solid var(--border, #3a3a3a)", borderRadius: 8, padding: 16, width: 320, maxHeight: "60vh", overflowY: "auto", color: "var(--fg, #ededed)" }}
          >
            <h3 style={{ margin: "0 0 10px", fontSize: 14, fontWeight: 600 }}>
              Add {count} to existing group
            </h3>
            {annotationGroups.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--muted, #aaa)" }}>No groups yet.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {annotationGroups.map((g) => (
                  <div
                    key={g.id}
                    style={{ display: "flex", alignItems: "center", gap: 4, padding: "0", border: "1px solid var(--border, #3a3a3a)", borderRadius: 4, overflow: "hidden" }}
                  >
                    <button
                      onClick={() => handleAddToExisting(g.id)}
                      disabled={busy}
                      style={{ flexGrow: 1, display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", background: "transparent", border: "none", cursor: busy ? "wait" : "pointer", textAlign: "left" }}
                      title={`Add ${count} to “${g.name}”`}
                    >
                      {g.color && (
                        <span style={{ width: 12, height: 12, background: g.color, borderRadius: 2, flexShrink: 0, opacity: g.isActive === false ? 0.4 : 1 }} />
                      )}
                      <span style={{ fontSize: 13, color: g.isActive === false ? "var(--muted, #888)" : "var(--fg, #ededed)", flexGrow: 1 }}>
                        {g.name}
                        {g.isActive === false && <span style={{ fontSize: 10, marginLeft: 6, color: "var(--muted, #777)" }}>(inactive)</span>}
                      </span>
                      {g.csiCode && (
                        <span style={{ fontSize: 11, color: "var(--muted, #aaa)", fontFamily: "ui-monospace, monospace" }}>{g.csiCode}</span>
                      )}
                    </button>
                    <button
                      onClick={() => openEdit(g)}
                      disabled={busy}
                      title="Edit group"
                      aria-label={`Edit group ${g.name}`}
                      style={{ flexShrink: 0, width: 30, height: "100%", minHeight: 30, display: "flex", alignItems: "center", justifyContent: "center", padding: 0, background: "transparent", border: "none", borderLeft: "1px solid var(--border, #3a3a3a)", color: "var(--muted, #aaa)", cursor: busy ? "wait" : "pointer", fontSize: 13 }}
                    >
                      ✎
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div style={{ marginTop: 10, display: "flex", justifyContent: "flex-end" }}>
              <button
                onClick={() => setShowAddPicker(false)}
                style={{ padding: "6px 14px", background: "transparent", border: "1px solid var(--border, #3a3a3a)", borderRadius: 4, color: "var(--muted, #aaa)", cursor: "pointer", fontSize: 13 }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Mass-delete confirmation */}
      {showDeleteConfirm && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.5)" }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowDeleteConfirm(false); }}
        >
          <div
            style={{ background: "var(--surface, #161616)", border: "1px solid var(--border, #3a3a3a)", borderRadius: 8, padding: 20, width: 360, color: "var(--fg, #ededed)" }}
          >
            <h3 style={{ margin: "0 0 10px", fontSize: 15, fontWeight: 600 }}>Delete {count} annotations?</h3>
            <p style={{ margin: "0 0 14px", fontSize: 13, color: "var(--muted, #aaa)", lineHeight: 1.4 }}>
              This permanently removes the selected annotations from the project. Any group memberships will also be cleaned up.
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                onClick={() => setShowDeleteConfirm(false)}
                disabled={busy}
                style={{ padding: "6px 14px", background: "transparent", border: "1px solid var(--border, #3a3a3a)", borderRadius: 4, color: "var(--muted, #aaa)", cursor: busy ? "default" : "pointer", fontSize: 13 }}
              >
                Cancel
              </button>
              <button
                onClick={handleMassDelete}
                disabled={busy}
                style={{ padding: "6px 14px", background: "#dc2626", border: "none", borderRadius: 4, color: "#fff", fontSize: 13, fontWeight: 500, cursor: busy ? "wait" : "pointer" }}
              >
                {busy ? "Deleting…" : "Delete all"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

