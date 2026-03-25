"use client";

import ProjectCard from "./ProjectCard";

interface ProjectData {
  id: string;
  name: string;
  numPages: number | null;
  status: string;
  pagesProcessed: number | null;
  createdAt: string | null;
  thumbnailUrl: string | null;
}

export default function ProjectGrid({
  projects,
  onDelete,
  onRename,
  contentMatches,
  csiSheetCounts,
  csiFilter,
}: {
  projects: ProjectData[];
  onDelete: (id: string) => void;
  onRename: (id: string, newName: string) => void;
  contentMatches?: Record<string, { matchCount: number; pageCount: number }>;
  csiSheetCounts?: Record<string, number>;
  csiFilter?: string | null;
}) {
  if (projects.length === 0) {
    return (
      <div className="text-center py-16 text-[var(--muted)]">
        <p className="text-lg mb-2">No projects yet</p>
        <p className="text-sm">Upload a PDF to get started</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
      {projects.map((p) => (
        <ProjectCard key={p.id} {...p} onDelete={onDelete} onRename={onRename} contentMatch={contentMatches?.[p.id]} csiSheetCount={csiSheetCounts?.[p.id]} csiFilter={csiFilter} />
      ))}
    </div>
  );
}
