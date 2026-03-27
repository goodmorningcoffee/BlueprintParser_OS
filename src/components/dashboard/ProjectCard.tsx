"use client";

import Link from "next/link";
import { useState } from "react";

interface ProjectCardProps {
  id: string;
  name: string;
  numPages: number | null;
  status: string;
  pagesProcessed: number | null;
  createdAt: string | null;
  thumbnailUrl: string | null;
  onDelete: (id: string) => void;
  onRename: (id: string, newName: string) => void;
  contentMatch?: { matchCount: number; pageCount: number };
  csiSheetCount?: number;
  csiFilter?: string | null;
  searchQuery?: string;
}

const STATUS_COLORS: Record<string, string> = {
  uploading: "text-yellow-400",
  processing: "text-blue-400",
  completed: "text-green-400",
  error: "text-red-400",
};

export default function ProjectCard({
  id,
  name,
  numPages,
  status,
  createdAt,
  onDelete,
  onRename,
  pagesProcessed,
  thumbnailUrl,
  contentMatch,
  csiSheetCount,
  csiFilter,
  searchQuery,
}: ProjectCardProps) {
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(name);

  async function saveName() {
    const trimmed = editName.trim();
    if (!trimmed || trimmed === name) {
      setEditName(name);
      setEditing(false);
      return;
    }
    const res = await fetch(`/api/projects/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: trimmed }),
    });
    if (res.ok) {
      onRename(id, trimmed);
    } else {
      setEditName(name);
    }
    setEditing(false);
  }

  async function handleDelete(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();

    if (!confirming) {
      setConfirming(true);
      setTimeout(() => setConfirming(false), 3000);
      return;
    }

    const res = await fetch(`/api/projects/${id}`, { method: "DELETE" });
    if (res.ok) onDelete(id);
  }

  return (
    <Link
      href={(() => {
        const params = new URLSearchParams();
        if (csiFilter) params.set("csi", csiFilter);
        if (searchQuery) params.set("q", searchQuery);
        const qs = params.toString();
        return `/project/${id}${qs ? `?${qs}` : ""}`;
      })()}
      className="block p-4 bg-[var(--surface)] border border-[var(--border)] rounded-lg hover:border-[var(--accent)] transition-colors relative group"
    >
      {/* Delete button */}
      <button
        onClick={handleDelete}
        className={`absolute top-2 right-2 px-2 py-0.5 rounded text-xs z-10 transition-colors ${
          confirming
            ? "bg-red-600 text-white"
            : "bg-[var(--bg)] text-[var(--muted)] opacity-0 group-hover:opacity-100 hover:text-red-400"
        }`}
      >
        {confirming ? "Confirm?" : "X"}
      </button>

      {/* Thumbnail */}
      <div
        className={`aspect-[4/3] bg-[var(--bg)] rounded mb-3 overflow-hidden flex items-center justify-center ${
          status === "processing" ? "animate-pulse" : ""
        }`}
      >
        {thumbnailUrl ? (
          <img
            src={thumbnailUrl}
            alt={name}
            className="w-full h-full object-contain"
          />
        ) : (
          <div className="flex flex-col items-center gap-1">
            <span className="text-[var(--muted)] text-sm capitalize">
              {status === "completed" ? "No preview" : status}
            </span>
            {status === "processing" && numPages != null && numPages > 0 && (
              <span className="text-[var(--accent)] text-xs">
                {pagesProcessed || 0} / {numPages} pages
              </span>
            )}
          </div>
        )}
      </div>

      {editing ? (
        <input
          autoFocus
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onBlur={saveName}
          onKeyDown={(e) => {
            if (e.key === "Enter") saveName();
            if (e.key === "Escape") { setEditName(name); setEditing(false); }
          }}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
          className="font-medium w-full bg-transparent border-b border-[var(--accent)] outline-none px-0"
        />
      ) : (
        <div className="flex items-center gap-1">
          <h3 className="font-medium truncate">{name}</h3>
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setEditing(true); setEditName(name); }}
            className="text-[var(--muted)] opacity-0 group-hover:opacity-100 hover:text-[var(--fg)] text-xs shrink-0"
            title="Rename project"
          >
            ✎
          </button>
        </div>
      )}

      <div className="flex items-center justify-between mt-1">
        <div className="flex items-center gap-2">
          <span className={`text-xs ${STATUS_COLORS[status] || "text-gray-400"}`}>
            {status}
          </span>
          {numPages != null && (
            <span className="text-xs text-[var(--muted)]">
              {numPages} pg
            </span>
          )}
        </div>
        {csiSheetCount ? (
          <span className="text-xs text-sky-400">
            {csiSheetCount} sheet{csiSheetCount !== 1 ? "s" : ""}
          </span>
        ) : contentMatch ? (
          <span className="text-xs text-[var(--accent)]">
            {contentMatch.matchCount} matches
          </span>
        ) : createdAt ? (
          <span className="text-xs text-[var(--muted)]">
            {new Date(createdAt).toLocaleDateString()}
          </span>
        ) : null}
      </div>
    </Link>
  );
}
