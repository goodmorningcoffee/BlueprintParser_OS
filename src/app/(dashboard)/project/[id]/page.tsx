"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQueryClient } from "@tanstack/react-query";
import {
  openProject,
  type OpenProjectHandle,
  type ProjectResponse,
} from "@/lib/project-lifecycle";
import { useSearch } from "@/hooks/useSearch";
import { isEditableKeyboardTarget } from "@/lib/keyboard-target";
import { useUiStore } from "@/stores/uiStore";
import { navigateViewerPage } from "@/stores/viewerCommands";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import PDFViewer from "@/components/viewer/PDFViewer";

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const csiParam = searchParams.get("csi");
  const qParam = searchParams.get("q");
  const { data: session } = useSession();
  const authenticated = !!session;
  const queryClient = useQueryClient();
  const [project, setProject] = useState<ProjectResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const activeOpenRef = useRef<OpenProjectHandle | null>(null);
  const loadedIdRef = useRef<string | null>(null);

  useSearch();

  const load = useCallback(() => {
    activeOpenRef.current?.dispose();
    setLoading(true);
    setError(null);
    const handle = openProject(queryClient, id, {
      demo: false,
      csiFilter: csiParam,
      searchQuery: qParam,
    });
    activeOpenRef.current = handle;

    void handle.result.then((result) => {
      if (activeOpenRef.current !== handle || result.status === "superseded") return;
      if (result.status === "opened") {
        setProject(result.project);
      } else {
        setError(result.error.message);
      }
      setLoading(false);
    });
    return handle;
  }, [csiParam, id, qParam, queryClient]);

  // NextAuth may refresh its session object on focus. Depending on the stable signed-in boolean,
  // plus the loaded-id guard, prevents that from allocating a new project generation.
  useEffect(() => {
    if (!authenticated) return;
    if (loadedIdRef.current === id && activeOpenRef.current) return;
    loadedIdRef.current = id;
    // Route activation must install its exact cleanup handle synchronously in this effect turn;
    // deferring `load` would let unmount run before ownership exists.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    return () => {
      // Retry and processing polling replace the effect's first handle. Unmount owns whichever
      // exact generation is current, not merely the handle captured on the first render.
      const current = activeOpenRef.current;
      current?.dispose();
      if (activeOpenRef.current === current) {
        activeOpenRef.current = null;
        if (loadedIdRef.current === id) loadedIdRef.current = null;
      }
    };
  }, [authenticated, id, load]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (isEditableKeyboardTarget(e.target)) return;
      if (
        (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
        useUiStore.getState().tagBrowseId
      ) return;
      const store = useViewerCoreStore.getState();

      if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        navigateViewerPage(store.pageNumber - 1);
      } else if (e.key === "ArrowRight" || e.key === "PageDown") {
        e.preventDefault();
        navigateViewerPage(store.pageNumber + 1);
      } else if (e.key === "Home") {
        e.preventDefault();
        navigateViewerPage(1);
      } else if (e.key === "End") {
        e.preventDefault();
        navigateViewerPage(store.numPages);
      } else if ((e.ctrlKey || e.metaKey) && e.key === "=") {
        e.preventDefault();
        store.zoomIn();
      } else if ((e.ctrlKey || e.metaKey) && e.key === "-") {
        e.preventDefault();
        store.zoomOut();
      } else if ((e.ctrlKey || e.metaKey) && e.key === "0") {
        e.preventDefault();
        store.zoomFit();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center text-[var(--muted)]">
        Loading project...
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="h-screen flex flex-col items-center justify-center gap-4">
        <span className="text-red-400">
          {error || "Project not found"}
        </span>
        <button
          onClick={load}
          className="px-4 py-2 text-sm bg-[var(--surface)] border border-[var(--border)] rounded hover:border-[var(--accent)] transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  if (project.status === "uploading" || project.status === "processing") {
    return (
      <ProcessingView
        projectName={project.name}
        status={project.status}
        numPages={project.numPages}
        pagesProcessed={project.pages.length}
        onRefresh={load}
      />
    );
  }

  return (
    <PDFViewer
      pdfUrl={project.pdfUrl}
      projectName={project.name}
      onRename={(newName) =>
        setProject((previous) => previous ? { ...previous, name: newName } : previous)}
    />
  );
}

function ProcessingView({
  projectName,
  status,
  numPages,
  pagesProcessed,
  onRefresh,
}: {
  projectName: string;
  status: string;
  numPages: number | null;
  pagesProcessed: number;
  onRefresh: () => void;
}) {
  useEffect(() => {
    const interval = setInterval(onRefresh, 3000);
    return () => clearInterval(interval);
  }, [onRefresh]);

  return (
    <div className="h-screen flex flex-col items-center justify-center gap-6">
      <div className="flex flex-col items-center gap-3">
        <div className="w-10 h-10 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
        <h2 className="text-lg font-medium">{projectName}</h2>
        <span className="text-[var(--muted)] text-sm capitalize">{status}...</span>
        {numPages != null && numPages > 0 && (
          <span className="text-[var(--muted)] text-xs">
            {pagesProcessed} of {numPages} pages processed
          </span>
        )}
      </div>
    </div>
  );
}
