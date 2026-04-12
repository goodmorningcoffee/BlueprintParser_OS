"use client";

import { useState } from "react";
import { useViewerStore } from "@/stores/viewerStore";
import { TWENTY_COLORS } from "@/types";
import type { ClientTakeoffItem } from "@/types";

interface BucketFillAssignDialogProps {
  pendingPolygon: NonNullable<ReturnType<typeof useViewerStore.getState>["bucketFillPendingPolygon"]>;
  width: number;
  height: number;
  cssScale: number;
}

export default function BucketFillAssignDialog({
  pendingPolygon,
  width,
  height,
  cssScale,
}: BucketFillAssignDialogProps) {
  const takeoffItems = useViewerStore((s) => s.takeoffItems);
  const addTakeoffItem = useViewerStore((s) => s.addTakeoffItem);
  const commitBucketFillToItem = useViewerStore((s) => s.commitBucketFillToItem);
  const setBucketFillPendingPolygon = useViewerStore((s) => s.setBucketFillPendingPolygon);
  const publicId = useViewerStore((s) => s.publicId);
  const projectId = useViewerStore((s) => s.projectId);
  const isDemo = useViewerStore((s) => s.isDemo);

  const areaItems = takeoffItems.filter((t) => t.shape === "polygon");

  const [showCreate, setShowCreate] = useState(areaItems.length === 0);
  const [formName, setFormName] = useState("");
  const [formColor, setFormColor] = useState(TWENTY_COLORS[areaItems.length % TWENTY_COLORS.length]);
  const [creating, setCreating] = useState(false);

  // Position near polygon centroid, clamped to viewport
  const verts = pendingPolygon.vertices;
  const cx = (verts.reduce((s, v) => s + v.x, 0) / verts.length) * width;
  const cy = (verts.reduce((s, v) => s + v.y, 0) / verts.length) * height;
  const dialogW = 240;
  const left = Math.max(8, Math.min(cx - dialogW / 2, width - dialogW - 8));
  const top = Math.min(cy + 20, height - 280);

  async function handleCreateAndAssign() {
    const name = formName.trim();
    if (!name) return;
    setCreating(true);
    try {
      let item: ClientTakeoffItem;
      if (isDemo) {
        item = {
          id: -Date.now(),
          groupId: null,
          name,
          shape: "polygon",
          color: formColor,
          size: 24,
          sortOrder: 0,
        };
      } else {
        const res = await fetch("/api/takeoff-items", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId, name, shape: "polygon", color: formColor }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        item = await res.json();
      }
      addTakeoffItem(item);
      commitBucketFillToItem(item);
    } catch (err) {
      console.error("Failed to create area item:", err);
      setCreating(false);
    }
  }

  return (
    <div
      style={{
        position: "absolute",
        left: `${left}px`,
        top: `${top}px`,
        width: `${dialogW}px`,
        zIndex: 18,
        pointerEvents: "auto",
        background: "var(--surface, #1a1a2e)",
        border: "1px solid var(--border, #333)",
        borderRadius: 8,
        padding: 10,
        boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
        transform: cssScale !== 1 ? `scale(${cssScale})` : undefined,
        transformOrigin: "top left",
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--fg, #e0e0e0)", marginBottom: 8 }}>
        Assign to Area Item
      </div>

      {/* Existing items list */}
      {areaItems.length > 0 && (
        <div style={{ maxHeight: 140, overflowY: "auto", marginBottom: 8 }}>
          {areaItems.map((item) => (
            <button
              key={item.id}
              onClick={() => commitBucketFillToItem(item)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                width: "100%",
                padding: "5px 6px",
                border: "none",
                borderRadius: 4,
                background: "transparent",
                color: "var(--fg, #e0e0e0)",
                fontSize: 11,
                cursor: "pointer",
                textAlign: "left",
              }}
              onMouseEnter={(e) => { (e.target as HTMLElement).style.background = "var(--accent, #333)"; }}
              onMouseLeave={(e) => { (e.target as HTMLElement).style.background = "transparent"; }}
            >
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  background: item.color,
                  flexShrink: 0,
                }}
              />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {item.name}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Create new section */}
      {showCreate ? (
        <div style={{ borderTop: areaItems.length > 0 ? "1px solid var(--border, #333)" : "none", paddingTop: areaItems.length > 0 ? 8 : 0 }}>
          <input
            type="text"
            placeholder="New item name"
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleCreateAndAssign(); }}
            autoFocus
            style={{
              width: "100%",
              padding: "4px 6px",
              borderRadius: 4,
              border: "1px solid var(--border, #444)",
              background: "var(--bg, #0f0f1a)",
              color: "var(--fg, #e0e0e0)",
              fontSize: 11,
              marginBottom: 6,
              outline: "none",
            }}
          />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginBottom: 6 }}>
            {TWENTY_COLORS.slice(0, 10).map((c) => (
              <button
                key={c}
                onClick={() => setFormColor(c)}
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: "50%",
                  background: c,
                  border: formColor === c ? "2px solid #fff" : "1px solid #555",
                  cursor: "pointer",
                  padding: 0,
                }}
              />
            ))}
          </div>
          <button
            onClick={handleCreateAndAssign}
            disabled={!formName.trim() || creating}
            style={{
              width: "100%",
              padding: "5px 0",
              borderRadius: 4,
              border: "none",
              background: formName.trim() ? "#22c55e" : "#333",
              color: "#fff",
              fontSize: 11,
              fontWeight: 600,
              cursor: formName.trim() ? "pointer" : "not-allowed",
            }}
          >
            {creating ? "Creating..." : "Create & Assign"}
          </button>
        </div>
      ) : (
        <button
          onClick={() => setShowCreate(true)}
          style={{
            width: "100%",
            padding: "5px 0",
            borderRadius: 4,
            border: "1px dashed var(--border, #444)",
            background: "transparent",
            color: "var(--muted, #888)",
            fontSize: 11,
            cursor: "pointer",
          }}
        >
          + Create New Item
        </button>
      )}

      {/* Cancel */}
      <button
        onClick={() => setBucketFillPendingPolygon(null)}
        style={{
          width: "100%",
          padding: "4px 0",
          marginTop: 6,
          borderRadius: 4,
          border: "none",
          background: "transparent",
          color: "var(--muted, #666)",
          fontSize: 10,
          cursor: "pointer",
        }}
      >
        Cancel
      </button>
    </div>
  );
}
