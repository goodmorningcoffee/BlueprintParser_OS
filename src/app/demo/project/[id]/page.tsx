"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
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

export default function DemoProjectPage() {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const csiParam = searchParams.get("csi");
  const qParam = searchParams.get("q");
  const queryClient = useQueryClient();
  const [project, setProject] = useState<ProjectResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const activeOpenRef = useRef<OpenProjectHandle | null>(null);

  useSearch();

  const load = useCallback(() => {
    activeOpenRef.current?.dispose();
    setLoading(true);
    setError(null);
    const handle = openProject(queryClient, id, {
      demo: true,
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

  useEffect(() => {
    // Install the lifecycle handle in the same effect turn so cleanup always owns this generation.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    const handle = load();
    return () => {
      handle.dispose();
      if (activeOpenRef.current === handle) activeOpenRef.current = null;
    };
  }, [load]);

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
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center text-[var(--muted)]">
        Loading demo project...
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="h-screen flex flex-col items-center justify-center gap-4">
        <span className="text-red-400">{error || "Project not found"}</span>
        <a href="/demo" className="text-sm text-[var(--accent)] hover:underline">
          Back to Demo
        </a>
      </div>
    );
  }

  return <PDFViewer pdfUrl={project.pdfUrl} projectName={project.name} backHref="/demo" />;
}
